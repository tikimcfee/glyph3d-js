import AgentSessionProvider from '@glyph3d/core/services/data/AgentSessionProvider.js';
import { AgentEventReader, eventRecord } from '@glyph3d/core/collections/agentEvents.js';
import {
    AGENT_SIDES,
    CATEGORY_IDS,
    DEFAULT_FILTERS,
    categoriesOfRecord,
    normalizeFilters,
    applyFilterChange,
    describeActiveFilter,
    matchesFilter,
    matchesSubset,
    summarizeEventRow,
    formatExpandedEvent,
    agentViewRect,
    footprintTileMetrics,
    matchTerminalSession,
    formatSessionLabel,
    extractProtocolTerminalLine,
    computeJumpOffset,
} from './wallAgentView.js';

/** Tail byte window requested on initial open and each `loadEarlier` page. */
const STREAM_WINDOW_BYTES = 256 * 1024;

/** Base zoom (CSS px / world unit) at which an Agent View lays out its internal CSS box. */
export const AGENT_BASE_ZOOM = 4;

/** Minimum rendered font size (CSS px) before an Agent View collapses to its far-zoom badge. */
const BADGE_FLOOR_PX = 7.2;
const BASE_FONT_PX = 11;

/**
 * @typedef {Object} AgentViewEntry
 * @property {boolean} open
 * @property {'right'|'left'|'top'|'bottom'} side
 * @property {string} sessionPinned - `'auto'` or an explicit `session_id` / workgroup name
 * @property {Record<string, boolean>} filters
 * @property {Set<string>} expandedIds
 * @property {Set<string>} fullBodyIds - events whose truncated file/output body was expanded in full
 * @property {Map<string, import('./wallAgentView.js').LineAnchor>} anchors
 * @property {string|null} resolvedSessionId
 * @property {string|null} jumpedEventId
 */

/**
 * @typedef {Object} SessionStream
 * @property {string} sessionId
 * @property {Map<string, { event: Object, pos: { at: number, line?: number, seq?: number }|null }>} entries
 * @property {string[]} order
 * @property {Map<string, Object>} orphans - updates whose adds predate the loaded window
 * @property {Object|null} sessionLine - latest `{"type":"session", ...}` frame from stream
 * @property {number|null} oldestAt - byte offset of oldest loaded `add`, for `loadEarlier`
 * @property {number|null} lastAt - byte offset where live `follow` resumes (non-provisional)
 * @property {number|null} transcriptSize
 * @property {boolean} loading
 * @property {boolean} loadingEarlier
 * @property {boolean} hasEarlier
 * @property {boolean} following
 * @property {string|null} error
 * @property {(() => void)|null} unsub
 * @property {AgentEventReader} liveReader
 * @property {number} generation
 */

/**
 * WallAgentViews — coordinates per-terminal Agent Views on the 2D wall:
 *   - Discovers sessions through `AgentSessionProvider` (`agentSessions/*`) and pairs them with
 *     running terminals using `termd/status` (`pwd`, `cwd`, `gx-<name>`, or manual pin).
 *   - Hydrates and follows `gomuxai` event streams (`agentEvents/read`, `agentEvents/follow`),
 *     folding `add`/`update` frames in place via `AgentEventReader`.
 *   - Stamps terminal scrollback line anchors as live events write into the stream, and jumps the
 *     attached terminal (`terminal.scroll <id> to <offset>` / `live`) when `jump` is clicked.
 *   - Positions world-anchored DOM cards in `TerminalWall._tickChrome()` at 60fps without React
 *     re-renders during camera pan/zoom.
 */
export default class WallAgentViews {
    /** @param {import('./TerminalWall.js').default} wall */
    constructor(wall) {
        this.wall = wall;
        /** @type {AgentSessionProvider|null} */
        this.provider = null;
        /** Reason `agentSessions/*` is unavailable on this relay (e.g. `--no-gomuxai`), or null. */
        this.unavailableReason = null;

        /** @type {Map<string, AgentViewEntry>} terminal id → view state */
        this._views = new Map();
        /** @type {Map<string, SessionStream>} session_id → shared stream */
        this._streams = new Map();
        /** @type {Map<string, { scrollbackRows: number, gridScrolledAtSync: number, view: number, alt: boolean, pwd: string, cwd: string, title: string }>} */
        this._termSync = new Map();
        /** @type {Map<string, { rootEl: HTMLElement, fullEl: HTMLElement, badgeEl: HTMLElement, lastKey: string }>} */
        this._dom = new Map();

        this._offSessions = null;
        this._offTermd = null;

        this._hydrateFromStore();
    }

    // ── lifecycle ────────────────────────────────────────────────────────────

    /** @param {import('@glyph3d/core/services/orchestration/WebSocketBridge.js').default} bridge */
    start(bridge) {
        this.provider = new AgentSessionProvider(bridge);
        this._offSessions = this.provider.onSessions(() => {
            this.unavailableReason = null;
            this._rebindAll();
            this.wall._emit();
        });
        this._offTermd = this.wall.termd.onChange(() => this._onTermdStatus());
        this._onTermdStatus();
    }

    /** Called by `TerminalWall` each time the display registers (`{ ok: true }`) on the relay. */
    async onRelayUp() {
        if (!this.provider) return;
        try {
            await this.provider.list();
            this.unavailableReason = null;
            this._rebindAll({ restartFollows: true });
            this.wall._emit();
        } catch (e) {
            const msg = String(e?.message || e || 'agent sessions unavailable');
            this.unavailableReason = msg;
            this.wall._emit();
        }
    }

    stop() {
        this._offTermd?.();
        this._offTermd = null;
        this._offSessions?.();
        this._offSessions = null;
        for (const stream of this._streams.values()) {
            stream.generation++;
            stream.unsub?.();
            stream.unsub = null;
            stream.following = false;
        }
        this._streams.clear();
        this.provider?.dispose();
        this.provider = null;
        this._dom.clear();
    }

    // ── store hydration & pruning ────────────────────────────────────────────

    _hydrateFromStore() {
        const saved = this.wall.store.agentViews?.() ?? {};
        for (const [id, raw] of Object.entries(saved)) {
            if (!raw || typeof raw !== 'object') continue;
            const entry = this._ensureEntry(id);
            entry.open = !!raw.open;
            entry.side = AGENT_SIDES.includes(raw.side) ? raw.side : this.wall.config.agentViewSide;
            entry.sessionPinned = typeof raw.session === 'string' && raw.session ? raw.session : 'auto';
            entry.filters = normalizeFilters(raw.filters);
        }
    }

    _persist(id) {
        const v = this._views.get(id);
        if (!v) return;
        this.wall.store.setAgentView(id, {
            open: v.open,
            side: v.side,
            session: v.sessionPinned,
            filters: v.filters,
        });
    }

    /** @param {string} id @returns {AgentViewEntry} */
    _ensureEntry(id) {
        let v = this._views.get(id);
        if (!v) {
            v = {
                open: false,
                side: this.wall.config.agentViewSide || 'right',
                sessionPinned: 'auto',
                filters: { ...DEFAULT_FILTERS },
                expandedIds: new Set(),
                fullBodyIds: new Set(),
                anchors: new Map(),
                resolvedSessionId: null,
                jumpedEventId: null,
            };
            this._views.set(id, v);
        }
        return v;
    }

    /** Drop runtime state for terminals that were killed or pruned. @param {(id: string) => boolean} isLive */
    prune(isLive) {
        let changed = false;
        for (const id of [...this._views.keys()]) {
            if (!isLive(id)) {
                this._views.delete(id);
                this._termSync.delete(id);
                this._dom.delete(id);
                changed = true;
            }
        }
        if (changed) this._gcStreams();
    }

    // ── queries & geometry ───────────────────────────────────────────────────

    /** Whether an Agent View is open on terminal `id`. @param {string} id */
    isOpen(id) {
        return !!this._views.get(id)?.open && !!this.wall.terminal(id);
    }

    /** Side (`right`|`left`|`top`|`bottom`) for `id`, or null when closed. @param {string} id */
    sideOf(id) {
        return this.isOpen(id) ? this._views.get(id).side : null;
    }

    /** Configured world dimensions `{ width, height, gap }` from `wall.config`. */
    dims() {
        const c = this.wall.config;
        return {
            width: c.agentViewWidth,
            height: c.agentViewHeight,
            gap: c.agentViewGap,
        };
    }

    /**
     * World-space rect of `id`'s open Agent View at `zoom`, or null when closed.
     * @param {string} id
     * @param {number} [zoom]
     * @returns {import('./wallLayout.js').Rect|null}
     */
    rect(id, zoom = this.wall.viewport.zoom) {
        if (!this.isOpen(id)) return null;
        const body = this.wall.canvasTerminalRect ? this.wall.canvasTerminalRect(id) : this.wall.terminalRect(id);
        const bar = this.wall.names ? this.wall.names.barHeight(id, zoom) : 0;
        return agentViewRect(body, bar, this._views.get(id).side, this.dims());
    }

    /**
     * Zoom-invariant tiling metrics for `WallGroups`.
     * @param {string} id
     */
    tileMetrics(id) {
        const body = this.wall.canvasTerminalRect ? this.wall.canvasTerminalRect(id) : this.wall.terminalRect(id);
        return footprintTileMetrics(body, this.sideOf(id), this.dims());
    }

    /** Current estimated primary-screen `scrollback_rows` for terminal `id`. @param {string} id */
    scrollbackNow(id) {
        const sync = this._termSync.get(id);
        const grid = this.wall.terminal(id);
        if (!sync) return grid?.scrolledRows ?? 0;
        const liveDelta = (!sync.alt && sync.view === 0 && grid)
            ? Math.max(0, (grid.scrolledRows ?? 0) - sync.gridScrolledAtSync)
            : 0;
        return sync.scrollbackRows + liveDelta;
    }

    /** Current `termd` subscriber `view` offset (`0` = live) for terminal `id`. @param {string} id */
    viewOffsetOf(id) {
        return this._termSync.get(id)?.view ?? 0;
    }

    /** Whether terminal `id` is currently on the alternate screen. @param {string} id */
    isAltScreen(id) {
        return !!(this.wall.terminal(id)?.altScreen || this._termSync.get(id)?.alt);
    }

    // ── commands / mutations ─────────────────────────────────────────────────

    /**
     * Open, close or toggle a terminal's Agent View, optionally setting its side.
     * @param {string} id
     * @param {'toggle'|'open'|'close'|'on'|'off'|'right'|'left'|'top'|'bottom'} [how='toggle']
     * @param {'right'|'left'|'top'|'bottom'|null} [side=null]
     */
    setOpen(id, how = 'toggle', side = null) {
        this._requireTerminal(id);
        const v = this._ensureEntry(id);
        if (AGENT_SIDES.includes(how)) {
            v.open = true;
            v.side = /** @type {any} */ (how);
        } else if (how === 'toggle') {
            v.open = !v.open;
        } else if (how === 'open' || how === 'on') {
            v.open = true;
        } else if (how === 'close' || how === 'off') {
            v.open = false;
        } else {
            throw new Error(`agent view takes toggle|open|close|right|left|top|bottom, not '${how}'`);
        }
        if (side != null) {
            if (!AGENT_SIDES.includes(side)) throw new Error(`side is right|left|top|bottom, not '${side}'`);
            v.side = side;
        }
        this._persist(id);
        this._rebindOne(id);
        this._gcStreams();
        this.wall.groups?.relayoutOf(id);
        this.wall._emit();
        return { open: v.open, side: v.side, session: v.resolvedSessionId };
    }

    /**
     * Move a terminal's Agent View to `side` (`right`|`left`|`top`|`bottom`), opening it if closed.
     * @param {string} id
     * @param {'right'|'left'|'top'|'bottom'} side
     */
    setSide(id, side) {
        if (!AGENT_SIDES.includes(side)) throw new Error(`side is right|left|top|bottom, not '${side}'`);
        return this.setOpen(id, 'open', side);
    }

    /**
     * Pin `id`'s Agent View to a specific session (`session_id`, workgroup name, or `'auto'`).
     * @param {string} id
     * @param {string} [session='auto']
     */
    setSession(id, session = 'auto') {
        this._requireTerminal(id);
        const v = this._ensureEntry(id);
        const target = (session || 'auto').trim() || 'auto';
        if (target !== 'auto' && this.provider?.sessions.length) {
            const found = matchTerminalSession({}, this.provider.sessions, target);
            if (!found) throw new Error(`no agent session matching '${target}'`);
            v.sessionPinned = found.session_id;
        } else {
            v.sessionPinned = target;
        }
        v.expandedIds.clear();
        v.fullBodyIds.clear();
        v.jumpedEventId = null;
        this._persist(id);
        this._rebindOne(id);
        this._gcStreams();
        this.wall._emit();
        return { id, pinned: v.sessionPinned, resolved: v.resolvedSessionId };
    }

    /**
     * Change `id`'s active category filters (`reset`|`only`|`on`|`off`|`toggle`).
     * @param {string} id
     * @param {'reset'|'only'|'on'|'off'|'toggle'} mode
     * @param {string[]} [tokens]
     */
    setFilter(id, mode, tokens = []) {
        this._requireTerminal(id);
        const v = this._ensureEntry(id);
        v.filters = applyFilterChange(v.filters, mode, tokens);
        this._persist(id);
        this.wall._emit();
        return { id, filters: { ...v.filters } };
    }

    /**
     * Toggle or set expansion (`show`/`hide`) on a single event row.
     * @param {string} id
     * @param {string} eventId
     * @param {'toggle'|'on'|'off'} [how='toggle']
     */
    toggleEvent(id, eventId, how = 'toggle') {
        this._requireTerminal(id);
        if (!eventId) throw new Error('name an event id');
        const v = this._ensureEntry(id);
        const next = how === 'toggle' ? !v.expandedIds.has(eventId) : how === 'on';
        if (next) v.expandedIds.add(eventId);
        else {
            v.expandedIds.delete(eventId);
            v.fullBodyIds.delete(eventId);
        }
        this.wall._emit();
        return { id, eventId, expanded: next };
    }

    /** Expand the full uncapped text of a truncated event body. */
    showFullBody(id, eventId) {
        this._requireTerminal(id);
        const v = this._ensureEntry(id);
        v.fullBodyIds.add(eventId);
        this.wall._emit();
    }

    /**
     * Bulk expand (`expand = true`) or collapse (`expand = false`) all visible events or a subset
     * of action categories/groups (e.g. `['tools']`, `['read', 'image']`, `['all']`).
     * @param {string} id
     * @param {boolean} expand
     * @param {string[]} [tokens]
     */
    setBulkExpanded(id, expand, tokens = []) {
        this._requireTerminal(id);
        const v = this._ensureEntry(id);
        if (!expand && (!tokens.length || tokens.some((t) => String(t).toLowerCase() === 'all'))) {
            const count = v.expandedIds.size;
            v.expandedIds.clear();
            v.fullBodyIds.clear();
            this.wall._emit();
            return { id, changed: count, expandedCount: 0 };
        }
        const records = expand ? this._visibleRecords(v) : this._allRecords(v);
        let changed = 0;
        for (const { rec } of records) {
            if (!matchesSubset(rec, tokens)) continue;
            if (expand && !v.expandedIds.has(rec.id)) {
                v.expandedIds.add(rec.id);
                changed++;
            } else if (!expand && v.expandedIds.has(rec.id)) {
                v.expandedIds.delete(rec.id);
                v.fullBodyIds.delete(rec.id);
                changed++;
            }
        }
        this.wall._emit();
        return { id, changed, expandedCount: v.expandedIds.size };
    }

    /**
     * Jump the attached terminal `id` to `target` (`'live'` or an `eventId` in its transcript).
     * Routes through the command bus (`terminal.scroll <id> live` or `terminal.scroll <id> to <offset>`).
     * @param {string} id
     * @param {string} target - `'live'` or an event id
     */
    async jump(id, target = 'live') {
        this._requireTerminal(id);
        const v = this._ensureEntry(id);
        if (this.isAltScreen(id)) {
            const msg = `${this.wall.nameOf(id)} is on the alternate screen — primary scrollback jump is unavailable while a full-screen TUI is active`;
            this.wall.notify(msg);
            throw new Error(msg);
        }

        if (!target || target === 'live') {
            v.jumpedEventId = null;
            const sync = this._termSync.get(id);
            if (sync) {
                sync.scrollbackRows = this.scrollbackNow(id);
                sync.gridScrolledAtSync = this.wall.terminal(id)?.scrolledRows ?? 0;
                sync.view = 0;
            }
            await this.wall.run(['terminal.scroll', id, 'live']);
            this.wall._emit();
            return { id, live: true, offset: 0 };
        }

        const stream = v.resolvedSessionId ? this._streams.get(v.resolvedSessionId) : null;
        const entry = stream?.entries.get(target);
        if (!entry) throw new Error(`no event '${target}' in ${id}'s agent stream`);

        const nowScrollback = this.scrollbackNow(id);
        let anchor = v.anchors.get(target);
        if (!anchor) {
            const proto = extractProtocolTerminalLine(entry.event);
            if (proto != null) anchor = { terminalLine: proto, exact: true };
            else anchor = this._approximateAnchor(stream, entry, nowScrollback);
            if (anchor) v.anchors.set(target, anchor);
        }

        const offset = computeJumpOffset(anchor, nowScrollback);
        v.jumpedEventId = target;
        const sync = this._termSync.get(id);
        if (sync) {
            sync.scrollbackRows = nowScrollback;
            sync.gridScrolledAtSync = this.wall.terminal(id)?.scrolledRows ?? 0;
            sync.view = offset;
        }

        if (offset === 0) await this.wall.run(['terminal.scroll', id, 'live']);
        else await this.wall.run(['terminal.scroll', id, 'to', String(offset)]);
        this.wall._emit();
        return { id, eventId: target, offset, nowScrollback, exact: !!anchor?.exact };
    }

    /** Load an older page of transcript events before `oldestAt` for `id`'s active session. */
    async loadEarlier(id) {
        this._requireTerminal(id);
        const v = this._views.get(id);
        const sid = v?.resolvedSessionId;
        if (!sid) throw new Error(`${id} has no active agent session`);
        const stream = this._streams.get(sid);
        if (!stream || stream.loadingEarlier || !stream.hasEarlier || !(stream.oldestAt > 0)) {
            return { id, loaded: 0, hasEarlier: !!stream?.hasEarlier };
        }
        stream.loadingEarlier = true;
        this.wall._emit();
        const gen = stream.generation;
        try {
            const res = await this.provider.read(sid, { until: stream.oldestAt, tail: STREAM_WINDOW_BYTES });
            if (stream.generation !== gen) return { id, loaded: 0, hasEarlier: stream.hasEarlier };
            const reader = new AgentEventReader({ retain: true });
            const changes = reader.push(res.lines.length ? `${res.lines.join('\n')}\n` : '');
            changes.push(...reader.end());

            let minAt = stream.oldestAt;
            const olderIds = [];
            for (const eid of reader.order) {
                const item = reader.byId.get(eid);
                if (!item) continue;
                if (item.pos?.at != null && item.pos.at < minAt) minAt = item.pos.at;
                if (stream.entries.has(eid)) continue;
                // Adopt any orphan update that landed inside the newer window.
                const orphanEv = stream.orphans.get(eid);
                if (orphanEv) stream.orphans.delete(eid);
                stream.entries.set(eid, { event: orphanEv ?? item.event, pos: item.pos });
                olderIds.push(eid);
            }
            for (const c of changes) {
                if (c.op === 'update' && !c.pos && !stream.entries.has(c.event.id)) {
                    stream.orphans.set(c.event.id, c.event);
                }
            }
            if (olderIds.length) {
                stream.order = [...olderIds, ...stream.order];
                stream.oldestAt = minAt;
                stream.hasEarlier = minAt > 0;
                this._seedHydratedAnchors(sid);
            } else {
                stream.hasEarlier = false;
            }
            return { id, loaded: olderIds.length, hasEarlier: stream.hasEarlier };
        } catch (e) {
            stream.error = String(e?.message || e);
            throw e;
        } finally {
            if (stream.generation === gen) {
                stream.loadingEarlier = false;
                this.wall._emit();
            }
        }
    }

    // ── snapshot & UI view descriptors ───────────────────────────────────────

    /** Summary attached to each terminal in `wall.snapshot().terminals`, plus `wall.snapshot().agentViews`. */
    describe(id) {
        const v = this._views.get(id);
        if (!v || !v.open || !this.wall.terminal(id)) return null;
        const sessions = this.provider?.sessions ?? [];
        const activeSession = v.resolvedSessionId
            ? (sessions.find((s) => s.session_id === v.resolvedSessionId) ?? null)
            : null;
        const stream = v.resolvedSessionId ? this._streams.get(v.resolvedSessionId) : null;
        const categoryCounts = Object.fromEntries(CATEGORY_IDS.map((cid) => [cid, 0]));
        const visible = [];
        if (stream) {
            for (const eid of stream.order) {
                const item = stream.entries.get(eid);
                if (!item) continue;
                const rec = eventRecord(item.event, item.pos, { showNoise: true });
                if (!rec) continue;
                for (const cid of categoriesOfRecord(rec)) {
                    if (cid in categoryCounts) categoryCounts[cid]++;
                }
                if (!matchesFilter(rec, v.filters)) continue;
                visible.push({ rec, ev: item.event, pos: item.pos });
            }
        }
        const totalCount = stream ? stream.order.length : 0;
        const standardCount = Math.max(0, totalCount - (categoryCounts.noise || 0));

        const rows = visible.map(({ rec, ev }) => {
            const expanded = v.expandedIds.has(rec.id);
            const row = summarizeEventRow(rec, { abandoned: !!ev.abandoned });
            return {
                ...row,
                expanded,
                jumped: v.jumpedEventId === rec.id,
                exactAnchor: !!v.anchors.get(rec.id)?.exact,
                detail: expanded
                    ? formatExpandedEvent(rec, { full: v.fullBodyIds.has(rec.id) })
                    : null,
            };
        });

        return {
            id,
            open: true,
            side: v.side,
            sessionPinned: v.sessionPinned,
            sessionId: v.resolvedSessionId,
            session: activeSession,
            sessionLabel: formatSessionLabel(activeSession ?? stream?.sessionLine),
            sessions: this._candidateSessions(id, sessions, activeSession),
            filters: { ...v.filters },
            filterLabel: describeActiveFilter(v.filters),
            categoryCounts,
            expandedCount: v.expandedIds.size,
            totalCount,
            standardCount,
            visibleCount: rows.length,
            loading: !!stream?.loading,
            loadingEarlier: !!stream?.loadingEarlier,
            hasEarlier: !!stream?.hasEarlier,
            following: !!stream?.following,
            error: stream?.error || this.unavailableReason || null,
            viewOffset: this.viewOffsetOf(id),
            altScreen: this.isAltScreen(id),
            rows,
        };
    }

    /** Candidate sessions shown in `id`'s header picker: matching sessions first, subagents grouped under parent, then recent others. */
    _candidateSessions(id, sessions, active) {
        const meta = this._termMeta(id);
        const dirPwd = meta.pwd || meta.cwd || '';
        const scored = sessions.map((s) => {
            const sameDir = dirPwd && s.cwd && s.cwd.replace(/\/+$/, '') === dirPwd.replace(/\/+$/, '');
            const isSubOfActive = active && s.parent_session?.session_id === active.session_id;
            const isActive = active && s.session_id === active.session_id;
            const live = s.status !== 'ended';
            const rank = (isActive ? 100 : 0) + (isSubOfActive ? 60 : 0) + (sameDir ? 40 : 0) + (live ? 10 : 0);
            return { s, rank };
        });
        scored.sort((a, b) => b.rank - a.rank);
        return scored.slice(0, 24).map(({ s }) => ({
            session_id: s.session_id,
            label: formatSessionLabel(s),
            status: s.status || 'unknown',
            harness: s.harness || '',
            cwd: s.cwd || '',
            isSubagent: !!s.parent_session,
        }));
    }

    /** Visible records for `v` in arrival order after applying `v.filters`. */
    _visibleRecords(v, stream = v.resolvedSessionId ? this._streams.get(v.resolvedSessionId) : null) {
        if (!stream) return [];
        const showNoise = !!v.filters.noise;
        const out = [];
        for (const eid of stream.order) {
            const item = stream.entries.get(eid);
            if (!item) continue;
            const rec = eventRecord(item.event, item.pos, { showNoise });
            if (!rec) continue;
            if (!matchesFilter(rec, v.filters)) continue;
            out.push({ rec, ev: item.event, pos: item.pos });
        }
        return out;
    }

    /** All loaded records for `v` (including noise), used when collapsing subsets regardless of active filter. */
    _allRecords(v, stream = v.resolvedSessionId ? this._streams.get(v.resolvedSessionId) : null) {
        if (!stream) return [];
        const out = [];
        for (const eid of stream.order) {
            const item = stream.entries.get(eid);
            if (!item) continue;
            const rec = eventRecord(item.event, item.pos, { showNoise: true });
            if (!rec) continue;
            out.push({ rec, ev: item.event, pos: item.pos });
        }
        return out;
    }

    // ── 60fps DOM positioning (`TerminalWall._tickChrome`) ───────────────────

    /**
     * Register or unregister a mounted Agent View card's DOM elements for direct per-frame camera
     * transform updates.
     * @param {string} id
     * @param {{ rootEl: HTMLElement, fullEl: HTMLElement, badgeEl: HTMLElement }|null} els
     */
    registerDom(id, els) {
        if (!els) {
            this._dom.delete(id);
            return;
        }
        this._dom.set(id, { ...els, lastKey: '' });
    }

    /**
     * Place every mounted Agent View card in screen space from `viewport` (`WallCamera`).
     * Runs once per frame inside `TerminalWall._tickChrome()` — zero React state updates during pan/zoom.
     *
     * Note on borders: `rootEl` carries the unscaled 1px outer frame snapped to integer screen pixels
     * so the card's outer border never thins below 1px or clips on fractional DPR coordinates; `fullEl`
     * scales inside `rootEl`'s content box and sets `--av-hairline` >= `ceil(1 / scale)` so internal
     * borders/dividers never snap to `0px` at any zoom level.
     *
     * @param {import('./WallCamera.js').default} viewport
     */
    updateScreenTransforms(viewport) {
        if (!this._dom.size) return;
        const fsId = this.wall.fullscreen?.id;
        const zoom = viewport.zoom;
        const view = viewport.view;

        for (const [id, dom] of this._dom) {
            if (fsId || !this.wall.onCanvas(id) || !this.isOpen(id)) {
                if (dom.lastKey !== 'hidden') {
                    dom.lastKey = 'hidden';
                    dom.rootEl.style.display = 'none';
                }
                continue;
            }
            const worldRect = this.rect(id, zoom);
            if (!worldRect) continue;
            const box = viewport.toScreenBox(worldRect);
            if (box.right < 0 || box.left > view.w || box.bottom < 0 || box.top > view.h) {
                if (dom.lastKey !== 'culled') {
                    dom.lastKey = 'culled';
                    dom.rootEl.style.display = 'none';
                }
                continue;
            }

            const scale = zoom / AGENT_BASE_ZOOM;
            const badgeMode = BASE_FONT_PX * scale < BADGE_FLOOR_PX;
            const focused = this.wall.focusedId === id;
            const left = Math.round(box.left);
            const top = Math.round(box.top);
            const screenW = Math.max(badgeMode ? 28 : 8, Math.round(box.right) - left);
            const screenH = Math.max(badgeMode ? 18 : 8, Math.round(box.bottom) - top);
            const key = `${left}|${top}|${screenW}|${screenH}|${scale.toFixed(4)}|${badgeMode ? 1 : 0}|${focused ? 1 : 0}`;
            if (key === dom.lastKey) continue;
            dom.lastKey = key;

            dom.rootEl.style.display = 'block';
            dom.rootEl.style.zIndex = focused ? '4' : '3';
            dom.rootEl.style.width = `${screenW}px`;
            dom.rootEl.style.height = `${screenH}px`;
            dom.rootEl.style.transform = `translate3d(${left}px, ${top}px, 0)`;

            if (badgeMode) {
                dom.fullEl.style.display = 'none';
                dom.badgeEl.style.display = 'flex';
            } else {
                const innerW = Math.max(1, screenW - 2);
                const innerH = Math.max(1, screenH - 2);
                const hairlinePx = Math.max(1, Math.ceil(1 / scale));
                dom.badgeEl.style.display = 'none';
                dom.fullEl.style.display = 'flex';
                dom.fullEl.style.width = `${(innerW / scale).toFixed(2)}px`;
                dom.fullEl.style.height = `${(innerH / scale).toFixed(2)}px`;
                dom.fullEl.style.transform = `scale(${scale.toFixed(5)})`;
                dom.fullEl.style.setProperty('--av-hairline', `${hairlinePx}px`);
            }
        }
    }

    // ── internals: termd sync, session pairing & stream folding ──────────────

    _requireTerminal(id) {
        if (!id) throw new Error('name a terminal');
        if (!this.wall.terminal(id)) throw new Error(`no terminal '${id}'`);
    }

    _termMeta(id) {
        const row = this.wall.termd.terminal(id);
        const grid = this.wall.terminal(id);
        return {
            id,
            pwd: row?.pwd || '',
            cwd: row?.cwd || '',
            title: this.wall.store.name(id) || row?.title || grid?.windowTitle || '',
        };
    }

    _onTermdStatus() {
        let rebindNeeded = false;
        for (const row of this.wall.termd.terminals) {
            const prev = this._termSync.get(row.id);
            const grid = this.wall.terminal(row.id);
            let maxView = 0;
            if (Array.isArray(row.subscribers)) {
                for (const sub of row.subscribers) {
                    if (Number.isFinite(sub.view) && sub.view > maxView) maxView = sub.view;
                }
            }
            const next = {
                scrollbackRows: Number.isFinite(row.scrollback_rows) ? row.scrollback_rows : 0,
                gridScrolledAtSync: grid?.scrolledRows ?? 0,
                view: maxView,
                alt: !!row.alt,
                pwd: row.pwd || '',
                cwd: row.cwd || '',
                title: row.title || '',
            };
            if (!prev || prev.pwd !== next.pwd || prev.cwd !== next.cwd) rebindNeeded = true;
            this._termSync.set(row.id, next);
        }
        if (rebindNeeded) this._rebindAll();
        this.wall._emit();
    }

    _rebindAll({ restartFollows = false } = {}) {
        for (const id of this._views.keys()) {
            if (this.wall.terminal(id)) this._rebindOne(id, { restartFollows });
        }
        this._gcStreams();
    }

    _rebindOne(id, { restartFollows = false } = {}) {
        const v = this._views.get(id);
        if (!v || !v.open) {
            if (v) v.resolvedSessionId = null;
            return;
        }
        const sessions = this.provider?.sessions ?? [];
        const matched = matchTerminalSession(this._termMeta(id), sessions, v.sessionPinned);
        const nextSid = matched?.session_id ?? (v.sessionPinned !== 'auto' ? v.sessionPinned : null);
        if (nextSid !== v.resolvedSessionId) {
            v.resolvedSessionId = nextSid;
            v.anchors.clear();
            v.jumpedEventId = null;
        }
        if (nextSid && this.provider) {
            this._ensureStream(nextSid, matched, { restartFollows });
            this._seedHydratedAnchors(nextSid);
        }
    }

    _gcStreams() {
        const wanted = new Set();
        for (const [id, v] of this._views) {
            if (v.open && v.resolvedSessionId && this.wall.terminal(id)) {
                wanted.add(v.resolvedSessionId);
            }
        }
        for (const [sid, stream] of this._streams) {
            if (wanted.has(sid)) continue;
            stream.generation++;
            stream.unsub?.();
            stream.unsub = null;
            if (stream.following && this.provider && this.wall.bridge?.connected) {
                this.provider.unfollow(sid).catch(() => {});
            }
            stream.following = false;
            this._streams.delete(sid);
        }
    }

    _ensureStream(sessionId, sessionInfo, { restartFollows = false } = {}) {
        let stream = this._streams.get(sessionId);
        if (!stream) {
            stream = {
                sessionId,
                entries: new Map(),
                order: [],
                orphans: new Map(),
                sessionLine: null,
                oldestAt: null,
                lastAt: null,
                transcriptSize: null,
                loading: false,
                loadingEarlier: false,
                hasEarlier: false,
                following: false,
                error: null,
                unsub: null,
                liveReader: new AgentEventReader({ retain: false }),
                generation: 1,
            };
            this._streams.set(sessionId, stream);
            this._openStream(stream, sessionInfo);
            return stream;
        }
        const shouldFollow = !sessionInfo || sessionInfo.status !== 'ended';
        if (restartFollows && !stream.loading) {
            stream.following = false;
            if (shouldFollow) this._startFollow(stream);
        } else if (!stream.following && !stream.loading && shouldFollow) {
            this._startFollow(stream);
        }
        return stream;
    }

    async _openStream(stream, sessionInfo) {
        if (!this.provider) return;
        const gen = stream.generation;
        stream.loading = true;
        stream.error = null;
        try {
            const { lines, size } = await this.provider.read(stream.sessionId, { tail: STREAM_WINDOW_BYTES });
            if (stream.generation !== gen) return;
            stream.transcriptSize = size;
            const reader = new AgentEventReader({ retain: true });
            const changes = reader.push(lines.length ? `${lines.join('\n')}\n` : '');
            changes.push(...reader.end());

            if (reader.session) stream.sessionLine = reader.session;
            stream.lastAt = reader.lastAt;
            let minAt = Infinity;
            for (const eid of reader.order) {
                const item = reader.byId.get(eid);
                if (!item) continue;
                if (item.pos?.at != null && item.pos.at < minAt) minAt = item.pos.at;
                stream.entries.set(eid, { event: item.event, pos: item.pos });
                stream.order.push(eid);
            }
            for (const c of changes) {
                if (c.op === 'update' && !c.pos && !stream.entries.has(c.event.id)) {
                    stream.orphans.set(c.event.id, c.event);
                }
            }
            stream.oldestAt = Number.isFinite(minAt) ? minAt : 0;
            stream.hasEarlier = stream.oldestAt > 0;
            stream.loading = false;

            this._seedHydratedAnchors(stream.sessionId);

            const latestMeta = this.provider.sessions.find((s) => s.session_id === stream.sessionId) ?? sessionInfo;
            if (!latestMeta || latestMeta.status !== 'ended') {
                await this._startFollow(stream);
            }
            this.wall._emit();
        } catch (e) {
            if (stream.generation !== gen) return;
            stream.loading = false;
            stream.error = String(e?.message || e);
            this.wall._emit();
        }
    }

    async _startFollow(stream) {
        if (!this.provider || stream.following) return;
        const gen = stream.generation;

        // Per EVENTS.md: drop uncommitted provisional replies before resuming a follow from `lastAt`.
        for (const eid of [...stream.order]) {
            const item = stream.entries.get(eid);
            if (item?.event?.kind === 'say' && item.event.say?.provisional) {
                stream.entries.delete(eid);
                stream.order = stream.order.filter((x) => x !== eid);
            }
        }

        stream.unsub?.();
        stream.liveReader = new AgentEventReader({ retain: false });
        stream.unsub = this.provider.subscribe(stream.sessionId, {
            lines: (lines) => this._onStreamLines(stream, lines),
            ended: () => {
                stream.following = false;
                this.wall._emit();
            },
        });
        stream.following = true;
        try {
            await this.provider.follow(stream.sessionId, { from: stream.lastAt });
        } catch (e) {
            if (stream.generation !== gen) return;
            stream.following = false;
            stream.error = String(e?.message || e);
            this.wall._emit();
        }
    }

    _onStreamLines(stream, lines) {
        if (!lines?.length) return;
        let changed = false;
        for (const raw of lines) {
            if (!raw || !raw.trim()) continue;
            let frame;
            try { frame = JSON.parse(raw); } catch { continue; }
            let change;
            try { change = stream.liveReader.accept(frame, `follow ${stream.sessionId}`); }
            catch (e) {
                console.warn('[agent-view] bad stream frame:', e.message);
                continue;
            }
            if (!change) continue;
            if (stream.liveReader.lastAt != null && (stream.lastAt == null || stream.liveReader.lastAt > stream.lastAt)) {
                stream.lastAt = stream.liveReader.lastAt;
            }
            if (change.op === 'session') {
                stream.sessionLine = change.session;
                changed = true;
                continue;
            }
            const ev = change.event;
            const existing = stream.entries.get(ev.id);
            if (existing) {
                existing.event = ev;
                const proto = extractProtocolTerminalLine(ev);
                if (proto != null) this._stampProtocolLine(stream.sessionId, ev.id, proto);
                changed = true;
            } else if (change.op === 'add') {
                const pos = change.pos ?? { at: ev.at, line: ev.line, seq: ev.seq };
                if (stream.oldestAt == null) stream.oldestAt = pos.at;
                stream.entries.set(ev.id, { event: ev, pos });
                stream.order.push(ev.id);
                this._stampLiveAdd(stream.sessionId, ev);
                changed = true;
            } else {
                stream.orphans.set(ev.id, ev);
            }
        }
        if (changed) this.wall._emit();
    }

    /** Stamp live terminal scrollback coordinates onto every open Agent View watching `sessionId`. */
    _stampLiveAdd(sessionId, ev) {
        const proto = extractProtocolTerminalLine(ev);
        for (const [termId, v] of this._views) {
            if (!v.open || v.resolvedSessionId !== sessionId) continue;
            if (proto != null) {
                v.anchors.set(ev.id, { terminalLine: proto, exact: true });
                continue;
            }
            const grid = this.wall.terminal(termId);
            const sync = this._termSync.get(termId);
            const cursorRow = sync?.view > 0 ? 0 : (grid?.cursorRow ?? 0);
            v.anchors.set(ev.id, {
                scrollbackRows: this.scrollbackNow(termId),
                cursorRow,
                exact: true,
            });
        }
    }

    _stampProtocolLine(sessionId, eventId, terminalLine) {
        for (const v of this._views.values()) {
            if (v.open && v.resolvedSessionId === sessionId) {
                v.anchors.set(eventId, { terminalLine, exact: true });
            }
        }
    }

    /** Seed anchors for historical events loaded via `agentEvents/read` when not already stamped. */
    _seedHydratedAnchors(sessionId) {
        const stream = this._streams.get(sessionId);
        if (!stream || !stream.order.length) return;
        for (const [termId, v] of this._views) {
            if (!v.open || v.resolvedSessionId !== sessionId) continue;
            const nowSb = this.scrollbackNow(termId);
            for (const eid of stream.order) {
                if (v.anchors.has(eid)) continue;
                const entry = stream.entries.get(eid);
                if (!entry) continue;
                const proto = extractProtocolTerminalLine(entry.event);
                if (proto != null) {
                    v.anchors.set(eid, { terminalLine: proto, exact: true });
                } else if (nowSb > 0) {
                    const approx = this._approximateAnchor(stream, entry, nowSb);
                    if (approx) v.anchors.set(eid, approx);
                }
            }
        }
    }

    _approximateAnchor(stream, entry, nowScrollback) {
        if (!stream || !entry || !(nowScrollback > 0)) return null;
        const at = entry.pos?.at ?? entry.event?.at ?? 0;
        const maxAt = Math.max(stream.transcriptSize || 0, stream.lastAt || 0, at, 1);
        const frac = Math.max(0, Math.min(1, at / maxAt));
        return { terminalLine: Math.round(frac * nowScrollback), exact: false };
    }
}
