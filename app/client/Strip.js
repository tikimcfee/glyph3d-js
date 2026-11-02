/**
 * Strip — Left-edge collapsible, scrollable desk list, off-screen edge marks, and
 * neighbor navigation (`docs/planes/DESIGN.md` §3.14, Slice 8).
 *
 * Whenever `strip.enabled` is true and live desks exist:
 * 1. Renders a collapsible, scrollable desk list along the left edge of `PlaneOverlay`
 *    in both the open world and inside an entered plane.
 * 2. Lists EVERY live desk (no `maxCards` cap or `+N more` cluster) in stable desk-TREE
 *    order (`strip.order = 'tree'` default: the hub `gomux`, its nested team desks indented
 *    under their parent, then `agents` and other desks; or `'bearing'` order by true bearing).
 *    The entered desk stays in its row and is highlighted (`entered: true`).
 * 3. Collapsible via the top header row (`strip:header` with `▾`/`▸` chevron) or the
 *    `strip.collapse [on|off|toggle]` verb; durable across reloads via `strip.collapsed`.
 *    When collapsed, only the thin header is shown and the plane's reserved column (`stripRightPx`)
 *    shrinks to `0`, giving the room back.
 * 4. Wheel over the strip band scrolls the desk list (preserving and clamping scroll offset
 *    across updates) without moving the camera or plane behind.
 * 5. Clicking a card invokes `carrel.enter <name>`.
 * 6. Inside an entered plane, off-screen deixis points (`ctx.deixis.list()`) and off-screen
 *    waiting agents receive high-contrast edge marks clamped to the viewport boundary, and the
 *    strip never covers the focused pin when expanded.
 *
 * Also provides `seatMap()` / `rollSeat()` on `Carrel` and `carrel.neighbor <h|l|j|k|parent|child>`.
 */

import * as THREE from 'three';
import { flowBoxes, squareWrap } from '@glyph3d/core/collections/layouts/flowBoxes.js';
import { getSetting, setSetting } from './settings.js';
import { waitingAgents } from '../commands/handlers/gomuxCommands.js';
/** @import Carrel from '@glyph3d/core/services/interaction/Carrel.js' */

const DEG2RAD = Math.PI / 180;
const _tmpPos = new THREE.Vector3();
const _tmpFwd = new THREE.Vector3();
const _tmpNdc = new THREE.Vector3();

export const DEFAULT_STRIP_CONFIG = Object.freeze({
    enabled: true,
    collapsed: false,
    order: 'tree',
    cardWidthPx: 148,
    cardMaxHeightPx: 96,
    cardMinHeightPx: 54,
    headerHeightPx: 26,
    headerGapPx: 6,
    treeIndentPx: 14,
    edgeLeftPx: 12,
    edgeTopPx: 52,
    edgeBottomPx: 16,
    cardGapPx: 10,
    pinClearancePx: 12,
    edgeMarkInsetPx: 8,
});

// ============================================================================
// Carrel seatMap, rollSeat, and pinAim (with leftInsetPx)
// ============================================================================

/**
 * Compute the 2D unrolled seat map of a `Carrel` (`{ seats, rows }`).
 * Each entry in `seats` is `{ id, row, col, x, y, w, h, cx, bearing }` in row-major
 * order (sorted by `row` ascending, then `x` ascending within each row).
 * `rows` is `Array<string[]>` of member IDs per row from left (`h`) to right (`l`).
 *
 * @param {Carrel} carrel
 * @returns {{ seats: Array<{id:string, row:number, col:number, x:number, y:number, w:number, h:number, cx:number, bearing:number}>, rows: string[][] }}
 */
export function computeSeatMap(carrel) {
    if (!carrel) return { seats: [], rows: [] };

    // 1. Plane mode with pins
    if (carrel.mode === 'plane' && carrel.planeUnit && carrel.planeArrange === 'pins') {
        const pins = (carrel.pinRects?.() || []).filter((p) => !p.ghost && p.rect);
        if (!pins.length) return { seats: [], rows: [] };
        const box = carrel._boardPx?.() || { w: 0, h: 0 };
        const byRowY = new Map();
        for (const p of pins) {
            const ry = Math.round(p.rect.y);
            if (!byRowY.has(ry)) byRowY.set(ry, []);
            byRowY.get(ry).push(p);
        }
        const sortedYs = [...byRowY.keys()].sort((a, b) => a - b);
        const seats = [];
        const rows = [];
        sortedYs.forEach((ry, rowIdx) => {
            const rowPins = byRowY.get(ry).sort((a, b) => a.rect.x - b.rect.x);
            rows.push(rowPins.map((p) => p.id));
            rowPins.forEach((p, colIdx) => {
                const cx = (p.rect.x + p.rect.w / 2) - box.w / 2;
                seats.push({
                    id: p.id,
                    row: rowIdx,
                    col: colIdx,
                    x: p.rect.x,
                    y: p.rect.y,
                    w: p.rect.w,
                    h: p.rect.h,
                    cx,
                    bearing: 0,
                });
            });
        });
        return { seats, rows };
    }

    // 2. Plane mode with tiles
    if (carrel.mode === 'plane' && carrel.planeUnit && carrel.planeArrange === 'tiles') {
        const panes = carrel.paneRects?.() || [];
        if (!panes.length) return { seats: [], rows: [] };
        const box = carrel._boardPx?.() || { w: 0, h: 0 };
        const byRowY = new Map();
        for (const p of panes) {
            const ry = Math.round(p.rect.y);
            if (!byRowY.has(ry)) byRowY.set(ry, []);
            byRowY.get(ry).push(p);
        }
        const sortedYs = [...byRowY.keys()].sort((a, b) => a - b);
        const seats = [];
        const rows = [];
        sortedYs.forEach((ry, rowIdx) => {
            const rowPanes = byRowY.get(ry).sort((a, b) => a.rect.x - b.rect.x);
            rows.push(rowPanes.map((p) => p.active || p.id));
            rowPanes.forEach((p, colIdx) => {
                const id = p.active || p.id;
                const cx = (p.rect.x + p.rect.w / 2) - box.w / 2;
                seats.push({
                    id,
                    row: rowIdx,
                    col: colIdx,
                    x: p.rect.x,
                    y: p.rect.y,
                    w: p.rect.w,
                    h: p.rect.h,
                    cx,
                    bearing: 0,
                });
            });
        });
        return { seats, rows };
    }

    // 3. Ring / Grid (wall) mode — unroll `panes.seats` via `flowBoxes` just like `_relayout()`
    const rawSeats = carrel.panes?.seats || [];
    if (!rawSeats.length) {
        const members = [...(carrel.entries?.values() || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        if (!members.length) return { seats: [], rows: [] };
        const row = members.map((m) => m.id);
        return {
            seats: members.map((m, i) => ({ id: m.id, row: 0, col: i, x: i, y: 0, w: 1, h: 1, cx: i - (members.length - 1) / 2, bearing: 0 })),
            rows: [row],
        };
    }

    const boxW = (carrel.boxH || 10) * (carrel.boxAspect || 1.6);
    const gap = carrel._gap ?? ((carrel.boxH || 10) * (carrel.gapFrac ?? 0.1));
    const R = Math.max(carrel._ringR ?? carrel.radius ?? 1, 1e-3);
    const grid = carrel.mode === 'grid' || carrel.mode === 'plane';
    const boxes = rawSeats.map((st) => ({ w: Math.max(st.w || boxW, 1e-3), h: Math.max(st.h || carrel.boxH || 1, 1e-3) }));
    const wrapWidth = grid
        ? squareWrap(boxes, gap)
        : Math.max((carrel.maxArcDeg || 300) * DEG2RAD * R, boxW + 1e-3);
    const { slots, width: liveW } = flowBoxes(boxes, { margin: gap, wrapWidth });
    const W = carrel._layoutW || liveW || 0;

    const byRow = new Map();
    rawSeats.forEach((st, idx) => {
        if (st.ghost) return;
        if (carrel.entries && !carrel.entries.has(st.id)) return;
        const slot = slots[idx] || { x: idx * (boxW + gap), y: 0, row: 0 };
        const w = boxes[idx].w;
        const h = boxes[idx].h;
        const cx = (slot.x + w / 2) - W / 2;
        const bearing = grid ? 0 : cx / R;
        const r = slot.row ?? 0;
        if (!byRow.has(r)) byRow.set(r, []);
        byRow.get(r).push({ id: st.id, row: r, col: 0, x: slot.x, y: slot.y, w, h, cx, bearing });
    });

    const sortedRowIndices = [...byRow.keys()].sort((a, b) => a - b);
    const seats = [];
    const rows = [];
    sortedRowIndices.forEach((rKey, denseRowIdx) => {
        const items = byRow.get(rKey).sort((a, b) => a.x - b.x);
        rows.push(items.map((item) => item.id));
        items.forEach((item, colIdx) => {
            item.row = denseRowIdx;
            item.col = colIdx;
            seats.push(item);
        });
    });

    return { seats, rows };
}

/**
 * Step from `memberId` in direction `dir` (`'h'|'l'|'j'|'k'|'left'|'right'|'down'|'up'`)
 * across `carrel.seatMap()`.
 *
 * Invariants:
 * - `l` steps +1 mod N in seat order, `h` steps -1 mod N in seat order.
 * - `l` followed by `h` ALWAYS returns to `memberId`.
 * - `l` repeated N times visits every seat in `seats` once and returns to `memberId`.
 * - `j` / `k` steps between shelf rows when `rows.length > 1`, choosing the seat in the
 *   target row with the closest horizontal center `cx`.
 *
 * @param {Carrel} carrel
 * @param {string|null} memberId
 * @param {string} dir
 * @param {(seat: Object) => boolean} [filterFn]
 * @returns {string|null}
 */
export function rollSeat(carrel, memberId, dir, filterFn = null) {
    const map = computeSeatMap(carrel);
    const seats = filterFn ? map.seats.filter(filterFn) : map.seats;
    if (!seats.length) return null;

    const d = normalizeDir(dir);
    const idx = memberId != null ? seats.findIndex((s) => s.id === memberId) : -1;

    if (d === 'l') {
        return seats[idx >= 0 ? (idx + 1) % seats.length : 0].id;
    }
    if (d === 'h') {
        return seats[idx >= 0 ? (idx - 1 + seats.length) % seats.length : seats.length - 1].id;
    }

    if (d === 'j' || d === 'k') {
        // Group filtered seats by row
        const rowGroups = new Map();
        for (const s of seats) {
            if (!rowGroups.has(s.row)) rowGroups.set(s.row, []);
            rowGroups.get(s.row).push(s);
        }
        const rowKeys = [...rowGroups.keys()].sort((a, b) => a - b);
        if (rowKeys.length <= 1) {
            // Single row: j steps forward like l, k steps backward like h
            return d === 'j'
                ? seats[idx >= 0 ? (idx + 1) % seats.length : 0].id
                : seats[idx >= 0 ? (idx - 1 + seats.length) % seats.length : seats.length - 1].id;
        }
        const curr = idx >= 0 ? seats[idx] : seats[0];
        const currRowPos = Math.max(0, rowKeys.indexOf(curr.row));
        // On ring/wall, row 0 is at the bottom and rows climb upward (+row = up = 'k', -row = down = 'j').
        // On a plane pin board, row 0 is at the top and rows descend (+row = down = 'j', -row = up = 'k').
        const rowsClimbUp = carrel?.mode !== 'plane';
        const delta = d === 'k' ? (rowsClimbUp ? 1 : -1) : (rowsClimbUp ? -1 : 1);
        const nextRowKey = rowKeys[(currRowPos + delta + rowKeys.length) % rowKeys.length];
        const candidates = rowGroups.get(nextRowKey) || [];
        if (!candidates.length) return curr.id;
        let best = candidates[0];
        let bestDist = Math.abs(best.cx - curr.cx);
        for (let i = 1; i < candidates.length; i++) {
            const dist = Math.abs(candidates[i].cx - curr.cx);
            if (dist < bestDist) {
                best = candidates[i];
                bestDist = dist;
            }
        }
        return best.id;
    }

    return null;
}

export const seatMap = computeSeatMap;

// ============================================================================
// Bearing & Neighbor Geometry
// ============================================================================

function normalizeDir(dir) {
    const s = String(dir ?? '').trim().toLowerCase();
    if (s === 'l' || s === 'right' || s === 'next') return 'l';
    if (s === 'h' || s === 'left' || s === 'prev') return 'h';
    if (s === 'j' || s === 'down') return 'j';
    if (s === 'k' || s === 'up') return 'k';
    if (s === 'parent' || s === 'out') return 'parent';
    if (s === 'child' || s === 'in') return 'child';
    return s;
}

/**
 * World center of a carrel (`{ x, y, z }`).
 * @param {Carrel} carrel
 * @returns {{x:number, y:number, z:number}}
 */
export function carrelWorldCenter(carrel) {
    if (!carrel) return { x: 0, y: 0, z: 0 };
    carrel.updateWorldMatrix?.(true, false);
    const pr = carrel.getPlaneRect?.();
    if (pr?.center) return { x: pr.center.x, y: pr.center.y, z: pr.center.z };
    if (carrel.matrixWorld) {
        _tmpPos.setFromMatrixPosition(carrel.matrixWorld);
        return { x: _tmpPos.x, y: _tmpPos.y, z: _tmpPos.z };
    }
    return {
        x: carrel.position?.x || 0,
        y: carrel.position?.y || 0,
        z: carrel.position?.z || 0,
    };
}

/**
 * Signed horizontal bearing in `(-π, π]` of `carrel` from `viewerPos` relative to
 * horizontal `viewerForward` (`{ x, z }`).
 * Negative bearing = left of forward; 0 = dead ahead; positive bearing = right of forward.
 *
 * @param {Carrel} carrel
 * @param {{x:number, y?:number, z:number}} viewerPos
 * @param {{x:number, y?:number, z:number}} [viewerForward={x:0,z:-1}]
 * @returns {number} radians in (-π, π]
 */
export function carrelBearingFrom(carrel, viewerPos, viewerForward = { x: 0, z: -1 }) {
    const c = carrelWorldCenter(carrel);
    const dx = c.x - (viewerPos?.x || 0);
    const dz = c.z - (viewerPos?.z || 0);
    const distSq = dx * dx + dz * dz;
    if (distSq < 1e-12) return 0;

    let fx = viewerForward?.x ?? 0;
    let fz = viewerForward?.z ?? -1;
    const fLen = Math.hypot(fx, fz);
    if (fLen > 1e-9) {
        fx /= fLen;
        fz /= fLen;
    } else {
        fx = 0;
        fz = -1;
    }
    // Right vector in XZ plane: forward × up = (fx, 0, fz) × (0, 1, 0) = (-fz, 0, fx)
    const rx = -fz;
    const rz = fx;
    const fwdDot = dx * fx + dz * fz;
    const rightDot = dx * rx + dz * rz;
    return Math.atan2(rightDot, fwdDot);
}

function isCarrelNode(obj) {
    return Boolean(obj && (obj.isCarrel || typeof obj.carrelName === 'string'));
}

/**
 * Find the parent `Carrel` that seats `carrel` as a nested desk, or `null` if top-level.
 * @param {Object} ctx
 * @param {Carrel} carrel
 * @returns {Carrel|null}
 */
export function parentCarrelOf(ctx, carrel) {
    if (!carrel) return null;
    if (isCarrelNode(carrel.parent) && !carrel.parent._dissolving) return carrel.parent;
    const map = ctx?.carrels instanceof Map ? ctx.carrels : null;
    if (!map) return null;
    const entryKey = carrel.name || `carrel:${carrel.carrelName}`;
    for (const c of map.values()) {
        if (c === carrel || c._dissolving) continue;
        if (c.entries?.has(entryKey) || c.entries?.get(carrel.carrelName)?.grid === carrel) {
            return c;
        }
    }
    const cname = String(carrel.carrelName || '');
    const slash = cname.lastIndexOf('/');
    if (slash > 0) {
        const p = map.get(cname.slice(0, slash));
        if (p && p !== carrel && !p._dissolving) return p;
    }
    return null;
}

/**
 * Return the nested child `Carrel`s seated inside `parentCarrel`, ordered by `parentCarrel.seatMap()`.
 * @param {Object} ctx
 * @param {Carrel} parentCarrel
 * @returns {Carrel[]}
 */
export function childCarrelsOf(ctx, parentCarrel) {
    if (!parentCarrel) return [];
    const map = ctx?.carrels instanceof Map ? ctx.carrels : null;
    const resolveChild = (id) => {
        const entry = parentCarrel.entries?.get(id);
        if (isCarrelNode(entry?.grid) && !entry.grid._dissolving) return entry.grid;
        if (map) {
            const stripped = String(id).startsWith('carrel:') ? String(id).slice('carrel:'.length) : String(id);
            const found = map.get(stripped);
            if (found && !found._dissolving) return found;
        }
        return null;
    };
    const { seats } = computeSeatMap(parentCarrel);
    const out = [];
    const seen = new Set();
    for (const s of seats) {
        const child = resolveChild(s.id);
        if (child && !seen.has(child.carrelName)) {
            seen.add(child.carrelName);
            out.push(child);
        }
    }
    for (const e of parentCarrel.entries?.values() || []) {
        if (isCarrelNode(e.grid) && !e.grid._dissolving && !seen.has(e.grid.carrelName)) {
            seen.add(e.grid.carrelName);
            out.push(e.grid);
        }
    }
    if (map) {
        for (const c of map.values()) {
            if (!c || c._dissolving || c === parentCarrel || seen.has(c.carrelName)) continue;
            if (parentCarrelOf(ctx, c) === parentCarrel) {
                seen.add(c.carrelName);
                out.push(c);
            }
        }
    }
    return out;
}

/**
 * Order all live carrels for the strip according to `orderMode` (`'tree'` or `'bearing'`).
 * - `'tree'` (default): stable desk-tree order — the hub (`gomux`), its nested team desks indented
 *   under their parent (`depth = 1..`), then `agents`, then remaining top-level desks in stable
 *   registration order (with any nested children indented under them). Invariant under camera motion.
 * - `'bearing'`: sorted by true bearing from `(viewerPos, viewerFwd)` ascending.
 *
 * @param {Object} ctx
 * @param {'tree'|'bearing'} orderMode
 * @param {{x:number,y?:number,z:number}} viewerPos
 * @param {{x:number,y?:number,z:number}} viewerFwd
 * @returns {Array<{carrel: Carrel, name: string, bearing: number, depth: number, parent: string|null}>}
 */
export function orderCarrelsForStrip(ctx, orderMode = 'tree', viewerPos = { x: 0, z: 0 }, viewerFwd = { x: 0, z: -1 }) {
    const map = ctx?.carrels instanceof Map ? ctx.carrels : null;
    if (!map || !map.size) return [];
    const live = [...map.values()].filter((c) => c && !c._dissolving);
    if (!live.length) return [];

    if (orderMode === 'bearing') {
        const list = live.map((c) => {
            const p = parentCarrelOf(ctx, c);
            return {
                carrel: c,
                name: c.carrelName,
                bearing: carrelBearingFrom(c, viewerPos, viewerFwd),
                depth: 0,
                parent: p?.carrelName ?? null,
            };
        });
        list.sort((a, b) => {
            if (Math.abs(a.bearing - b.bearing) > 1e-6) return a.bearing - b.bearing;
            return a.name.localeCompare(b.name);
        });
        return list;
    }

    // Default: stable desk-tree order ('tree')
    const roots = live.filter((c) => !parentCarrelOf(ctx, c));
    const rootPriority = (c) => {
        if (c.carrelName === 'gomux') return 0;
        if (c.carrelName === 'agents') return 1;
        return 2;
    };
    const orderedRoots = [...roots].sort((a, b) => {
        const pa = rootPriority(a);
        const pb = rootPriority(b);
        return pa !== pb ? pa - pb : 0;
    });

    const visited = new Set();
    const ordered = [];
    const visit = (c, depth, parentName) => {
        if (!c || c._dissolving || visited.has(c.carrelName)) return;
        visited.add(c.carrelName);
        ordered.push({
            carrel: c,
            name: c.carrelName,
            bearing: carrelBearingFrom(c, viewerPos, viewerFwd),
            depth,
            parent: parentName,
        });
        const children = childCarrelsOf(ctx, c);
        for (const child of children) {
            visit(child, depth + 1, c.carrelName);
        }
    };

    for (const r of orderedRoots) {
        visit(r, 0, null);
    }
    for (const c of live) {
        if (!visited.has(c.carrelName)) {
            const p = parentCarrelOf(ctx, c);
            visit(c, p ? 1 : 0, p?.carrelName ?? null);
        }
    }
    return ordered;
}

/**
 * Resolve the neighbor `Carrel` from `fromName` in direction `dir`
 * (`'h'|'l'|'j'|'k'|'parent'|'child'`).
 *
 * @param {Object} ctx
 * @param {string} dir
 * @param {string|null} [fromName]
 * @returns {{ carrel: Carrel|null, from: Carrel|null, dir: string, bearing?: number, error?: string }}
 */
export function resolveCarrelNeighbor(ctx, dir, fromName = null) {
    const map = ctx?.carrels instanceof Map ? ctx.carrels : null;
    if (!map || !map.size) return { carrel: null, from: null, dir: normalizeDir(dir), error: 'no carrels' };

    const d = normalizeDir(dir);
    if (!['h', 'l', 'j', 'k', 'parent', 'child'].includes(d)) {
        return { carrel: null, from: null, dir: d, error: `usage: carrel.neighbor <h|l|j|k|parent|child> (got '${dir}')` };
    }

    const live = [...map.values()].filter((c) => c && !c._dissolving);
    if (!live.length) return { carrel: null, from: null, dir: d, error: 'no live carrels' };

    const refName = fromName || ctx.enteredCarrel || ctx.activeCarrel || live[0].carrelName;
    const from = map.get(String(refName));
    if (!from || from._dissolving) {
        return { carrel: null, from: null, dir: d, error: `no carrel '${refName}'` };
    }

    // 1. parent / child
    if (d === 'parent') {
        const parent = parentCarrelOf(ctx, from);
        if (!parent) return { carrel: null, from, dir: d, error: `'${from.carrelName}' has no parent carrel` };
        return { carrel: parent, from, dir: d };
    }
    if (d === 'child') {
        const children = childCarrelsOf(ctx, from);
        if (!children.length) return { carrel: null, from, dir: d, error: `'${from.carrelName}' has no child carrels` };
        return { carrel: children[0], from, dir: d };
    }

    // 2. Seated inside a parent carrel: use the parent carrel's `rollSeat` over its child-carrel seats!
    const parent = parentCarrelOf(ctx, from);
    if (parent) {
        const isChildCarrelSeat = (seat) => {
            const e = parent.entries?.get(seat.id);
            if (isCarrelNode(e?.grid) && !e.grid._dissolving) return true;
            const stripped = String(seat.id).startsWith('carrel:') ? String(seat.id).slice(7) : String(seat.id);
            const c = map.get(stripped);
            return Boolean(c && !c._dissolving);
        };
        const fromSeatId = parent.entries?.has(from.name) ? from.name : from.carrelName;
        const nextSeatId = rollSeat(parent, fromSeatId, d, isChildCarrelSeat);
        if (nextSeatId) {
            const stripped = String(nextSeatId).startsWith('carrel:') ? String(nextSeatId).slice(7) : String(nextSeatId);
            const target = parent.entries?.get(nextSeatId)?.grid || map.get(stripped);
            if (target && !target._dissolving) {
                return { carrel: target, from, dir: d };
            }
        }
    }

    // 3. Top-level peer carrels: order around the shared ring/hub centroid by true bearing
    // so the cyclic order is invariant across all peers (`l` then `h` always returns, and
    // `l × N` visits every peer once).
    const peers = live.filter((c) => !parentCarrelOf(ctx, c));
    const pool = peers.includes(from) ? peers : live;
    if (pool.length <= 1) {
        return { carrel: from, from, dir: d, bearing: 0 };
    }

    // Group into elevation rows (y within 2 world units = same row) for multi-row j/k support
    const centers = new Map(pool.map((c) => [c.carrelName, carrelWorldCenter(c)]));
    let cxSum = 0, czSum = 0;
    for (const p of centers.values()) {
        cxSum += p.x;
        czSum += p.z;
    }
    const hubCenter = { x: cxSum / pool.length, z: czSum / pool.length };

    // Check if carrels are collinear (e.g. a flat wall along X or Z): if so, order along the line;
    // otherwise order by cyclic bearing around `hubCenter`.
    const ordered = sortCarrelsCyclic(pool, centers, hubCenter);

    if (d === 'l' || d === 'h') {
        const idx = ordered.findIndex((c) => c.carrelName === from.carrelName);
        const step = d === 'l' ? 1 : -1;
        const next = ordered[(idx + step + ordered.length) % ordered.length];
        const bearing = carrelBearingFrom(next, centers.get(from.carrelName), {
            x: hubCenter.x - centers.get(from.carrelName).x,
            z: hubCenter.z - centers.get(from.carrelName).z,
        });
        return { carrel: next, from, dir: d, bearing };
    }

    // j / k on top-level carrels: group by elevation `y` if multi-row, else step l / h
    const sortedByY = [...ordered].sort((a, b) => centers.get(a.carrelName).y - centers.get(b.carrelName).y);
    const yRows = [];
    for (const c of sortedByY) {
        const cy = centers.get(c.carrelName).y;
        const lastRow = yRows[yRows.length - 1];
        if (!lastRow || Math.abs(cy - lastRow.y) > 2.0) {
            yRows.push({ y: cy, items: [c] });
        } else {
            lastRow.items.push(c);
        }
    }
    if (yRows.length <= 1) {
        const idx = ordered.findIndex((c) => c.carrelName === from.carrelName);
        const step = d === 'j' ? 1 : -1;
        const next = ordered[(idx + step + ordered.length) % ordered.length];
        return { carrel: next, from, dir: d };
    }

    const currRowIdx = Math.max(0, yRows.findIndex((r) => r.items.some((c) => c.carrelName === from.carrelName)));
    const delta = d === 'k' ? 1 : -1;
    const nextRow = yRows[(currRowIdx + delta + yRows.length) % yRows.length];
    const fromPos = centers.get(from.carrelName);
    let best = nextRow.items[0];
    let bestDist = Infinity;
    for (const cand of nextRow.items) {
        const p = centers.get(cand.carrelName);
        const dist = Math.hypot(p.x - fromPos.x, p.z - fromPos.z);
        if (dist < bestDist) {
            best = cand;
            bestDist = dist;
        }
    }
    return { carrel: best, from, dir: d };
}

/**
 * Deterministic cyclic order of peer carrels around their shared hub center (or along their line
 * if collinear).
 * @param {Carrel[]} pool
 * @param {Map<string, {x:number,y:number,z:number}>} centers
 * @param {{x:number, z:number}} hubCenter
 * @returns {Carrel[]}
 */
function sortCarrelsCyclic(pool, centers, hubCenter) {
    // Check if all carrels sit on nearly the same Z (a wall along X)
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const c of pool) {
        const p = centers.get(c.carrelName);
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.z < minZ) minZ = p.z;
        if (p.z > maxZ) maxZ = p.z;
    }
    const spanX = maxX - minX;
    const spanZ = maxZ - minZ;
    if (spanZ < 1e-3 && spanX > 1e-3) {
        return [...pool].sort((a, b) => {
            const dx = centers.get(a.carrelName).x - centers.get(b.carrelName).x;
            return Math.abs(dx) > 1e-6 ? dx : a.carrelName.localeCompare(b.carrelName);
        });
    }
    return [...pool].sort((a, b) => {
        const pa = centers.get(a.carrelName);
        const pb = centers.get(b.carrelName);
        const angA = Math.atan2(pa.x - hubCenter.x, -(pa.z - hubCenter.z));
        const angB = Math.atan2(pb.x - hubCenter.x, -(pb.z - hubCenter.z));
        if (Math.abs(angA - angB) > 1e-6) return angA - angB;
        const dx = pa.x - pb.x;
        if (Math.abs(dx) > 1e-6) return dx;
        return a.carrelName.localeCompare(b.carrelName);
    });
}

// ============================================================================
// Waiting-agent & Deixis helpers for Strip
// ============================================================================

/**
 * Collect all currently waiting agents across `ctx.gomuxHub` and `ctx.agentBooks`.
 * Returns a Map from agent/lane id -> `{ name, detail, groupId, carrelName }`.
 *
 * @param {Object} ctx
 * @returns {Map<string, {name:string, detail:string, groupId:string, carrelName:string|null}>}
 */
export function collectWaitingAgents(ctx) {
    const out = new Map();
    if (!ctx) return out;

    const findOwnerCarrelName = (groupId, agentName) => {
        const holder = ctx.holding?.holderOf?.(groupId);
        if (holder?.carrelName) return holder.carrelName;
        if (ctx.carrels instanceof Map) {
            for (const c of ctx.carrels.values()) {
                if (c._dissolving) continue;
                if (c.entries?.has(groupId) || c.entries?.has(`agent:book:${agentName}`) || c.entries?.has(agentName)) {
                    return c.carrelName;
                }
            }
        }
        return null;
    };

    // 1. From gomuxHub
    for (const w of waitingAgents(ctx.gomuxHub)) {
        const lane = ctx.agentBooks?.lanes?.get?.(w.name);
        const groupId = lane?.groupId || `agent:book:${w.name}`;
        out.set(w.name, {
            name: w.name,
            detail: w.detail || 'needs you',
            groupId,
            carrelName: findOwnerCarrelName(groupId, w.name),
        });
    }

    // 2. From agentBooks lanes with a raised hand (`lane.beacon` or `meta.gomux.status === 'waiting'`)
    if (ctx.agentBooks?.lanes instanceof Map) {
        for (const [id, lane] of ctx.agentBooks.lanes.entries()) {
            const status = lane.meta?.gomux?.status;
            if (!lane.beacon && status !== 'waiting') continue;
            if (out.has(id)) continue;
            const groupId = lane.groupId || `agent:book:${id}`;
            out.set(id, {
                name: id,
                detail: typeof lane.beacon === 'string' ? lane.beacon : (lane.meta?.gomux?.detail || 'waiting'),
                groupId,
                carrelName: findOwnerCarrelName(groupId, id),
            });
        }
    }

    return out;
}

/**
 * Count how many waiting agents belong to `carrel` (including nested child carrels).
 * @param {Object} ctx
 * @param {Carrel} carrel
 * @param {Map<string, {name:string, detail:string, groupId:string, carrelName:string|null}>} [waitingMap]
 * @returns {{ count: number, names: string[] }}
 */
export function waitingOnCarrel(ctx, carrel, waitingMap = null) {
    if (!carrel) return { count: 0, names: [] };
    const wMap = waitingMap || collectWaitingAgents(ctx);
    if (!wMap.size) return { count: 0, names: [] };

    const deskNames = new Set([carrel.carrelName]);
    const stack = [carrel];
    while (stack.length) {
        const cur = stack.pop();
        for (const child of childCarrelsOf(ctx, cur)) {
            if (!deskNames.has(child.carrelName)) {
                deskNames.add(child.carrelName);
                stack.push(child);
            }
        }
    }

    const names = [];
    for (const w of wMap.values()) {
        if (w.carrelName && deskNames.has(w.carrelName)) {
            names.push(w.name);
            continue;
        }
        if (carrel.entries?.has(w.groupId) || carrel.entries?.has(w.name)) {
            names.push(w.name);
        }
    }
    return { count: names.length, names };
}

// ============================================================================
// Strip Controller
// ============================================================================

export class Strip {
    /**
     * @param {Object} ctx - AppContext
     * @param {import('./PlaneOverlay.js').default} overlay
     * @param {{exec: (cmd: string) => any} & Partial<typeof DEFAULT_STRIP_CONFIG>} opts
     *   exec: runs a verb on the live command bus (a card's click is `carrel.enter <name>`) — required:
     *   the strip runs on the provider's raw ctx, which carries no router of its own
     */
    constructor(ctx, overlay, opts) {
        const { exec, ...cfgOpts } = opts ?? {};
        if (typeof exec !== 'function') throw new Error('Strip: opts.exec (the command bus) is required');
        this.ctx = ctx;
        this.overlay = overlay;
        if (overlay) overlay._strip = this;
        this._exec = exec;
        this.config = { ...DEFAULT_STRIP_CONFIG, ...cfgOpts };
        if (cfgOpts?.enabled === undefined) {
            const s = getSetting('strip.enabled');
            if (s != null) this.config.enabled = Boolean(s);
        }
        if (cfgOpts?.order === undefined) {
            const o = getSetting('strip.order');
            if (o === 'tree' || o === 'bearing') this.config.order = o;
        }
        this._collapsed = cfgOpts?.collapsed !== undefined
            ? Boolean(cfgOpts.collapsed)
            : Boolean(getSetting('strip.collapsed') ?? DEFAULT_STRIP_CONFIG.collapsed);
        this.config.collapsed = this._collapsed;

        this._scrollPx = 0;
        this._maxScrollPx = 0;
        this._contentHeightPx = 0;
        this._listViewportHeightPx = 0;
        this._listTopY = 0;
        this._lastHeader = null;
        /** @type {Array<{name:string, bearing:number, depth:number, parent:string|null, entered:boolean, waitingCount:number, waitingNames:string[], shown:boolean, inView:boolean, rect:{x:number,y:number,w:number,h:number}|null}>} */
        this._lastCards = [];
        /** @type {Array<{id:string, kind:'deixis'|'waiting', edge:'left'|'right'|'top'|'bottom', x:number, y:number, text:string}>} */
        this._lastEdgeMarks = [];
        this._lastStripRightPx = 0;
        this._lastCluster = null;
        /** The desk and reserve the focused pin was last cleared for (`<desk>|<stripRightPx>`; see update's step 7). @type {string|null} */
        this._pinClearKey = null;
    }

    /**
     * Update strip configuration at runtime.
     * @param {Partial<typeof DEFAULT_STRIP_CONFIG>} opts
     */
    configure(opts = {}) {
        if (!opts || typeof opts !== 'object') return;
        const { collapsed, ...rest } = opts;
        Object.assign(this.config, rest);
        if (collapsed !== undefined) {
            this.setCollapsed(collapsed, { persist: false });
        }
    }

    /**
     * Whether the strip is enabled (`strip.enabled`).
     * @returns {boolean}
     */
    isEnabled() {
        return Boolean(this.config.enabled);
    }

    /**
     * Whether the strip is collapsed (`strip.collapsed`).
     * @returns {boolean}
     */
    isCollapsed() {
        return Boolean(this._collapsed);
    }

    /**
     * Current desk ordering mode (`'tree'` or `'bearing'`).
     * @returns {'tree'|'bearing'}
     */
    orderMode() {
        return this.config.order === 'bearing' ? 'bearing' : 'tree';
    }

    /**
     * Collapse or expand the strip, optionally persisting `strip.collapsed` in settings.
     * When collapsed, `stripRightPx()` and `leftInsetForCarrel()` become `0`, giving the
     * reserved column back to the active plane.
     *
     * @param {boolean} collapsed
     * @param {{ persist?: boolean }} [opts]
     * @returns {boolean}
     */
    setCollapsed(collapsed, { persist = true } = {}) {
        const next = Boolean(collapsed);
        const prev = this._collapsed;
        this._collapsed = next;
        this.config.collapsed = next;
        if (persist) {
            setSetting(this.ctx, 'strip.collapsed', next);
        }
        this.update();
        if (prev !== next) {
            this._reaimPlaneForReserveChange();
        }
        return this._collapsed;
    }

    /**
     * Toggle the strip collapsed state.
     * @param {{ persist?: boolean }} [opts]
     * @returns {boolean}
     */
    toggleCollapsed(opts) {
        return this.setCollapsed(!this._collapsed, opts);
    }

    /**
     * Current vertical scroll offset in device pixels (clamped to `[0, maxScrollPx]`).
     * @returns {number}
     */
    scrollPx() {
        return this._scrollPx;
    }

    /**
     * Maximum vertical scroll offset in device pixels (`>= 0`).
     * @returns {number}
     */
    maxScrollPx() {
        return this._maxScrollPx;
    }

    /**
     * Set vertical scroll offset in device pixels, clamped to `[0, maxScrollPx]`.
     * @param {number} px
     * @returns {number}
     */
    setScroll(px) {
        const raw = Number(px);
        if (!Number.isFinite(raw)) return this._scrollPx;
        this._scrollPx = Math.max(0, Math.round(raw));
        this.update();
        return this._scrollPx;
    }

    /**
     * Scroll the strip list by `deltaPx` device pixels (`+` scrolls down, `-` scrolls up).
     * @param {number} deltaPx
     * @returns {number}
     */
    scrollBy(deltaPx) {
        const d = Number(deltaPx);
        if (!Number.isFinite(d) || d === 0) return this._scrollPx;
        return this.setScroll(this._scrollPx + d);
    }

    /**
     * Handle a mouse wheel event at device-pixel coordinates `(devX, devY)`.
     * If the strip is expanded and `(devX, devY)` lies inside the strip band `[0, stripRightPx]`,
     * scrolls the desk list and returns `true` so the camera/plane behind never moves.
     *
     * @param {number} devX
     * @param {number} devY
     * @param {number} deltaY - wheel delta in device pixels
     * @returns {boolean}
     */
    handleWheelAt(devX, devY, deltaY) {
        if (!this.isEnabled() || this.isCollapsed()) return false;
        if (!(this._lastStripRightPx > 0)) return false;
        const vp = this.overlay?.viewport?.() || { width: 1600, height: 1000, dpr: 1 };
        const vpH = vp.height || 1000;
        if (devX < 0 || devX > this._lastStripRightPx || devY < 0 || devY > vpH) {
            return false;
        }
        this.scrollBy(deltaY);
        return true;
    }

    /**
     * Handle a mouse wheel event at CSS client coordinates `(clientX, clientY)`.
     * @param {number} clientX
     * @param {number} clientY
     * @param {number} deltaY
     * @param {number} [deltaMode=0]
     * @returns {boolean}
     */
    handleWheelAtClient(clientX, clientY, deltaY, deltaMode = 0) {
        return Boolean(this.overlay?.wheelAtClient?.(clientX, clientY, deltaY, deltaMode));
    }

    /**
     * The right-most device-pixel X coordinate occupied by the left-edge strip cards
     * (`0` when disabled or collapsed).
     * Used by `enterPlaneDesk` / `pinAim` and `_ensureFocusedPinClear` so the strip never covers
     * the focused pin.
     * @returns {number}
     */
    stripRightPx() {
        return this._lastStripRightPx;
    }

    /**
     * Compute the left inset in device pixels needed if `forCarrel` (or a standalone surface when null)
     * is entered right now. Returns `0` when the strip is disabled or collapsed.
     * @param {Carrel|null} [_forCarrel]
     * @returns {number}
     */
    leftInsetForCarrel(_forCarrel = null) {
        if (!this.isEnabled() || this.isCollapsed()) return 0;
        const map = this.ctx?.carrels instanceof Map ? this.ctx.carrels : null;
        if (!map) return 0;
        let liveCount = 0;
        for (const c of map.values()) {
            if (!c || c._dissolving) continue;
            liveCount++;
        }
        if (liveCount === 0) return 0;
        const vp = this.overlay?.viewport?.() || { width: 1600, height: 1000, dpr: 1 };
        const dpr = vp.dpr || 1;
        return Math.round((this.config.edgeLeftPx + this.config.cardWidthPx + this.config.pinClearancePx) * dpr);
    }

    /**
     * Inspect current strip placement state (for verbs and test gates).
     */
    getState() {
        return {
            enabled: this.isEnabled(),
            collapsed: this.isCollapsed(),
            order: this.orderMode(),
            enteredCarrel: this.ctx?.enteredCarrel ?? null,
            stripRightPx: this._lastStripRightPx,
            scrollPx: this._scrollPx,
            maxScrollPx: this._maxScrollPx,
            contentHeightPx: this._contentHeightPx,
            viewportHeightPx: this._listViewportHeightPx,
            header: this._lastHeader ? { ...this._lastHeader, rect: { ...this._lastHeader.rect } } : null,
            cards: this._lastCards.map((c) => ({ ...c, rect: c.rect ? { ...c.rect } : null })),
            cluster: this._lastCluster ? { ...this._lastCluster } : null,
            edgeMarks: this._lastEdgeMarks.map((m) => ({ ...m })),
        };
    }

    /**
     * Remove any `'strip'` overlay items not updated during the current frame.
     * @param {Set<string>} activeIds
     * @private
     */
    _pruneStripOverlay(activeIds) {
        if (!this.overlay?.items) return;
        for (const [id, rec] of [...this.overlay.items.entries()]) {
            if (rec.kind === 'strip' && !activeIds.has(id)) {
                this.overlay.remove(id);
            }
        }
    }

    /**
     * Per-frame update. Renders the collapsible header row, scrollable desk cards, and
     * (when inside a plane) off-screen edge marks into `this.overlay`.
     */
    update() {
        const overlay = this.overlay;
        const ctx = this.ctx;
        if (!overlay || !ctx) return;

        const activeIds = new Set();
        this._lastHeader = null;
        this._lastCards = [];
        this._lastEdgeMarks = [];
        this._lastStripRightPx = 0;
        this._lastCluster = null;

        const enabled = this.isEnabled();
        if (!enabled || !(ctx.carrels instanceof Map)) {
            this._pruneStripOverlay(activeIds);
            return;
        }

        const enteredName = ctx.enteredCarrel;
        const entered = enteredName ? ctx.carrels.get(enteredName) : null;
        const planeState = ctx.cameraController?.planeState?.() ?? null;
        const inPlane = Boolean((entered && !entered._dissolving) || (planeState && !planeState.leaving));

        const vp = this.overlay?.viewport?.() || { width: 1600, height: 1000, dpr: 1 };
        const dpr = vp.dpr || 1;
        const vpW = vp.width || 1600;
        const vpH = vp.height || 1000;

        // 1. Viewer position and forward direction for bearing calculations
        const { viewerPos, viewerFwd } = this._viewerFrame(entered);

        // 2. Collect ALL live carrels in configured order ('tree' default or 'bearing')
        const orderMode = this.orderMode();
        const orderedDesks = orderCarrelsForStrip(ctx, orderMode, viewerPos, viewerFwd);
        if (orderedDesks.length === 0) {
            this._scrollPx = 0;
            this._maxScrollPx = 0;
            this._contentHeightPx = 0;
            if (inPlane) {
                const waitingMap = collectWaitingAgents(ctx);
                this._renderOffscreenEdgeMarks(entered, waitingMap, vpW, vpH, dpr, activeIds);
            }
            this._pruneStripOverlay(activeIds);
            return;
        }

        const waitingMap = collectWaitingAgents(ctx);
        const baseCardW = Math.round(this.config.cardWidthPx * dpr);
        const leftX = Math.round(this.config.edgeLeftPx * dpr);
        const topY = Math.round(this.config.edgeTopPx * dpr);
        const headerH = Math.round(this.config.headerHeightPx * dpr);
        const headerGap = Math.round(this.config.headerGapPx * dpr);
        const gapY = Math.round(this.config.cardGapPx * dpr);
        const bottomMargin = Math.round(this.config.edgeBottomPx * dpr);
        const indentUnitPx = Math.round(this.config.treeIndentPx * dpr);

        const listTopY = topY + headerH + headerGap;
        const listBottomY = Math.max(listTopY + Math.round(this.config.cardMinHeightPx * dpr), vpH - bottomMargin);
        const listViewportH = Math.max(1, listBottomY - listTopY);
        this._listTopY = listTopY;
        this._listViewportHeightPx = listViewportH;

        const waitingIdsOnStrip = new Set();
        const candidates = [];
        let curOffset = 0;
        for (const d of orderedDesks) {
            const waitInfo = waitingOnCarrel(ctx, d.carrel, waitingMap);
            for (const wn of waitInfo.names) waitingIdsOnStrip.add(wn);
            const indentPx = orderMode === 'tree' ? Math.min(d.depth, 3) * indentUnitPx : 0;
            const cardX = leftX + indentPx;
            const cardW = Math.max(Math.round(64 * dpr), baseCardW - indentPx);
            const pr = d.carrel.getPlaneRect?.();
            const aspect = pr && pr.height > 0 ? pr.width / pr.height : 16 / 10;
            const rawH = Math.round(baseCardW / Math.max(0.5, Math.min(3.0, aspect)));
            const cardH = Math.max(
                Math.round(this.config.cardMinHeightPx * dpr),
                Math.min(Math.round(this.config.cardMaxHeightPx * dpr), rawH)
            );
            candidates.push({
                ...d,
                waitingCount: waitInfo.count,
                waitingNames: waitInfo.names,
                cardX,
                cardW,
                cardH,
                offsetY: curOffset,
            });
            curOffset += cardH + gapY;
        }

        const contentHeightPx = candidates.length > 0 ? curOffset - gapY : 0;
        const maxScrollPx = Math.max(0, contentHeightPx - listViewportH);
        this._contentHeightPx = contentHeightPx;
        this._maxScrollPx = maxScrollPx;
        this._scrollPx = Math.max(0, Math.min(maxScrollPx, Math.round(this._scrollPx || 0)));

        // 3. Header row (`strip:header`) with chevron and click-to-toggle
        const collapsed = this.isCollapsed();
        const totalWaiting = waitingIdsOnStrip.size;
        const chevron = collapsed ? '▶' : '▼';
        const headerTitle = `${chevron} Desks (${candidates.length})`;
        const headerBadge = totalWaiting > 0
            ? `${totalWaiting} waiting`
            : (collapsed && entered ? entered.carrelName : '');
        const headerRect = { x: leftX, y: topY, w: baseCardW, h: headerH };
        this._lastHeader = {
            id: 'strip:header',
            title: headerTitle,
            badge: headerBadge,
            collapsed,
            count: candidates.length,
            waitingCount: totalWaiting,
            rect: headerRect,
        };
        activeIds.add('strip:header');
        overlay.setCard('strip:header', {
            x: headerRect.x,
            y: headerRect.y,
            w: headerRect.w,
            h: headerRect.h,
            title: headerTitle,
            badge: headerBadge,
            color: 0x0f172a,
            borderColor: totalWaiting > 0 ? 0xf59e0b : 0x475569,
            borderWidth: 1.5,
            badgeColor: totalWaiting > 0 ? 0xf59e0b : 0x6ee7a0,
            opacity: 1.0,
            z: 8,
            kind: 'strip',
            interactive: true,
            data: {
                kind: 'header',
                collapsed,
                count: candidates.length,
                waitingCount: totalWaiting,
            },
            onClick: () => this._exec('strip.collapse toggle'),
        });

        // 4. When collapsed, only the thin header is shown and `stripRightPx` is 0
        if (collapsed) {
            this._lastStripRightPx = 0;
            for (const item of candidates) {
                const isEntered = Boolean(entered && item.name === entered.carrelName);
                const cardEntry = ctx.carrelCards?.get?.(item.name) ?? null;
                const tex = cardEntry?.target?.texture ?? null;
                this._lastCards.push({
                    name: item.name,
                    bearing: item.bearing,
                    depth: item.depth,
                    parent: item.parent,
                    entered: isEntered,
                    waitingCount: item.waitingCount,
                    waitingNames: item.waitingNames,
                    shown: false,
                    inView: false,
                    hasTexture: !!tex,
                    placeholder: !tex,
                    rect: null,
                });
            }
            if (inPlane) {
                this._renderOffscreenEdgeMarks(entered, waitingMap, vpW, vpH, dpr, activeIds);
            }
            this._pruneStripOverlay(activeIds);
            return;
        }

        // 5. Expanded: reserve left band `[0, stripRightPx]` and render scrollable desk cards
        this._lastStripRightPx = leftX + baseCardW + Math.round(this.config.pinClearancePx * dpr);
        activeIds.add('strip:backdrop');
        overlay.setCard('strip:backdrop', {
            x: 0,
            y: 0,
            w: this._lastStripRightPx,
            h: vpH,
            title: '',
            badge: '',
            color: 0x050608,
            borderColor: 0x050608,
            borderWidth: 0,
            opacity: 1.0,
            z: 1,
            kind: 'strip',
            interactive: false,
        });

        const minVisibleCardH = Math.round(24 * dpr);
        for (const item of candidates) {
            const isEntered = Boolean(entered && item.name === entered.carrelName);
            const rawY = listTopY + item.offsetY - this._scrollPx;
            const rawBottom = rawY + item.cardH;
            const drawY = Math.max(listTopY, rawY);
            const drawBottom = Math.min(vpH - Math.round(4 * dpr), rawBottom);
            const drawH = drawBottom - drawY;
            const inView = drawH >= minVisibleCardH && rawBottom > listTopY && rawY < vpH - Math.round(4 * dpr);

            const cardEntry = inView
                ? (ctx.carrelCards?.ensureCard?.(item.carrel, this.config.cardWidthPx) ?? null)
                : (ctx.carrelCards?.get?.(item.name) ?? null);
            const tex = cardEntry?.target?.texture ?? null;
            const placeholder = !tex;

            const rect = { x: item.cardX, y: inView ? drawY : rawY, w: item.cardW, h: inView ? drawH : item.cardH };
            const targetName = item.name;
            const shortName = item.depth > 0 && item.parent && targetName.startsWith(`${item.parent}/`)
                ? `└ ${targetName.slice(item.parent.length + 1)}`
                : (item.depth > 0 ? `└ ${targetName}` : targetName);

            if (inView) {
                const badge = item.waitingCount > 0
                    ? `${item.waitingCount} waiting`
                    : (placeholder
                        ? '…'
                        : (isEntered
                            ? 'entered'
                            : (targetName === ctx.carrelBack ? 'back' : '')));
                const borderColor = item.waitingCount > 0
                    ? 0xf59e0b
                    : (isEntered
                        ? 0x6ee7a0
                        : (targetName === ctx.carrelBack ? 0x60a5fa : 0x334155));
                const badgeColor = item.waitingCount > 0
                    ? 0xf59e0b
                    : (placeholder
                        ? 0x475569
                        : (isEntered ? 0x6ee7a0 : 0x3b82f6));

                const cardId = `strip:card:${targetName}`;
                activeIds.add(cardId);
                overlay.setCard(cardId, {
                    x: rect.x,
                    y: rect.y,
                    w: rect.w,
                    h: rect.h,
                    title: shortName,
                    badge,
                    borderColor,
                    borderWidth: isEntered ? 2.5 : 1.5,
                    color: isEntered ? 0x112233 : 0x0b1220,
                    badgeColor,
                    opacity: 1.0,
                    z: 5,
                    texture: tex,
                    placeholder,
                    kind: 'strip',
                    data: {
                        carrel: targetName,
                        bearing: item.bearing,
                        depth: item.depth,
                        parent: item.parent,
                        entered: isEntered,
                        waiting: item.waitingCount,
                        waitingNames: item.waitingNames,
                        placeholder,
                        stale: cardEntry ? cardEntry.stale : true,
                    },
                    onClick: () => this._exec(`carrel.enter ${JSON.stringify(targetName)}`),
                });
            }

            this._lastCards.push({
                name: targetName,
                bearing: item.bearing,
                depth: item.depth,
                parent: item.parent,
                entered: isEntered,
                waitingCount: item.waitingCount,
                waitingNames: item.waitingNames,
                shown: inView,
                inView,
                hasTexture: !!tex,
                placeholder,
                rect,
            });
        }

        // 6. Off-screen edge marks for Deixis points and off-screen waiting agents (when in a plane)
        if (inPlane) {
            this._renderOffscreenEdgeMarks(entered, waitingMap, vpW, vpH, dpr, activeIds);
        }

        // 7. Focused-pin non-overlap: when the reserve changes under a desk (entered, the band's width), the
        // focused pin is cleared ONCE — never per frame: a pan that slides the pin under the band is the
        // person's, and pulling it back each frame would wall the board off at the focused pin.
        const clearKey = `${entered?.carrelName ?? ''}|${this._lastStripRightPx}`;
        if (clearKey !== this._pinClearKey && this._ensureFocusedPinClear(entered, vpW)) this._pinClearKey = clearKey;

        this._pruneStripOverlay(activeIds);
    }

    /**
     * Re-aim the active plane view when the strip collapses or expands so collapsing gives the
     * reserved column back to the plane and expanding clears the strip again.
     * @private
     */
    _reaimPlaneForReserveChange() {
        const cc = this.ctx?.cameraController;
        const st = cc?.planeState?.();
        if (!st || st.leaving) return;

        const vp = cc.planeViewport?.() || this.overlay?.viewport?.() || { width: 1600, height: 1000, dpr: 1 };
        const dpr = vp.dpr || 1;
        const enteredName = this.ctx?.enteredCarrel;
        const entered = enteredName && this.ctx?.carrels instanceof Map ? this.ctx.carrels.get(enteredName) : null;

        if (entered && entered.mode === 'plane' && entered.planeArrange === 'pins' && entered.planeUnit) {
            const focusId = entered.focusedPin?.();
            if (!focusId) return;
            const topMarginPx = Number(getSetting('plane.topMarginPx') ?? 0) * dpr;
            const leftInset = this.leftInsetForCarrel(entered);
            const aim = entered.pinAim(focusId, vp, topMarginPx, leftInset);
            if (aim) cc.setPlaneAim?.(aim.x, st.aim.y);
            return;
        }

        const targetId = this.ctx?.planeTarget;
        if (targetId && !String(targetId).startsWith('carrel:')) {
            const entry = this.ctx?.registry?.get?.(targetId);
            const plane = entry?.grid ? cc.planeOf?.(entry.grid) : null;
            if (plane && st.pxPerUnit > 0) {
                const leftInset = this.leftInsetForCarrel(null);
                const viewW = vp.width / st.pxPerUnit;
                const leftMargin = (Number(getSetting('plane.leftMarginPx') ?? 0) * dpr) / st.pxPerUnit;
                const ax0 = plane.width <= viewW ? 0 : -plane.width / 2 + viewW / 2 - leftMargin;
                const ax = leftInset > 0 ? Math.min(ax0, -plane.width / 2 + viewW / 2 - leftInset / st.pxPerUnit) : ax0;
                cc.setPlaneAim?.(ax, st.aim.y);
            }
        }
    }

    /**
     * Compute viewer world position and horizontal forward vector for bearing calculations.
     * @param {Carrel|null} entered
     * @private
     */
    _viewerFrame(entered) {
        if (entered) {
            const center = carrelWorldCenter(entered);
            const pr = entered.getPlaneRect?.();
            if (pr?.normal) {
                // Looking INTO the entered plane (`-normal`)
                return {
                    viewerPos: center,
                    viewerFwd: { x: -pr.normal.x, z: -pr.normal.z },
                };
            }
        }
        const cam = this.ctx?.camera;
        if (cam) {
            _tmpFwd.set(0, 0, -1).applyQuaternion(cam.quaternion);
            return {
                viewerPos: { x: cam.position.x, y: cam.position.y, z: cam.position.z },
                viewerFwd: { x: _tmpFwd.x, z: _tmpFwd.z },
            };
        }
        const center = entered ? carrelWorldCenter(entered) : { x: 0, y: 0, z: 0 };
        return {
            viewerPos: center,
            viewerFwd: { x: -Math.sin(entered?.rotation?.y || 0), z: -Math.cos(entered?.rotation?.y || 0) },
        };
    }

    /**
     * Render edge marks for off-screen Deixis points (`ctx.deixis.list()`) and any waiting
     * agent whose surface is off-screen in the entered plane (or hidden in overflow).
     * @private
     */
    _renderOffscreenEdgeMarks(entered, waitingMap, vpW, vpH, dpr, activeIds) {
        const cam = this.ctx?.camera;
        if (!cam) return;
        cam.updateMatrixWorld?.();
        cam.updateProjectionMatrix?.();

        const inset = Math.round(this.config.edgeMarkInsetPx * dpr);
        const minX = Math.max(inset, this._lastStripRightPx + Math.round(4 * dpr));
        const maxX = vpW - inset;
        const minY = inset;
        const maxY = vpH - inset;

        // A. Deixis points
        const points = this.ctx?.deixis?.list?.() || [];
        for (const pt of points) {
            if (pt.status === 'orphan' || pt.status === 'resolved') continue;
            const worldPos = this._pointWorldPos(pt);
            if (!worldPos) continue;
            const proj = this._projectToScreen(worldPos, cam, vpW, vpH);
            if (!proj.offscreen) continue;
            const clamped = clampToViewportEdge(proj.x, proj.y, minX, maxX, minY, maxY, vpW, vpH);
            const hexColor = hueToHex(pt.hue);
            const labelText = `● ${pt.who}${pt.say ? `: ${pt.say}` : ''}`;
            const markId = `strip:mark:deixis:${pt.id}`;
            activeIds?.add(markId);
            this.overlay.setCard(markId, {
                x: clamped.x,
                y: clamped.y,
                w: Math.round(116 * dpr),
                h: Math.round(22 * dpr),
                title: labelText,
                color: 0x0a0e16,
                borderColor: hexColor,
                badgeColor: hexColor,
                opacity: 1.0,
                z: 5,
                kind: 'strip',
                data: { kind: 'deixis', who: pt.who, ref: pt.ref?.text, edge: clamped.edge },
            });
            this._lastEdgeMarks.push({
                id: markId,
                kind: 'deixis',
                who: pt.who,
                edge: clamped.edge,
                x: clamped.x,
                y: clamped.y,
                text: labelText,
            });
        }

        // B. Waiting agents:
        //    - A waiting agent seated on the ENTERED carrel whose book/surface is off-screen
        //    - OR a waiting agent on another carrel whose card wasn't shown directly on the strip
        const shownWaitingNames = new Set();
        for (const c of this._lastCards) {
            if (c.shown && !c.entered) {
                for (const name of c.waitingNames) shownWaitingNames.add(name);
            }
        }

        for (const w of waitingMap.values()) {
            if (shownWaitingNames.has(w.name)) continue;
            const worldPos = this._waitingWorldPos(w);
            let proj = worldPos ? this._projectToScreen(worldPos, cam, vpW, vpH) : null;
            // If the waiting agent is on an unshown card, or its surface in the entered carrel is off-screen,
            // emit an explicit edge mark so a waiting agent is NEVER lost!
            const onEnteredCarrel = Boolean(entered && w.carrelName === entered.carrelName);
            if (onEnteredCarrel && proj && !proj.offscreen) continue;

            if (!proj) {
                proj = { x: minX, y: Math.round(vpH * 0.5), offscreen: true };
            }
            const clamped = clampToViewportEdge(proj.x, proj.y, minX, maxX, minY, maxY, vpW, vpH);
            const labelText = `⚑ ${w.name} · waiting`;
            const markId = `strip:mark:waiting:${w.name}`;
            activeIds?.add(markId);
            this.overlay.setCard(markId, {
                x: clamped.x,
                y: clamped.y,
                w: Math.round(116 * dpr),
                h: Math.round(22 * dpr),
                title: labelText,
                badge: 'waiting',
                color: 0x30200c,
                borderColor: 0xf59e0b,
                badgeColor: 0xf59e0b,
                opacity: 1.0,
                z: 5,
                kind: 'strip',
                data: { kind: 'waiting', name: w.name, carrel: w.carrelName, edge: clamped.edge },
            });
            this._lastEdgeMarks.push({
                id: markId,
                kind: 'waiting',
                who: w.name,
                edge: clamped.edge,
                x: clamped.x,
                y: clamped.y,
                text: labelText,
            });
        }
    }

    /**
     * Resolve the 3D world position of a Deixis `Point`.
     * @param {Object} pt
     * @returns {THREE.Vector3|null}
     * @private
     */
    _pointWorldPos(pt) {
        const entry = this.ctx?.registry?.get?.(pt?.ref?.entity);
        const grid = entry?.grid;
        if (!grid) return null;
        grid.updateWorldMatrix?.(true, false);

        const mt = grid.metrics;
        const po = grid.pixelOrigin?.();
        if (mt?.lineSpacing > 0 && po) {
            const line0 = pt.ref.kind === 'terminal'
                ? Math.max(0, (pt.ref.durable?.line ?? 0) - (grid.linesScrolled ?? 0))
                : Math.max(0, (pt.ref.durable?.line ?? 1) - 1);
            const col0 = Math.max(0, (pt.ref.durable?.col ?? 1) - 1);
            const lx = po.x + col0 * (mt.charWidth || 0);
            const ly = po.y - (line0 + 0.5) * mt.lineSpacing;
            return new THREE.Vector3(lx, ly, 0).applyMatrix4(grid.matrixWorld);
        }

        const b = grid.getBounds?.();
        if (b && !b.isEmpty()) return b.getCenter(new THREE.Vector3());
        if (grid.matrixWorld) return new THREE.Vector3().setFromMatrixPosition(grid.matrixWorld);
        return null;
    }

    /**
     * Resolve the 3D world position of a waiting agent's book or carrel.
     * @param {{name:string, groupId:string, carrelName:string|null}} w
     * @returns {THREE.Vector3|null}
     * @private
     */
    _waitingWorldPos(w) {
        const entry = this.ctx?.registry?.get?.(w.groupId) || this.ctx?.registry?.get?.(w.name);
        const grid = entry?.grid;
        if (grid) {
            grid.updateWorldMatrix?.(true, false);
            const b = grid.getBounds?.();
            if (b && !b.isEmpty()) return b.getCenter(new THREE.Vector3());
            if (grid.matrixWorld) return new THREE.Vector3().setFromMatrixPosition(grid.matrixWorld);
        }
        if (w.carrelName && this.ctx?.carrels instanceof Map) {
            const c = this.ctx.carrels.get(w.carrelName);
            if (c) {
                const pos = carrelWorldCenter(c);
                return new THREE.Vector3(pos.x, pos.y, pos.z);
            }
        }
        return null;
    }

    /**
     * Project a 3D world position to device-pixel screen coordinates.
     * @private
     */
    _projectToScreen(worldPos, cam, vpW, vpH) {
        _tmpNdc.copy(worldPos).project(cam);
        const behind = _tmpNdc.z > 1.0;
        let sx = (_tmpNdc.x * 0.5 + 0.5) * vpW;
        let sy = (-_tmpNdc.y * 0.5 + 0.5) * vpH;
        if (behind) {
            sx = vpW - sx;
            sy = vpH - sy;
        }
        const offscreen = behind || sx < 0 || sx > vpW || sy < 0 || sy > vpH;
        return { x: sx, y: sy, offscreen };
    }

    /**
     * Clear the focused pin of the left-edge strip on a pin-arranged plane desk, once: if its screen
     * left edge is `< stripRightPx`, inset the plane's aim so it sits at `stripRightPx`. The render
     * calls it when the reserve changes (see step 7), never every frame.
     * @param {Carrel|null} entered
     * @param {number} vpW
     * @returns {boolean} whether it could judge (no desk, or a plane view not up yet: false — ask again)
     * @private
     */
    _ensureFocusedPinClear(entered, vpW) {
        if (!entered) return true;
        if (this.ctx?.planeTarget && this.ctx.planeTarget !== `carrel:${entered.carrelName}`) return true;
        const stripRight = this._lastStripRightPx;
        if (!(stripRight > 0)) return true;
        if (entered.mode !== 'plane' || entered.planeArrange !== 'pins' || !entered.planeUnit) return true;

        const cc = this.ctx?.cameraController;
        const st = cc?.planeState?.();
        if (!st || st.leaving) return false;

        const focusId = entered.focusedPin?.();
        if (!focusId) return true;
        const pin = entered.pinRects?.().find((p) => p.id === focusId);
        const box = entered._boardPx?.();
        if (!pin || !box) return true;

        const scale = typeof entered._planeScale === 'function' ? entered._planeScale() : 1;
        const k = entered.planeK / scale; // device px per world unit
        const r = pin.rect;
        const pinLeftWorld = -box.w / (2 * k) + r.x / k;
        // Screen X of `pinLeftWorld` when plane aim is `st.aim.x`:
        // screenLeft = vpW / 2 + (pinLeftWorld - st.aim.x) * k
        const screenLeft = vpW / 2 + (pinLeftWorld - st.aim.x) * k;
        if (screenLeft >= stripRight - 0.5) return true;

        // Inset aim.x so `screenLeft === stripRight`
        const newAimX = pinLeftWorld - (stripRight - vpW / 2) / k;
        cc.setPlaneAim?.(newAimX, st.aim.y);
        return true;
    }
}

function clampToViewportEdge(x, y, minX, maxX, minY, maxY, vpW, vpH) {
    const cx = Math.max(minX, Math.min(maxX - 110, Math.round(x)));
    const cy = Math.max(minY, Math.min(maxY - 24, Math.round(y)));
    let edge = 'right';
    if (x < 0) edge = 'left';
    else if (x > vpW) edge = 'right';
    else if (y < 0) edge = 'top';
    else if (y > vpH) edge = 'bottom';
    return { x: cx, y: cy, edge };
}

function hueToHex(hue) {
    if (!hue || typeof hue !== 'object') return 0x60a5fa;
    const r = Math.max(0, Math.min(255, Math.round((hue.r ?? 0.4) * 255)));
    const g = Math.max(0, Math.min(255, Math.round((hue.g ?? 0.7) * 255)));
    const b = Math.max(0, Math.min(255, Math.round((hue.b ?? 1.0) * 255)));
    return (r << 16) | (g << 8) | b;
}

// ============================================================================
// Command registration: `carrel.neighbor <h|l|j|k|parent|child>`
// ============================================================================

/**
 * Register `carrel.neighbor` and `strip.collapse` on the command router if not already registered.
 * @param {import('./CommandProvider.jsx').AppRouter} router
 */
export function registerStripCommands(router) {
    if (!router) return;

    if (!router._commands?.has?.('carrel.neighbor')) {
        router.register('carrel.neighbor', async (args, ctx) => {
            const dir = args[0];
            if (!dir) {
                return { text: 'ERR: usage: carrel.neighbor <h|l|j|k|parent|child> [from]', data: null };
            }
            const fromArg = args[1] ? String(args[1]) : null;
            const resolved = resolveCarrelNeighbor(ctx, dir, fromArg);
            if (resolved.error || !resolved.carrel) {
                return { text: `ERR: ${resolved.error || 'no neighbor found'}`, data: null };
            }

            const next = resolved.carrel;
            const fromName = resolved.from?.carrelName ?? null;
            const enterRes = typeof ctx.execute === 'function'
                ? await ctx.execute(['carrel.enter', next.carrelName])
                : await router.execute(`carrel.enter ${JSON.stringify(next.carrelName)}`);
            return {
                text: `OK: carrel.neighbor ${resolved.dir} '${fromName}' → '${next.carrelName}'`,
                data: {
                    from: fromName,
                    to: next.carrelName,
                    name: next.carrelName,
                    dir: resolved.dir,
                    bearing: resolved.bearing ?? 0,
                    enter: enterRes?.data ?? null,
                },
            };
        }, {
            description: 'Step to the neighboring carrel by bearing / seat geometry (h/l around the ring or shelf, j/k between rows, parent/child for nested desks)',
            usage: '<h|l|j|k|parent|child> [from]',
            returns: '{ from, to, name, dir, bearing }',
        });
    }

    if (!router._commands?.has?.('strip.collapse')) {
        router.register('strip.collapse', (args, ctx) => {
            const strip = ctx?.strip;
            if (!strip) {
                return { text: 'ERR: strip not initialized', data: null };
            }
            const raw = String(args[0] ?? 'toggle').trim().toLowerCase();
            let next;
            if (!raw || raw === 'toggle') {
                next = !strip.isCollapsed();
            } else if (raw === 'on' || raw === 'true' || raw === '1' || raw === 'yes') {
                next = true;
            } else if (raw === 'off' || raw === 'false' || raw === '0' || raw === 'no') {
                next = false;
            } else {
                return { text: `ERR: usage: strip.collapse [on|off|toggle] (got '${args[0]}')`, data: null };
            }
            strip.setCollapsed(next, { persist: true });
            const st = strip.getState();
            return {
                text: `OK: strip ${st.collapsed ? 'collapsed' : 'expanded'} (stripRightPx=${st.stripRightPx}, desks=${st.cards.length})`,
                data: {
                    collapsed: st.collapsed,
                    stripRightPx: st.stripRightPx,
                    order: st.order,
                    scrollPx: st.scrollPx,
                    maxScrollPx: st.maxScrollPx,
                    count: st.cards.length,
                },
            };
        }, {
            description: 'Collapse or expand the left-edge desk strip (durable setting strip.collapsed)',
            usage: '[on|off|toggle]',
            returns: '{ collapsed, stripRightPx, order, scrollPx, maxScrollPx, count }',
        });
    }
}

export default Strip;
