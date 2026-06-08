import React, { useEffect, useMemo, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { EditorView, Decoration } from '@codemirror/view';
import { StateField, RangeSetBuilder } from '@codemirror/state';
import { resolveScopeColor, FOREGROUND } from '@glyph3d/core/parsing';

// EditorPanel — a 2D companion to the focused 3D code grid. Read-only (Phase 1): it
// mirrors whichever CodeGrid holds primary/key focus, rendering the SAME source and the
// SAME tree-sitter highlights — no second parse, no language loaded into CodeMirror. It
// reads grid.getHighlights() (captures carry absolute offsets) and paints them as CM
// decorations with the shared theme, so 2D and 3D coloring are identical by construction.
// One file, two projections: 3D for structure, 2D for the dense line-by-line read.

const rgb = (c) => `rgb(${(c.r * 255) | 0}, ${(c.g * 255) | 0}, ${(c.b * 255) | 0})`;

// Matches the dock panels' dark surface; base text = the 3D FOREGROUND so uncaptured
// glyphs read the same in both views.
const baseTheme = EditorView.theme({
  '&': { backgroundColor: '#0b0e13', color: rgb(FOREGROUND), height: '100%', fontSize: '12px' },
  '.cm-scroller': { fontFamily: 'ui-monospace, "JetBrains Mono", Menlo, monospace', lineHeight: '1.5' },
  '.cm-gutters': { backgroundColor: '#0b0e13', color: '#3a4350', border: 'none' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'transparent' },
  '&.cm-focused': { outline: 'none' },
}, { dark: true });

// A CM decoration StateField built from tree-sitter captures (absolute offsets + scope),
// colored via the shared theme. RangeSetBuilder needs sorted, non-overlapping ranges, so
// overlaps are clamped (first wins) and ends are clamped to the doc length.
function decorationField(captures) {
  // Build against CM's ACTUAL live doc length (state.doc.length), not a snapshot's: CM
  // normalizes line endings, and the value/extensions props can update a tick apart, so a
  // capture offset can momentarily exceed the current doc. Skip out-of-range starts, clamp
  // ends — never hand RangeSetBuilder a position past the doc (that throws and crashes CM).
  // TODO(load+normalize): once CodeGrid normalizes content to \n at the load seam, CM's
  // line-ending normalization can't drift captures vs the doc and this clamp is just belt-and-suspenders.
  const build = (docLength) => {
    if (!captures || !captures.length) return Decoration.none;
    const marks = [];
    for (const c of captures) {
      const color = resolveScopeColor(c.scope);
      if (!color) continue;
      const from = c.startIndex | 0;
      if (from >= docLength) continue;
      const to = Math.min(c.endIndex | 0, docLength);
      if (to > from) marks.push({ from, to, style: `color: ${rgb(color)}` });
    }
    marks.sort((a, b) => a.from - b.from || a.to - b.to);
    const builder = new RangeSetBuilder();
    let last = 0;
    for (const m of marks) {
      const from = Math.max(m.from, last);
      if (from >= m.to) continue; // fully overlapped by a prior mark — skip
      builder.add(from, m.to, Decoration.mark({ attributes: { style: m.style } }));
      last = m.to;
    }
    return builder.finish();
  };
  return StateField.define({
    create: (state) => build(state.doc.length),
    update: (value, tr) => (tr.docChanged ? build(tr.state.doc.length) : value),
    provide: (f) => EditorView.decorations.from(f),
  });
}

export default function EditorPanel({ client }) {
  const [snap, setSnap] = useState({ filename: null, content: '', captures: null });

  useEffect(() => {
    if (!client) return undefined;
    const am = client.ctx?.attentionManager;
    const reg = client.ctx?.registry;
    let gridUnsub = null;

    const apply = (grid) => {
      if (!grid || typeof grid.getContent !== 'function') {
        setSnap({ filename: null, content: '', captures: null });
        return;
      }
      setSnap({
        filename: grid.getFilename?.() ?? null,
        content: grid.getContent() ?? '',
        captures: grid.getHighlights?.()?.captures ?? null,
      });
    };

    const focusedGrid = () => {
      const slot = am?.get?.('primary') || am?.get?.('key');
      const entry = slot?.id ? reg?.get?.(slot.id) : null;
      return entry?.type === 'grid' ? entry.grid : null;
    };

    const onFocus = () => {
      const grid = focusedGrid();
      gridUnsub?.(); gridUnsub = null;
      // refresh reactively when this grid re-parses (the highlights-updated emit)
      if (grid?.onHighlightsChanged) gridUnsub = grid.onHighlightsChanged(() => apply(grid));
      apply(grid);
    };

    const unsubs = [am?.on?.('change:primary', onFocus), am?.on?.('change:key', onFocus)].filter(Boolean);
    reg?.addChangeListener?.(onFocus); // grid added/removed (e.g. file.open) → re-evaluate focus
    onFocus();

    return () => {
      unsubs.forEach((u) => u?.());
      reg?.removeChangeListener?.(onFocus);
      gridUnsub?.();
    };
  }, [client]);

  // No lineWrapping: long lines SCROLL horizontally (the .cm-scroller's native overflow) rather
  // than wrap. Wrapping made the 2D read fight its panel for width and broke the 1:1 line
  // correspondence with the 3D grid (whose lines are the file's true lines). The panel is a
  // viewport onto the grid — it clips and scrolls; it never reshapes what it mirrors.
  const extensions = useMemo(
    () => [baseTheme, EditorView.editable.of(false), decorationField(snap.captures)],
    [snap.captures, snap.content],
  );

  if (!snap.filename) {
    return (
      <div style={{ padding: 12, color: '#5c6675', font: '12px ui-monospace, "JetBrains Mono", monospace' }}>
        No code grid focused — click one in the field.
      </div>
    );
  }

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', background: '#0b0e13' }}>
      <div style={{
        padding: '6px 8px', borderBottom: '1px solid #1b1f29', color: '#7c8596',
        font: '11px ui-monospace, "JetBrains Mono", monospace', flex: '0 0 auto',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>{snap.filename}</div>
      <div style={{ flex: '1 1 auto', minHeight: 0 }}>
        <CodeMirror
          value={snap.content}
          height="100%"
          editable={false}
          theme="none"
          basicSetup={{ lineNumbers: true, foldGutter: false, highlightActiveLine: false, highlightActiveLineGutter: false }}
          extensions={extensions}
        />
      </div>
    </div>
  );
}
