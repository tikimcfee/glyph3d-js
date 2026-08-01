import React, { useCallback, useEffect, useState } from 'react';

/**
 * LspResultsPanel — the 2D view on the LspNavigator controller.
 *
 * Subscribes to client.ctx.lspNavigator and renders the definition + references
 * for the symbol at the caret: a grouped, scrollable list where each row is
 * `file:line` over its source-line preview, clickable to jump (lsp.goto). It's
 * LIVE — it tracks the caret, so you open it once and it follows as you click
 * around. House style mirrors AgentsPanel (a `client` prop, subscription
 * state, command-bus side effects only).
 */

const S = {
  content: {
    width: '100%', height: '100%', boxSizing: 'border-box',
    background: 'rgba(8,10,14,0.94)', display: 'flex', flexDirection: 'column',
    overflow: 'hidden', font: '12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace',
    color: '#c8ccd6',
  },
  header: {
    flex: '0 0 auto', display: 'flex', alignItems: 'baseline', gap: 8,
    padding: '7px 9px', borderBottom: '1px solid #1b212c', whiteSpace: 'nowrap',
  },
  brand: { color: '#6fe0c8', fontWeight: 600, letterSpacing: '0.06em' },
  origin: { flex: '1 1 auto', color: '#8893a3', overflow: 'hidden', textOverflow: 'ellipsis' },
  dim: { color: '#5a6573' },
  list: { flex: '1 1 auto', overflowY: 'auto', padding: '2px 0 8px' },
  msg: { padding: '12px 10px', color: '#6a7585' },
  section: {
    padding: '7px 9px 3px', color: '#7c8596', fontSize: 10.5, letterSpacing: '0.05em',
    textTransform: 'uppercase', position: 'sticky', top: 0,
    background: 'rgba(8,10,14,0.96)',
  },
  row: {
    display: 'flex', flexDirection: 'column', gap: 1, padding: '5px 10px',
    borderLeft: '2px solid transparent', cursor: 'pointer', userSelect: 'none',
  },
  loc: { color: '#dfe3ea', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  preview: { color: '#7e8896', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
};

const baseName = (uri) => String(uri || '').split('/').pop() || uri;

function readState(client) {
  const nav = client?.ctx?.lspNavigator;
  return nav?.state?.() ?? { status: 'idle', origin: null, def: null, refs: [], refsTotal: 0 };
}

function Row({ item, accent, onJump }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      style={{
        ...S.row,
        borderLeftColor: hover ? accent : 'transparent',
        background: hover ? 'rgba(111,224,200,0.07)' : 'transparent',
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={() => onJump(item)}
      title={item.uri}
    >
      <div style={S.loc}>{item.label}</div>
      {item.preview && <div style={S.preview}>{item.preview}</div>}
    </div>
  );
}

export default function LspResultsPanel({ client }) {
  const [st, setSt] = useState(() => readState(client));

  useEffect(() => {
    const nav = client?.ctx?.lspNavigator;
    const refresh = () => setSt(readState(client));
    refresh();
    return nav?.on?.(refresh);
  }, [client]);

  const jump = useCallback((loc) => {
    if (!loc) return;
    client?.router?.execute?.(
      ['lsp.goto', loc.uri, String(loc.sL), String(loc.sC), String(loc.eL), String(loc.eC)]);
  }, [client]);

  const origin = st.origin ? `${baseName(st.origin.uri)}:${st.origin.line + 1}:${st.origin.col + 1}` : null;
  const empty = st.status === 'ready' && !st.def && st.refs.length === 0;

  return (
    <div style={S.content}>
      <div style={S.header}>
        <span style={S.brand}>⌖ LSP</span>
        <span style={S.origin}>{origin || <span style={S.dim}>no symbol</span>}</span>
        {st.status === 'loading' && <span style={S.dim}>…</span>}
      </div>
      <div style={S.list}>
        {st.status === 'idle' && (
          <div style={S.msg}>Click a symbol in a code grid to see its definition &amp; references.</div>
        )}
        {st.status === 'loading' && <div style={S.msg}>Looking up…</div>}
        {empty && <div style={S.msg}>No definition or references for this symbol.</div>}

        {st.status === 'ready' && st.def && (
          <>
            <div style={S.section}>definition</div>
            <Row item={st.def} accent="#6fe0c8" onJump={jump} />
          </>
        )}
        {st.status === 'ready' && st.refs.length > 0 && (
          <>
            <div style={S.section}>references · {st.refsTotal}</div>
            {st.refs.map((r, i) => <Row key={i} item={r} accent="#c8a9ff" onJump={jump} />)}
          </>
        )}
      </div>
    </div>
  );
}
