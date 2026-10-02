// PC client: an Obsidian-like Markdown workspace. Typing happens here; drawing
// fields are displayed (live) but are only edited on the tablet.
import { marked } from 'marked';
import { connect } from '../common/socket.js';
import { api, drawings, session } from './store.js';
import { createEditor, EMBED_RE } from './editor.js';
import { createInkEmbed, setInkActions, setDarkPaper } from './inkEmbed.js';

const $ = s => document.querySelector(s);
const scroller = document.querySelector('#scroller');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const prefs = (() => { try { return JSON.parse(localStorage.getItem('inkvault.pc') || '{}'); } catch { return {}; } })();
const savePrefs = () => { try { localStorage.setItem('inkvault.pc', JSON.stringify(prefs)); } catch {} };
prefs.open ??= {};

let tree = [];
let notes = []; // all note paths
let current = null; // path of open note
let mode = 'edit';
let saveTimer = 0;
let saving = Promise.resolve();
let lastSaved = '';

// ---------------------------------------------------------------------------
// Socket
// ---------------------------------------------------------------------------

const sock = connect('pc', {
  onStatus: connected => session.set({ connected }),
  onMessage(m) {
    if (m.type === 'state') session.set({ active: m.active, tablets: m.tablets, pcs: m.pcs });
    else if (m.type === 'change') drawings.onChange(m.id, m.change);
    else if (m.type === 'live') drawings.onLive(m.id, m.sid, m.stroke);
    else if (m.type === 'tree') loadTree();
  },
});

setInkActions({
  edit(id) {
    sock.send({ type: 'open', id, note: current || '' });
    if (!session.state.tablets) toastMsg('No tablet connected yet. Open “Connect tablet” in the status bar.');
  },
  done(id) { sock.send({ type: 'close', id }); },
});

session.subscribe(s => {
  const chip = $('#tablet-chip');
  chip.classList.toggle('ok', s.connected && s.tablets > 0);
  chip.classList.toggle('off', !s.connected);
  chip.querySelector('span').textContent = !s.connected ? 'Server offline' : s.tablets ? `Tablet connected${s.tablets > 1 ? ` (${s.tablets})` : ''}` : 'No tablet';
  $('#btn-done-drawing').hidden = !s.active;
});

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

const editor = createEditor($('#editor'), {
  onChange: text => {
    if (!current) return;
    setSaveState('Unsaved');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => save(text), 500);
    updateCounts(text);
  },
  onOpenLink: openLink,
  getNoteNames: () => notes.map(p => p.replace(/\.md$/i, '').split('/').pop()),
});

function save(text = editor.getText()) {
  clearTimeout(saveTimer);
  if (!current || text === lastSaved) { setSaveState('Saved'); return saving; }
  const path = current;
  setSaveState('Saving…');
  saving = saving
    .then(() => api.send('PUT', `/api/note?path=${encodeURIComponent(path)}`, text))
    .then(() => { if (path === current) { lastSaved = text; setSaveState('Saved'); } })
    .catch(e => { setSaveState('Save failed'); toastMsg(`Could not save: ${e.message}`); });
  return saving;
}
window.addEventListener('beforeunload', e => {
  if (current && editor.getText() !== lastSaved) { save(); e.preventDefault(); }
});

function setSaveState(s) { $('#save-state').textContent = s; }
function updateCounts(text) {
  const words = (text.replace(/!\[\[ink-[a-z0-9]+\.svg\]\]/g, '').match(/\S+/g) || []).length;
  const inks = (text.match(/!\[\[ink-[a-z0-9]+\.svg\]\]/g) || []).length;
  $('#counts').textContent = `${words} words${inks ? ` · ${inks} drawing${inks > 1 ? 's' : ''}` : ''}`;
}

// The server rewrote links inside notes (after a rename); refresh the open note if it was one of them.
async function reloadIfChanged() {
  if (!current) return;
  const { text } = await api.get(`/api/note?path=${encodeURIComponent(current)}`);
  if (text !== lastSaved && editor.getText() === lastSaved) {
    const top = scroller.scrollTop;
    lastSaved = text;
    editor.setText(text);
    requestAnimationFrame(() => { scroller.scrollTop = top; });
    if (mode === 'read') renderReading();
  }
}

async function openNote(path, { focus = true, nav = 'push', scroll = 0 } = {}) {
  if (current) await save();
  try {
    const { text } = await api.get(`/api/note?path=${encodeURIComponent(path)}`);
    // Remember where we were on the page we're leaving, for Back.
    if (current && history.state?.path === current) history.replaceState({ ...history.state, scroll: scroller.scrollTop }, '');
    const url = `?note=${encodeURIComponent(path)}`;
    if (nav === 'push' && path !== current) history.pushState({ path, scroll: 0 }, '', url);
    else if (nav !== 'none') history.replaceState({ path, scroll: 0 }, '', url);
    current = path;
    lastSaved = text;
    editor.setText(text);
    scroller.scrollTop = 0;
    requestAnimationFrame(() => { scroller.scrollTop = scroll; });
    prefs.last = path;
    savePrefs();
    $('#title').value = path.replace(/\.md$/i, '').split('/').pop();
    $('#crumb').textContent = path.includes('/') ? path.split('/').slice(0, -1).join(' / ') : '';
    document.body.classList.remove('empty');
    setSaveState('Saved');
    updateCounts(text);
    renderTree();
    if (mode === 'read') renderReading();
    if (focus && mode === 'edit') editor.focus();
  } catch (e) {
    toastMsg(`Could not open ${path}: ${e.message}`);
  }
}

function showEmpty() {
  current = null;
  document.body.classList.add('empty');
  editor.setText('');
  $('#title').value = '';
  $('#crumb').textContent = '';
}

async function insertDrawing() {
  if (!current) await newNote();
  if (mode === 'read') setMode('edit');
  const d = await api.send('POST', '/api/drawing');
  drawings.put(d);
  editor.insertDrawing(d.id);
  await save();
  sock.send({ type: 'open', id: d.id, note: current });
  if (!session.state.tablets) toastMsg('Drawing added. Connect a tablet to draw in it.');
}

function resolveLink(name) {
  const target = name.toLowerCase().replace(/\.md$/, '');
  return notes.find(p => p.toLowerCase().replace(/\.md$/, '') === target)
    || notes.find(p => p.toLowerCase().replace(/\.md$/, '').split('/').pop() === target.split('/').pop());
}

async function openLink(name, { newTab = false } = {}) {
  let path = resolveLink(name);
  if (!path) {
    ({ path } = await api.send('POST', '/api/note', { name }));
    await loadTree();
  }
  if (newTab) window.open(`/pc?note=${encodeURIComponent(path)}`, '_blank');
  else openNote(path);
}

// Back / forward between notes (also the browser's and the mouse's back buttons, Alt+←/→).
window.addEventListener('popstate', e => {
  const path = e.state?.path;
  if (!path) return;
  if (notes.includes(path)) openNote(path, { nav: 'none', scroll: e.state.scroll || 0 });
  else toastMsg('That note was moved or deleted.');
});
$('#btn-back').onclick = () => history.back();
$('#btn-forward').onclick = () => history.forward();

// Inline title = file name (rename on commit), as in Obsidian.
$('#title').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); editor.focus(); }
  if (e.key === 'Escape') { e.target.value = current.replace(/\.md$/i, '').split('/').pop(); editor.focus(); }
});
$('#title').addEventListener('change', async e => {
  if (!current) return;
  const name = e.target.value.replace(/[\\/:*?"<>|#^[\]]/g, '').trim();
  const dir = current.includes('/') ? current.slice(0, current.lastIndexOf('/') + 1) : '';
  const to = `${dir}${name}.md`;
  if (!name || to === current) { e.target.value = current.replace(/\.md$/i, '').split('/').pop(); return; }
  await save();
  try {
    const r = await api.send('POST', '/api/rename', { from: current, to });
    current = r.path;
    prefs.last = r.path;
    savePrefs();
    history.replaceState({ path: r.path, scroll: scroller.scrollTop }, '', `?note=${encodeURIComponent(r.path)}`);
    await loadTree();
    if (r.linksUpdated) {
      toastMsg(`Updated links in ${r.linksUpdated} note${r.linksUpdated > 1 ? 's' : ''}`);
      reloadIfChanged();
    }
  } catch (err) {
    toastMsg(err.message);
    e.target.value = current.replace(/\.md$/i, '').split('/').pop();
  }
});

// ---------------------------------------------------------------------------
// Reading view
// ---------------------------------------------------------------------------

function setMode(m) {
  mode = m;
  document.body.classList.toggle('reading', m === 'read');
  $('#btn-mode').title = m === 'read' ? 'Edit (Ctrl+E)' : 'Reading view (Ctrl+E)';
  $('#btn-mode').classList.toggle('on', m === 'read');
  if (m === 'read') renderReading();
  else { clearReading(); editor.focus(); }
}

function clearReading() {
  const root = $('#reading');
  root.querySelectorAll('.ink-embed').forEach(el => el.destroy?.());
  root.innerHTML = '';
}

function renderReading() {
  clearReading();
  const root = $('#reading');
  const text = editor.getText()
    .split('\n')
    .map(line => {
      const m = EMBED_RE.exec(line);
      return m ? `\n<div class="ink-slot" data-id="${m[1]}"></div>\n` : line;
    })
    .join('\n')
    .replace(/(?<!!)\[\[([^\]\n|#]+)(?:[#|]([^\]\n]*))?\]\]/g, (_, target, alias) => `<a class="wikilink" data-link="${esc(target.trim())}">${esc((alias || target).trim())}</a>`);
  root.innerHTML = marked.parse(text, { gfm: true, breaks: false });
  root.querySelectorAll('.ink-slot').forEach(slot => slot.replaceWith(createInkEmbed(slot.dataset.id)));
  root.querySelectorAll('a.wikilink').forEach(a => {
    if (!resolveLink(a.dataset.link)) a.classList.add('unresolved');
    a.addEventListener('click', e => { e.preventDefault(); openLink(a.dataset.link); });
  });
  root.querySelectorAll('a[href^="http"]').forEach(a => { a.target = '_blank'; a.rel = 'noopener'; });
}

// ---------------------------------------------------------------------------
// File tree
// ---------------------------------------------------------------------------

async function loadTree() {
  tree = await api.get('/api/tree');
  notes = [];
  (function walk(nodes) { for (const n of nodes) n.type === 'file' ? notes.push(n.path) : walk(n.children); })(tree);
  renderTree();
}

function renderTree() {
  const root = $('#tree');
  root.innerHTML = '';
  const build = (nodes, depth) => {
    const frag = document.createDocumentFragment();
    for (const n of nodes) {
      const row = document.createElement('div');
      row.className = `node ${n.type}${n.path === current ? ' active' : ''}`;
      row.style.paddingLeft = `${10 + depth * 14}px`;
      row.dataset.path = n.path;
      row.draggable = true;
      if (n.type === 'folder') {
        const open = !!prefs.open[n.path];
        row.innerHTML = `<span class="chev${open ? ' open' : ''}">›</span><span class="name">${esc(n.name)}</span>`;
        row.onclick = () => { prefs.open[n.path] = !open; savePrefs(); renderTree(); };
        frag.appendChild(row);
        if (open) frag.appendChild(build(n.children, depth + 1));
      } else {
        row.innerHTML = `<span class="name">${esc(n.name)}</span>`;
        row.onclick = () => openNote(n.path);
        frag.appendChild(row);
      }
      row.oncontextmenu = e => { e.preventDefault(); treeMenu(e, n); };
      row.ondragstart = e => e.dataTransfer.setData('text/x-inkvault', n.path);
      row.ondragover = e => { if (n.type === 'folder') { e.preventDefault(); row.classList.add('drop'); } };
      row.ondragleave = () => row.classList.remove('drop');
      row.ondrop = e => { e.preventDefault(); row.classList.remove('drop'); move(e.dataTransfer.getData('text/x-inkvault'), n.path); };
    }
    return frag;
  };
  root.appendChild(build(tree, 0));
}
$('#tree').ondragover = e => e.preventDefault();
$('#tree').ondrop = e => { if (e.target === $('#tree')) move(e.dataTransfer.getData('text/x-inkvault'), ''); };

async function move(from, folder) {
  if (!from || from === folder || folder.startsWith(`${from}/`)) return;
  const to = (folder ? `${folder}/` : '') + from.split('/').pop();
  if (to === from) return;
  try {
    if (current) await save();
    const r = await api.send('POST', '/api/rename', { from, to });
    if (current === from) current = r.path;
    else if (current?.startsWith(`${from}/`)) current = r.path + current.slice(from.length);
    await loadTree();
  } catch (e) { toastMsg(e.message); }
}

async function newNote(folder = currentFolder()) {
  const { path } = await api.send('POST', '/api/note', { folder, name: 'Untitled' });
  if (folder) prefs.open[folder] = true;
  await loadTree();
  await openNote(path, { focus: false });
  $('#title').focus();
  $('#title').select();
}

async function newFolder(parent = currentFolder()) {
  const name = prompt('Folder name', 'New folder');
  if (!name) return;
  const { path } = await api.send('POST', '/api/folder', { path: parent ? `${parent}/${name}` : name });
  prefs.open[path] = true;
  if (parent) prefs.open[parent] = true;
  savePrefs();
  loadTree();
}

const currentFolder = () => (current && current.includes('/') ? current.slice(0, current.lastIndexOf('/')) : '');

function treeMenu(e, n) {
  const items = [];
  if (n.type === 'folder') {
    items.push(['New note', () => newNote(n.path)], ['New folder', () => newFolder(n.path)]);
  }
  items.push(['Rename', async () => {
    const old = n.type === 'file' ? n.name : n.path.split('/').pop();
    const name = prompt('Rename to', old);
    if (!name || name === old) return;
    const dir = n.path.includes('/') ? n.path.slice(0, n.path.lastIndexOf('/') + 1) : '';
    try {
      if (current) await save();
      const r = await api.send('POST', '/api/rename', { from: n.path, to: dir + name + (n.type === 'file' ? '.md' : '') });
      if (current === n.path) current = r.path;
      else if (current?.startsWith(`${n.path}/`)) current = r.path + current.slice(n.path.length);
      await loadTree();
      if (current) $('#title').value = current.replace(/\.md$/i, '').split('/').pop();
      if (r.linksUpdated) {
        toastMsg(`Updated links in ${r.linksUpdated} note${r.linksUpdated > 1 ? 's' : ''}`);
        reloadIfChanged();
      }
    } catch (err) { toastMsg(err.message); }
  }]);
  items.push(['Delete', async () => {
    if (!confirm(`Move “${n.name}” to the vault's .trash folder?`)) return;
    await api.send('DELETE', `/api/note?path=${encodeURIComponent(n.path)}`);
    if (current === n.path || current?.startsWith(`${n.path}/`)) { lastSaved = editor.getText(); showEmpty(); }
    await loadTree();
  }, 'danger']);
  showMenu(e.clientX, e.clientY, items);
}

function showMenu(x, y, items) {
  const menu = $('#ctx');
  menu.innerHTML = '';
  for (const [label, fn, cls] of items) {
    const b = document.createElement('button');
    b.textContent = label;
    if (cls) b.className = cls;
    b.onclick = () => { menu.hidden = true; fn(); };
    menu.appendChild(b);
  }
  menu.hidden = false;
  menu.style.left = `${Math.min(x, innerWidth - 180)}px`;
  menu.style.top = `${Math.min(y, innerHeight - menu.offsetHeight - 8)}px`;
}
document.addEventListener('mousedown', e => { if (!e.target.closest('#ctx')) $('#ctx').hidden = true; });

// ---------------------------------------------------------------------------
// Search (sidebar) and quick switcher (Ctrl+O)
// ---------------------------------------------------------------------------

let searchTimer = 0;
$('#search').addEventListener('input', e => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  document.body.classList.toggle('searching', !!q);
  if (!q) return;
  searchTimer = setTimeout(async () => {
    const results = await api.get(`/api/search?q=${encodeURIComponent(q)}`);
    const box = $('#results');
    box.innerHTML = results.length ? '' : '<div class="muted pad">No matches</div>';
    for (const r of results) {
      const div = document.createElement('div');
      div.className = 'result';
      div.innerHTML = `<div class="r-title">${esc(r.path.replace(/\.md$/i, ''))}</div>` +
        r.hits.map(h => `<div class="r-hit">${highlight(h.text, q)}</div>`).join('');
      div.onclick = () => openNote(r.path);
      box.appendChild(div);
    }
  }, 180);
});
const highlight = (text, q) => {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  return i < 0 ? esc(text) : `${esc(text.slice(0, i))}<mark>${esc(text.slice(i, i + q.length))}</mark>${esc(text.slice(i + q.length))}`;
};

function fuzzy(q, s) {
  q = q.toLowerCase();
  s = s.toLowerCase();
  let score = 0, j = 0, run = 0;
  for (let i = 0; i < s.length && j < q.length; i++) {
    if (s[i] === q[j]) { j++; run++; score += run * 2 + (i === 0 || '/ -_'.includes(s[i - 1]) ? 5 : 0); }
    else run = 0;
  }
  return j === q.length ? score - s.length * 0.05 : -1;
}

function openSwitcher() {
  const modal = $('#switcher');
  const input = modal.querySelector('input');
  const list = modal.querySelector('.list');
  let sel = 0;
  let items = [];
  const render = () => {
    const q = input.value.trim();
    items = q
      ? notes.map(p => ({ p, s: fuzzy(q, p.replace(/\.md$/i, '')) })).filter(x => x.s >= 0).sort((a, b) => b.s - a.s).map(x => x.p)
      : notes.slice();
    items = items.slice(0, 50);
    if (q && !resolveLink(q)) items.push({ create: q });
    sel = Math.min(sel, items.length - 1);
    list.innerHTML = '';
    items.forEach((it, i) => {
      const d = document.createElement('div');
      d.className = `item${i === sel ? ' sel' : ''}`;
      d.innerHTML = it.create ? `<span class="muted">Create</span> ${esc(it.create)}` : esc(it.replace(/\.md$/i, ''));
      d.onmousedown = e => { e.preventDefault(); choose(i); };
      list.appendChild(d);
    });
  };
  const close = () => { modal.hidden = true; input.onkeydown = input.oninput = null; };
  const choose = i => {
    const it = items[i];
    close();
    if (!it) return;
    if (it.create) openLink(it.create);
    else openNote(it);
  };
  input.value = '';
  input.oninput = () => { sel = 0; render(); };
  input.onkeydown = e => {
    if (e.key === 'ArrowDown') { sel = Math.min(items.length - 1, sel + 1); render(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); render(); e.preventDefault(); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(sel); }
    else if (e.key === 'Escape') { close(); editor.focus(); }
  };
  modal.onmousedown = e => { if (e.target === modal) close(); };
  modal.hidden = false;
  render();
  input.focus();
}

// ---------------------------------------------------------------------------
// Connect-tablet dialog
// ---------------------------------------------------------------------------

async function openConnect() {
  const modal = $('#connect');
  const info = await api.get('/api/info');
  // If the PC itself is browsing via a LAN name/IP, that address works for the tablet too.
  const local = /^(localhost|127\.|\[::1\])/.test(location.hostname);
  const urls = (info.urls.length ? info.urls : local ? [] : [location.origin]).map(u => `${u}/tablet`);
  const box = modal.querySelector('.urls');
  box.innerHTML = urls.map(u => `<div class="url"><img alt="QR code" src="/api/qr?text=${encodeURIComponent(u)}"><code>${esc(u)}</code></div>`).join('');
  modal.querySelector('.docker').hidden = urls.length > 0;
  modal.querySelector('.install-url').textContent = urls.length ? urls[0].replace(/\/tablet$/, '/install') : '/install';
  modal.hidden = false;
  modal.onmousedown = e => { if (e.target === modal || e.target.closest('.close')) modal.hidden = true; };
}

// ---------------------------------------------------------------------------
// Chrome: buttons, keyboard, theme, sidebar
// ---------------------------------------------------------------------------

let toastTimer = 0;
function toastMsg(text) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
}

$('#btn-new').onclick = () => newNote();
$('#btn-folder').onclick = () => newFolder();
$('#btn-draw').onclick = insertDrawing;
$('#btn-mode').onclick = () => setMode(mode === 'read' ? 'edit' : 'read');
$('#btn-done-drawing').onclick = () => sock.send({ type: 'close' });
$('#btn-switcher').onclick = openSwitcher;
$('#tablet-chip').onclick = openConnect;
$('#btn-sidebar').onclick = () => { prefs.sidebar = !document.body.classList.toggle('no-sidebar'); savePrefs(); };
$('#btn-theme').onclick = () => {
  prefs.theme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = prefs.theme;
  savePrefs();
};
$('#empty-new').onclick = () => newNote();

document.addEventListener('keydown', e => {
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (mod && e.altKey && k === 'd') { e.preventDefault(); insertDrawing(); }
  else if (mod && !e.shiftKey && k === 'o') { e.preventDefault(); openSwitcher(); }
  else if (mod && !e.shiftKey && k === 'e') { e.preventDefault(); setMode(mode === 'read' ? 'edit' : 'read'); }
  else if (mod && e.shiftKey && k === 'f') { e.preventDefault(); $('#search').focus(); $('#search').select(); }
  else if (mod && !e.shiftKey && k === 's') { e.preventDefault(); save(); }
  else if (e.altKey && !mod && k === 'n') { e.preventDefault(); newNote(); }
  else if (e.key === 'Escape' && session.state.active && !document.querySelector('.modal:not([hidden])')) sock.send({ type: 'close' });
});

if (prefs.theme) document.documentElement.dataset.theme = prefs.theme;
const applyPaper = () => {
  setDarkPaper(prefs.darkPaper);
  $('#btn-paper').classList.toggle('on', !!prefs.darkPaper);
  $('#btn-paper').title = prefs.darkPaper ? 'White canvas for drawings' : 'Black canvas for drawings';
};
$('#btn-paper').onclick = () => { prefs.darkPaper = !prefs.darkPaper; savePrefs(); applyPaper(); };
applyPaper();
if (prefs.sidebar === false) document.body.classList.add('no-sidebar');

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

(async () => {
  await loadTree();
  const fromUrl = new URLSearchParams(location.search).get('note');
  const start = [fromUrl, prefs.last].find(p => p && notes.includes(p)) || notes[0];
  if (start) openNote(start, { nav: 'replace' });
  else showEmpty();
})();
