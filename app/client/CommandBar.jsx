import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { createLogger } from '@glyph3d/core/utils/Logger.js';
import { rank } from './palette/rank.js';
import { verbEntries, nounEntries } from './palette/providers.js';

// One INFO line per palette action — what was picked and the verb line it ran.
// Pairs with the bus dispatch trace (console.debug) and the attention timeline
// (`log.level DEBUG attention`); all three land in the capture ring → log.tail.
const plog = createLogger('palette');

/**
 * CommandBar — the command palette: one summoned modal that is the ingress for
 * everything. DOM chrome (fed `client` via CommandProvider.onReady). Pure binding:
 * it owns NO behavior — every action is router.execute(<verb line>), the same path
 * the CLI drives. Opened with ⌘K / Ctrl-K; Esc or a backdrop click dismisses; it
 * stays open across commands (a session tool, not a one-shot).
 *
 * Two modes, derived from the input alone (no toggle):
 *
 *   SEARCH (default)  — the line is a query over a unified index of nouns AND
 *     verbs (files, open sheets, layout schemes, command names), fzf-ranked.
 *     ↑/↓ move the selection; Tab inserts the selection into the line; Enter
 *     executes the selected noun's command line (shown under every row — the
 *     subtitle IS the verb line, so the palette teaches the bus vocabulary as
 *     you use it). Enter on a verb inserts `verb ` for arg entry — except an
 *     exactly-typed verb, which runs (the REPL contract: a fully-typed line
 *     always executes). Empty input lists recent history instead.
 *
 *   COMMAND — the line starts with a known verb + a space: it's a raw command
 *     line, exactly the classic REPL. Enter runs it verbatim; ↑/↓ walk history;
 *     a hint row shows the verb's usage.
 *
 * Keystrokes are kept out of the camera/edit paths: the camera and the keyboard
 * responder chain (keyboardRouter.js) both yield when a real <input> is focused, and
 * we stopPropagation defensively.
 *
 * `onHighlight(entry|null)` fires as the selection moves — a no-op socket today;
 * glance-preview (camera peeks at the highlighted candidate) plugs in there.
 */

const HISTORY_KEY = 'glyph3d.cmdHistory';
const MAX_HISTORY = 100;
const HISTORY_ROWS = 8;

const KIND_BADGE = {
  file: ['file', '#7fb3d5'],
  sheet: ['open', '#9fe7c8'],
  scheme: ['scheme', '#c9a0e8'],
  verb: ['verb', '#6cf'],
  history: ['hist', '#5b6675'],
};

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; }
}
function saveHistory(h) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(h.slice(-MAX_HISTORY))); } catch { /* quota / private mode */ }
}

/** entry.key with the fzf-matched characters highlighted. */
function HighlightedKey({ text, positions }) {
  if (!positions?.size) return <>{text}</>;
  return (
    <>
      {[...text].map((ch, i) => (positions.has(i)
        ? <span key={i} style={S.hl}>{ch}</span>
        : <React.Fragment key={i}>{ch}</React.Fragment>))}
    </>
  );
}

export default function CommandBar({ client, open, onClose, onHighlight }) {
  const [value, setValue] = useState('');
  const [result, setResult] = useState(null);   // { ok: boolean, text: string }
  const [history, setHistory] = useState(loadHistory);
  const [histIdx, setHistIdx] = useState(-1);    // command-mode history walk; -1 = live
  const [verbs, setVerbs] = useState([]);        // palette entries, kind 'verb'
  const [nouns, setNouns] = useState([]);        // palette entries, kinds file/sheet/scheme
  const [sel, setSel] = useState(-1);            // selected row; -1 = none
  const [running, setRunning] = useState(false);
  const inputRef = useRef(null);

  // Refresh both halves of the index each time the palette opens: verbs are a sync
  // registry read; nouns may be an RPC away (file roster), so they stream in.
  useEffect(() => {
    if (!open || !client) return;
    setVerbs(verbEntries(client));
    let stale = false;
    nounEntries(client).then((n) => { if (!stale) setNouns(n); });
    inputRef.current?.focus();
    return () => { stale = true; };
  }, [open, client]);

  const verbNames = useMemo(() => new Set(verbs.map((v) => v.key)), [verbs]);
  // ONE array identity per index refresh — rank() builds its fzf corpus per identity.
  const allEntries = useMemo(() => [...verbs, ...nouns], [verbs, nouns]);

  // Mode is derived from the line alone: a known verb followed by a space is a
  // raw command line; everything else is a search query.
  const firstTok = (value.split(/\s+/)[0] || '').toLowerCase();
  const isCommandMode = /\s/.test(value) && verbNames.has(firstTok);
  const query = isCommandMode ? '' : value.trim();

  // The visible rows. Searching → ranked matches; empty input → recent history
  // (most recent first), so the bar opens onto your own vocabulary.
  const rows = useMemo(() => {
    if (isCommandMode) return [];
    if (query) return rank(query, allEntries);
    return history.slice(-HISTORY_ROWS).reverse()
      .map((line) => ({ entry: { kind: 'history', key: line, command: null, insert: line, detail: '' }, positions: null }));
  }, [isCommandMode, query, allEntries, history]);

  // Selection follows the list: top match auto-selected while searching, nothing
  // selected on the history list (so a stray Enter can't re-fire the last command).
  useEffect(() => { setSel(query ? 0 : -1); }, [query, rows.length]);

  // The glance-preview socket: report the highlighted entry (or null). No-op today.
  useEffect(() => { onHighlight?.(sel >= 0 ? rows[sel]?.entry ?? null : null); }, [sel, rows, onHighlight]);

  const commandUsage = isCommandMode ? verbs.find((v) => v.key === firstTok) : null;

  const run = useCallback(async (cmd) => {
    // cmd: string (typed line) or token array (a noun's command — array form keeps
    // paths with spaces intact through the router's tokenizer).
    const tokens = Array.isArray(cmd) ? cmd : null;
    const text = tokens ? tokens.join(' ') : String(cmd).trim();
    if (!text || !client?.router) return;
    setRunning(true);
    let res;
    try { res = await client.router.execute(tokens ?? text); }
    catch (e) { res = { text: `ERR: ${e?.message || e}` }; }
    setRunning(false);
    const t = res?.text ?? '(no output)';
    setResult({ ok: !/^ERR/i.test(t), text: t });
    // Noun executions enter history as their verb line — re-running from history
    // re-teaches the same incantation the subtitle showed.
    setHistory((h) => { const nh = [...h.filter((x) => x !== text), text]; saveHistory(nh); return nh; });
    setHistIdx(-1);
    setValue('');
  }, [client]);

  /** Put text in the input (Tab / picking a verb) and keep composing. */
  const insert = useCallback((text) => {
    setValue(text);
    setHistIdx(-1);
    inputRef.current?.focus();
  }, []);

  /** Activate a row: nouns execute their command line, history re-fires its
   *  line, a verb inserts `verb ` for arg entry. */
  const activate = useCallback((row) => {
    const e = row?.entry;
    if (!e) return;
    if (e.command) { plog.info(`${e.kind} ${e.key} → ${e.command.join(' ')}`); run(e.command); }
    else if (e.kind === 'history') { plog.info(`history → ${e.key}`); run(e.key); }
    else insert(e.insert ?? e.key);
  }, [run, insert]);

  const onKeyDown = (e) => {
    e.stopPropagation();   // keep keystrokes out of camera/edit (the global handlers also guard inputs)
    if (e.key === 'Escape') { e.preventDefault(); onClose?.(); return; }

    if (e.key === 'Enter') {
      e.preventDefault();
      if (isCommandMode) { run(value); return; }
      const row = sel >= 0 ? rows[sel] : null;
      // The REPL contract: a fully-typed known verb always executes, args or not.
      if (row?.entry.kind === 'verb' && row.entry.key === query.toLowerCase()) { run(row.entry.key); return; }
      if (row) { activate(row); return; }
      if (value.trim()) run(value);  // no match selected — fire the raw line (verbatim escape hatch)
      return;
    }

    if (e.key === 'Tab') {
      e.preventDefault();
      if (isCommandMode) return;
      const row = sel >= 0 ? rows[sel] : rows[0];
      if (!row) return;
      const en = row.entry;
      // Tab always INSERTS — a verb for arg entry, a noun as its editable command line.
      insert(en.insert ?? (en.command ? en.command.join(' ') : en.key));
      return;
    }

    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      if (!isCommandMode && rows.length) {
        // Search/history list: arrows move the selection. ↑ from nothing lands on
        // the most recent history row — the old REPL's "↑ = last command".
        setSel((s) => (s === -1 && dir === -1) ? 0
          : Math.min(rows.length - 1, Math.max(query ? 0 : -1, s + dir)));
        return;
      }
      // Command mode: arrows walk history into the line (the classic REPL).
      if (!history.length) return;
      if (dir < 0) {
        const ni = histIdx < 0 ? history.length - 1 : Math.max(0, histIdx - 1);
        setHistIdx(ni); setValue(history[ni] ?? '');
      } else {
        if (histIdx < 0) return;
        const ni = histIdx + 1;
        if (ni >= history.length) { setHistIdx(-1); setValue(''); }
        else { setHistIdx(ni); setValue(history[ni]); }
      }
    }
  };

  if (!client || !open) return null;

  return (
    <div style={S.backdrop} onMouseDown={() => onClose?.()}>
      <div style={S.panel}
        onMouseDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
        <div style={{ ...S.barRow, ...(running ? S.barRunning : null) }}>
          <span style={S.prompt}>›</span>
          <input
            ref={inputRef}
            style={S.input}
            value={value}
            spellCheck={false}
            autoComplete="off"
            placeholder="search files · commands · schemes — Tab completes · Enter runs · Esc closes"
            onChange={(e) => { setValue(e.target.value); setHistIdx(-1); }}
            onKeyDown={onKeyDown}
          />
          <span style={S.escHint}>esc</span>
        </div>
        {commandUsage && (
          <div style={S.usageHint}>
            <span style={S.mName}>{commandUsage.key}</span>
            {commandUsage.usage ? <span style={S.mUsage}> {commandUsage.usage}</span> : null}
            {commandUsage.detail ? <span style={S.usageDesc}> — {commandUsage.detail}</span> : null}
          </div>
        )}
        {rows.length > 0 && (
          <div style={S.matches}>
            {rows.map((row, i) => {
              const en = row.entry;
              const [badge, badgeColor] = KIND_BADGE[en.kind] || ['?', '#888'];
              const cmdLine = en.command ? en.command.join(' ')
                : en.kind === 'verb' ? `${en.key} ${en.usage || ''}`.trim() : en.key;
              return (
                <button key={`${en.kind}:${en.key}`} type="button"
                  data-palette-row data-kind={en.kind} data-cmd={cmdLine}
                  style={{ ...S.match, ...(i === sel ? S.matchSel : null) }}
                  onMouseEnter={() => setSel(i)}
                  onMouseDown={(e) => { e.preventDefault(); activate(row); }}>
                  <span style={{ ...S.badge, color: badgeColor, borderColor: badgeColor }}>{badge}</span>
                  <span style={S.rowBody}>
                    <span style={S.rowKey}>
                      <HighlightedKey text={en.key} positions={row.positions} />
                      {en.detail ? <span style={S.rowDetail}>  {en.detail}</span> : null}
                    </span>
                    <span style={S.rowCmd}>› {cmdLine}</span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
        {result && (
          <div style={{ ...S.result, ...(result.ok ? S.ok : S.err) }}>{result.text}</div>
        )}
      </div>
    </div>
  );
}

const S = {
  backdrop: {
    position: 'fixed', inset: 0, zIndex: 100,
    background: 'rgba(2,4,8,0.45)', backdropFilter: 'blur(1.5px)',
    display: 'flex', justifyContent: 'center', alignItems: 'flex-start', paddingTop: '14vh',
    font: '12px ui-monospace, Menlo, Consolas, monospace',
  },
  panel: {
    width: 'min(640px, 92vw)', display: 'flex', flexDirection: 'column', gap: 6,
  },
  // border stays LONGHAND wherever a variant merges a borderColor on top —
  // React warns (and drops the color) when shorthand and longhand mix.
  barRow: {
    display: 'flex', alignItems: 'center', gap: 7, padding: '8px 12px', borderRadius: 8,
    background: 'rgba(12,14,19,0.97)', borderWidth: 1, borderStyle: 'solid', borderColor: '#2a3340',
    boxShadow: '0 10px 40px rgba(0,0,0,0.5)',
  },
  barRunning: { borderColor: '#6cf' },
  prompt: { color: '#6cf', fontWeight: 700 },
  input: {
    flex: 1, font: 'inherit', fontSize: 13, color: '#dce6f0', background: 'transparent', border: 'none', outline: 'none',
  },
  escHint: { color: '#5b6675', fontSize: 10, border: '1px solid #2a3340', borderRadius: 3, padding: '1px 4px', flex: '0 0 auto' },
  usageHint: {
    padding: '5px 11px', borderRadius: 6, background: 'rgba(12,14,19,0.97)', border: '1px solid #283341',
  },
  usageDesc: { color: '#6b7785' },
  matches: {
    display: 'flex', flexDirection: 'column', gap: 2, padding: 4, borderRadius: 6,
    background: 'rgba(12,14,19,0.97)', border: '1px solid #283341', overflow: 'auto', maxHeight: '46vh',
  },
  match: {
    display: 'flex', gap: 8, alignItems: 'flex-start', font: 'inherit', textAlign: 'left',
    background: 'transparent', border: 'none', borderRadius: 4, padding: '4px 7px', cursor: 'pointer', color: '#aebccb',
  },
  matchSel: { background: 'rgba(80,140,200,0.16)' },
  badge: {
    flex: '0 0 auto', fontSize: 9, borderWidth: 1, borderStyle: 'solid', borderRadius: 3,
    padding: '0px 4px', marginTop: 1, background: 'transparent',
    textTransform: 'uppercase', letterSpacing: '0.5px',
  },
  rowBody: { display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 },
  rowKey: { color: '#dce6f0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  rowDetail: { color: '#6b7785', fontSize: 11 },
  // the data-oriented subtitle: the exact verb line this row will execute
  rowCmd: { color: '#5b6675', fontSize: 11, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  hl: { color: '#6cf', fontWeight: 700 },
  mName: { color: '#6cf' },
  mUsage: { color: '#6b7785', fontSize: 11 },
  // last result, below the input. Multi-line output (tables) scrolls within a capped box.
  result: {
    whiteSpace: 'pre', overflow: 'auto', maxHeight: '40vh', padding: '8px 11px', borderRadius: 6,
    background: 'rgba(12,14,19,0.97)', borderWidth: 1, borderStyle: 'solid', borderColor: '#283341',
    lineHeight: 1.4, boxShadow: '0 10px 40px rgba(0,0,0,0.5)',
  },
  ok: { color: '#9fe7c8', borderColor: '#234b3d' },
  err: { color: '#f0a0a0', borderColor: '#5a2730' },
};
