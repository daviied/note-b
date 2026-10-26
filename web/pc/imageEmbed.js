// Pictures in notes: `![[photo.jpg]]` (Obsidian syntax, optional `|width`) on
// its own line is shown as the image. While a photo is on its way from the
// phone the image doesn't exist yet, so a "waiting for phone" card is shown.
import { StateField, RangeSetBuilder } from '@codemirror/state';
import { EditorView, Decoration, WidgetType } from '@codemirror/view';

export const IMAGE_EMBED_RE = /^!\[\[([\w.-]+\.(?:png|jpe?g|gif|webp))(?:\|(\d+))?\]\]\s*$/i;
export const IMAGE_INLINE_RE = /!\[\[([\w.-]+\.(?:png|jpe?g|gif|webp))(?:\|(\d+))?\]\]/gi;
export const imageUrl = name => `/api/file/${encodeURIComponent(name)}`;
export const photoReqId = name => /^photo-([a-z0-9]+)\.jpg$/.exec(name)?.[1] || null;

const waiting = new Set(); // image names the PC is waiting for (photo requested, not arrived)
const listeners = new Map(); // name -> Set(reload callbacks)

let actions = { cancel() {} };
export function setImageActions(a) { actions = { ...actions, ...a }; }
export function setWaiting(name, on) { on ? waiting.add(name) : waiting.delete(name); imageChanged(name); }
export function imageChanged(name) { for (const fn of listeners.get(name) || []) fn(); }

export function createImageEmbed(name, width, { onRemove } = {}) {
  const el = document.createElement('div');
  el.className = 'img-embed';
  el.innerHTML = `
    <img alt="" draggable="false">
    <div class="img-wait"><span class="img-spin"></span><span class="img-msg"></span><button class="img-cancel">Cancel</button></div>
    <button class="img-remove" title="Remove picture from note">Remove</button>`;
  const img = el.querySelector('img');
  const wait = el.querySelector('.img-wait');
  const msg = el.querySelector('.img-msg');
  if (width) img.style.width = `${width}px`;

  const load = () => {
    if (waiting.has(name)) {
      el.classList.add('waiting');
      msg.textContent = 'Waiting for phone… take or choose a photo there';
      return;
    }
    img.src = `${imageUrl(name)}?v=${Date.now()}`; // re-fetch when it changes
  };
  img.onload = () => el.classList.remove('waiting', 'missing');
  img.onerror = () => {
    el.classList.add('missing');
    msg.textContent = `Picture not found: ${name}`;
  };
  el.querySelector('.img-cancel').onclick = () => actions.cancel(name);
  const remove = el.querySelector('.img-remove');
  if (onRemove) remove.onclick = () => onRemove(el);
  else remove.hidden = true;

  if (!listeners.has(name)) listeners.set(name, new Set());
  listeners.get(name).add(load);
  el.destroy = () => listeners.get(name)?.delete(load);
  el.classList.toggle('waiting', waiting.has(name));
  load();
  return el;
}

class ImageWidget extends WidgetType {
  constructor(name, width) { super(); this.name = name; this.width = width; }
  eq(o) { return o.name === this.name && o.width === this.width; }
  toDOM(view) {
    return createImageEmbed(this.name, this.width, {
      onRemove: el => {
        const line = view.state.doc.lineAt(view.posAtDOM(el));
        const doc = view.state.doc;
        const from = line.number === doc.lines && line.number > 1 ? line.from - 1 : line.from;
        const to = line.number < doc.lines ? line.to + 1 : line.to;
        view.dispatch({ changes: { from, to } });
      },
    });
  }
  destroy(dom) { dom.destroy?.(); }
  ignoreEvent() { return true; }
  get estimatedHeight() { return 300; }
}

function build(state) {
  const b = new RangeSetBuilder();
  for (let i = 1; i <= state.doc.lines; i++) {
    const line = state.doc.line(i);
    if (line.text.charCodeAt(0) !== 33) continue; // '!'
    const m = IMAGE_EMBED_RE.exec(line.text);
    if (m) b.add(line.from, line.to, Decoration.replace({ widget: new ImageWidget(m[1], m[2] ? Number(m[2]) : 0), block: true }));
  }
  return b.finish();
}

export const imageField = StateField.define({
  create: build,
  update: (v, tr) => (tr.docChanged ? build(tr.state) : v),
  provide: f => [EditorView.decorations.from(f), EditorView.atomicRanges.of(view => view.state.field(f))],
});
