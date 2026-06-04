import React, { useEffect, useRef, useState, useCallback } from 'react';

/**
 * CommandBar — the command palette: a summoned modal to fire bus verbs without leaving the app
 * for the terminal. DOM chrome (fed `client` via CommandProvider.onReady). Pure binding: it owns
 * NO behavior — every submit is router.execute(<verb line>), the same path the CLI drives.
 *
 * Opened with ⌘K / Ctrl-K (or the ButtonBar's "commands" button), centered over a dim backdrop.
 * It's a power tool for a session of commands, so Enter runs but KEEPS it open (clears the line,
 * shows the result, ready for the next); Esc or a backdrop click dismisses.
 *
 *   Enter      run the line (router.execute) → show the result below; stay open
 *   Tab        complete the verb to the top match (from router.listCommands())
 *   ↑ / ↓      walk command history (persisted to localStorage — survives reload)
 *   Esc        dismiss the palette
 *
 * Keystrokes are kept out of the camera/edit paths: InputManager + EntityKeystrokeRouter both
 * yield when a real <input> is focused, and we stopPropagation defensively.
 */

const HISTORY_KEY = 'glyph3d.cmdHistory';
const MAX_HISTORY = 100;
const MAX_MATCHES = 6;

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; }
}
function saveHistory(h) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(h.slice(-MAX_HISTORY))); } catch { /* quota / private mode */ }
}

export default function CommandBar({ client, open, onClose }) {
  const [value, setValue] = useState('');
  const [result, setResult] = useState(null);   // { ok: boolean, text: string }
  const [history, setHistory] = useState(loadHistory);
  const [histIdx, setHistIdx] = useState(-1);    // -1 = live (not walking history)
  const [verbs, setVerbs] = useState([]);        // [{ name, usage, description }]
  const [running, setRunning] = useState(false);
  const inputRef = useRef(null);

  // The registered verb list, for Tab-completion + the suggestion strip.
  useEffect(() => {
    if (!client?.router?.listCommands) return;
    try { setVerbs(client.router.listCommands() || []); } catch { setVerbs([]); }
  }, [client]);

  // Focus the input each time the palette opens (it's a summoned modal).
  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);

  // Suggestions: only while typing the FIRST token (the verb), before any space/args.
  const firstTok = value.split(/\s+/)[0] || '';
  const hasArgs = /\s/.test(value);
  const matches = (!hasArgs && firstTok)
    ? verbs.filter((v) => v.name.startsWith(firstTok.toLowerCase()) && v.name !== firstTok.toLowerCase()).slice(0, MAX_MATCHES)
    : [];

  const run = useCallback(async (cmd) => {
    const text = String(cmd).trim();
    if (!text || !client?.router) return;
    setRunning(true);
    let res;
    try { res = await client.router.execute(text); }
    catch (e) { res = { text: `ERR: ${e?.message || e}` }; }
    setRunning(false);
    const t = res?.text ?? '(no output)';
    setResult({ ok: !/^ERR/i.test(t), text: t });
    setHistory((h) => { const nh = [...h.filter((x) => x !== text), text]; saveHistory(nh); return nh; });
    setHistIdx(-1);
    setValue('');
  }, [client]);

  const onKeyDown = (e) => {
    e.stopPropagation();   // keep keystrokes out of camera/edit (the global handlers also guard inputs)
    if (e.key === 'Enter') { e.preventDefault(); run(value); return; }
    if (e.key === 'Escape') { e.preventDefault(); onClose?.(); return; }
    if (e.key === 'Tab' && matches.length) { e.preventDefault(); setValue(matches[0].name + ' '); setHistIdx(-1); return; }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!history.length) return;
      const ni = histIdx < 0 ? history.length - 1 : Math.max(0, histIdx - 1);
      setHistIdx(ni); setValue(history[ni] ?? '');
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (histIdx < 0) return;
      const ni = histIdx + 1;
      if (ni >= history.length) { setHistIdx(-1); setValue(''); }
      else { setHistIdx(ni); setValue(history[ni]); }
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
            placeholder="command — e.g. sheet.list · grid.layout 0 z-pages   (Tab completes · ↑ history · Esc closes)"
            onChange={(e) => { setValue(e.target.value); setHistIdx(-1); }}
            onKeyDown={onKeyDown}
          />
          <span style={S.escHint}>esc</span>
        </div>
        {matches.length > 0 && (
          <div style={S.matches}>
            {matches.map((m) => (
              <button key={m.name} type="button" style={S.match}
                title={m.description || ''}
                onMouseDown={(e) => { e.preventDefault(); setValue(m.name + ' '); setHistIdx(-1); inputRef.current?.focus(); }}>
                <span style={S.mName}>{m.name}</span>
                {m.usage ? <span style={S.mUsage}>{m.usage}</span> : null}
              </button>
            ))}
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
  barRow: {
    display: 'flex', alignItems: 'center', gap: 7, padding: '8px 12px', borderRadius: 8,
    background: 'rgba(12,14,19,0.97)', border: '1px solid #2a3340',
    boxShadow: '0 10px 40px rgba(0,0,0,0.5)',
  },
  barRunning: { borderColor: '#6cf' },
  prompt: { color: '#6cf', fontWeight: 700 },
  input: {
    flex: 1, font: 'inherit', fontSize: 13, color: '#dce6f0', background: 'transparent', border: 'none', outline: 'none',
  },
  escHint: { color: '#5b6675', fontSize: 10, border: '1px solid #2a3340', borderRadius: 3, padding: '1px 4px', flex: '0 0 auto' },
  matches: {
    display: 'flex', flexDirection: 'column', gap: 2, padding: 4, borderRadius: 6,
    background: 'rgba(12,14,19,0.97)', border: '1px solid #283341',
  },
  match: {
    display: 'flex', gap: 8, alignItems: 'baseline', font: 'inherit', textAlign: 'left',
    background: 'transparent', border: 'none', borderRadius: 4, padding: '3px 7px', cursor: 'pointer', color: '#aebccb',
  },
  mName: { color: '#6cf' },
  mUsage: { color: '#6b7785', fontSize: 11 },
  // last result, below the input. Multi-line output (tables) scrolls within a capped box.
  result: {
    whiteSpace: 'pre', overflow: 'auto', maxHeight: '40vh', padding: '8px 11px', borderRadius: 6,
    background: 'rgba(12,14,19,0.97)', border: '1px solid #283341', lineHeight: 1.4,
    boxShadow: '0 10px 40px rgba(0,0,0,0.5)',
  },
  ok: { color: '#9fe7c8', borderColor: '#234b3d' },
  err: { color: '#f0a0a0', borderColor: '#5a2730' },
};
