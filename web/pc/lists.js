// Bullet and numbered lists, Obsidian-style: markers render as real bullets /
// styled numbers, nested levels indent, wrapped items hang under their text.
// The Markdown stays plain (`- item`, `1. item`); Enter continuing a list and
// Backspace removing a marker come from @codemirror/lang-markdown.
import { RangeSetBuilder } from '@codemirror/state';
import { EditorView, Decoration, ViewPlugin, WidgetType, keymap } from '@codemirror/view';
import { syntaxTree, ensureSyntaxTree, indentUnit } from '@codemirror/language';
import { indentMore, indentLess } from '@codemirror/commands';

const BULLETS = ['•', '◦', '▪'];

class BulletWidget extends WidgetType {
  constructor(depth) { super(); this.depth = depth; }
  eq(o) { return o.depth === this.depth; }
  toDOM() {
    const el = document.createElement('span');
    el.className = 'cm-list-bullet';
    el.textContent = BULLETS[this.depth % BULLETS.length];
    return el;
  }
}

const hide = Decoration.replace({});

function buildDecorations(view) {
  const b = new RangeSetBuilder();
  const { state } = view;
  let lastLine = -1;
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter(node) {
        if (node.name !== 'ListMark') return;
        const item = node.node.parent;
        const list = item?.parent;
        if (!list || (list.name !== 'BulletList' && list.name !== 'OrderedList')) return;
        const line = state.doc.lineAt(node.from);
        // only markers that start the line (not e.g. inside a blockquote)
        if (line.number === lastLine || state.sliceDoc(line.from, node.from).trim()) return;
        lastLine = line.number;
        let depth = -1;
        for (let p = list; p; p = p.parent) if (p.name === 'BulletList' || p.name === 'OrderedList') depth++;
        const markEnd = state.sliceDoc(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to;
        const task = /^\[[ xX]\]/.test(state.sliceDoc(markEnd, markEnd + 3));
        b.add(line.from, line.from, Decoration.line({ class: 'cm-list-line', attributes: { style: `--list-depth: ${depth}` } }));
        if (node.from > line.from) b.add(line.from, node.from, hide); // indentation is shown by the layout instead
        if (list.name === 'OrderedList') b.add(node.from, markEnd, Decoration.mark({ class: 'cm-list-number' }));
        else if (!task) b.add(node.from, markEnd, Decoration.replace({ widget: new BulletWidget(depth) }));
      },
    });
  }
  return b.finish();
}

const listDecorations = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = buildDecorations(view); }
  update(u) {
    if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) this.decorations = buildDecorations(u.view);
  }
}, { decorations: v => v.decorations });

// ---------------------------------------------------------------------------
// Toggle the selected lines into / out of a list (Ctrl+Shift+8 bullets,
// Ctrl+Shift+7 numbers). Numbering continues from a list just above.
// ---------------------------------------------------------------------------

const ITEM = /^(\s*)([-*+]|\d+[.)])(\s+)/;

export function toggleList(kind) {
  return view => {
    const { state } = view;
    const lines = [];
    for (const r of state.selection.ranges) {
      for (let n = state.doc.lineAt(r.from).number; n <= state.doc.lineAt(r.to).number; n++) {
        if (!lines.some(l => l.number === n)) lines.push(state.doc.line(n));
      }
    }
    lines.sort((a, b) => a.number - b.number);
    const targets = lines.length > 1 ? lines.filter(l => l.text.trim()) : lines; // skip blank lines in a multi-line selection
    if (!targets.length) return false;
    const isKind = m => m && (kind === 'bullet' ? /^[-*+]$/.test(m[2]) : /^\d/.test(m[2]));
    const remove = targets.every(l => isKind(ITEM.exec(l.text)));

    let n = 1;
    const prev = targets[0].number > 1 && ITEM.exec(state.doc.line(targets[0].number - 1).text);
    if (kind === 'number' && prev && /^\d/.test(prev[2])) n = parseInt(prev[2], 10) + 1;

    const changes = targets.map(l => {
      const m = ITEM.exec(l.text);
      const indent = m ? m[1] : /^\s*/.exec(l.text)[0];
      const from = l.from + indent.length;
      if (remove) return { from, to: l.from + m[0].length, insert: '' };
      const marker = kind === 'bullet' ? '- ' : `${n++}. `;
      return { from, to: m ? l.from + m[0].length : from, insert: marker };
    });
    view.dispatch(state.update({ changes, scrollIntoView: true, userEvent: 'input.list' }));
    view.focus();
    return true;
  };
}

// ---------------------------------------------------------------------------
// Renumbering: numbered lists count up from their first item; a list nested
// under another item starts at 1. Run after nesting / un-nesting / toggling.
// ---------------------------------------------------------------------------

function renumberChanges(state) {
  const tree = ensureSyntaxTree(state, state.doc.length, 200) || syntaxTree(state);
  const changes = [];
  tree.iterate({
    enter(node) {
      if (node.name !== 'OrderedList') return;
      const nested = node.node.parent?.name === 'ListItem';
      let expected = null;
      for (let item = node.node.firstChild; item; item = item.nextSibling) {
        if (item.name !== 'ListItem') continue;
        const mark = item.firstChild;
        if (!mark || mark.name !== 'ListMark') continue;
        const text = state.sliceDoc(mark.from, mark.to);
        const num = parseInt(text, 10);
        if (expected === null) expected = nested ? 1 : num;
        if (num !== expected) changes.push({ from: mark.from, to: mark.to, insert: `${expected}${text.slice(-1)}` });
        expected++;
      }
    },
  });
  return changes;
}

function withRenumber(command) {
  return view => {
    if (!command(view)) return false;
    const changes = renumberChanges(view.state);
    if (changes.length) view.dispatch({ changes, userEvent: 'input.list' });
    return true;
  };
}

// Tab / Shift+Tab nest and un-nest list items (and indent other lines as before).
const tabKeys = keymap.of([
  { key: 'Tab', run: withRenumber(indentMore), shift: withRenumber(indentLess) },
  { key: 'Mod-Shift-8', run: withRenumber(toggleList('bullet')) },
  { key: 'Mod-Shift-7', run: withRenumber(toggleList('number')) },
]);

export const toggleListRenumbered = kind => withRenumber(toggleList(kind));

export function listExtension() {
  return [
    indentUnit.of('\t'), // a tab nests correctly under both "- " and "1. " in every Markdown reader
    EditorView.theme({ '.cm-content': { tabSize: '4' } }),
    listDecorations,
    tabKeys,
  ];
}
