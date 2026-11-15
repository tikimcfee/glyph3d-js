import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FONT_FAMILIES, FALLBACK_FONTS } from '@glyph3d/core/fonts/families.js';
import { zoomsWheel } from './chord.js';
import {
  CATEGORY_BY_ID,
  CATEGORY_GROUPS_TREE,
  categoryHue,
  expandCategoryTokens,
  groupSelectionState,
  isDefaultFilter,
  isExactFilter,
  agentViewRect,
  pickAgentSide,
} from './wallAgentView.js';

/** Build `@font-face` CSS once from `@glyph3d/core/fonts/families.js` so Agent Views share the exact terminal font faces. */
function buildFontFaceCss() {
  const rules = [];
  for (const [id, entry] of Object.entries(FONT_FAMILIES)) {
    const cssName = `glyph3d-${id}`;
    const f = entry.font;
    if (f.variations) {
      rules.push(
        `@font-face{font-family:'${cssName}';src:url('${f.url}') format('truetype');font-weight:200 800;font-style:oblique -11deg 0deg;font-display:swap;}`,
      );
    } else {
      rules.push(
        `@font-face{font-family:'${cssName}';src:url('${f.url}') format('truetype');font-weight:400;font-style:normal;font-display:swap;}`,
      );
      if (f.faces?.bold?.url) {
        rules.push(
          `@font-face{font-family:'${cssName}';src:url('${f.faces.bold.url}') format('truetype');font-weight:700;font-style:normal;font-display:swap;}`,
        );
      }
      if (f.faces?.italic?.url) {
        rules.push(
          `@font-face{font-family:'${cssName}';src:url('${f.faces.italic.url}') format('truetype');font-weight:400;font-style:italic;font-display:swap;}`,
        );
      }
      if (f.faces?.boldItalic?.url) {
        rules.push(
          `@font-face{font-family:'${cssName}';src:url('${f.faces.boldItalic.url}') format('truetype');font-weight:700;font-style:italic;font-display:swap;}`,
        );
      }
    }
  }
  FALLBACK_FONTS.forEach((fb, idx) => {
    rules.push(
      `@font-face{font-family:'glyph3d-fallback-${idx}';src:url('${fb.url}') format('truetype');font-weight:400;font-style:normal;font-display:swap;}`,
    );
  });
  return rules.join('\n');
}

const FONT_CSS = buildFontFaceCss();

function fontStackFor(familyId) {
  const fbs = FALLBACK_FONTS.map((_, i) => `'glyph3d-fallback-${i}'`).join(', ');
  return `'glyph3d-${familyId || 'monaspace-neon'}', ${fbs}, ui-monospace, monospace`;
}

const STATUS_DOT = {
  processing: { color: '#6ee7a0', char: '●', label: 'processing' },
  waiting:    { color: '#fbbf24', char: '●', label: 'waiting for you' },
  idle:       { color: '#60a5fa', char: '●', label: 'idle' },
  error:      { color: '#f87171', char: '●', label: 'error' },
  ended:      { color: '#6b7383', char: '○', label: 'ended' },
  unknown:    { color: '#7c8596', char: '◌', label: 'unknown' },
};

/**
 * Explicit border longhand helpers — avoids mixing CSS `border` shorthand with `borderColor`
 * overrides in React inline styles (which drops border colors on state transitions).
 */
function boxBorder(color, width = 'var(--av-hairline, 1px)', style = 'solid') {
  return {
    borderTopWidth: width,
    borderRightWidth: width,
    borderBottomWidth: width,
    borderLeftWidth: width,
    borderStyle: style,
    borderColor: color,
  };
}

function bottomBorder(color, width = 'var(--av-hairline, 1px)') {
  return {
    borderTopWidth: 0,
    borderRightWidth: 0,
    borderBottomWidth: width,
    borderLeftWidth: 0,
    borderStyle: 'solid',
    borderColor: color,
  };
}

function topBorder(color, width = 'var(--av-hairline, 1px)') {
  return {
    borderTopWidth: width,
    borderRightWidth: 0,
    borderBottomWidth: 0,
    borderLeftWidth: 0,
    borderStyle: 'solid',
    borderColor: color,
  };
}

/** Button that never steals DOM keyboard focus from the attached terminal. */
function ActionBtn({ buttonRef, style, onClick, children, ...rest }) {
  return (
    <button
      ref={buttonRef}
      type="button"
      tabIndex={-1}
      className="wall-agent-btn"
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.(e);
      }}
      style={style}
      {...rest}
    >
      {children}
    </button>
  );
}

/** Crisp tri-state checkbox (`'all'` -> ✓, `'some'` -> –, `'none'` -> empty) with visible idle border. */
function CheckBox({ state }) {
  const active = state === 'all' || state === 'some';
  return (
    <span
      aria-hidden="true"
      style={{
        ...styles.checkBox,
        background: state === 'all' ? '#1e3a5f' : state === 'some' ? '#192a44' : '#0b0f1e',
        borderColor: active ? '#5b8bd4' : '#43506a',
        color: state === 'all' ? '#93c5fd' : '#7fb3ee',
      }}
    >
      {state === 'all' ? '✓' : state === 'some' ? '–' : ''}
    </span>
  );
}

function sumCounts(counts, categoryIds) {
  if (!counts) return 0;
  let total = 0;
  for (const cid of categoryIds) total += counts[cid] || 0;
  return total;
}

/** Collapsible grouped category filter & subset expand/collapse menu drawer. */
function CategoryMenuDrawer({ wall, view, menuRef, onClose }) {
  const [folded, setFolded] = useState({});

  const toggleFold = (groupId) => {
    setFolded((prev) => ({ ...prev, [groupId]: !prev[groupId] }));
  };

  const toggleGroupFilter = (token, categoryIds) => {
    const st = groupSelectionState(view.filters, categoryIds);
    const mode = st === 'all' ? 'off' : 'on';
    wall.run(['wall.agent.filter', view.id, mode, token]);
  };

  const toggleSolo = (token, categoryIds) => {
    if (isExactFilter(view.filters, categoryIds)) {
      wall.run(['wall.agent.filter', view.id, 'reset']);
    } else {
      wall.run(['wall.agent.filter', view.id, 'only', token]);
    }
  };

  const expandSubset = async (token) => {
    const ids = expandCategoryTokens([token]);
    const anyEnabled = ids.some((cid) => !!view.filters[cid]);
    if (!anyEnabled) {
      await wall.run(['wall.agent.filter', view.id, 'on', token]);
    }
    await wall.run(['wall.agent.expand', view.id, token]);
  };

  const collapseSubset = (token) => {
    wall.run(['wall.agent.collapse', view.id, token]);
  };

  const renderCategoryRow = (catId, depth) => {
    const cat = CATEGORY_BY_ID[catId];
    if (!cat) return null;
    const checked = !!view.filters[catId];
    const solo = isExactFilter(view.filters, [catId]);
    const count = view.categoryCounts?.[catId] ?? 0;
    const hue = categoryHue(catId);

    return (
      <div
        key={catId}
        data-menu-category={catId}
        className="wall-agent-menu-row"
        style={{ ...styles.menuCatRow, paddingLeft: 8 + depth * 12 }}
      >
        <div
          data-filter={catId}
          style={styles.menuLabelHit}
          onClick={() => wall.run(['wall.agent.filter', view.id, 'toggle', catId])}
          title={`${cat.title} — click to show or hide`}
        >
          <CheckBox state={checked ? 'all' : 'none'} />
          <span style={{ ...styles.catDot, background: hue }} />
          <span style={{ ...styles.menuCatLabel, color: checked ? '#dce2ee' : '#7f8a9f' }}>
            {cat.short}
          </span>
          <span style={styles.menuCount}>{count}</span>
        </div>

        <span style={styles.menuRowBtns}>
          <ActionBtn
            data-filter-only={catId}
            style={{ ...styles.miniBtn, ...(solo ? styles.miniBtnActive : null) }}
            onClick={() => toggleSolo(catId, [catId])}
            title={solo ? 'Showing only this category — click to show all' : `Show only ${cat.short.toLowerCase()}`}
          >
            only
          </ActionBtn>
          <ActionBtn
            data-expand-subset={catId}
            style={styles.miniBtn}
            onClick={() => expandSubset(catId)}
            title={`Expand all ${cat.short.toLowerCase()}`}
          >
            exp
          </ActionBtn>
          <ActionBtn
            data-collapse-subset={catId}
            style={styles.miniBtn}
            onClick={() => collapseSubset(catId)}
            title={`Collapse ${cat.short.toLowerCase()}`}
          >
            col
          </ActionBtn>
        </span>
      </div>
    );
  };

  const renderGroupHeader = (group, depth = 0) => {
    const isFolded = !!folded[group.id];
    const st = groupSelectionState(view.filters, group.categories);
    const solo = isExactFilter(view.filters, group.categories);
    const count = sumCounts(view.categoryCounts, group.categories);

    return (
      <div
        data-menu-group={group.id}
        className="wall-agent-menu-row"
        style={{
          ...styles.menuGroupHeader,
          paddingLeft: 4 + depth * 12,
          background: depth === 0 ? '#12182d' : '#0f1527',
        }}
      >
        <ActionBtn
          data-group-fold={group.id}
          style={styles.foldBtn}
          onClick={() => toggleFold(group.id)}
          title={isFolded ? `Unfold ${group.label}` : `Fold ${group.label}`}
        >
          {isFolded ? '▸' : '▾'}
        </ActionBtn>

        <div
          data-filter-group={group.token}
          style={styles.menuLabelHit}
          onClick={() => toggleGroupFilter(group.token, group.categories)}
          title={`Toggle all categories in ${group.label}`}
        >
          <CheckBox state={st} />
          <span style={{
            ...styles.menuGroupLabel,
            color: st === 'none' ? '#8893a8' : '#e6ebf5',
            fontWeight: depth === 0 ? 700 : 600,
          }}>
            {group.label}
          </span>
          <span style={styles.menuCount}>{count}</span>
        </div>

        <span style={styles.menuRowBtns}>
          <ActionBtn
            data-filter-only={group.token}
            style={{ ...styles.miniBtn, ...(solo ? styles.miniBtnActive : null) }}
            onClick={() => toggleSolo(group.token, group.categories)}
            title={solo ? `Showing only ${group.label.toLowerCase()} — click to show all` : `Show only ${group.label.toLowerCase()}`}
          >
            only
          </ActionBtn>
          <ActionBtn
            data-expand-subset={group.token}
            style={styles.miniBtn}
            onClick={() => expandSubset(group.token)}
            title={`Expand all ${group.label.toLowerCase()}`}
          >
            exp
          </ActionBtn>
          <ActionBtn
            data-collapse-subset={group.token}
            style={styles.miniBtn}
            onClick={() => collapseSubset(group.token)}
            title={`Collapse ${group.label.toLowerCase()}`}
          >
            col
          </ActionBtn>
        </span>
      </div>
    );
  };

  const defaultActive = isDefaultFilter(view.filters);

  return (
    <div ref={menuRef} data-agent-menu={view.id} style={styles.menuDrawer}>
      <div style={styles.menuTopBar}>
        <span style={styles.menuTopTitle}>Action groups &amp; subsets</span>
        <span style={styles.menuRowBtns}>
          <ActionBtn
            data-filter="all"
            style={{ ...styles.miniBtn, ...(!defaultActive ? styles.resetBtnActive : null) }}
            onClick={() => wall.run(['wall.agent.filter', view.id, 'reset'])}
            title="Reset filter to show all standard categories"
          >
            show all
          </ActionBtn>
          <ActionBtn
            data-action="close-filter-menu"
            style={styles.miniBtn}
            onClick={onClose}
            title="Close menu"
          >
            done ▲
          </ActionBtn>
        </span>
      </div>

      {CATEGORY_GROUPS_TREE.map((group) => {
        const groupFolded = !!folded[group.id];
        return (
          <div key={group.id} style={styles.menuGroupSection}>
            {renderGroupHeader(group, 0)}
            {!groupFolded && (
              <>
                {group.subgroups.map((sub) => {
                  const subFolded = !!folded[sub.id];
                  return (
                    <div key={sub.id} style={styles.menuSubgroupSection}>
                      {renderGroupHeader(sub, 1)}
                      {!subFolded && sub.categories.map((cid) => renderCategoryRow(cid, 2))}
                    </div>
                  );
                })}
                {group.directCategories.map((cid) => renderCategoryRow(cid, 1))}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Single event row inside an Agent View stream. */
function EventRow({ wall, termId, row }) {
  const onShow = () => {
    wall.run(['wall.agent.show', termId, row.id, 'toggle']);
  };
  const onJump = () => {
    wall.run(['wall.agent.jump', termId, row.id]);
  };
  const onShowFull = () => {
    wall.run(['wall.agent.show', termId, row.id, 'full']);
  };

  return (
    <div
      data-agent-event={row.id}
      data-event-kind={row.eventKind}
      data-event-action={row.action}
      style={{
        ...styles.eventBlock,
        opacity: row.abandoned ? 0.48 : 1,
        background: row.jumped ? 'rgba(110, 231, 160, 0.09)' : (row.expanded ? '#0f1328' : 'transparent'),
      }}
    >
      <div className="wall-agent-row" style={styles.rowLine} onClick={onShow} title={`${row.tag}: ${row.summary}`}>
        <span style={{ ...styles.hueBar, background: row.hue }} />
        <span style={{ ...styles.tag, color: row.hue }}>{row.tag}</span>
        <span style={{
          ...styles.summary,
          color: row.status === 'error' ? '#f87171' : row.eventKind === 'think' ? '#9aa3b8' : '#d4d9e4',
          textDecoration: row.abandoned ? 'line-through' : 'none',
        }}>
          {row.summary}
        </span>
        {row.stat && (
          <span style={{
            ...styles.stat,
            color: row.status === 'error' ? '#f87171' : '#858fa3',
          }}>
            {row.stat}
          </span>
        )}
        <span className="wall-agent-actions" style={styles.rowActions} onClick={(e) => e.stopPropagation()}>
          <ActionBtn
            data-action="show"
            style={{ ...styles.rowBtn, ...(row.expanded ? styles.rowBtnActive : null) }}
            onClick={onShow}
            title={row.expanded ? 'Collapse event details' : 'Expand event details'}
          >
            {row.expanded ? 'hide' : 'show'}
          </ActionBtn>
          <ActionBtn
            data-action="jump"
            style={{ ...styles.rowBtn, ...(row.jumped ? styles.rowBtnJumpActive : null) }}
            onClick={onJump}
            title={row.exactAnchor ? 'Jump attached terminal to this event' : 'Jump attached terminal near this event'}
          >
            jump
          </ActionBtn>
        </span>
      </div>

      {row.expanded && row.detail && (
        <div style={styles.detailBox}>
          {(row.detail.facts.length > 0 || row.detail.target) && (
            <div style={styles.detailMeta}>
              {row.detail.target && <span style={styles.detailTarget}>{row.detail.target}</span>}
              {row.detail.facts.length > 0 && (
                <span style={styles.detailFacts}>{row.detail.facts.join(' · ')}</span>
              )}
            </div>
          )}
          {row.detail.detail && row.detail.detail !== row.summary && (
            <pre style={styles.detailHeaderPre}>{row.detail.detail}</pre>
          )}
          {row.detail.body ? (
            <pre style={styles.detailBodyPre}>{row.detail.body}</pre>
          ) : (
            !row.detail.detail && <div style={styles.detailEmpty}>(no output text)</div>
          )}
          {row.detail.truncated && (
            <ActionBtn data-action="show-full" style={styles.moreBtn} onClick={onShowFull}>
              show all {row.detail.totalLines} lines
            </ActionBtn>
          )}
        </div>
      )}
    </div>
  );
}

/** One terminal's world-anchored Agent View companion pane. */
function AgentViewCard({ wall, view, focused, fontFamily, onPreviewSide }) {
  const rootRef = useRef(null);
  const fullRef = useRef(null);
  const badgeRef = useRef(null);
  const listRef = useRef(null);
  const menuRef = useRef(null);
  const menuBtnRef = useRef(null);

  const [menuOpen, setMenuOpen] = useState(false);
  const [stickBottom, setStickBottom] = useState(true);
  const prevTailRef = useRef({ sessionId: null, count: 0, lastId: null });

  // Register DOM handles with `wall.agents` so `TerminalWall._tickChrome()` transforms them at 60fps.
  useLayoutEffect(() => {
    wall.agents.registerDom(view.id, {
      rootEl: rootRef.current,
      fullEl: fullRef.current,
      badgeEl: badgeRef.current,
    });
    wall.agents.updateScreenTransforms(wall.viewport);
    return () => wall.agents.registerDom(view.id, null);
  }, [wall, view.id]);

  // Re-sync screen box whenever side or dimensions change in React snapshot.
  useLayoutEffect(() => {
    wall.agents.updateScreenTransforms(wall.viewport);
  }, [wall, view.side, view.rows.length, focused]);

  // Auto-follow live bottom when at tail; preserve scroll offset when reading history above.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const lastId = view.rows.length ? view.rows[view.rows.length - 1].id : null;
    const prev = prevTailRef.current;
    const sessionChanged = prev.sessionId !== view.sessionId;
    const tailAdvanced = lastId !== prev.lastId || view.rows.length > prev.count;
    prevTailRef.current = { sessionId: view.sessionId, count: view.rows.length, lastId };

    if (sessionChanged || (stickBottom && tailAdvanced)) {
      el.scrollTop = el.scrollHeight;
    }
  }, [view.sessionId, view.rows, stickBottom]);

  // Dismiss open dropdown menu on outside click or Escape.
  useEffect(() => {
    if (!menuOpen) return undefined;
    const onPointerDown = (e) => {
      const t = /** @type {Node} */ (e.target);
      if (menuRef.current?.contains(t) || menuBtnRef.current?.contains(t)) return;
      setMenuOpen(false);
    };
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setMenuOpen(false);
      }
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [menuOpen]);

  const onListScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 24;
    if (atBottom !== stickBottom) setStickBottom(atBottom);
  };

  const scrollToTail = () => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setStickBottom(true);
  };

  // Forward canvas zoom-modified wheels (`Ctrl+wheel` pinch, `Cmd+wheel`, etc.) to `WallPointer`;
  // plain wheels scroll the event stream (or open category drawer) naturally.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      if (zoomsWheel(e, wall.config.zoomKeys)) {
        wall.pointer?._onWheel(e);
        return;
      }
      e.stopPropagation();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [wall]);

  // Header drag → live preview of right / left / top / bottom around the attached terminal.
  const onHeaderDown = (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('button, select, input')) return;
    e.preventDefault();
    e.stopPropagation();
    if (wall.focusedId !== view.id) wall.focus(view.id);

    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;
    let currentSide = view.side;

    const onMove = (me) => {
      if (!dragging && Math.hypot(me.clientX - startX, me.clientY - startY) < 5) return;
      dragging = true;
      const worldPt = wall.viewport.toWorld(me.clientX, me.clientY);
      const winRect = wall.windowRect(view.id);
      currentSide = pickAgentSide(winRect, worldPt);
      onPreviewSide({ id: view.id, side: currentSide });
    };
    const onEnd = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
      onPreviewSide(null);
      if (dragging && currentSide !== view.side) {
        wall.run(['wall.agent.side', view.id, currentSide]);
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd);
    window.addEventListener('pointercancel', onEnd);
  };

  const dot = STATUS_DOT[view.session?.status || (view.following ? 'idle' : 'unknown')] ?? STATUS_DOT.unknown;
  const fontStack = useMemo(() => fontStackFor(fontFamily), [fontFamily]);
  const filtered = !isDefaultFilter(view.filters);
  const denom = view.filters.noise ? view.totalCount : (view.standardCount ?? view.totalCount);
  const countText = filtered && denom !== view.visibleCount
    ? `${view.visibleCount}/${denom}`
    : `${view.visibleCount}`;

  return (
    <div
      ref={rootRef}
      data-agent-view={view.id}
      data-side={view.side}
      style={{
        ...styles.root,
        borderColor: focused ? '#4ade80' : '#4a5568',
        fontFamily: fontStack,
      }}
      onPointerDown={(e) => {
        e.stopPropagation();
        if (wall.focusedId !== view.id) wall.focus(view.id);
      }}
    >
      {/* Far-zoom compact badge (outer 1px border lives on unscaled `rootEl`) */}
      <div
        ref={badgeRef}
        data-agent-badge={view.id}
        style={{
          ...styles.badge,
          background: focused ? '#11261c' : '#121622',
        }}
        onClick={() => wall.run(['wall.reveal', view.id])}
        title={`${view.sessionLabel} (${view.visibleCount} events) — click to frame`}
      >
        <span style={{ color: dot.color }}>{dot.char}</span>
        <span style={styles.badgeText}>≡ {view.totalCount}</span>
      </div>

      {/* World-scaled sister terminal pane */}
      <div ref={fullRef} style={styles.card}>
        {/* Title / session header — drag to attach to right, left, top or bottom */}
        <div
          data-agent-header={view.id}
          onPointerDown={onHeaderDown}
          style={{
            ...styles.header,
            background: focused ? '#16402c' : '#1e2536',
            borderColor: focused ? '#265c40' : '#313b52',
            color: focused ? '#8ef0b8' : '#cbd3e1',
          }}
          title="Drag header to move Agent View to right, left, top or bottom of its terminal"
        >
          <span style={{ color: dot.color, flex: '0 0 auto' }} title={`session status: ${dot.label}`}>{dot.char}</span>
          <select
            data-action="session-select"
            value={view.sessionPinned === 'auto' ? 'auto' : (view.sessionId || view.sessionPinned)}
            onChange={(e) => wall.run(['wall.agent.session', view.id, e.target.value])}
            style={{
              ...styles.sessionSelect,
              color: focused ? '#b8f7d2' : '#d4d9e4',
            }}
            title="Paired agent session (auto-matches terminal directory, or pick any session / subagent)"
          >
            <option value="auto" style={styles.selectOption}>
              {view.sessionPinned === 'auto' && view.session
                ? `auto · ${view.sessionLabel}`
                : 'auto (match terminal cwd)'}
            </option>
            {view.sessions.map((s) => (
              <option key={s.session_id} value={s.session_id} style={styles.selectOption}>
                {s.status !== 'ended' ? '● ' : '○ '}{s.label}
              </option>
            ))}
          </select>

          {view.viewOffset > 0 && (
            <ActionBtn
              data-action="jump-live"
              style={styles.liveChip}
              onClick={() => wall.run(['wall.agent.jump', view.id, 'live'])}
              title="Return attached terminal from scrollback to live output"
            >
              ↑{view.viewOffset} · live
            </ActionBtn>
          )}
          <span style={styles.sideTag} title={`Attached on ${view.side} (drag header to move)`}>{view.side[0].toUpperCase()}</span>
          <ActionBtn
            data-action="close-agent"
            style={styles.closeBtn}
            onClick={() => wall.run(['wall.agent', view.id, 'close'])}
            title="Close Agent View (terminal keeps running)"
          >
            ×
          </ActionBtn>
        </div>

        {/* Clean single-row toolbar: collapsible grouped category menu + expand/collapse actions */}
        <div style={styles.toolbar}>
          <div style={styles.toolbarLeft}>
            <ActionBtn
              buttonRef={menuBtnRef}
              data-action="toggle-filter-menu"
              aria-expanded={menuOpen}
              style={{
                ...styles.filterTrigger,
                ...(filtered ? styles.filterTriggerFiltered : null),
                ...(menuOpen ? styles.filterTriggerOpen : null),
              }}
              onClick={() => setMenuOpen((o) => !o)}
              title="Filter or expand/collapse specific action groups & categories"
            >
              <span style={{ color: '#8ea4c8', flex: '0 0 auto' }}>{menuOpen ? '▴' : '▾'}</span>
              <span style={styles.filterTriggerText}>{view.filterLabel || 'all actions'}</span>
              <span style={styles.filterTriggerCount}>{countText}</span>
            </ActionBtn>
            {view.following && (
              <span style={styles.liveIndicator} title="Following live transcript stream">● live</span>
            )}
          </div>

          <span style={styles.toolbarRight}>
            <ActionBtn
              data-action="expand-all"
              style={styles.toolbarBtn}
              onClick={() => wall.run(['wall.agent.expand', view.id, 'all'])}
              title={filtered ? `Expand all visible (${view.filterLabel}) events` : 'Expand all visible events'}
            >
              + expand
            </ActionBtn>
            <ActionBtn
              data-action="collapse-all"
              style={{
                ...styles.toolbarBtn,
                ...(view.expandedCount > 0 ? styles.toolbarBtnActive : null),
              }}
              onClick={() => wall.run(['wall.agent.collapse', view.id, 'all'])}
              title="Collapse all expanded events"
            >
              − collapse
            </ActionBtn>
          </span>
        </div>

        {/* Body container: hosts collapsible grouped menu drawer + scrolling event stream */}
        <div style={styles.bodyWrap}>
          {menuOpen && (
            <CategoryMenuDrawer
              wall={wall}
              view={view}
              menuRef={menuRef}
              onClose={() => setMenuOpen(false)}
            />
          )}

          <div ref={listRef} onScroll={onListScroll} style={styles.list}>
            {view.hasEarlier && (
              <ActionBtn
                data-action="load-earlier"
                disabled={view.loadingEarlier}
                style={styles.earlierBtn}
                onClick={() => wall.run(['wall.agent.earlier', view.id])}
              >
                {view.loadingEarlier ? 'loading earlier…' : '↑ load earlier events'}
              </ActionBtn>
            )}

            {view.error && (
              <div style={styles.emptyState}>
                <div style={{ color: '#f0b089' }}>agent stream unavailable</div>
                <div style={{ color: '#7c8596', marginTop: 3 }}>{view.error}</div>
              </div>
            )}

            {!view.error && !view.sessionId && (
              <div style={styles.emptyState}>
                <div>no matching agent session for this terminal&apos;s directory yet</div>
                <div style={{ color: '#6b7383', marginTop: 3 }}>
                  start an agent in this terminal, or pick any session in the header above
                </div>
              </div>
            )}

            {!view.error && view.sessionId && view.loading && !view.rows.length && (
              <div style={styles.emptyState}>reading transcript…</div>
            )}

            {!view.error && view.sessionId && !view.loading && !view.rows.length && (
              <div style={styles.emptyState}>
                {view.totalCount > 0 ? (
                  <div>
                    <div>no events match &ldquo;{view.filterLabel}&rdquo;</div>
                    <ActionBtn
                      data-action="reset-empty-filter"
                      style={{ ...styles.moreBtn, marginTop: 6 }}
                      onClick={() => wall.run(['wall.agent.filter', view.id, 'reset'])}
                    >
                      show all actions
                    </ActionBtn>
                  </div>
                ) : 'waiting for first event…'}
              </div>
            )}

            {view.rows.map((row) => (
              <EventRow key={row.id} wall={wall} termId={view.id} row={row} />
            ))}
          </div>

          {!stickBottom && view.rows.length > 0 && (
            <ActionBtn data-action="follow-tail" style={styles.followBar} onClick={scrollToTail}>
              ↓ follow live stream
            </ActionBtn>
          )}
        </div>
      </div>
    </div>
  );
}

/** Drop-side preview outline shown around a terminal while dragging its Agent View header. */
function DropSideGhost({ wall, preview }) {
  if (!preview || !wall.terminal(preview.id)) return null;
  const body = wall.terminalRect(preview.id);
  const bar = wall.names ? wall.names.barHeight(preview.id, wall.viewport.zoom) : 0;
  const worldRect = agentViewRect(body, bar, preview.side, wall.agents.dims());
  const box = wall.viewport.toScreenBox(worldRect);
  return (
    <div
      data-agent-drop-ghost={preview.side}
      style={{
        position: 'absolute',
        left: Math.round(box.left),
        top: Math.round(box.top),
        width: Math.max(4, Math.round(box.right - box.left)),
        height: Math.max(4, Math.round(box.bottom - box.top)),
        ...boxBorder('#6ee7a0', '1.5px', 'dashed'),
        background: 'rgba(110, 231, 160, 0.08)',
        pointerEvents: 'none',
        zIndex: 6,
        boxSizing: 'border-box',
      }}
    />
  );
}

/** Overlay layer rendering every open world-anchored Agent View on the wall canvas. */
export default function AgentViewOverlay({ wall, state }) {
  const [preview, setPreview] = useState(null);
  const views = state.agentViews || [];
  if (!views.length || state.fullscreen) return null;

  return (
    <>
      <style>{`
        ${FONT_CSS}
        .wall-agent-btn:focus, .wall-agent-btn:focus-visible { outline: none; }
        .wall-agent-btn:hover { filter: brightness(1.14); }
        .wall-agent-row:hover { background: rgba(255, 255, 255, 0.05); }
        .wall-agent-row .wall-agent-actions { opacity: 0.88; }
        .wall-agent-row:hover .wall-agent-actions { opacity: 1; }
        .wall-agent-menu-row:hover { background: rgba(255, 255, 255, 0.04); }
      `}</style>
      {preview && <DropSideGhost wall={wall} preview={preview} />}
      {views.map((v) => (
        <AgentViewCard
          key={v.id}
          wall={wall}
          view={v}
          focused={state.focusedId === v.id}
          fontFamily={state.config.fontFamily}
          onPreviewSide={setPreview}
        />
      ))}
    </>
  );
}

const styles = {
  root: {
    position: 'absolute',
    left: 0,
    top: 0,
    willChange: 'transform',
    userSelect: 'none',
    boxSizing: 'border-box',
    overflow: 'hidden',
    background: '#0a0a1e',
    ...boxBorder('#4a5568', '1px'),
  },
  badge: {
    display: 'none',
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    color: '#c4ccd8',
    fontSize: 11,
    padding: '0 6px',
    cursor: 'pointer',
    boxSizing: 'border-box',
    overflow: 'hidden',
    whiteSpace: 'nowrap',
  },
  badgeText: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    transformOrigin: '0 0',
    background: '#0a0a1e',
    boxSizing: 'border-box',
    overflow: 'hidden',
    fontSize: 11,
    lineHeight: '15px',
    color: '#d4d9e4',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    height: 22,
    padding: '0 5px 0 7px',
    ...bottomBorder('#313b52'),
    cursor: 'grab',
    flex: '0 0 auto',
    boxSizing: 'border-box',
  },
  sessionSelect: {
    flex: '1 1 auto',
    minWidth: 0,
    background: 'transparent',
    ...boxBorder('transparent', '0px'),
    font: 'inherit',
    fontSize: 10.5,
    padding: 0,
    cursor: 'pointer',
    outline: 'none',
    textOverflow: 'ellipsis',
  },
  selectOption: {
    backgroundColor: '#13182a',
    color: '#d4d9e4',
  },
  liveChip: {
    flex: '0 0 auto',
    background: '#1a3026',
    color: '#8ef0b8',
    ...boxBorder('#356b4f'),
    borderRadius: 0,
    font: 'inherit',
    fontSize: 9.5,
    lineHeight: '14px',
    padding: '0 4px',
    cursor: 'pointer',
  },
  sideTag: {
    flex: '0 0 auto',
    color: '#858fa3',
    fontSize: 9.5,
    padding: '0 2px',
  },
  closeBtn: {
    flex: '0 0 auto',
    width: 16,
    height: 16,
    padding: 0,
    background: 'transparent',
    color: 'inherit',
    ...boxBorder('transparent', '0px'),
    font: 'inherit',
    fontSize: 13,
    lineHeight: '16px',
    cursor: 'pointer',
    textAlign: 'center',
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 5,
    height: 24,
    padding: '0 5px',
    background: '#0e1224',
    ...bottomBorder('#263149'),
    flex: '0 0 auto',
    boxSizing: 'border-box',
  },
  toolbarLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    flex: '1 1 auto',
    minWidth: 0,
  },
  toolbarRight: {
    display: 'flex',
    alignItems: 'center',
    gap: 3,
    flex: '0 0 auto',
  },
  filterTrigger: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    maxWidth: '100%',
    minWidth: 0,
    background: '#151c33',
    color: '#d8dfec',
    ...boxBorder('#384562'),
    borderRadius: 0,
    padding: '1px 6px',
    font: 'inherit',
    fontSize: 9.5,
    lineHeight: '14px',
    cursor: 'pointer',
  },
  filterTriggerFiltered: {
    background: '#172540',
    color: '#e6f0ff',
    borderColor: '#4c74b4',
  },
  filterTriggerOpen: {
    background: '#1d2b49',
    borderColor: '#6992d6',
  },
  filterTriggerText: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  filterTriggerCount: {
    flex: '0 0 auto',
    color: '#8da0be',
    fontSize: 9,
    paddingLeft: 2,
  },
  liveIndicator: {
    flex: '0 0 auto',
    color: '#6ee7a0',
    fontSize: 9,
    whiteSpace: 'nowrap',
  },
  toolbarBtn: {
    background: '#141b30',
    color: '#b8c2d4',
    ...boxBorder('#34415c'),
    borderRadius: 0,
    font: 'inherit',
    fontSize: 9.5,
    lineHeight: '14px',
    padding: '1px 5px',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  toolbarBtnActive: {
    background: '#1b2640',
    color: '#dce5f5',
    borderColor: '#4a5f88',
  },
  bodyWrap: {
    position: 'relative',
    flex: '1 1 auto',
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
  },
  menuDrawer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    maxHeight: 'calc(100% - 8px)',
    overflowY: 'auto',
    overflowX: 'hidden',
    zIndex: 5,
    background: '#0d1223',
    ...bottomBorder('#415378'),
    boxShadow: '0 8px 22px rgba(0, 0, 0, 0.65)',
  },
  menuTopBar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 4,
    padding: '4px 6px',
    background: '#141c34',
    ...bottomBorder('#283450'),
  },
  menuTopTitle: {
    color: '#93a3bf',
    fontSize: 9.5,
    fontWeight: 600,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  menuGroupSection: {
    ...bottomBorder('#1e273d'),
  },
  menuSubgroupSection: {
    ...bottomBorder('#171f33'),
  },
  menuGroupHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    minHeight: 20,
    padding: '2px 5px 2px 4px',
    ...bottomBorder('#1a2236'),
  },
  menuCatRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    minHeight: 19,
    padding: '1px 5px 1px 16px',
  },
  foldBtn: {
    flex: '0 0 auto',
    width: 13,
    height: 14,
    padding: 0,
    background: 'transparent',
    color: '#8b97ae',
    ...boxBorder('transparent', '0px'),
    font: 'inherit',
    fontSize: 9.5,
    lineHeight: '14px',
    cursor: 'pointer',
    textAlign: 'center',
  },
  menuLabelHit: {
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    flex: '1 1 auto',
    minWidth: 0,
    cursor: 'pointer',
    padding: '1px 0',
  },
  checkBox: {
    flex: '0 0 auto',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 11,
    height: 11,
    ...boxBorder('#43506a'),
    fontSize: 8.5,
    lineHeight: '10px',
    fontWeight: 700,
    boxSizing: 'border-box',
  },
  catDot: {
    flex: '0 0 auto',
    width: 7,
    height: 7,
  },
  menuGroupLabel: {
    flex: '1 1 auto',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: 10,
  },
  menuCatLabel: {
    flex: '1 1 auto',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: 9.5,
  },
  menuCount: {
    flex: '0 0 auto',
    color: '#6e798f',
    fontSize: 9,
    paddingRight: 2,
  },
  menuRowBtns: {
    display: 'flex',
    alignItems: 'center',
    gap: 2,
    flex: '0 0 auto',
  },
  miniBtn: {
    background: '#151d33',
    color: '#9fb0ca',
    ...boxBorder('#313e59'),
    borderRadius: 0,
    padding: '0 4px',
    font: 'inherit',
    fontSize: 8.5,
    lineHeight: '13px',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  miniBtnActive: {
    background: '#1e3558',
    color: '#e6f0ff',
    borderColor: '#5c8be0',
  },
  resetBtnActive: {
    background: '#193529',
    color: '#95f3be',
    borderColor: '#3a7a5c',
  },
  list: {
    flex: '1 1 auto',
    overflowY: 'auto',
    overflowX: 'hidden',
    padding: '2px 0',
  },
  earlierBtn: {
    display: 'block',
    width: '100%',
    background: '#11172c',
    color: '#96a2b8',
    ...bottomBorder('#242f47'),
    padding: '3px 6px',
    font: 'inherit',
    fontSize: 9.5,
    cursor: 'pointer',
    textAlign: 'center',
  },
  emptyState: {
    padding: '12px 10px',
    color: '#7c8596',
    fontSize: 10.5,
    lineHeight: '15px',
  },
  eventBlock: {
    ...bottomBorder('#192138'),
  },
  rowLine: {
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    minHeight: 19,
    padding: '1px 5px 1px 0',
    cursor: 'pointer',
  },
  hueBar: {
    width: 3,
    alignSelf: 'stretch',
    flex: '0 0 auto',
  },
  tag: {
    flex: '0 0 auto',
    minWidth: 38,
    maxWidth: 68,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontWeight: 700,
    fontSize: 10,
  },
  summary: {
    flex: '1 1 auto',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: 10.5,
  },
  stat: {
    flex: '0 0 auto',
    fontSize: 9.5,
    whiteSpace: 'nowrap',
  },
  rowActions: {
    display: 'flex',
    alignItems: 'center',
    gap: 2,
    flex: '0 0 auto',
  },
  rowBtn: {
    background: '#141b30',
    color: '#a8b4c9',
    ...boxBorder('#323f59'),
    borderRadius: 0,
    padding: '0 4px',
    font: 'inherit',
    fontSize: 9.5,
    lineHeight: '14px',
    cursor: 'pointer',
  },
  rowBtnActive: {
    background: '#202e4c',
    color: '#e6edf8',
    borderColor: '#5672a8',
  },
  rowBtnJumpActive: {
    background: '#173a29',
    color: '#93f2bc',
    borderColor: '#3d855f',
  },
  detailBox: {
    padding: '4px 7px 6px 10px',
    ...topBorder('#222c46'),
    background: '#080b19',
    userSelect: 'text',
  },
  detailMeta: {
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: 6,
    marginBottom: 3,
    fontSize: 9.5,
  },
  detailTarget: {
    color: '#93c5fd',
    wordBreak: 'break-all',
  },
  detailFacts: {
    color: '#788296',
  },
  detailHeaderPre: {
    margin: '0 0 4px 0',
    padding: '3px 5px',
    background: '#10162b',
    ...boxBorder('#25304c'),
    color: '#c4ccd8',
    font: 'inherit',
    fontSize: 10,
    lineHeight: '14px',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  detailBodyPre: {
    margin: 0,
    padding: '4px 5px',
    background: '#0b0f1f',
    ...boxBorder('#202a44'),
    color: '#cfd6e3',
    font: 'inherit',
    fontSize: 10,
    lineHeight: '14px',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    maxHeight: 220,
    overflowY: 'auto',
  },
  detailEmpty: {
    color: '#5d6574',
    fontSize: 10,
    fontStyle: 'italic',
  },
  moreBtn: {
    marginTop: 4,
    background: '#151e36',
    color: '#93c5fd',
    ...boxBorder('#334770'),
    borderRadius: 0,
    padding: '1px 6px',
    font: 'inherit',
    fontSize: 9.5,
    cursor: 'pointer',
  },
  followBar: {
    flex: '0 0 auto',
    background: '#132b20',
    color: '#8ef0b8',
    ...topBorder('#2d664c'),
    padding: '2px 6px',
    font: 'inherit',
    fontSize: 9.5,
    cursor: 'pointer',
    textAlign: 'center',
  },
};
