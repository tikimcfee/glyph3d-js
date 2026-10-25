import React, { useEffect, useRef, useState, useCallback } from 'react';
import { stateController } from '@glyph3d/core/services/state';
import { DEFAULT_LAYOUT } from '@glyph3d/core/workers/builders/index.js';
import { bookInSlot } from './bookFocus.js';
import { DESK_KNOBS, BOOK_KNOBS, deskInSlot, readDesk, readBook } from './tuning.js';
/** @import { AppClient } from './CommandProvider.jsx' */

/**
 * HudPanel — THE one floating helper over the canvas: what you're locked into, and
 * what you can do about it. The old pair (a bottom-center context breadcrumb that
 * REFLECTED focus/edit/key state, a bottom-right panel that CONTROLLED the focused
 * window) merged into one deterministic window — bottom-right by default, draggable,
 * collapsible, position + toggles persisted as hud.*.
 *
 * Top-down, each row earning its place only when its subject is in play:
 *
 *   header        grip · focused name (the FOCUS accent) · address toggle · collapse
 *   context chips AST scope · EDIT caret · KEY target — rendered 1:1 from the
 *                 InteractionContext's composable nodes, SUBSCRIPTION-driven (the
 *                 itests assert cursor moves land without polling)
 *   address bar   the focus path as clickable segments → focus.path (the same
 *                 absolute focus the keyboard walk lands on)
 *   LSP row       def + references at the caret (LspNavigator) → lsp.goto / panel
 *   controls      camera row · dir-volume splay⇄collapse · agent/delta book paging
 *                 (◂ ▸ live + where you are: turn in the run, sheet, live|held) ·
 *                 layout modes · edit + readout
 *   Desk          (collapsible) the desk the focused thing sits at — or the focused desk —
 *                 and ITS knobs: shape, seats, facing, radius, rows, arc, spacing… Each
 *                 edit is carrel.set on that desk alone (its own value, persisted); ↺
 *                 hands a knob back to what the desk was born as.
 *   Book          (collapsible) the focused agent/delta book's own knobs: form, deck
 *                 spacing / press / slide / glide (book.set, book.form), and for an agent
 *                 book the turns it keeps (book.limit).
 *
 * The HUD owns no behavior: every control is a thin { fire: a bus verb, reflect:
 * live state } binding. Reflection subscribes to InteractionContext + LspNavigator +
 * AttentionManager + registry, and polls only the readouts that don't emit
 * (scroll/frame/layout/edit).
 */

const LAYOUT_MODES = ['long-column', 'newspaper', 'no-wrap', 'z-pages'];

// kind → chip accent. FOCUS pale blue (hover/selection family), AST violet (the
// semantic family), EDIT caret yellow (CodeGrid.CARET_COLOR), KEY green (live
// capture), LSP teal (the navigator). Future kinds add a row here and a renderer.
const ACCENT = { focus: '#9fd2ff', ast: '#c8a9ff', edit: '#ffd84d', key: '#7fe0a0', lsp: '#6fe0c8' };

// Best-guess the active preset from the grid's layout params (modes are param bundles, so this is
// an inference for the highlight, not authoritative). Missing params read as DEFAULT_LAYOUT.
function inferMode(L) {
  if (!L) return null;
  if (L.axis === 'z') return 'z-pages';
  if ((L.wrapWidth ?? DEFAULT_LAYOUT.wrapWidth) === 0) return 'no-wrap';
  if ((L.pageHeight ?? DEFAULT_LAYOUT.pageHeight) === 0) return 'long-column';
  return 'newspaper';
}

// Trim a label (filename/path) for the header, keeping the tail (the basename).
function short(s, n = 26) {
  s = String(s || '');
  return s.length <= n ? s : '…' + s.slice(-(n - 1));
}

const tailName = (s, n = 24) => {
  const t = String(s || '').split('/').pop();
  return t.length > n ? '…' + t.slice(-(n - 1)) : t;
};

// Split a flattened path into its address-bar segments (drop empties so a
// leading/trailing slash doesn't render a blank chip).
const segmentsOf = (p) => String(p || '').split('/').filter(Boolean);

// The FOCUS node dedupes into the header title; every other kind renders a chip.
function chipLabel(n) {
  if (n.kind === 'edit') return `EDIT ${n.cursor.line}:${n.cursor.col}`;
  if (n.kind === 'ast') return n.label;
  if (n.kind === 'key') return `KEY ${n.entityType || tailName(n.id)}`;
  return `${n.kind.toUpperCase()} ${tailName(n.id)}`;
}

// The focused window's control state (attention.primary). Pure read — polled, since
// scroll/frame/layout/edit don't emit.
function readFocus(client) {
  const am = client?.ctx?.attentionManager;
  const reg = client?.ctx?.registry;
  if (!am || !reg) return null;
  const p = am.get?.('primary');
  if (!p?.id) return null;
  const entry = reg.get(p.id);
  if (!entry?.grid) return null;
  const { id, grid, type } = entry;
  // A plain grid window — what the grid.* controls (close, layout, scroll) address. A book's
  // page is a CodeGrid too, but it's the book's; terminals lack getLayout.
  const isGrid = type === 'grid' && !entry.role && typeof grid.getLayout === 'function';
  const cc = client.ctx.cameraController;
  // The BOOK in play — the same resolution a bare book verb runs (bookFocus): the focused
  // entity's own book — a volume (the cover, or the one a focused file rides), an agent
  // book (a card or the cover), a delta book.
  const bk = bookInSlot(client.ctx, 'primary');
  const volume = bk?.kind === 'volume' ? bk.book : null;
  const shelfBook = bk && bk.kind !== 'volume' ? {
    kind: bk.kind,
    addr: bk.kind === 'agent' ? bk.agentId : `delta:${bk.setId}`,
    ...(bk.kind === 'agent' ? bk.books.headState(bk.agentId) : bk.book.headState()),
  } : null;
  // The desk in play: the focused desk, or the one the focused thing sits at (a book, a card
  // on its page, a team desk inside the gomuxai hub) — and its knobs, live.
  const desk = deskInSlot(client.ctx, 'primary');
  return {
    id,
    type: type || (isGrid ? 'grid' : 'window'),
    desk: desk ? readDesk(client.ctx, desk) : null,
    bookTune: bk && bk.kind !== 'volume' ? {
      ...readBook(client.ctx, bk),
      limit: bk.kind === 'agent' ? bk.books.limitOf(bk.agentId) : null,
    } : null,
    name: grid.getFilename?.() || grid.userData?.name || id,
    isGrid,
    volume: volume ? {
      path: volume.userData.path, name: volume.userData.name,
      form: volume.form, head: volume.head, count: volume.sheets.length,
    } : null,
    book: shelfBook,
    layoutMode: isGrid ? inferMode(grid.getLayout?.()) : null,
    scroll: isGrid ? (grid.getScrollOffset?.() ?? 0) : 0,
    total: isGrid ? (grid.getTotalVisualRows?.() ?? 0) : 0,
    frameRows: isGrid ? (grid.getFrameRows?.() ?? 0) : 0,
    editing: isGrid ? (grid.getCursor?.() != null) : false,
    cameraLocked: cc?.isLocked?.() ?? false,
  };
}

/** @param {{ client: AppClient | null }} props */
export default function HudPanel({ client }) {
  const [f, setF] = useState(() => readFocus(client));
  const [nodes, setNodes] = useState([]);       // InteractionContext — subscription, no poll
  const [lsp, setLsp] = useState(null);         // LspNavigator state
  const [collapsed, setCollapsed] = useState(() => !!stateController.get('hud.collapsed', false));
  const [addr, setAddr] = useState(() => !!stateController.get('hud.addr', false)); // address bar open
  const [hoverSeg, setHoverSeg] = useState(-1); // address-bar segment under the cursor
  const [pos, setPos] = useState(() => stateController.get('hud.pos', null)); // {x,y} once dragged
  const [deskOpen, setDeskOpen] = useState(() => !!stateController.get('hud.deskOpen', false));
  const [bookOpen, setBookOpen] = useState(() => !!stateController.get('hud.bookOpen', false));
  const posRef = useRef(pos);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!client) return undefined;
    const refresh = () => setF(readFocus(client));
    const am = client.ctx?.attentionManager;
    const reg = client.ctx?.registry;
    const ic = client.ctx?.interactionContext;
    const nav = client.ctx?.lspNavigator;
    const unsubs = [
      am?.on?.('change:primary', refresh), am?.on?.('change:key', refresh),
    ].filter(Boolean);
    if (ic) { setNodes(ic.nodes()); unsubs.push(ic.on(setNodes)); }
    if (nav) { setLsp(nav.state()); unsubs.push(nav.on(setLsp)); }
    reg?.addChangeListener?.(refresh);                 // window removed/retargeted → restate
    const iv = setInterval(refresh, 150);              // scroll/frame/layout/edit don't emit — poll
    refresh();
    return () => {
      unsubs.forEach((u) => u?.());
      reg?.removeChangeListener?.(refresh);
      clearInterval(iv);
    };
  }, [client]);

  const fire = useCallback((...argv) => client?.router?.execute(argv), [client]);
  // A knob edit re-reads at once, so a dragged slider tracks the desk instead of the poll.
  const tune = useCallback((...argv) => {
    Promise.resolve(client?.router?.execute(argv)).finally(() => setF(readFocus(client)));
  }, [client]);

  // Drag by the grip: fixed-position move clamped to the viewport; position
  // persists on release. Until first drag it anchors bottom-right above the
  // status bar.
  const onGripDown = (e) => {
    e.preventDefault();
    const el = rootRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    const move = (ev) => {
      const p = {
        x: Math.max(0, Math.min(window.innerWidth - r.width, ev.clientX - dx)),
        y: Math.max(0, Math.min(window.innerHeight - r.height, ev.clientY - dy)),
      };
      posRef.current = p;
      setPos(p);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      if (posRef.current) stateController.set('hud.pos', posRef.current);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
  };

  const toggle = () => setCollapsed((c) => {
    stateController.set('hud.collapsed', !c);
    return !c;
  });

  const toggleAddr = () => setAddr((a) => {
    stateController.set('hud.addr', !a);
    return !a;
  });

  const toggleDesk = () => setDeskOpen((o) => { stateController.set('hud.deskOpen', !o); return !o; });
  const toggleBook = () => setBookOpen((o) => { stateController.set('hud.bookOpen', !o); return !o; });

  // Jump to an ancestor directory (or the focused entity itself) by its full
  // path — the same absolute focus the keyboard walk lands on, via the bus.
  const focusPath = (p) => { if (p) fire('focus.path', p); };

  // Jump to a known LSP location (a def/ref chip) via the bus.
  const jumpLoc = (l) => fire('lsp.goto', l.uri, String(l.sL), String(l.sC), String(l.eL), String(l.eC));

  const focusNode = nodes.find((n) => n.kind === 'focus') || null;
  const chips = nodes.filter((n) => n.kind !== 'focus');   // FOCUS lives in the title
  if (!f && nodes.length === 0) return null;               // truly free → no helper

  const title = f?.name || (focusNode ? tailName(focusNode.path) : 'free');
  const segs = focusNode ? segmentsOf(focusNode.path) : [];
  const showChips = !collapsed && chips.length > 0;
  const showAddr = !collapsed && addr && segs.length > 0;
  const showLsp = !collapsed && lsp?.status === 'ready' && (lsp.def || lsp.refs.length > 0);

  // Until first drag: bottom-right over the canvas, raised to clear the inline
  // status bar. A drag switches to explicit x/y.
  const place = pos ? { left: pos.x, top: pos.y } : { right: 12, bottom: 30 };

  return (
    <div ref={rootRef} style={{ ...S.panel, ...place }}
      onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
      <div style={S.header}>
        <span onPointerDown={onGripDown} title="drag to move" style={S.grip}>⠿</span>
        <span style={S.htitle} title={focusNode?.path || f?.id || title}>{short(title)}</span>
        {segs.length > 0 && (
          <button type="button" style={S.collapse} title={addr ? 'hide path' : 'show full path'}
            onClick={toggleAddr}>{addr ? '▾' : '▸'}</button>
        )}
        <button type="button" style={S.collapse} title={collapsed ? 'expand' : 'collapse'}
          onClick={toggle}>{collapsed ? '◂' : '▾'}</button>
      </div>
      {/* Context chips — the locked-in state (AST scope, caret, key target), 1:1 from
          the InteractionContext. data-g3d-context is the itests' ground-truth probe. */}
      {showChips && (
        <div style={S.chips} data-g3d-context>
          {chips.map((n, i) => (
            <span key={`${n.kind}:${n.id}:${i}`} data-kind={n.kind} title={n.id}
              style={{ ...S.chip, borderLeft: `2px solid ${ACCENT[n.kind] || '#4a5468'}` }}>
              {chipLabel(n)}
            </span>
          ))}
        </div>
      )}
      {showAddr && (
        <div style={S.addr} data-g3d-address onMouseLeave={() => setHoverSeg(-1)}>
          <span style={{ color: '#4a5468' }}>⌂</span>
          {segs.map((s, i) => {
            const prefix = segs.slice(0, i + 1).join('/');
            const isTail = i === segs.length - 1;
            const hot = hoverSeg === i;
            return (
              <React.Fragment key={i}>
                <span style={{ color: '#39424f' }}>›</span>
                <span onClick={() => focusPath(prefix)} onMouseEnter={() => setHoverSeg(i)}
                  title={`focus ${prefix}`}
                  style={{
                    cursor: 'pointer', whiteSpace: 'nowrap',
                    color: isTail ? ACCENT.focus : (hot ? '#cdd6e2' : '#8893a3'),
                    textDecoration: hot ? 'underline' : 'none',
                  }}>{s}</span>
              </React.Fragment>
            );
          })}
        </div>
      )}
      {showLsp && (
        <div style={S.lspRow} data-g3d-lsp>
          <span style={{ color: '#4a5468' }} title="LSP — definition & references">⌖</span>
          {lsp.def && (
            <span onClick={() => jumpLoc(lsp.def)}
              title={`definition\n${lsp.def.uri}\n${lsp.def.preview}`}
              style={S.lspBtn(ACCENT.lsp)}>def {lsp.def.label}</span>
          )}
          {lsp.refsTotal > 0 && (
            <span onClick={() => fire('panel.open', 'lspResults')}
              title="open the LSP results panel"
              style={S.lspBtn(ACCENT.ast)}>{lsp.refsTotal} ref{lsp.refsTotal === 1 ? '' : 's'} ▸</span>
          )}
        </div>
      )}
      {!collapsed && f && (
        <div style={S.controls}>
          <div style={S.row}>
            <Btn onClick={() => fire('camera.focus', f.id)}>focus</Btn>
            <Btn onClick={() => fire('camera.reset')}>reset</Btn>
            <Toggle on={f.cameraLocked} onStyle={S.cyanOn} onClick={() => fire('camera.lock')}>
              {f.cameraLocked ? 'cam ●' : 'cam ○'}
            </Toggle>
            {/* close = remove the focused grid from the field (sheet.close if it's a tab) */}
            {f.isGrid && (
              <button type="button" style={S.closeBtn} title="close / remove this grid"
                onClick={() => fire('grid.close', f.id)}>close ✕</button>
            )}
          </div>
          {/* The dir volume in play (the focused file's, or the focused cover itself):
              deck ⇄ splay — the button names the ACTION, the lit state means splayed. */}
          {f.volume && (
            <div style={S.row}>
              <Toggle on={f.volume.form === 'splay'}
                onClick={() => fire('book.form', f.volume.path, f.volume.form === 'splay' ? 'deck' : 'splay')}>
                {f.volume.form === 'splay' ? 'collapse ▧' : 'splay ▦'}
              </Toggle>
              <span style={S.readout} title={f.volume.path}>
                {short(f.volume.name, 14)} · page {f.volume.head + 1}/{f.volume.count}
              </span>
            </div>
          )}
          {/* The agent/delta book in play: turn its pages, ride live, and READ where you
              are — the turn the open sheet belongs to (its event's prompt), the sheet's
              place in the whole run (~ = a floor: the read began mid-record), the sheet
              among those kept, live vs held. */}
          {f.book && (
            <div style={S.row} data-g3d-book>
              <Btn onClick={() => fire('book.page', f.book.addr, 'prev')}>◂</Btn>
              <Btn onClick={() => fire('book.page', f.book.addr, 'next')}>▸</Btn>
              <Toggle on={f.book.following} onStyle={S.liveOn}
                onClick={() => fire('book.page', f.book.addr, 'last')}>
                {f.book.following ? 'live ●' : 'live ○'}
              </Toggle>
              <span style={S.readout} title={`${f.book.addr} — sheet ${f.book.head + 1} of ${f.book.count} kept`}>
                {f.book.turn != null ? `turn ${f.book.turn} · ` : ''}
                {f.book.sheet ? `sheet ${f.book.exact ? '' : '~'}${f.book.sheet}/${f.book.sheets} · ` : ''}
                {f.book.head + 1}/{f.book.count} · {f.book.following ? 'live' : 'held'}
                {f.book.loading ? ' · loading older…' : ''}
                {f.book.newer ? ` · +${f.book.newer} newer (live reloads)` : ''}
              </span>
            </div>
          )}
          {f.desk && (
            <Section name="desk" title={f.desk.name} open={deskOpen} onToggle={toggleDesk}
              own={Object.keys(f.desk.own).length > 0}
              hint={`the desk ${f.desk.name} — its own knobs (carrel.set ${f.desk.name} …); new desks take Settings ▸ Carrel`}>
              {DESK_KNOBS.filter((k) => k.hud !== false && (!k.shows || k.shows(f.desk.values))).map((k) => (
                <KnobRow key={k.key} knob={k} value={f.desk.values[k.key]} own={k.key in f.desk.own}
                  resetHint={`back to what ${f.desk.name} was born as (${f.desk.born[k.key]})`}
                  onSet={(v) => tune('carrel.set', f.desk.name, k.key, String(v))}
                  onReset={() => tune('carrel.set', f.desk.name, k.key, 'default')} />
              ))}
            </Section>
          )}
          {f.bookTune && f.book && (
            <Section name="book" title={f.book.addr} open={bookOpen} onToggle={toggleBook}
              own={Object.keys(f.bookTune.own).length > 0 || f.bookTune.limit?.override != null}
              hint={`the book ${f.book.addr} — its own knobs (book.set ${f.book.addr} …); new books take Settings ▸ Books`}>
              <KnobRow knob={FORM_KNOB} value={f.bookTune.form} own={'form' in f.bookTune.own}
                resetHint="back to a deck"
                onSet={(v) => tune('book.form', f.book.addr, v)}
                onReset={() => tune('book.form', f.book.addr, 'default')} />
              {BOOK_KNOBS.filter((k) => !k.shows || k.shows(f.bookTune)).map((k) => (
                <KnobRow key={k.key} knob={k} value={f.bookTune.values[k.key]} own={k.key in f.bookTune.own}
                  resetHint="back to the shelf's default (Settings)"
                  onSet={(v) => tune('book.set', f.book.addr, k.key, String(v))}
                  onReset={() => tune('book.set', f.book.addr, k.key, 'default')} />
              ))}
              {f.bookTune.limit && (
                <KnobRow knob={LIMIT_KNOB} value={f.bookTune.limit.cap} own={f.bookTune.limit.override != null}
                  resetHint="back to the shelf's default (Settings ▸ Agent Books)"
                  onSet={(v) => tune('book.limit', f.book.addr, String(v))}
                  onReset={() => tune('book.limit', f.book.addr, 'default')} />
              )}
            </Section>
          )}
          {f.isGrid && (
            <>
              <div style={S.row}>
                {LAYOUT_MODES.map((m) => (
                  <Mode key={m} on={f.layoutMode === m} onClick={() => fire('grid.layout', f.id, m)}>{m}</Mode>
                ))}
              </div>
              <div style={S.row}>
                <Toggle on={f.editing} onStyle={S.editOn}
                  onClick={() => fire(f.editing ? 'edit.stop' : 'edit.start', f.id)}>
                  {f.editing ? 'edit ●' : 'edit ○'}
                </Toggle>
                <span style={S.readout}>
                  {f.frameRows > 0 ? `frame ${f.frameRows} · ` : ''}row {f.scroll}/{f.total}
                </span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** The book's form as a knob row (book.form), and an agent book's kept turns (book.limit). */
const FORM_KNOB = { key: 'form', type: 'enum', options: ['deck', 'splay'], names: { deck: 'deck', splay: 'laid open' },
  label: 'Form — a deck of pages, or laid open as a grid' };
const LIMIT_KNOB = { key: 'limit', type: 'count', min: 0, step: 1,
  label: 'Turns this book keeps (0 = every turn) — Enter to apply; fewer sheds the oldest' };

// ── composable primitives — each a thin binding of { onClick: fire(verb), reflect: on } ──

/** A collapsible HUD section: a header line (caret · NAME · subject · ● when the subject has
 *  values of its own) over its rows. */
function Section({ name, title, hint, open, onToggle, own, children }) {
  return (
    <div style={S.section} data-g3d-tune={name}>
      <button type="button" style={S.secHdr} title={hint} onClick={onToggle}>
        <span style={S.caret}>{open ? '▾' : '▸'}</span>
        <span style={S.secName}>{name}</span>
        <span style={S.secTitle}>{title}</span>
        {own && <span style={S.secDot} title="has values of its own">●</span>}
      </button>
      {open && <div style={S.secBody}>{children}</div>}
    </div>
  );
}

/** One knob: its effect as the label; option buttons (enum), a slider + value (number), or a
 *  typed count committed on Enter / leaving the field (count — a change too heavy to fire per
 *  drag tick); ↺ when the value is the instance's own. Fires onSet / onReset — the caller's verbs. */
function KnobRow({ knob, value, own, resetHint, onSet, onReset }) {
  const shown = typeof value === 'number' ? Math.round(value * 100) / 100 : value;
  return (
    <div style={S.knob} data-knob={knob.key}>
      <div style={S.knobHead}>
        <span style={S.knobLabel} title={knob.key}>{knob.label}</span>
        {own && <button type="button" style={S.knobReset} title={resetHint} onClick={onReset}>↺</button>}
      </div>
      {knob.type === 'enum' ? (
        <div style={S.row}>
          {knob.options.map((o) => (
            <Mode key={o} on={value === o} onClick={() => onSet(o)}>{knob.names?.[o] ?? o}</Mode>
          ))}
        </div>
      ) : knob.type === 'count' ? (
        <div style={S.row}>
          <input key={String(value)} type="number" style={S.count} min={knob.min} step={knob.step}
            defaultValue={Number.isFinite(value) ? value : ''}
            onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') e.currentTarget.blur(); }}
            onBlur={(e) => { const n = Number(e.currentTarget.value); if (Number.isFinite(n) && n !== value) onSet(n); }} />
        </div>
      ) : (
        <div style={S.row}>
          <input type="range" style={S.slider} min={knob.min} max={knob.max} step={knob.step}
            value={Number.isFinite(value) ? value : knob.min}
            onChange={(e) => onSet(e.target.value)} />
          <span style={{ ...S.knobVal, ...(own ? S.knobOwn : null) }}>{shown ?? '—'}</span>
        </div>
      )}
    </div>
  );
}

function Btn({ onClick, children }) {
  return <button type="button" style={S.btn} onClick={onClick}>{children}</button>;
}
function Toggle({ on, onStyle, onClick, children }) {
  return <button type="button" style={{ ...S.btn, ...(on ? (onStyle || S.cyanOn) : null) }} onClick={onClick}>{children}</button>;
}
function Mode({ on, onClick, children }) {
  return <button type="button" style={{ ...S.mode, ...(on ? S.cyanOn : null) }} onClick={onClick}>{children}</button>;
}

const S = {
  panel: {
    position: 'fixed', zIndex: 20,   // placed via `place` — bottom-right default, draggable
    font: '12px ui-monospace, Menlo, Consolas, monospace',
    background: 'rgba(10,12,16,0.82)', color: '#aebccb',
    border: '1px solid #283341', borderRadius: 7, padding: '8px 10px',
    display: 'flex', flexDirection: 'column', gap: 6, minWidth: 210, maxWidth: 340,
    userSelect: 'none', backdropFilter: 'blur(6px)', boxShadow: '0 4px 18px rgba(0,0,0,0.35)',
  },
  controls: { display: 'flex', flexDirection: 'column', gap: 6, borderTop: '1px solid #1c222c', paddingTop: 6 },
  row: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' },
  chips: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 4, fontSize: 11 },
  chip: { padding: '0 5px', whiteSpace: 'nowrap', color: '#aeb8c6' },
  addr: {
    display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 3,
    fontSize: 11, borderTop: '1px solid #1c222c', paddingTop: 5,
  },
  lspRow: {
    display: 'flex', alignItems: 'center', gap: 4, fontSize: 11,
    borderTop: '1px solid #1c222c', paddingTop: 5,
  },
  lspBtn: (color) => ({ cursor: 'pointer', color, padding: '0 4px', whiteSpace: 'nowrap' }),
  btn: {
    font: 'inherit', color: '#aebccb', background: '#1a212b',
    border: '1px solid #2a3340', borderRadius: 4, padding: '2px 8px', cursor: 'pointer',
  },
  closeBtn: {
    font: 'inherit', color: '#d99', background: '#241a1d',
    border: '1px solid #4a2730', borderRadius: 4, padding: '2px 8px', cursor: 'pointer', marginLeft: 'auto',
  },
  mode: {
    font: 'inherit', fontSize: 11, color: '#8b9aa8', background: '#141a22',
    border: '1px solid #232b34', borderRadius: 4, padding: '2px 6px', cursor: 'pointer',
  },
  cyanOn: { color: '#08101a', background: '#6cf', border: '1px solid #6cf' },        // active mode / cam-lock
  editOn: { color: '#1a1206', background: '#f0b45a', border: '1px solid #f0b45a' },  // amber = editing
  liveOn: { color: '#08140c', background: '#7fe0a0', border: '1px solid #7fe0a0' },  // green = riding live
  readout: { color: '#6b7785', fontSize: 11, marginLeft: 'auto', whiteSpace: 'nowrap' },
  header: { display: 'flex', alignItems: 'center', gap: 6 },
  section: { display: 'flex', flexDirection: 'column', gap: 4, borderTop: '1px solid #1c222c', paddingTop: 5 },
  secHdr: {
    display: 'flex', alignItems: 'center', gap: 6, width: '100%', margin: 0, padding: 0,
    font: 'inherit', fontSize: 10, textAlign: 'left', color: '#8893a3',
    background: 'transparent', border: 'none', cursor: 'pointer',
  },
  caret: { flex: '0 0 auto', width: 9, fontSize: 8 },
  secName: { flex: '0 0 auto', textTransform: 'uppercase', letterSpacing: '0.08em' },
  secTitle: { flex: '1 1 auto', minWidth: 0, color: '#cdd6e2', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  secDot: { flex: '0 0 auto', fontSize: 8, color: '#9aa3b2' },
  secBody: { display: 'flex', flexDirection: 'column', gap: 5, paddingLeft: 15 },
  knob: { display: 'flex', flexDirection: 'column', gap: 2 },
  knobHead: { display: 'flex', alignItems: 'flex-start', gap: 4 },
  knobLabel: { flex: '1 1 auto', minWidth: 0, fontSize: 10, color: '#8893a3', whiteSpace: 'normal', overflowWrap: 'break-word', lineHeight: 1.3 },
  knobReset: { flex: '0 0 auto', font: 'inherit', fontSize: 12, lineHeight: 1, color: '#7c8596', background: 'transparent', border: 'none', cursor: 'pointer', padding: '0 2px' },
  slider: { flex: '1 1 auto', minWidth: 0, accentColor: '#6c8fc0', height: 12 },
  knobVal: { flex: '0 0 44px', textAlign: 'right', color: '#6b7785', fontSize: 10, fontVariantNumeric: 'tabular-nums' },
  knobOwn: { color: '#cdd6e2' },
  count: {
    width: 72, font: 'inherit', fontSize: 11, color: '#c8ccd6', background: '#0f141b',
    border: '1px solid #232b34', borderRadius: 4, padding: '1px 5px', outline: 'none', textAlign: 'right',
  },
  grip: { cursor: 'grab', color: '#4a5468', letterSpacing: -1, padding: '0 2px' },
  htitle: { color: '#9fd2ff', fontWeight: 600, fontSize: 11, letterSpacing: 0.4, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  collapse: { font: 'inherit', color: '#9ab', background: 'transparent', border: 'none', cursor: 'pointer', padding: '0 2px', lineHeight: 1 },
};
