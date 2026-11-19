/**
 * wallAgentView — pure geometry, categorization, session pairing, row formatting and scrollback
 * jump math for a terminal's attached Agent View on the 2D wall canvas.
 *
 * Protocol-pure: reads records produced by `@glyph3d/core/collections/agentEvents.js` (the contract
 * in `gomuxai`'s `docs/EVENTS.md`) and action identities from `@glyph3d/core/collections/toolRegistry.js`,
 * paired with `termd` 1.4 status fields (`pwd`, `cwd`, `scrollback_rows`, `alt`, `view`).
 * Zero THREE, zero DOM — imported directly by unit tests and wall modules alike.
 */

import { eventFacts } from '@glyph3d/core/collections/agentEvents.js';
import { kindForAction, ACTION_HUES, cssHue } from '@glyph3d/core/collections/toolRegistry.js';
import { BAR_ROOM } from './wallLayout.js';

/** Which side of a terminal its Agent View sits on. */
export const AGENT_SIDES = Object.freeze(['right', 'left', 'top', 'bottom']);

/**
 * Filterable / expandable action categories in display order.
 * Every record maps to at least one category (`categoriesOfRecord`).
 */
export const CATEGORIES = Object.freeze([
    { id: 'prompt', label: 'prompt', short: 'Prompts',         title: 'Prompts & messages into the agent' },
    { id: 'think',  label: 'think',  short: 'Thinking',        title: 'Interior reasoning / thinking steps' },
    { id: 'say',    label: 'say',    short: 'Replies',         title: 'Agent replies' },
    { id: 'read',   label: 'read',   short: 'File reads',      title: 'Text file reads' },
    { id: 'image',  label: 'image',  short: 'Image reads',     title: 'Image file reads' },
    { id: 'edit',   label: 'edit',   short: 'Edits & writes',  title: 'File edits & writes' },
    { id: 'run',    label: 'run',    short: 'Commands & tasks', title: 'Shell commands & background tasks' },
    { id: 'search', label: 'search', short: 'Search & web',    title: 'Grep, glob, web search & fetch' },
    { id: 'ask',    label: 'ask',    short: 'Ask & skills',    title: 'Questions, peer messages, skills & other tools' },
    { id: 'system', label: 'system', short: 'System',          title: 'Harness system records & model requests' },
    { id: 'noise',  label: 'noise',  short: 'Bookkeeping',     title: 'Bookkeeping calls (TodoWrite, ToolSearch, …)' },
]);

export const CATEGORY_BY_ID = Object.freeze(
    Object.fromEntries(CATEGORIES.map((c) => [c.id, c])),
);

export const CATEGORY_IDS = Object.freeze(CATEGORIES.map((c) => c.id));

/** Content categories shown by default (`all`); `noise` stays off until asked for. */
export const STANDARD_CATEGORY_IDS = Object.freeze(CATEGORY_IDS.filter((id) => id !== 'noise'));

/** Named action subsets accepted by filter, expand and collapse commands and UI groups. */
export const CATEGORY_GROUPS = Object.freeze({
    all: CATEGORY_IDS,
    standard: STANDARD_CATEGORY_IDS,
    conversation: Object.freeze(['prompt', 'think', 'say']),
    messages: Object.freeze(['prompt', 'say']),
    msgs: Object.freeze(['prompt', 'say']),
    tools: Object.freeze(['read', 'image', 'edit', 'run', 'search', 'ask']),
    tool: Object.freeze(['read', 'image', 'edit', 'run', 'search', 'ask']),
    reads: Object.freeze(['read', 'image']),
    files: Object.freeze(['read', 'image', 'edit']),
    system_all: Object.freeze(['system', 'noise']),
});

/**
 * Explicit hierarchical grouping of action categories for the collapsible filter & expand menu:
 *   1. Conversation (`prompt`, `think`, `say`)
 *   2. Tool calls (`tools`), with nested subgroup File & image reads (`reads`: `read`, `image`)
 *      plus `edit`, `run`, `search`, `ask`
 *   3. System & bookkeeping (`system`, `noise`)
 */
export const CATEGORY_GROUPS_TREE = Object.freeze([
    Object.freeze({
        id: 'conversation',
        label: 'Conversation',
        token: 'conversation',
        categories: CATEGORY_GROUPS.conversation,
        subgroups: Object.freeze([]),
        directCategories: CATEGORY_GROUPS.conversation,
    }),
    Object.freeze({
        id: 'tools',
        label: 'Tool calls',
        token: 'tools',
        categories: CATEGORY_GROUPS.tools,
        subgroups: Object.freeze([
            Object.freeze({
                id: 'reads',
                label: 'File & image reads',
                token: 'reads',
                categories: CATEGORY_GROUPS.reads,
            }),
        ]),
        directCategories: Object.freeze(['edit', 'run', 'search', 'ask']),
    }),
    Object.freeze({
        id: 'system_all',
        label: 'System & bookkeeping',
        token: 'system_all',
        categories: CATEGORY_GROUPS.system_all,
        subgroups: Object.freeze([]),
        directCategories: CATEGORY_GROUPS.system_all,
    }),
]);

/** Default category filter map: every standard category on, `noise` off. */
export const DEFAULT_FILTERS = Object.freeze(
    Object.fromEntries(CATEGORY_IDS.map((id) => [id, id !== 'noise'])),
);

/** Distinct cyan-blue hue for image reads so they stand slightly apart from text file reads. */
const IMAGE_HUE = Object.freeze({ r: 0.32, g: 0.80, b: 0.94 });

/**
 * Identity color (CSS hex) for a category id — matches the left hue bar on event rows.
 * @param {string} categoryId
 * @returns {string}
 */
export function categoryHue(categoryId) {
    if (categoryId === 'image') return cssHue(IMAGE_HUE);
    return cssHue(ACTION_HUES[categoryId] ?? ACTION_HUES.other);
}

// ── categorization & subset matching ─────────────────────────────────────────

/**
 * Whether a tool record is an image read (`Read` of an image file: gomuxai sets `meta.bytes` on
 * image reads per `EVENTS.md`).
 * @param {Object} rec
 * @returns {boolean}
 */
export function isImageToolRead(rec) {
    return rec?.eventKind === 'tool' && rec.action === 'read' && Number(rec.meta?.bytes) > 0;
}

/**
 * Categories a record belongs to: every event maps cleanly to its action category (`read` for text
 * file reads, `image` for image file reads where `meta.bytes > 0`, etc.) so `only tools` never
 * pulls in prompts and `only reads` selects file + image reads cleanly.
 * @param {Object} rec - record from `agentEvents.eventRecord`
 * @returns {string[]}
 */
export function categoriesOfRecord(rec) {
    if (!rec) return [];
    switch (rec.eventKind) {
        case 'prompt':
            return ['prompt'];
        case 'think':
            return ['think'];
        case 'say':
            return ['say'];
        case 'system':
        case 'request':
            return ['system'];
        case 'tool': {
            const a = String(rec.action || '').toLowerCase();
            if (a === 'noise') return ['noise'];
            if (a === 'read') return isImageToolRead(rec) ? ['image'] : ['read'];
            if (a === 'edit' || a === 'write') return ['edit'];
            if (a === 'bash' || a === 'task') return ['run'];
            if (a === 'grep' || a === 'glob' || a === 'search' || a === 'fetch') return ['search'];
            return ['ask'];
        }
        default:
            return ['system'];
    }
}

/**
 * Expand one or more category / group tokens into validated category ids. Throws naming any unknown
 * token so CLI verbs fail loud.
 * @param {string[]} tokens
 * @returns {string[]}
 */
export function expandCategoryTokens(tokens) {
    const out = new Set();
    for (const raw of tokens) {
        for (const tok of String(raw).toLowerCase().split(/[,\s]+/).filter(Boolean)) {
            if (tok in CATEGORY_GROUPS) {
                for (const id of CATEGORY_GROUPS[tok]) out.add(id);
            } else if (CATEGORY_IDS.includes(tok)) {
                out.add(tok);
            } else {
                throw new Error(
                    `unknown action category '${tok}' (categories: ${CATEGORY_IDS.join(', ')}; groups: all, conversation, tools, reads, files, messages, system_all)`,
                );
            }
        }
    }
    return [...out];
}

/**
 * Normalize a persisted or partial filter object against `DEFAULT_FILTERS`.
 * @param {Record<string, boolean>|null|undefined} raw
 * @returns {Record<string, boolean>}
 */
export function normalizeFilters(raw) {
    const out = { ...DEFAULT_FILTERS };
    if (!raw || typeof raw !== 'object') return out;
    for (const id of CATEGORY_IDS) {
        if (typeof raw[id] === 'boolean') out[id] = raw[id];
    }
    return out;
}

/**
 * Whether `filters` currently shows every standard category (`all` default).
 * @param {Record<string, boolean>} filters
 * @returns {boolean}
 */
export function isAllStandardSelected(filters) {
    return STANDARD_CATEGORY_IDS.every((id) => !!filters?.[id]);
}

/**
 * Whether `filters` equals `DEFAULT_FILTERS` (every standard category on, `noise` off).
 * @param {Record<string, boolean>} filters
 * @returns {boolean}
 */
export function isDefaultFilter(filters) {
    return isAllStandardSelected(filters) && !filters?.noise;
}

/**
 * Tri-state selection state (`'all' | 'some' | 'none'`) for a group of category ids.
 * @param {Record<string, boolean>} filters
 * @param {readonly string[]} categoryIds
 * @returns {'all'|'some'|'none'}
 */
export function groupSelectionState(filters, categoryIds) {
    let onCount = 0;
    for (const id of categoryIds) {
        if (filters?.[id]) onCount++;
    }
    if (onCount === 0) return 'none';
    if (onCount === categoryIds.length) return 'all';
    return 'some';
}

/**
 * Whether `filters` has ONLY `targetIds` enabled across all `CATEGORY_IDS`.
 * @param {Record<string, boolean>} filters
 * @param {readonly string[]} targetIds
 * @returns {boolean}
 */
export function isExactFilter(filters, targetIds) {
    const set = new Set(targetIds);
    return CATEGORY_IDS.every((id) => !!filters?.[id] === set.has(id));
}

/**
 * Human-readable summary of the active filter map for the collapsed dropdown trigger button.
 * @param {Record<string, boolean>} filters
 * @returns {string}
 */
export function describeActiveFilter(filters) {
    if (isAllStandardSelected(filters)) {
        return filters?.noise ? 'all + noise' : 'all actions';
    }
    const enabled = CATEGORY_IDS.filter((id) => !!filters?.[id]);
    if (enabled.length === 0) return 'none';
    if (isExactFilter(filters, CATEGORY_GROUPS.conversation)) return 'conversation';
    if (isExactFilter(filters, CATEGORY_GROUPS.messages)) return 'messages';
    if (isExactFilter(filters, CATEGORY_GROUPS.tools)) return 'tool calls';
    if (isExactFilter(filters, CATEGORY_GROUPS.reads)) return 'file & img reads';
    if (isExactFilter(filters, CATEGORY_GROUPS.files)) return 'file ops';
    if (isExactFilter(filters, CATEGORY_GROUPS.system_all)) return 'system & noise';
    if (enabled.length === 1) {
        const c = CATEGORY_BY_ID[enabled[0]];
        return c ? c.short.toLowerCase() : enabled[0];
    }
    if (enabled.length === 2) {
        return `${enabled[0]} + ${enabled[1]}`;
    }
    return `${enabled.length} categories`;
}

/**
 * Apply a filter mutation (`reset` | `only` | `on` | `off` | `toggle`) and return a fresh map.
 * @param {Record<string, boolean>} current
 * @param {'reset'|'only'|'on'|'off'|'toggle'} mode
 * @param {string[]} [tokens]
 * @returns {Record<string, boolean>}
 */
export function applyFilterChange(current, mode, tokens = []) {
    const cur = normalizeFilters(current);
    if (mode === 'reset') return { ...DEFAULT_FILTERS };
    const cats = expandCategoryTokens(tokens);
    if (!cats.length) throw new Error('name at least one category or group (e.g. tools, reads, read, image, edit, run, think, say, prompt, noise)');
    if (mode === 'only') {
        const hasAll = tokens.some((t) => String(t).toLowerCase() === 'all');
        if (hasAll) return Object.fromEntries(CATEGORY_IDS.map((id) => [id, true]));
        const set = new Set(cats);
        const next = Object.fromEntries(CATEGORY_IDS.map((id) => [id, set.has(id)]));
        // Preserve noise only when explicitly requested in `only`.
        if (!set.has('noise')) next.noise = false;
        return next;
    }
    const next = { ...cur };
    for (const id of cats) {
        if (mode === 'on') next[id] = true;
        else if (mode === 'off') next[id] = false;
        else if (mode === 'toggle') next[id] = !next[id];
        else throw new Error(`filter mode takes reset|only|on|off|toggle, not '${mode}'`);
    }
    return next;
}

/**
 * Whether a record passes the active filter map.
 * If a record has multiple categories (e.g. a prompt with images → `['prompt', 'image']`), it
 * shows whenever ANY of its categories is enabled.
 * @param {Object} rec
 * @param {Record<string, boolean>} filters
 * @returns {boolean}
 */
export function matchesFilter(rec, filters) {
    const cats = categoriesOfRecord(rec);
    return cats.some((c) => !!filters?.[c]);
}

/**
 * Whether a record matches a subset token list (for bulk expand / collapse of a specific action set).
 * Empty tokens or `['all']` matches every record passed in.
 * @param {Object} rec
 * @param {string[]} [tokens]
 * @returns {boolean}
 */
export function matchesSubset(rec, tokens = []) {
    if (!tokens.length || tokens.some((t) => String(t).toLowerCase() === 'all')) return true;
    const set = new Set(expandCategoryTokens(tokens));
    return categoriesOfRecord(rec).some((c) => set.has(c));
}

// ── row & expanded content formatting ────────────────────────────────────────

/** @param {number} bytes @returns {string} */
export function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return '';
    if (bytes < 1024) return `${Math.round(bytes)}B`;
    if (bytes < 1024 * 1024) {
        const kb = bytes / 1024;
        return `${kb >= 10 ? Math.round(kb) : kb.toFixed(1)}KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** First non-empty line of text, whitespace-collapsed and clipped to `maxChars`. */
function oneLine(text, maxChars = 140) {
    if (!text) return '';
    for (const raw of String(text).split('\n')) {
        const s = raw.replace(/\s+/g, ' ').trim();
        if (!s) continue;
        return s.length > maxChars ? `${s.slice(0, maxChars - 1)}…` : s;
    }
    return '';
}

const STATUS_BADGE = Object.freeze({
    pending: '…',
    background: 'bg',
    error: 'err',
    interrupted: 'int',
});

/**
 * Format a record into a compact 1-line row descriptor for the Agent View event stream.
 * @param {Object} rec - record from `agentEvents.eventRecord`
 * @param {{ abandoned?: boolean }} [opts]
 */
export function summarizeEventRow(rec, { abandoned = false } = {}) {
    const categories = categoriesOfRecord(rec);
    const imgRead = isImageToolRead(rec);
    const hueObj = imgRead ? IMAGE_HUE : (ACTION_HUES[kindForAction(rec.action)] ?? ACTION_HUES.other);
    const hue = cssHue(hueObj);

    let tag = rec.action || rec.eventKind || 'event';
    let summary = '';
    let stat = '';

    switch (rec.eventKind) {
        case 'prompt': {
            if (rec.command) tag = rec.command === '!' ? '!cmd' : String(rec.command);
            else tag = String(rec.tag || 'you').replace(/\s*·\s*/g, '·');
            summary = oneLine(rec.result) || (rec.images > 0 ? `(${rec.images} attached image${rec.images === 1 ? '' : 's'})` : '(empty prompt)');
            if (rec.images > 0) stat = `${rec.images} img`;
            break;
        }
        case 'think': {
            tag = 'think';
            summary = rec.redacted && !rec.result ? '(redacted thinking)' : (oneLine(rec.result) || '(thinking…)');
            if (rec.redacted) stat = 'redacted';
            else if (rec.result) {
                const n = rec.result.split('\n').length;
                if (n > 1) stat = `${n}L`;
            }
            break;
        }
        case 'say': {
            tag = rec.provisional ? 'say…' : 'say';
            summary = oneLine(rec.result) || '(empty reply)';
            if (rec.final) stat = 'final';
            break;
        }
        case 'tool': {
            const a = String(rec.action || 'tool').toLowerCase();
            if (a === 'noise') tag = String(rec.tag || rec.name || 'noise');
            else if (imgRead) tag = 'image';
            else tag = a;

            if (a === 'grep' || a === 'search') {
                summary = [oneLine(rec.detail, 70), rec.target].filter(Boolean).join('  ');
            } else if (rec.target) {
                summary = rec.target;
            } else {
                summary = oneLine(rec.detail) || oneLine(rec.result) || rec.name || a;
            }

            const metric = toolMetric(rec, imgRead);
            const sb = STATUS_BADGE[rec.status] || '';
            stat = [metric, sb].filter(Boolean).join(' · ');
            break;
        }
        case 'system': {
            tag = rec.subtype ? String(rec.subtype) : 'system';
            summary = oneLine(rec.result) || rec.detail || 'system event';
            break;
        }
        case 'request': {
            tag = 'model';
            summary = rec.detail || 'request';
            break;
        }
        default:
            summary = oneLine(rec.result) || rec.detail || rec.target || tag;
    }

    return {
        id: rec.id,
        eventKind: rec.eventKind,
        action: rec.action,
        categories,
        hue,
        tag,
        summary,
        stat,
        status: rec.status ?? 'ok',
        abandoned: !!abandoned,
        turnIndex: rec.turn?.index ?? null,
        agent: rec.agent ?? null,
        subSessions: rec.subSessions ?? [],
    };
}

function toolMetric(rec, imgRead) {
    const m = rec.meta;
    if (imgRead) return formatBytes(m.bytes);
    if (rec.action === 'read') {
        if (Array.isArray(m?.range) && m.range.length >= 2) return `L${m.range[0]}–${m.range[1]}`;
        if (rec.file?.total) return `${rec.file.total}L`;
    }
    if (rec.action === 'edit' && m && (m.added != null || m.removed != null)) {
        return `+${m.added ?? 0} −${m.removed ?? 0}`;
    }
    if (rec.action === 'write' && rec.file?.total) return `${rec.file.total}L`;
    return '';
}

/**
 * Format the expanded detail view for a single event (`show`).
 * Caps rendered lines to `maxLines` unless `full: true` is passed, returning `{ truncated, totalLines }`
 * so huge file reads stay instant when expanding many rows at once.
 * @param {Object} rec
 * @param {{ maxLines?: number, full?: boolean }} [opts]
 */
export function formatExpandedEvent(rec, { maxLines = 160, full = false } = {}) {
    const facts = eventFacts(rec);
    if (rec.agent) facts.unshift(`agent ${rec.agent}`);
    if (isImageToolRead(rec) && rec.meta?.bytes > 0) facts.push(formatBytes(rec.meta.bytes));

    const target = rec.target || '';
    const detail = rec.detail && rec.detail !== rec.subtype ? rec.detail : '';

    let rawBody = '';
    if (rec.file?.text != null) {
        const start = rec.file.start || 1;
        const rawLines = rec.file.text.split('\n');
        if (rawLines.length > 1 && rawLines[rawLines.length - 1] === '') rawLines.pop();
        const width = String(start + rawLines.length - 1).length;
        const limit = full ? rawLines.length : Math.min(rawLines.length, maxLines);
        const numbered = [];
        for (let i = 0; i < limit; i++) {
            numbered.push(`${String(start + i).padStart(width, ' ')} │ ${rawLines[i]}`);
        }
        return {
            facts,
            target,
            detail,
            body: numbered.join('\n'),
            totalLines: rawLines.length,
            truncated: rawLines.length > limit,
        };
    }

    rawBody = rec.result || '';
    if (!rawBody) {
        return { facts, target, detail, body: '', totalLines: 0, truncated: false };
    }
    const lines = rawBody.split('\n');
    const limit = full ? lines.length : Math.min(lines.length, maxLines);
    return {
        facts,
        target,
        detail,
        body: lines.slice(0, limit).join('\n'),
        totalLines: lines.length,
        truncated: lines.length > limit,
    };
}

// ── world geometry, drag side picking & tiling footprints ────────────────────

/**
 * World-space rect `{ minX, minY, maxX, maxY }` of an Agent View attached to `side` of a terminal.
 * On `'right'` and `'left'`, the pane aligns flush from `body.minY` up to `body.maxY + barHeight`
 * (the top of the terminal's window). On `'top'` and `'bottom'`, it matches the terminal's width
 * (`body.minX .. body.maxX`).
 *
 * @param {import('./wallLayout.js').Rect} bodyRect - terminal grid bounds in world units
 * @param {number} barHeight - title bar height at current zoom (world units)
 * @param {'right'|'left'|'top'|'bottom'} side
 * @param {{ width: number, height: number, gap: number }} dims - world units from `wall.config`
 * @returns {import('./wallLayout.js').Rect}
 */
export function agentViewRect(bodyRect, barHeight, side, { width, height, gap }) {
    const topY = bodyRect.maxY + Math.max(0, barHeight);
    switch (side) {
        case 'left':
            return {
                minX: bodyRect.minX - gap - width,
                maxX: bodyRect.minX - gap,
                minY: bodyRect.minY,
                maxY: topY,
            };
        case 'top':
            return {
                minX: bodyRect.minX,
                maxX: bodyRect.maxX,
                minY: topY + gap,
                maxY: topY + gap + height,
            };
        case 'bottom':
            return {
                minX: bodyRect.minX,
                maxX: bodyRect.maxX,
                minY: bodyRect.minY - gap - height,
                maxY: bodyRect.minY - gap,
            };
        case 'right':
        default:
            return {
                minX: bodyRect.maxX + gap,
                maxX: bodyRect.maxX + gap + width,
                minY: bodyRect.minY,
                maxY: topY,
            };
    }
}

/**
 * Zoom-invariant tile footprint metrics for `WallGroups` (`tileLayout` reserves `BAR_ROOM` above `h`
 * and returns `place = { x: tileLeft, y: tileTop - BAR_ROOM }`).
 * Placing the terminal's body at `{ x: place.x + shiftX, y: place.y - shiftY }` keeps the terminal,
 * its title bar (up to `BAR_ROOM`), and its attached Agent View strictly inside the allocated tile
 * on all 4 sides (`right`, `left`, `top`, `bottom`).
 *
 * @param {import('./wallLayout.js').Rect} bodyRect
 * @param {'right'|'left'|'top'|'bottom'|null} side - null when no Agent View is open
 * @param {{ width: number, height: number, gap: number }} dims
 * @returns {{ w: number, h: number, shiftX: number, shiftY: number, tileBox: import('./wallLayout.js').Rect }}
 */
export function footprintTileMetrics(bodyRect, side, dims) {
    const bodyW = bodyRect.maxX - bodyRect.minX;
    const bodyH = bodyRect.maxY - bodyRect.minY;
    let w = bodyW, h = bodyH, shiftX = 0, shiftY = 0;
    if (side === 'right') {
        w = bodyW + dims.gap + dims.width;
    } else if (side === 'left') {
        w = dims.width + dims.gap + bodyW;
        shiftX = dims.width + dims.gap;
    } else if (side === 'bottom') {
        h = bodyH + dims.gap + dims.height;
    } else if (side === 'top') {
        h = dims.height + dims.gap + bodyH;
        shiftY = dims.height + dims.gap;
    }
    const minX = bodyRect.minX - shiftX;
    const maxY = bodyRect.maxY + BAR_ROOM + shiftY;
    return {
        w,
        h,
        shiftX,
        shiftY,
        tileBox: { minX, maxX: minX + w, minY: maxY - (h + BAR_ROOM), maxY },
    };
}

/**
 * Pick which side of `windowRect` a dragged world point `pt` is aiming for, using aspect-normalized
 * quadrants around the terminal window's center.
 * @param {import('./wallLayout.js').Rect} windowRect
 * @param {{ x: number, y: number }} pt - world coordinates (y up)
 * @returns {'right'|'left'|'top'|'bottom'}
 */
export function pickAgentSide(windowRect, pt) {
    const cx = (windowRect.minX + windowRect.maxX) / 2;
    const cy = (windowRect.minY + windowRect.maxY) / 2;
    const halfW = Math.max((windowRect.maxX - windowRect.minX) / 2, 1e-6);
    const halfH = Math.max((windowRect.maxY - windowRect.minY) / 2, 1e-6);
    const nx = (pt.x - cx) / halfW;
    const ny = (pt.y - cy) / halfH;
    if (Math.abs(nx) >= Math.abs(ny)) return nx >= 0 ? 'right' : 'left';
    return ny >= 0 ? 'top' : 'bottom';
}

// ── session discovery & pairing ──────────────────────────────────────────────

/** Normalize a filesystem path for comparison (strip trailing slashes except root `/`). */
export function normPath(p) {
    if (!p || typeof p !== 'string') return '';
    const trimmed = p.trim();
    if (trimmed === '/') return '/';
    return trimmed.replace(/\/+$/, '');
}

/** Parse an RFC3339 / ISO timestamp into epoch ms (0 when absent or unparseable). */
function mtimeMs(s) {
    const t = s?.mtime ? Date.parse(s.mtime) : NaN;
    return Number.isFinite(t) ? t : 0;
}

/**
 * Match a terminal (`termd/status` row + terminal id/title) to the best `AgentSession` from
 * `agentSessions/list`.
 *
 * Priority:
 *   1. `pinned`: exact `session_id`, workgroup `name`, or unique `session_id` prefix (`pinned !== 'auto'`)
 *   2. Exact `sessionId` reported by `WallBus` for an attached gomuxai agent (`termMeta.sessionId`)
 *   3. Workgroup match: `termMeta.attached` (`<name>[@<host>]`) or terminal id/title `gx-<name>` ↔ `session.workgroup?.name === <name>`
 *   4. Directory match: normalized `pwd` (OSC 7) or `cwd` matching `session.cwd` on a top-level
 *      session (`!session.parent_session`), preferring live (`status !== 'ended'`) then newest `mtime`
 *
 * @param {{ id?: string, attached?: string, sessionId?: string, pwd?: string, cwd?: string, title?: string }} termMeta
 * @param {import('@glyph3d/core/services/data/AgentSessionProvider.js').AgentSession[]} sessions
 * @param {string|null} [pinned] - `'auto'` or null uses automatic matching
 * @returns {import('@glyph3d/core/services/data/AgentSessionProvider.js').AgentSession|null}
 */
export function matchTerminalSession(termMeta, sessions, pinned = null) {
    if (!Array.isArray(sessions) || !sessions.length) return null;

    if (pinned && pinned !== 'auto') {
        const exact = sessions.find((s) => s.session_id === pinned || s.workgroup?.name === pinned);
        if (exact) return exact;
        const pref = sessions.filter((s) => s.session_id?.startsWith(pinned));
        if (pref.length === 1) return pref[0];
        return null;
    }

    const candidates = [...sessions].sort((a, b) => {
        const aLive = a.status !== 'ended' ? 1 : 0;
        const bLive = b.status !== 'ended' ? 1 : 0;
        if (aLive !== bLive) return bLive - aLive;
        return mtimeMs(b) - mtimeMs(a);
    });

    if (termMeta?.sessionId) {
        const bySid = candidates.find((s) => s.session_id === termMeta.sessionId);
        if (bySid) return bySid;
    }

    if (typeof termMeta?.attached === 'string' && termMeta.attached.trim()) {
        const raw = termMeta.attached.trim();
        const bare = raw.includes('@') ? raw.slice(0, raw.indexOf('@')) : raw;
        const wg = candidates.find((s) => !s.parent_session && s.workgroup?.name === bare);
        if (wg) return wg;
    }

    // Workgroup terminal convention (`gx-<name>`).
    for (const label of [termMeta?.id, termMeta?.title]) {
        const m = typeof label === 'string' && /^gx-([A-Za-z0-9_.-]+)$/.exec(label.trim());
        if (m) {
            const wg = candidates.find((s) => !s.parent_session && s.workgroup?.name === m[1]);
            if (wg) return wg;
        }
    }

    // Exact directory match (`pwd` from OSC 7 wins over initial `cwd`).
    const dirs = [normPath(termMeta?.pwd), normPath(termMeta?.cwd)].filter(Boolean);
    for (const dir of dirs) {
        const top = candidates.find((s) => !s.parent_session && normPath(s.cwd) === dir);
        if (top) return top;
    }
    return null;
}

/**
 * Format a concise human-readable label for a session in the Agent View header / session picker.
 * @param {import('@glyph3d/core/services/data/AgentSessionProvider.js').AgentSession|null} s
 * @returns {string}
 */
export function formatSessionLabel(s) {
    if (!s) return 'no session';
    const who = s.workgroup?.name || s.agent_name || s.harness || 'agent';
    const shortId = String(s.session_id || '').slice(0, 8);
    const title = s.title ? oneLine(s.title, 34) : (s.project || shortDir(s.cwd) || shortId);
    const sub = s.parent_session ? 'sub · ' : '';
    return `${sub}${who}: ${title || shortId}`;
}

function shortDir(cwd) {
    const n = normPath(cwd);
    if (!n) return '';
    const parts = n.split('/');
    return parts[parts.length - 1] || n;
}

// ── terminal scrollback line anchors & jump math ─────────────────────────────

/**
 * Read a protocol-supplied terminal line number from an event when the turn/event stream provides
 * one (forward-compatible with the native turn-wrapping port).
 * @param {Object} ev - raw `EVENTS.md` event frame
 * @returns {number|null}
 */
export function extractProtocolTerminalLine(ev) {
    const candidates = [
        ev?.terminal_line,
        ev?.turn?.terminal_line,
        ev?.[ev?.kind]?.terminal_line,
    ];
    for (const c of candidates) {
        if (Number.isFinite(c) && c >= 0) return Math.floor(c);
    }
    return null;
}

/**
 * @typedef {{ terminalLine?: number, scrollbackRows?: number, cursorRow?: number, exact?: boolean }} LineAnchor
 */

/**
 * Convert an event's stored `LineAnchor` into the `termd` `view` offset (`0` = live screen;
 * `k > 0` = `k` rows back from live) given the terminal's current `nowScrollback` row count.
 * Places the event `contextRows` below the top edge of the terminal viewport.
 *
 * @param {LineAnchor|null|undefined} anchor
 * @param {number} nowScrollback - current `scrollback_rows` of the terminal
 * @param {number} [contextRows=2]
 * @returns {number} whole-number `view` offset in `[0, nowScrollback]`
 */
export function computeJumpOffset(anchor, nowScrollback, contextRows = 2) {
    const maxOff = Math.max(0, Math.floor(nowScrollback || 0));
    if (!anchor || maxOff === 0) return 0;
    const absRow = Number.isFinite(anchor.terminalLine)
        ? anchor.terminalLine
        : (Math.max(0, anchor.scrollbackRows || 0) + Math.max(0, anchor.cursorRow || 0));
    const desiredTop = Math.max(0, absRow - Math.max(0, contextRows));
    const rawOffset = maxOff - desiredTop;
    return Math.max(0, Math.min(maxOff, Math.round(rawOffset)));
}
