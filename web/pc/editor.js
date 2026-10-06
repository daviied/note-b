// Markdown editor (CodeMirror 6) with Obsidian-style styling, [[wikilinks]],
// and drawing fields rendered inline where `![[ink-<id>.svg]]` appears.
import { EditorState, StateField, RangeSetBuilder } from '@codemirror/state';
import {
  EditorView, Decoration, WidgetType, MatchDecorator, ViewPlugin, keymap,
  drawSelection, dropCursor, highlightActiveLine, placeholder, rectangularSelection,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxHighlighting, HighlightStyle, indentOnInput } from '@codemirror/language';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { autocompletion, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { tags as t } from '@lezer/highlight';
import { createInkEmbed } from './inkEmbed.js';
import { mathExtension, mathCompletion, insertMath } from './math.js';

export const EMBED_RE = /^!\[\[ink-([a-z0-9]+)\.svg\]\]\s*$/;
export const embedLine = id => `![[ink-${id}.svg]]`;

// --- drawing fields ----------------------------------------------------------

class InkWidget extends WidgetType {
  constructor(id) { super(); this.id = id; }
  eq(other) { return other.id === this.id; }
  toDOM(view) {
    return createInkEmbed(this.id, {
      onRemove: el => {
        const pos = view.posAtDOM(el);
        const line = view.state.doc.lineAt(pos);
        const to = line.number < view.state.doc.lines ? line.to + 1 : line.to;
        const from = line.number === view.state.doc.lines && line.number > 1 ? line.from - 1 : line.from;
        view.dispatch({ changes: { from, to } });
      },
    });
  }
  destroy(dom) { dom.destroy?.(); }
  ignoreEvent() { return true; }
  get estimatedHeight() { return 380; }
}

function buildInk(state) {
  const b = new RangeSetBuilder();
  const doc = state.doc;
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    if (line.length < 12 || line.text.charCodeAt(0) !== 33) continue; // '!'
    const m = EMBED_RE.exec(line.text);
    if (m) b.add(line.from, line.to, Decoration.replace({ widget: new InkWidget(m[1]), block: true }));
  }
  return b.finish();
}

const inkField = StateField.define({
  create: buildInk,
  update: (value, tr) => (tr.docChanged ? buildInk(tr.state) : value),
  provide: f => [EditorView.decorations.from(f), EditorView.atomicRanges.of(view => view.state.field(f))],
});

// --- wikilinks -----------------------------------------------------------------

const linkMatcher = new MatchDecorator({
  regexp: /(?<!!)\[\[([^\]\n|#]+)(?:[#|][^\]\n]*)?\]\]/g,
  decoration: m => Decoration.mark({ class: 'cm-wikilink', attributes: { 'data-link': m[1].trim(), title: 'Click to open · Alt+click to edit' } }),
});
const wikilinks = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = linkMatcher.createDeco(view); }
  update(u) { this.decorations = linkMatcher.updateDeco(u, this.decorations); }
}, { decorations: v => v.decorations });

// --- look ---------------------------------------------------------------------

const mdStyle = HighlightStyle.define([
  { tag: t.heading1, fontSize: '1.75em', fontWeight: '700', lineHeight: '1.3' },
  { tag: t.heading2, fontSize: '1.45em', fontWeight: '700', lineHeight: '1.3' },
  { tag: t.heading3, fontSize: '1.25em', fontWeight: '650' },
  { tag: [t.heading4, t.heading5, t.heading6], fontSize: '1.08em', fontWeight: '650' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.link, color: 'var(--accent)' },
  { tag: t.url, color: 'var(--muted)', textDecoration: 'underline' },
  { tag: t.monospace, fontFamily: 'var(--mono)', color: 'var(--code)' },
  { tag: [t.processingInstruction, t.meta, t.contentSeparator], color: 'var(--faint)' },
  { tag: t.quote, color: 'var(--muted)' },
  { tag: t.list, color: 'var(--accent)' },
]);

// --- public API -----------------------------------------------------------------

export function createEditor(parent, { onChange, onOpenLink, getNoteNames }) {
  const linkCompletion = ctx => {
    const m = ctx.matchBefore(/\[\[[^\]\n]*$/);
    if (!m) return null;
    // Replace whatever was typed (and an auto-inserted "]]") and leave the cursor after the link.
    const apply = (view, completion, from, to) => {
      const end = view.state.sliceDoc(to, to + 2) === ']]' ? to + 2 : to;
      const insert = `${completion.label}]]`;
      view.dispatch({ changes: { from, to: end, insert }, selection: { anchor: from + insert.length } });
    };
    return {
      from: m.from + 2,
      options: getNoteNames().map(name => ({ label: name, type: 'text', apply })),
      validFor: /^[^\]\n]*$/,
    };
  };

  const extensions = [
    history(),
    drawSelection(),
    dropCursor(),
    rectangularSelection(),
    indentOnInput(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    closeBrackets(),
    autocompletion({ override: [linkCompletion, mathCompletion], icons: false }),
    mathExtension(),
    markdown({ base: markdownLanguage }),
    syntaxHighlighting(mdStyle),
    EditorView.lineWrapping,
    placeholder('Start typing…'),
    inkField,
    wikilinks,
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, indentWithTab]),
    EditorView.domEventHandlers({
      // Click a [[link]] to open it, like Obsidian. Alt+click (or the arrow keys) edits it instead.
      mousedown(e) {
        const link = e.target.closest?.('.cm-wikilink');
        if (!link || e.button !== 0 || e.altKey || e.shiftKey) return false;
        e.preventDefault();
        onOpenLink(link.dataset.link, { newTab: e.ctrlKey || e.metaKey });
        return true;
      },
    }),
    EditorView.updateListener.of(u => { if (u.docChanged) onChange(u.state.doc.toString()); }),
  ];

  const view = new EditorView({ parent, state: EditorState.create({ doc: '', extensions }) });

  return {
    view,
    setText(text) {
      view.setState(EditorState.create({ doc: text, extensions }));
    },
    getText: () => view.state.doc.toString(),
    focus: () => view.focus(),
    insertMath(display) {
      insertMath(display)(view);
      view.focus();
    },
    // Insert a drawing embed on its own line at the cursor.
    insertDrawing(id) {
      const { state } = view;
      const pos = state.selection.main.head;
      const line = state.doc.lineAt(pos);
      const before = line.text.trim() ? '\n' : '';
      const insertAt = line.text.trim() ? line.to : line.from;
      const after = '\n';
      const text = `${before}${embedLine(id)}${after}`;
      view.dispatch({
        changes: { from: insertAt, to: line.text.trim() ? line.to : line.to, insert: text },
        selection: { anchor: insertAt + text.length },
        scrollIntoView: true,
      });
      view.focus();
    },
  };
}
