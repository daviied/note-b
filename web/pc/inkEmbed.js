// A drawing field as shown on the PC: read-only, updates live while the
// tablet draws, click to send it to the tablet.
import { drawPage, PAGE_WIDTH, DEFAULT_HEIGHT } from '../../shared/ink.js';
import { drawings, session } from './store.js';

let actions = { edit() {}, done() {}, remove: null };
export function setInkActions(a) {
  actions = { ...actions, ...a };
}

export function createInkEmbed(id, { onRemove } = {}) {
  const el = document.createElement('div');
  el.className = 'ink-embed';
  el.dataset.id = id;
  el.innerHTML = `
    <div class="ink-paper"><canvas></canvas><div class="ink-overlay"><span>✎ Edit on tablet</span></div></div>
    <div class="ink-bar">
      <span class="ink-state"></span>
      <span class="grow"></span>
      <button class="ink-btn ink-done" hidden>Done</button>
      <button class="ink-btn ink-remove" title="Remove drawing from note">Remove</button>
    </div>`;
  const paper = el.querySelector('.ink-paper');
  const canvas = el.querySelector('canvas');
  const ctx = canvas.getContext('2d');
  const stateEl = el.querySelector('.ink-state');
  const doneBtn = el.querySelector('.ink-done');
  const removeBtn = el.querySelector('.ink-remove');
  let entry = null;
  let raf = 0;

  function render() {
    raf = 0;
    const w = paper.clientWidth;
    if (!w) return;
    const d = entry?.drawing;
    const height = d ? d.height : DEFAULT_HEIGHT;
    const scale = w / PAGE_WIDTH;
    const h = Math.round(height * scale);
    const dpr = window.devicePixelRatio || 1;
    paper.style.height = `${h}px`;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
    if (d) drawPage(ctx, d, { live: [...entry.live.values()] });
    else {
      ctx.fillStyle = '#f0efe9';
      ctx.fillRect(0, 0, PAGE_WIDTH, height);
    }
    if (entry?.missing) stateEl.textContent = 'Drawing file not found';
  }
  const schedule = () => { if (!raf) raf = requestAnimationFrame(render); };

  const unsubDrawing = drawings.subscribe(id, e => { entry = e; schedule(); });
  const unsubSession = session.subscribe(s => {
    const active = s.active?.id === id;
    el.classList.toggle('active', active);
    doneBtn.hidden = !active;
    stateEl.textContent = active
      ? (s.tablets ? 'Editing on tablet…' : 'Waiting for a tablet to connect…')
      : 'Drawing · click to edit on tablet';
  });
  const ro = new ResizeObserver(schedule);
  ro.observe(paper);

  paper.addEventListener('mousedown', e => e.preventDefault()); // keep editor selection steady
  paper.addEventListener('click', () => actions.edit(id));
  doneBtn.addEventListener('click', () => actions.done(id));
  if (onRemove) removeBtn.addEventListener('click', () => onRemove(el));
  else removeBtn.hidden = true;

  el.destroy = () => {
    unsubDrawing();
    unsubSession();
    ro.disconnect();
    cancelAnimationFrame(raf);
  };
  return el;
}
