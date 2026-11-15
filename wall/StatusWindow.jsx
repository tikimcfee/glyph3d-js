import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { chordLabel } from './chord.js';
import { DockButtons, useHeadDrag } from './Panel.jsx';
import { dockLayout, DOCK_WIDTHS } from './dockLayout.js';

/**
 * termd on the wall (docs/termd/DESIGN.md, "Status: in the app") — three small pieces, every number
 * from termd's own status document, which the relay pushes (`termd/status`, TermdStatus in core):
 *
 *   TermdChip     beside the relay chip: `● termd 4` — green when a brain answers, a dim ring when
 *                 the namespace is idle (no daemon), amber while it restarts, red when it's
 *                 unreachable, failed or lost. A click opens the window.
 *   StatusWindow  the daemon (version, engine, namespace, uptime, holder and brain, restarts) and its
 *                 terminals, one row each, then the latest errors. Floats (drag its head) or sticks to
 *                 the left or right edge, like the sidebar (Panel.jsx); open, side and spot persist
 *                 per relay. A row's click reveals its terminal (wall.reveal: shown, focused, framed).
 *                 Toggled by the chord + S or `wall.status`.
 *   TermdNotice   one line under the topbar, only when something is wrong: a restart that lingers
 *                 (amber, after restartNoticeMs), unreachable, failed, lost (red; lost stays until
 *                 dismissed or a terminal is spawned), or a brain too old for the display's typing
 *                 (red: it has no `key`/`paste` op, so keys and pastes are dropped).
 *
 * Quiet by default: amber marks only what needs a look (blocked, lagging, queued input, a warning),
 * everything secondary is muted.
 */

const C = {
  panel: '#141821', border: '#2a303c', text: '#c8ced8', muted: '#6b7383',
  ok: '#6ee7a0', amber: '#e3b341', red: '#e5534b',
};

/** Re-render on every termd/status change; returns the model. */
function useTermd(wall) {
  const version = useRef(0);
  useSyncExternalStore(
    (cb) => wall.termd.onChange(() => { version.current++; cb(); }),
    () => version.current,
  );
  return wall.termd;
}

/** The clock: the time of this render, re-rendering once a second while `on`. */
function useNow(on) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!on) return undefined;
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [on]);
  return Date.now();
}

/** Brain trouble: restarting, unreachable or failed. */
const TROUBLE = new Set(['restarting', 'unreachable', 'failed']);

/** When the brain stopped answering (by this page's clock), while it hasn't come back; else null. */
function useTroubleSince(termd) {
  const ref = useRef(null);
  if (!TROUBLE.has(termd.state)) ref.current = null;
  else if (ref.current == null) ref.current = Date.now();
  return ref.current;
}

// ── formatting (the same as `g3d status`: crates/g3d/src/render.rs) ─────────

/** `512 B`, `3.1 KB`, `41 MB` (powers of 1000). */
function bytes(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n, u = 0;
  while (v >= 1000 && u < units.length - 1) { v /= 1000; u++; }
  return u === 0 ? `${n} B` : `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}

/** `45s`, `12m`, `3h 12m`, `2d 4h`. */
function span(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

/** `HH:MM` (local time). */
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

/** The program a terminal runs: argv[0]'s basename, a login shell's `-` dropped. */
function program(argv) {
  const a0 = argv?.[0] ?? '';
  return a0.slice(a0.lastIndexOf('/') + 1).replace(/^-/, '');
}

/** `own · 2 watch`, `—` for no one. */
function subscribers(subs) {
  const n = (r) => subs.filter((s) => s.role === r).length;
  const parts = [];
  if (n('own')) parts.push('own');
  if (n('attach')) parts.push(`${n('attach')} attach`);
  if (n('watch')) parts.push(`${n('watch')} watch`);
  return parts.length ? parts.join(' · ') : '—';
}

/** `name-version` → `name version`. */
const nv = (s) => (s || '').replace('/', ' ');

/** What needs a look, then what is merely so. */
function notes(t) {
  const loud = [], quiet = [];
  if (t.flow === 'blocked') loud.push('blocked');
  else if (t.flow === 'paused') quiet.push('paused');
  if (t.subscribers.some((s) => s.lagging)) loud.push('lagging');
  if (t.input_queued > 0) loud.push(`${bytes(t.input_queued)} input queued`);
  if (t.alt) quiet.push('alt');
  if (t.restored) quiet.push(t.unseen > 0 ? `restored: ${t.restored}, ${bytes(t.unseen)} unseen` : `restored: ${t.restored}`);
  return { loud, quiet };
}

/** A row's hover text: the whole of what the document says about it. */
function rowTitle(t) {
  const lines = [
    t.argv.join(' ') + (t.login ? '  (login shell)' : ''),
    `${t.id} · pid ${t.pid} · handle ${t.handle} · ${t.cols}×${t.rows}`,
    `cwd ${t.cwd}${t.pwd && t.pwd !== t.cwd ? ` · now ${t.pwd}` : ''}`,
  ];
  if (t.title) lines.push(`title ${t.title}`);
  for (const s of t.subscribers) {
    lines.push(`${s.role} · ${s.client || `connection ${s.conn}`}${s.pid ? ` (pid ${s.pid})` : ''} · ${s.mode} · ${s.flow}${s.lagging ? ' · lagging' : ''}${s.lags ? ` · ${s.lags} resync${s.lags === 1 ? '' : 's'}` : ''}${s.view ? ` · scrolled back ${s.view}` : ''}`);
  }
  return lines.join('\n');
}

// ── the chip ─────────────────────────────────────────────────────────────

/** How each state reads on the chip. */
function chipLook(termd) {
  const n = termd.terminals.length;
  switch (termd.state) {
    case 'ok': return { mark: '●', color: C.ok, text: `termd ${n}` };
    case 'absent': return { mark: '○', color: C.muted, text: 'termd idle' };
    case 'restarting': return { mark: '●', color: C.amber, text: 'termd restarting' };
    case 'unknown': return { mark: '○', color: C.muted, text: 'termd' };
    default: return { mark: '●', color: C.red, text: `termd ${termd.state}` };
  }
}

export function TermdChip({ wall }) {
  const termd = useTermd(wall);
  const look = chipLook(termd);
  return (
    <button
      data-termd={termd.state}
      tabIndex={-1}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => wall.run(['wall.status', 'toggle'])}
      title={`termd's status (${chordLabel(['S'])})`}
      style={{ ...styles.chip, color: look.color }}
    >{look.mark} <span style={{ color: termd.state === 'ok' ? C.text : look.color }}>{look.text}</span></button>
  );
}

// ── the notice ───────────────────────────────────────────────────────────

/** The notice for a state, or null: `{ kind, tone, text, dismiss }`. */
export function noticeFor(termd, sinceMs, now, cfg) {
  if (termd.lost) {
    return { kind: 'lost', tone: C.red, dismiss: true,
      text: `termd lost: the shells in namespace "${termd.lost.ns}" are gone · a new terminal starts a fresh termd` };
  }
  if (termd.lacks.length) {
    return { kind: 'lacks', tone: C.red,
      text: `typing can't reach termd: its engine has no ${termd.lacks.join(' or ')} op (protocol 1.2) · g3d upgrade moves it to the relay's, every shell kept` };
  }
  switch (termd.state) {
    case 'restarting':
      return now - sinceMs >= cfg.restartNoticeMs
        ? { kind: 'restarting', tone: C.amber, text: "termd's engine is restarting · the shells are alive" }
        : null;
    case 'unreachable':
      return { kind: 'unreachable', tone: C.red, text: `termd not answering · ${span(now - sinceMs)} · retrying` };
    case 'failed':
      return { kind: 'failed', tone: C.red,
        text: "termd's engine is down — it keeps crashing · the shells are alive, frozen · g3d upgrade retries it now" };
    default: return null;
  }
}

export function TermdNotice({ wall }) {
  const termd = useTermd(wall);
  const since = useTroubleSince(termd);
  const waiting = termd.state === 'restarting' || termd.state === 'unreachable';
  const now = useNow(waiting);
  // A restart's notice waits restartNoticeMs; wake once when it's due.
  const [, poke] = useState(0);
  useEffect(() => {
    if (termd.state !== 'restarting') return undefined;
    const t = setTimeout(() => poke((x) => x + 1), Math.max(0, wall.config.restartNoticeMs - (Date.now() - since)) + 10);
    return () => clearTimeout(t);
  }, [termd.state, since, wall]);
  const n = noticeFor(termd, since, now, wall.config);
  if (!n) return null;
  return (
    <div data-termd-notice={n.kind} style={{ ...styles.notice, color: n.tone }}>
      <span>{n.text}</span>
      {n.dismiss && (
        <button tabIndex={-1} onMouseDown={(e) => e.preventDefault()} title="dismiss"
          onClick={() => wall.run(['wall.status.dismiss'])} style={styles.dismiss}>×</button>
      )}
    </div>
  );
}

// ── the window ───────────────────────────────────────────────────────────

/** The header: the daemon, its holder and brain. */
function Daemon({ termd, now }) {
  const d = termd.doc?.daemon;
  if (!d) {
    const why = {
      absent: 'no termd running in this namespace — the next terminal starts one',
      unknown: 'no word from the relay',
      lost: 'the namespace is gone',
    }[termd.state] ?? `termd ${termd.state}`;
    return <div style={{ color: C.muted }}>{why}{termd.relay?.ns ? ` · ns ${termd.relay.ns}` : ''}</div>;
  }
  const b = d.brain, r = b.restarts;
  const restarts = [['crash', r.crash], ['watchdog', r.watchdog], ['upgrade', r.upgrade]].filter(([, n]) => n > 0);
  const rss = (x) => (x != null ? ` · ${bytes(x)}` : '');
  return (
    <>
      <div style={styles.split}>
        <span>{nv(d.version)} <span style={styles.muted}>· {nv(d.engine)} · {d.ns ? `ns ${d.ns}` : d.socket}</span></span>
        <span style={styles.muted}>up {span(now - d.started_at)}</span>
      </div>
      <div style={{ ...styles.muted, display: 'flex', gap: '2.2em', flexWrap: 'wrap' }}>
        <span>holder {d.holder.pid}{rss(d.holder.rss)}</span>
        <span>brain {b.pid} · gen {b.generation}{rss(b.rss)}</span>
        {restarts.length > 0 && <span>restarts: {restarts.map(([w, n]) => `${n} ${w}`).join(', ')} · last {b.last_start.reason} {clock(b.last_start.at)}</span>}
      </div>
      {d.env.warnings.map((w) => <div key={w} style={{ color: C.amber }}>env: {w}</div>)}
      {termd.upgradeAvailable && (
        <div style={{ color: C.amber }}>the relay ships {nv(termd.upgradeAvailable)} · g3d upgrade moves termd to it, every shell kept</div>
      )}
    </>
  );
}

/** One row per terminal: name, program, size, who watches, what it's doing, what needs a look. */
function Terminals({ wall, termd, now, stale }) {
  const ts = termd.terminals;
  if (!termd.doc) return null;
  if (!ts.length) return <div style={{ ...styles.muted, marginTop: 6 }}>no terminals</div>;
  return (
    <table style={{ ...styles.table, opacity: stale ? 0.55 : 1 }}><tbody>
      {ts.map((t) => {
        const onWall = !!wall.terminal(t.id);
        const name = onWall ? wall.nameOf(t.id) : (t.title || t.id);
        const { loud, quiet } = notes(t);
        const doing = t.out_bps > 0 ? `${bytes(t.out_bps)}/s` : t.last_output_at ? `idle ${span(now - t.last_output_at)}` : '';
        return (
          <tr key={t.id} data-status-row={t.id} className="termd-status-row" title={rowTitle(t)}
            onClick={() => { if (onWall) wall.run(['wall.reveal', t.id]); }}
            style={{ cursor: onWall ? 'pointer' : 'default' }}>
            <td style={{ ...styles.td, color: '#e6e9ef' }}>{name}</td>
            <td style={{ ...styles.td, ...styles.muted }}>{program(t.argv)}</td>
            <td style={{ ...styles.td, ...styles.muted, textAlign: 'right' }}>{t.cols}×{t.rows}</td>
            <td style={{ ...styles.td, ...styles.muted }}>{subscribers(t.subscribers)}</td>
            <td style={{ ...styles.td, ...(t.out_bps > 0 ? null : styles.muted) }}>{doing}</td>
            <td style={{ ...styles.td, paddingRight: 0 }}>
              {loud.length > 0 && <span style={{ color: C.amber }}>{loud.join(' · ')}</span>}
              {loud.length > 0 && quiet.length > 0 && ' '}
              {quiet.length > 0 && <span style={styles.muted}>{quiet.join(' · ')}</span>}
            </td>
          </tr>
        );
      })}
    </tbody></table>
  );
}

/** The latest errors, newest first. */
function Errors({ termd, shown }) {
  const es = (termd.doc?.errors ?? []).slice(0, shown);
  if (!es.length) return null;
  return (
    <div style={{ marginTop: 8 }}>
      {es.map((e) => (
        <div key={`${e.code}:${e.id ?? ''}`} style={styles.err} title={`${e.message}\nfirst ${new Date(e.first_at).toLocaleString()} · ${e.count}×`}>
          <span style={styles.muted}>{clock(e.at)}</span>{' '}
          <span style={{ color: C.amber }}>{e.code}</span>
          {e.count > 1 && <span style={styles.muted}> ×{e.count}</span>}
          {e.id && <span style={styles.muted}> {e.id}</span>}{' '}
          <span>{e.message}</span>
        </div>
      ))}
    </div>
  );
}

/** The window. `state` is the wall's snapshot (its statusWindow placement). */
export default function StatusWindow({ wall, state }) {
  const sw = state.statusWindow;
  const termd = useTermd(wall);
  const now = useNow(sw.open);
  const boxRef = useRef(null);
  const { dragAt, onHeadDown } = useHeadDrag(wall, 'wall.status', sw.side, boxRef);
  if (!sw.open) return null;

  const floatAt = dragAt ?? sw.float;
  const box = sw.side === 'float'
    ? { ...(floatAt ? { left: floatAt.x, top: floatAt.y } : { right: 12, top: 46 }), maxHeight: 'calc(100% - 120px)', borderRadius: 7, border: `1px solid ${C.border}`, maxWidth: 'calc(100vw - 32px)' }
    : { top: 0, bottom: 0, [sw.side]: dockLayout(state).status, width: DOCK_WIDTHS.status, [sw.side === 'left' ? 'borderRight' : 'borderLeft']: `1px solid ${C.border}` };

  const stale = termd.state !== 'ok' && !!termd.doc;
  const look = chipLook(termd);
  return (
    <div ref={boxRef} data-status-window="" data-side={sw.side} style={{ ...styles.panel, ...box }}>
      <style>{'.termd-status-row:hover{background:#1b2130}'}</style>
      <div style={{ ...styles.head, cursor: sw.side === 'float' ? 'move' : 'default' }} onPointerDown={onHeadDown}>
        <span style={{ flex: 1 }}>
          <span style={{ color: look.color }}>{look.mark}</span> <span style={{ color: C.muted }}>termd</span>
          {termd.state !== 'ok' && <span style={{ color: look.color }}> · {termd.state === 'absent' ? 'idle' : termd.state}</span>}
        </span>
        <DockButtons wall={wall} verb="wall.status" side={sw.side} close={{ title: `close (${chordLabel(['S'])})`, action: 'close-status' }} />
      </div>
      <div style={styles.body}>
        <Daemon termd={termd} now={now} />
        <Terminals wall={wall} termd={termd} now={now} stale={stale} />
        <Errors termd={termd} shown={wall.config.errorsShown} />
      </div>
    </div>
  );
}

const styles = {
  chip: { padding: '4px 6px', background: 'transparent', border: 'none', font: 'inherit', cursor: 'pointer' },
  notice: {
    position: 'absolute', top: 46, left: '50%', transform: 'translateX(-50%)', zIndex: 8, maxWidth: 'calc(100vw - 32px)',
    background: C.panel, border: `1px solid ${C.border}`, borderRadius: 5, padding: '5px 12px',
    display: 'flex', gap: 10, alignItems: 'center', whiteSpace: 'nowrap', pointerEvents: 'auto',
  },
  dismiss: { background: 'transparent', border: 'none', color: C.muted, font: 'inherit', cursor: 'pointer', padding: 0 },
  panel: {
    position: 'absolute', zIndex: 7, display: 'flex', flexDirection: 'column', background: 'rgba(20, 24, 33, 0.97)',
    boxShadow: '0 8px 30px rgba(0,0,0,0.45)', font: '12px ui-monospace, SFMono-Regular, Menlo, monospace', color: C.text,
    userSelect: 'text', boxSizing: 'border-box',
  },
  head: { display: 'flex', alignItems: 'center', gap: 2, padding: '5px 6px 5px 10px', borderBottom: '1px solid #1e2430', userSelect: 'none' },
  body: { overflow: 'auto', padding: '7px 10px 9px', flex: '1 1 auto', lineHeight: 1.55 },
  split: { display: 'flex', justifyContent: 'space-between', gap: 24 },
  muted: { color: C.muted },
  table: { borderCollapse: 'collapse', marginTop: 7, whiteSpace: 'nowrap' },
  td: { padding: '0 14px 0 0', verticalAlign: 'top' },
  // Errors wrap (never cut); the window stays about as wide as its terminal rows.
  err: { maxWidth: 640, textIndent: '-3.2em', paddingLeft: '3.2em' },
};
