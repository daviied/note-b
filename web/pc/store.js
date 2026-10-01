// Client-side state shared by the PC UI: drawings (kept live via the socket),
// which drawing the tablet is editing, and how many tablets are connected.
import { applyChange } from '../../shared/ink.js';

export const api = {
  async get(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    return r.json();
  },
  async send(method, url, body) {
    const r = await fetch(url, {
      method,
      headers: typeof body === 'string' ? { 'Content-Type': 'text/plain' } : { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body ?? {}),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    return r.json();
  },
};

const docs = new Map(); // id -> { drawing, promise, subs: Set, live: Map(sid -> stroke) }

function entry(id) {
  let e = docs.get(id);
  if (!e) {
    e = { drawing: null, subs: new Set(), live: new Map() };
    e.promise = api.get(`/api/drawing/${id}`)
      .then(d => { e.drawing = d; notify(id); })
      .catch(() => { e.missing = true; notify(id); });
    docs.set(id, e);
  }
  return e;
}

function notify(id) {
  const e = docs.get(id);
  if (e) for (const fn of e.subs) fn(e);
}

export const drawings = {
  subscribe(id, fn) {
    const e = entry(id);
    e.subs.add(fn);
    if (e.drawing || e.missing) fn(e);
    return () => e.subs.delete(fn);
  },
  put(drawing) {
    const e = entry(drawing.id);
    e.drawing = drawing;
    notify(drawing.id);
  },
  onChange(id, change) {
    const e = docs.get(id);
    if (!e?.drawing) return;
    applyChange(e.drawing, change);
    for (const s of change.add || []) e.live.delete(s.id);
    notify(id);
  },
  onLive(id, sid, stroke) {
    const e = docs.get(id);
    if (!e) return;
    if (stroke) e.live.set(sid, stroke);
    else e.live.delete(sid);
    notify(id);
  },
};

// Session state: { active: {id, note} | null, tablets, pcs, connected }
export const session = {
  state: { active: null, tablets: 0, pcs: 0, connected: false },
  subs: new Set(),
  set(patch) {
    Object.assign(this.state, patch);
    for (const fn of this.subs) fn(this.state);
  },
  subscribe(fn) {
    this.subs.add(fn);
    fn(this.state);
    return () => this.subs.delete(fn);
  },
};
