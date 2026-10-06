// Math: LaTeX between $...$ (inline) or $$...$$ (block), rendered with KaTeX,
// in the editor (Obsidian-style live preview) and in reading view.
import katex from 'katex';
import { StateField, StateEffect } from '@codemirror/state';
import { EditorView, Decoration, WidgetType, keymap } from '@codemirror/view';
import { snippetCompletion } from '@codemirror/autocomplete';

// ---------------------------------------------------------------------------
// Finding math in Markdown text (skips code blocks and `code spans`)
// ---------------------------------------------------------------------------

// Returns [{ from, to, tex, display }] in document order.
export function findMath(text) {
  const out = [];
  const n = text.length;
  let i = 0;
  let lineStart = true;
  let fence = null; // the ``` or ~~~ that opened the current code block
  while (i < n) {
    if (lineStart) {
      const m = /^ {0,3}(`{3,}|~{3,})/.exec(text.slice(i, i + 40));
      const eol = text.indexOf('\n', i);
      const end = eol < 0 ? n : eol;
      if (fence) {
        if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
        i = end + 1;
        continue;
      }
      if (m) {
        fence = m[1];
        i = end + 1;
        continue;
      }
      lineStart = false;
    }
    const c = text[i];
    if (c === '\n') { lineStart = true; i++; continue; }
    if (c === '\\') { i += 2; continue; } // \$ is a literal dollar
    if (c === '`') {
      let k = i;
      while (text[k] === '`') k++;
      const ticks = text.slice(i, k);
      const close = text.indexOf(ticks, k);
      i = close < 0 ? k : close + ticks.length;
      continue;
    }
    if (c !== '$') { i++; continue; }
    if (text[i + 1] === '$') {
      const close = text.indexOf('$$', i + 2);
      if (close < 0) { i += 2; continue; }
      const tex = text.slice(i + 2, close);
      if (tex.trim()) out.push({ from: i, to: close + 2, tex, display: true });
      i = close + 2;
      continue;
    }
    // inline: $x$ — no space just inside the dollars, stays on one line, not "$5 and $6"
    const eol = text.indexOf('\n', i);
    const lineEnd = eol < 0 ? n : eol;
    let j = i + 1;
    let found = -1;
    if (text[j] && !/\s/.test(text[j])) {
      while (j < lineEnd) {
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === '$') {
          if (!/\s/.test(text[j - 1]) && !/\d/.test(text[j + 1] || '')) found = j;
          break;
        }
        j++;
      }
    }
    if (found > i + 1) {
      out.push({ from: i, to: found + 1, tex: text.slice(i + 1, found), display: false });
      i = found + 1;
    } else {
      i++;
    }
  }
  return out;
}

// MathLive (the Desmos-style editor) writes a few of its own macros; teach KaTeX them too.
const MACROS = {
  '\\mleft': '\\left',
  '\\mright': '\\right',
  '\\differentialD': '\\mathrm{d}',
  '\\exponentialE': '\\mathrm{e}',
  '\\imaginaryI': '\\mathrm{i}',
  '\\placeholder': '\\square',
};

export function renderMath(tex, display) {
  return katex.renderToString(tex, { displayMode: display, throwOnError: false, output: 'htmlAndMathml', strict: false, trust: false, macros: { ...MACROS } });
}

// Plain, portable LaTeX (so notes also render in Obsidian etc.)
const portable = tex => tex.replace(/\\(mleft|mright|differentialD|exponentialE|imaginaryI)(?![a-zA-Z])/g, (_, m) => MACROS[`\\${m}`]).trim();

// ---------------------------------------------------------------------------
// Editor. Math is shown rendered. Click it (or press Ctrl+M next to it) to
// edit it in a Desmos-style math box: x^2 becomes a superscript, / makes a
// fraction, sqrt/pi/theta turn into symbols. Alt+click edits the raw LaTeX.
// ---------------------------------------------------------------------------

const openMath = StateEffect.define(); // { from, to, display, tex }
const closeMath = StateEffect.define();
let editId = 0;

// The range currently being edited in a math box (null when none).
const mathEditing = StateField.define({
  create: () => null,
  update(v, tr) {
    for (const e of tr.effects) {
      if (e.is(openMath)) return { ...e.value, id: ++editId };
      if (e.is(closeMath)) return null;
    }
    if (v && tr.docChanged) return { ...v, from: tr.changes.mapPos(v.from, -1), to: tr.changes.mapPos(v.to, 1) };
    return v;
  },
});

let mathlive = null;
function loadMathLive() {
  mathlive ||= import('mathlive').then(ML => {
    ML.MathfieldElement.fontsDirectory = '/mathlive/fonts';
    ML.MathfieldElement.soundsDirectory = null; // no key click sounds
    return ML;
  });
  return mathlive;
}

class MathFieldWidget extends WidgetType {
  constructor(edit) {
    super();
    this.edit = edit;
  }
  eq(o) { return o.edit.id === this.edit.id; }
  toDOM(view) {
    const { display, tex, id } = this.edit;
    const wrap = document.createElement('span');
    wrap.className = `cm-mathfield${display ? ' cm-mathfield-block' : ''}`;
    let done = false;
    const commit = (mf, where = 'after') => {
      if (done) return;
      done = true;
      const cur = view.state.field(mathEditing);
      if (!cur || cur.id !== id) return;
      const latex = portable(mf.getValue('latex-without-placeholders'));
      const { from, to } = cur;
      let insert = '';
      if (latex) {
        if (!display) insert = `$${latex}$`;
        else {
          // a display block gets its own lines
          const doc = view.state.doc;
          const pre = from > doc.lineAt(from).from ? '\n' : '';
          const post = to < doc.lineAt(to).to ? '\n' : '';
          insert = `${pre}$$\n${latex}\n$$${post}`;
        }
      }
      view.dispatch({
        changes: { from, to, insert },
        selection: { anchor: where === 'before' ? from : from + insert.length },
        effects: closeMath.of(null),
        userEvent: 'input.math',
      });
      view.focus();
    };
    loadMathLive().then(ML => {
      if (done) return;
      const mf = new ML.MathfieldElement();
      // attributes can be set before the box is on the page; most properties can't
      mf.setAttribute('math-virtual-keyboard-policy', 'manual');
      mf.setAttribute('smart-fence', 'on');
      mf.value = tex;
      mf.addEventListener('change', () => commit(mf)); // Enter, or leaving the box
      // clicking elsewhere: commit after the editor has finished handling that click
      mf.addEventListener('focusout', () => setTimeout(() => commit(mf)));
      // Like Desmos: arrow keys at the edge stay in the box; Enter / Tab / Esc / clicking away finish.
      mf.addEventListener('move-out', e => e.preventDefault());
      mf.addEventListener('keydown', e => {
        // handled here (not left to MathLive) so the key doesn't also reach the note, e.g. Enter adding a line
        if (e.key === 'Escape' || e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
          e.preventDefault();
          e.stopPropagation();
          commit(mf, e.key === 'Tab' && e.shiftKey ? 'before' : 'after');
        }
      }, true);
      wrap.appendChild(mf);
      const start = () => {
        if (done) return;
        if (!mf.isConnected) return requestAnimationFrame(start); // wait until it's on the page
        try { mf.menuItems = []; } catch {}
        mf.focus();
        mf.executeCommand('moveToMathfieldEnd');
      };
      requestAnimationFrame(start);
    });
    return wrap;
  }
  ignoreEvent() { return true; }
}

class MathWidget extends WidgetType {
  constructor(tex, display, block, preview) {
    super();
    this.tex = tex;
    this.display = display;
    this.block = block;
    this.preview = preview;
  }
  eq(o) {
    return o.tex === this.tex && o.display === this.display && o.block === this.block && o.preview === this.preview;
  }
  toDOM(view) {
    const el = document.createElement(this.block ? 'div' : 'span');
    el.className = `cm-math${this.block ? ' cm-math-block' : ''}${this.preview ? ' cm-math-preview' : ''}`;
    el.innerHTML = renderMath(this.tex, this.display);
    if (!this.preview) {
      el.title = 'Click to edit · Alt+click for LaTeX';
      el.addEventListener('mousedown', e => {
        e.preventDefault();
        const from = view.posAtDOM(el);
        const m = view.state.field(mathRanges).find(r => r.from === from);
        if (!m) return;
        if (e.altKey) view.dispatch({ selection: { anchor: m.from + (m.display ? 2 : 1) } }); // raw LaTeX
        else view.dispatch({ effects: openMath.of({ from: m.from, to: m.to, display: m.display, tex: m.tex.trim() }) });
        view.focus();
      });
    }
    return el;
  }
  ignoreEvent() { return true; }
  get estimatedHeight() { return this.block ? 60 : -1; }
}

const mathRanges = StateField.define({
  create: s => findMath(s.doc.toString()),
  update: (v, tr) => (tr.docChanged ? findMath(tr.state.doc.toString()) : v),
});

function buildDecorations(state) {
  const decos = [];
  const sel = state.selection.ranges;
  const doc = state.doc;
  const edit = state.field(mathEditing);
  for (const m of state.field(mathRanges)) {
    if (edit && edit.from === m.from && edit.to === m.to) continue; // shown as a math box below
    // raw LaTeX only when the cursor is inside it (Alt+click, or typed by hand)
    const raw = sel.some(r => (r.empty ? r.from > m.from && r.from < m.to : r.from < m.to && r.to > m.from));
    const startLine = doc.lineAt(m.from);
    const endLine = doc.lineAt(m.to);
    // $$ on its own lines -> a centred block; otherwise it sits in the text line
    const block = m.display && m.from === startLine.from && m.to === endLine.to;
    if (raw) {
      decos.push(Decoration.mark({ class: 'cm-math-src' }).range(m.from, m.to));
      decos.push(Decoration.widget({ widget: new MathWidget(m.tex, m.display, block, true), side: 1, block }).range(block ? endLine.to : m.to));
    } else {
      decos.push(Decoration.replace({ widget: new MathWidget(m.tex, m.display, block, false), block }).range(m.from, m.to));
    }
  }
  if (edit) {
    const widget = new MathFieldWidget(edit);
    decos.push(edit.to > edit.from ? Decoration.replace({ widget }).range(edit.from, edit.to) : Decoration.widget({ widget, side: 1 }).range(edit.from));
  }
  return Decoration.set(decos, true);
}

const mathDecorations = StateField.define({
  create: buildDecorations,
  update: (v, tr) => (tr.docChanged || tr.selection || tr.effects.length ? buildDecorations(tr.state) : v),
  provide: f => EditorView.decorations.from(f),
});

// Ctrl+M: edit the math next to the cursor, or start new inline math (from the selection, if any).
// Ctrl+Shift+M: start a new math block.
function insertMath(display) {
  return view => {
    const { state } = view;
    if (state.field(mathEditing)) return true;
    const r = state.selection.main;
    const near = r.empty && state.field(mathRanges).find(m => r.from >= m.from && r.from <= m.to);
    if (near && !display) {
      view.dispatch({ effects: openMath.of({ from: near.from, to: near.to, display: near.display, tex: near.tex.trim() }) });
      return true;
    }
    view.dispatch({ effects: openMath.of({ from: r.from, to: r.to, display, tex: state.sliceDoc(r.from, r.to) }) });
    return true;
  };
}

// ---------------------------------------------------------------------------
// Autocomplete for LaTeX commands, only inside math
// ---------------------------------------------------------------------------

const S = (tpl, label, detail) => snippetCompletion(tpl, { label, detail, type: 'function' });
const W = (word, detail) => ({ label: `\\${word}`, apply: `\\${word}`, detail, type: 'keyword' });
const GREEK = 'alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu xi pi rho sigma tau upsilon phi varphi chi psi omega Gamma Delta Theta Lambda Xi Pi Sigma Phi Psi Omega'.split(' ');
const LATEX = [
  S('\\frac{${num}}{${den}}', '\\frac', 'fraction'),
  S('\\dfrac{${num}}{${den}}', '\\dfrac', 'large fraction'),
  S('\\sqrt{${x}}', '\\sqrt', 'square root'),
  S('\\sqrt[${n}]{${x}}', '\\sqrt[n]', 'n-th root'),
  S('\\sum_{${i=1}}^{${n}}', '\\sum', 'sum'),
  S('\\prod_{${i=1}}^{${n}}', '\\prod', 'product'),
  S('\\int_{${a}}^{${b}} ${f(x)} \\, dx', '\\int', 'integral'),
  S('\\iint_{${D}}', '\\iint', 'double integral'),
  S('\\oint_{${C}}', '\\oint', 'contour integral'),
  S('\\lim_{${x} \\to ${a}}', '\\lim', 'limit'),
  S('\\frac{d${y}}{d${x}}', '\\dv', 'derivative'),
  S('\\frac{\\partial ${f}}{\\partial ${x}}', '\\pdv', 'partial derivative'),
  S('\\vec{${v}}', '\\vec', 'vector arrow'),
  S('\\hat{${x}}', '\\hat', 'hat'),
  S('\\bar{${x}}', '\\bar', 'bar'),
  S('\\overline{${x}}', '\\overline', 'overline'),
  S('\\dot{${x}}', '\\dot', 'dot'),
  S('\\text{${text}}', '\\text', 'normal text'),
  S('\\mathbb{${R}}', '\\mathbb', 'ℝ ℕ ℤ …'),
  S('\\mathrm{${x}}', '\\mathrm', 'upright'),
  S('\\mathbf{${x}}', '\\mathbf', 'bold'),
  S('\\left( ${x} \\right)', '\\left(', 'auto-size ( )'),
  S('\\left[ ${x} \\right]', '\\left[', 'auto-size [ ]'),
  S('\\left| ${x} \\right|', '\\left|', 'auto-size | |'),
  S('\\binom{${n}}{${k}}', '\\binom', 'binomial'),
  S('\\begin{pmatrix}\n${a} & ${b} \\\\\n${c} & ${d}\n\\end{pmatrix}', '\\pmatrix', 'matrix ( )'),
  S('\\begin{bmatrix}\n${a} & ${b} \\\\\n${c} & ${d}\n\\end{bmatrix}', '\\bmatrix', 'matrix [ ]'),
  S('\\begin{cases}\n${a} & \\text{if } ${x} \\\\\n${b} & \\text{otherwise}\n\\end{cases}', '\\cases', 'piecewise'),
  S('\\begin{aligned}\n${a} &= ${b} \\\\\n&= ${c}\n\\end{aligned}', '\\aligned', 'aligned equations'),
  ...GREEK.map(g => W(g, 'greek')),
  ...['infty', 'partial', 'nabla', 'cdot', 'times', 'div', 'pm', 'mp', 'leq', 'geq', 'neq', 'approx', 'equiv', 'sim', 'propto',
    'to', 'rightarrow', 'leftarrow', 'Rightarrow', 'Leftrightarrow', 'mapsto', 'in', 'notin', 'subset', 'subseteq', 'cup', 'cap',
    'emptyset', 'forall', 'exists', 'neg', 'land', 'lor', 'angle', 'degree', 'circ', 'ldots', 'cdots', 'quad',
    'sin', 'cos', 'tan', 'arcsin', 'arccos', 'arctan', 'log', 'ln', 'exp', 'det', 'max', 'min'].map(w => W(w)),
];

function mathCompletion(ctx) {
  const inside = ctx.state.field(mathRanges).some(m => ctx.pos > m.from && ctx.pos < m.to);
  if (!inside) return null;
  const word = ctx.matchBefore(/\\[a-zA-Z]*/);
  if (!word) return null;
  return { from: word.from, options: LATEX, validFor: /^\\[a-zA-Z]*$/ };
}

export function mathExtension() {
  return [
    mathRanges,
    mathEditing,
    mathDecorations,
    keymap.of([
      { key: 'Mod-m', run: insertMath(false) },
      { key: 'Mod-Shift-m', run: insertMath(true) },
    ]),
  ];
}
export { mathCompletion, insertMath };

// ---------------------------------------------------------------------------
// Reading view: swap math out before Markdown parsing (so _ and \ survive),
// then back in as rendered HTML.
// ---------------------------------------------------------------------------

export function protectMath(text) {
  const found = findMath(text);
  const html = [];
  let out = '';
  let last = 0;
  for (const m of found) {
    html.push(renderMath(m.tex, m.display));
    out += text.slice(last, m.from) + `MATHTOKEN${html.length - 1}END`;
    last = m.to;
  }
  out += text.slice(last);
  return { text: out, restore: rendered => rendered.replace(/MATHTOKEN(\d+)END/g, (_, i) => html[i]) };
}
