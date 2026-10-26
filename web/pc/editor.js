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
import { listExtension, toggleListRenumbered } from './lists.js';
import { imageField } from './imageEmbed.js';

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
]);

// --- public API -----------------------------------------------------------------

export function createEditor(parent, { onChange, onOpenLink, getNoteNames, onImageFiles = () => {} }) {
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
    listExtension(),
    markdown({ base: markdownLanguage }),
    syntaxHighlighting(mdStyle),
    EditorView.lineWrapping,
    placeholder('Start typing…'),
    inkField,
    imageField,
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
      // Paste or drop image files straight into the note.
      paste(e) {
        const files = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith('image/'));
        if (!files.length) return false;
        e.preventDefault();
        onImageFiles(files);
        return true;
      },
      drop(e, view) {
        const files = [...(e.dataTransfer?.files || [])].filter(f => f.type.startsWith('image/'));
        if (!files.length) return false;
        e.preventDefault();
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos != null) view.dispatch({ selection: { anchor: pos } });
        onImageFiles(files);
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
    toggleList(kind) {
      toggleListRenumbered(kind)(view);
    },
    // Insert a drawing embed on its own line at the cursor.
    insertDrawing(id) {
      this.insertLine(embedLine(id));
    },
    // Insert a line of its own (embed) after the cursor's line, or in place of an empty line.
    insertLine(content) {
      const { state } = view;
      const line = state.doc.lineAt(state.selection.main.head);
      const filled = !!line.text.trim();
      const last = line.number === state.doc.lines;
      // goes below a line with text, or replaces an empty line; a line break after it only if none follows
      const text = `${filled ? '\n' : ''}${content}${last ? '\n' : ''}`;
      const from = filled ? line.to : line.from;
      view.dispatch({ changes: { from, to: line.to, insert: text }, selection: { anchor: from + text.length + (last ? 0 : 1) }, scrollIntoView: true });
      view.focus();
    },
    // Remove the line that is exactly `content` (e.g. a cancelled picture placeholder).
    removeLine(content) {
      const doc = view.state.doc;
      for (let i = 1; i <= doc.lines; i++) {
        const line = doc.line(i);
        if (line.text.trim() !== content) continue;
        const from = i === doc.lines && i > 1 ? line.from - 1 : line.from;
        const to = i < doc.lines ? line.to + 1 : line.to;
        view.dispatch({ changes: { from, to } });
        return true;
      }
      return false;
    },
  };
}
