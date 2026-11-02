/**
 * Strip — Left-edge carrel cards, off-screen edge marks, and neighbor navigation
 * inside an entered plane (`docs/planes/DESIGN.md` §3.14, Slice 8).
 *
 * Inside an entered plane (`ctx.enteredCarrel`):
 * 1. Renders the OTHER live carrels as quiet cards along the left edge of `PlaneOverlay`,
 *    ordered by TRUE BEARING from where you stand (the ring unrolled: the seat layout that
 *    rolls into the cylinder at curvature 1/R lays out the strip at curvature 0).
 * 2. Shows at most `maxCards` (default 6) cards on the edge, with the remainder summarized in a
 *    cluster pill (`+N more` or `+N more · M waiting` — a waiting count never aggregates away).
 *    Carrels with waiting agents carry a waiting badge and are guaranteed to be either shown
 *    as a card or edge-marked.
 * 3. Clicking a card (`overlay.clickAt` / `pickAt`) invokes `carrel.enter <name>` (the switch cut).
 * 4. Off-screen deixis points (`ctx.deixis.list()`) and off-screen waiting agents receive
 *    high-contrast edge marks clamped to the viewport boundary.
 * 5. Never covers the focused pin: if the entered plane is a pin board (`planeArrange === 'pins'`)
 *    and the focused pin's screen rect overlaps `[0, stripRightPx]`, insets the plane's aim so
 *    the focused pin clears the strip.
 *
 * Also provides `seatMap()` / `rollSeat()` on `Carrel` and `carrel.neighbor <h|l|j|k|parent|child>`.
 */

import * as THREE from 'three';
import { flowBoxes, squareWrap } from '@glyph3d/core/collections/layouts/flowBoxes.js';
import { getSetting } from './settings.js';
import { waitingAgents } from '../commands/handlers/gomuxCommands.js';
/** @import Carrel from '@glyph3d/core/services/interaction/Carrel.js' */

const DEG2RAD = Math.PI / 180;
const _tmpPos = new THREE.Vector3();
const _tmpFwd = new THREE.Vector3();
const _tmpNdc = new THREE.Vector3();

export const DEFAULT_STRIP_CONFIG = Object.freeze({
    enabled: true,
    maxCards: 6,
    cardWidthPx: 148,
    cardMaxHeightPx: 96,
    cardMinHeightPx: 54,
    edgeLeftPx: 12,
    edgeTopPx: 52,
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

/**
 * Find the parent `Carrel` that seats `carrel` as a nested desk, or `null` if top-level.
 * @param {Object} ctx
 * @param {Carrel} carrel
 * @returns {Carrel|null}
 */
export function parentCarrelOf(ctx, carrel) {
    if (!carrel) return null;
    if (carrel.parent?.isCarrel && !carrel.parent._dissolving) return carrel.parent;
    const map = ctx?.carrels instanceof Map ? ctx.carrels : null;
    if (!map) return null;
    const entryKey = carrel.name || `carrel:${carrel.carrelName}`;
    for (const c of map.values()) {
        if (c === carrel || c._dissolving) continue;
        if (c.entries?.has(entryKey) || c.entries?.get(carrel.carrelName)?.grid === carrel) {
            return c;
        }
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
        if (entry?.grid?.isCarrel && !entry.grid._dissolving) return entry.grid;
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
        if (e.grid?.isCarrel && !e.grid._dissolving && !seen.has(e.grid.carrelName)) {
            seen.add(e.grid.carrelName);
            out.push(e.grid);
        }
    }
    return out;
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
            if (e?.grid?.isCarrel && !e.grid._dissolving) return true;
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
     * @param {Partial<typeof DEFAULT_STRIP_CONFIG>} [opts]
     */
    constructor(ctx, overlay, opts = {}) {
        this.ctx = ctx;
        this.overlay = overlay;
        this.config = { ...DEFAULT_STRIP_CONFIG, ...opts };
        /** @type {Array<{name:string, bearing:number, waitingCount:number, waitingNames:string[], shown:boolean, rect:{x:number,y:number,w:number,h:number}|null}>} */
        this._lastCards = [];
        /** @type {Array<{id:string, kind:'deixis'|'waiting', edge:'left'|'right'|'top'|'bottom', x:number, y:number, text:string}>} */
        this._lastEdgeMarks = [];
        this._lastStripRightPx = 0;
        this._lastCluster = null;
    }

    /**
     * Update strip configuration at runtime.
     * @param {Partial<typeof DEFAULT_STRIP_CONFIG>} opts
     */
    configure(opts = {}) {
        Object.assign(this.config, opts);
    }

    /**
     * The right-most device-pixel X coordinate occupied by the left-edge strip cards (0 when hidden).
     * Used by `enterPlaneDesk` / `pinAim` and `_ensureFocusedPinClear` so the strip never covers
     * the focused pin.
     * @returns {number}
     */
    stripRightPx() {
        return this._lastStripRightPx;
    }

    /**
     * Compute the left inset in device pixels needed if `forCarrel` (or a standalone surface when null)
     * is entered right now.
     * @param {Carrel|null} [forCarrel]
     * @returns {number}
     */
    leftInsetForCarrel(forCarrel = null) {
        const enabledSetting = getSetting('strip.enabled');
        const enabled = enabledSetting != null ? Boolean(enabledSetting) : this.config.enabled;
        if (!enabled) return 0;
        const map = this.ctx?.carrels instanceof Map ? this.ctx.carrels : null;
        if (!map) return 0;
        const targetName = forCarrel ? forCarrel.carrelName : null;
        let others = 0;
        for (const c of map.values()) {
            if (!c || c._dissolving || c.carrelName === targetName) continue;
            others++;
        }
        if (others === 0) return 0;
        const vp = this.overlay?.viewport?.() || { width: 1600, height: 1000, dpr: 1 };
        const dpr = vp.dpr || 1;
        return Math.round((this.config.edgeLeftPx + this.config.cardWidthPx + this.config.pinClearancePx) * dpr);
    }

    /**
     * Inspect current strip placement state (for verbs and test gates).
     */
    getState() {
        return {
            enteredCarrel: this.ctx?.enteredCarrel ?? null,
            stripRightPx: this._lastStripRightPx,
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
     * Per-frame update. Renders strip cards, cluster summary, and off-screen edge marks into
     * `this.overlay` when inside an entered plane (`ctx.enteredCarrel` or any `plane.enter` view),
     * and enforces that the focused pin is never covered by the strip.
     */
    update() {
        const overlay = this.overlay;
        const ctx = this.ctx;
        if (!overlay || !ctx) return;

        const activeIds = new Set();
        this._lastCards = [];
        this._lastEdgeMarks = [];
        this._lastStripRightPx = 0;
        this._lastCluster = null;

        const enabledSetting = getSetting('strip.enabled');
        const enabled = enabledSetting != null ? Boolean(enabledSetting) : this.config.enabled;
        const enteredName = ctx.enteredCarrel;
        const entered = enteredName && ctx.carrels instanceof Map ? ctx.carrels.get(enteredName) : null;
        const planeState = ctx.cameraController?.planeState?.() ?? null;
        const inPlane = Boolean((entered && !entered._dissolving) || (planeState && !planeState.leaving));
        if (!enabled || !inPlane || !(ctx.carrels instanceof Map)) {
            this._pruneStripOverlay(activeIds);
            return;
        }

        const maxCardsSetting = Number(getSetting('strip.maxCards'));
        const maxCards = Number.isFinite(maxCardsSetting) && maxCardsSetting >= 1
            ? Math.floor(maxCardsSetting)
            : this.config.maxCards;

        const vp = this.overlay?.viewport?.() || { width: 1600, height: 1000, dpr: 1 };
        const dpr = vp.dpr || 1;
        const vpW = vp.width || 1600;
        const vpH = vp.height || 1000;

        // 1. Viewer position and forward direction for true bearing
        const { viewerPos, viewerFwd } = this._viewerFrame(entered);

        // 2. Collect other live carrels, ordered by true bearing from viewer
        const waitingMap = collectWaitingAgents(ctx);
        const candidates = [];
        const enteredParent = entered ? parentCarrelOf(ctx, entered) : null;
        for (const c of ctx.carrels.values()) {
            if (!c || c._dissolving || (entered && c.carrelName === entered.carrelName)) continue;
            // Skip child carrels that are already represented inside another non-entered parent carrel,
            // unless we are currently inside their parent or sibling in the same parent!
            const parent = parentCarrelOf(ctx, c);
            if (parent && parent !== entered && parent !== enteredParent) continue;

            const bearing = carrelBearingFrom(c, viewerPos, viewerFwd);
            const waitInfo = waitingOnCarrel(ctx, c, waitingMap);
            candidates.push({
                carrel: c,
                name: c.carrelName,
                bearing,
                waitingCount: waitInfo.count,
                waitingNames: waitInfo.names,
            });
        }

        // Sort by true bearing ascending (left-to-right across the horizon), tie-break by name
        candidates.sort((a, b) => {
            if (Math.abs(a.bearing - b.bearing) > 1e-6) return a.bearing - b.bearing;
            return a.name.localeCompare(b.name);
        });

        // 3. Select up to `maxCards` cards to show on the left edge.
        // Invariant: waiting carrels are prioritized into the visible set (preserving bearing order)
        // so a waiting agent is always shown on a card (or if > maxCards all waiting, edge-marked + counted in cluster).
        let shownSet;
        if (candidates.length <= maxCards) {
            shownSet = new Set(candidates.map((c) => c.name));
        } else {
            const picked = new Set();
            for (const c of candidates) {
                if (c.waitingCount > 0 && picked.size < maxCards) picked.add(c.name);
            }
            for (const c of candidates) {
                if (picked.size >= maxCards) break;
                picked.add(c.name);
            }
            shownSet = picked;
        }

        // 4. Layout visible cards along the left edge
        const cardW = Math.round(this.config.cardWidthPx * dpr);
        const leftX = Math.round(this.config.edgeLeftPx * dpr);
        const gapY = Math.round(this.config.cardGapPx * dpr);
        let curY = Math.round(this.config.edgeTopPx * dpr);

        for (const item of candidates) {
            if (!shownSet.has(item.name)) {
                this._lastCards.push({
                    name: item.name,
                    bearing: item.bearing,
                    waitingCount: item.waitingCount,
                    waitingNames: item.waitingNames,
                    shown: false,
                    rect: null,
                });
                continue;
            }

            // Ensure CarrelCards has a card entry / aspect ratio for this carrel
            const cardEntry = ctx.carrelCards?.ensureCard?.(item.carrel, cardW) ?? null;
            const pr = item.carrel.getPlaneRect?.();
            const aspect = pr && pr.height > 0 ? pr.width / pr.height : 16 / 10;
            const rawH = Math.round(cardW / Math.max(0.5, Math.min(3.0, aspect)));
            const cardH = Math.max(
                Math.round(this.config.cardMinHeightPx * dpr),
                Math.min(Math.round(this.config.cardMaxHeightPx * dpr), rawH)
            );

            const rect = { x: leftX, y: curY, w: cardW, h: cardH };
            const badge = item.waitingCount > 0
                ? `${item.waitingCount} waiting`
                : (item.carrel.carrelName === ctx.carrelBack ? 'back' : '');
            const borderColor = item.waitingCount > 0
                ? 0xf59e0b
                : (item.carrel.carrelName === ctx.carrelBack ? 0x60a5fa : 0x334155);

            const targetName = item.name;
            const cardId = `strip:card:${targetName}`;
            activeIds.add(cardId);
            overlay.setCard(cardId, {
                x: rect.x,
                y: rect.y,
                w: rect.w,
                h: rect.h,
                title: targetName,
                badge,
                borderColor,
                color: 0x0b1220,
                badgeColor: item.waitingCount > 0 ? 0xf59e0b : 0x3b82f6,
                opacity: 1.0,
                z: 5,
                texture: cardEntry?.target?.texture ?? null,
                kind: 'strip',
                data: {
                    carrel: targetName,
                    bearing: item.bearing,
                    waiting: item.waitingCount,
                    waitingNames: item.waitingNames,
                    stale: cardEntry ? cardEntry.stale : true,
                },
                onClick: () => {
                    if (typeof ctx.execute === 'function') {
                        return ctx.execute(['carrel.enter', targetName]);
                    }
                    if (ctx.commandRouter?.execute) {
                        return ctx.commandRouter.execute(`carrel.enter ${JSON.stringify(targetName)}`);
                    }
                    return null;
                },
            });

            this._lastCards.push({
                name: targetName,
                bearing: item.bearing,
                waitingCount: item.waitingCount,
                waitingNames: item.waitingNames,
                shown: true,
                rect,
            });
            curY += cardH + gapY;
        }

        if (shownSet.size > 0) {
            this._lastStripRightPx = leftX + cardW + Math.round(this.config.pinClearancePx * dpr);
            // Opaque backdrop across the reserved left-edge strip band `[0, stripRightPx]` so
            // panned-off columns or adjacent pins on a desk never show through behind/between cards.
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
        }

        // 5. Cluster pill if more than `maxCards` other carrels exist
        const hidden = this._lastCards.filter((c) => !c.shown);
        if (hidden.length > 0) {
            const hiddenWaiting = hidden.reduce((sum, c) => sum + c.waitingCount, 0);
            const clusterText = hiddenWaiting > 0
                ? `+${hidden.length} more · ${hiddenWaiting} waiting`
                : `+${hidden.length} more`;
            const clusterRect = {
                x: leftX,
                y: curY,
                w: cardW,
                h: Math.round(24 * dpr),
            };
            activeIds.add('strip:cluster');
            overlay.setCard('strip:cluster', {
                x: clusterRect.x,
                y: clusterRect.y,
                w: clusterRect.w,
                h: clusterRect.h,
                title: clusterText,
                badge: hiddenWaiting > 0 ? `${hiddenWaiting} waiting` : '',
                color: hiddenWaiting > 0 ? 0x30200c : 0x0e141e,
                borderColor: hiddenWaiting > 0 ? 0xf59e0b : 0x334155,
                badgeColor: 0xf59e0b,
                opacity: 1.0,
                z: 5,
                kind: 'strip',
                data: { hiddenCount: hidden.length, waitingCount: hiddenWaiting },
            });
            this._lastCluster = {
                count: hidden.length,
                waitingCount: hiddenWaiting,
                text: clusterText,
                rect: clusterRect,
            };
        }

        // 6. Off-screen edge marks for Deixis points and off-screen waiting agents
        this._renderOffscreenEdgeMarks(entered, waitingMap, vpW, vpH, dpr, activeIds);

        // 7. Focused-pin non-overlap: ensure the strip never covers the entered plane's focused pin
        this._ensureFocusedPinClear(entered, vpW);

        this._pruneStripOverlay(activeIds);
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
            if (c.shown) {
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
     * Ensure the left-edge strip never covers the focused pin on a pin-arranged plane desk.
     * If the focused pin's screen left edge is `< stripRightPx`, insets the plane's aim so
     * the focused pin's left edge sits at `stripRightPx`.
     * @param {Carrel|null} entered
     * @param {number} vpW
     * @private
     */
    _ensureFocusedPinClear(entered, vpW) {
        if (!entered) return;
        if (this.ctx?.planeTarget && this.ctx.planeTarget !== `carrel:${entered.carrelName}`) return;
        const stripRight = this._lastStripRightPx;
        if (!(stripRight > 0)) return;
        if (entered.mode !== 'plane' || entered.planeArrange !== 'pins' || !entered.planeUnit) return;

        const cc = this.ctx?.cameraController;
        const st = cc?.planeState?.();
        if (!st || st.leaving) return;

        const focusId = entered.focusedPin?.();
        if (!focusId) return;
        const pin = entered.pinRects?.().find((p) => p.id === focusId);
        const box = entered._boardPx?.();
        if (!pin || !box) return;

        const scale = typeof entered._planeScale === 'function' ? entered._planeScale() : 1;
        const k = entered.planeK / scale; // device px per world unit
        const r = pin.rect;
        const pinLeftWorld = -box.w / (2 * k) + r.x / k;
        // Screen X of `pinLeftWorld` when plane aim is `st.aim.x`:
        // screenLeft = vpW / 2 + (pinLeftWorld - st.aim.x) * k
        const screenLeft = vpW / 2 + (pinLeftWorld - st.aim.x) * k;
        if (screenLeft >= stripRight - 0.5) return;

        // Inset aim.x so `screenLeft === stripRight`
        const newAimX = pinLeftWorld - (stripRight - vpW / 2) / k;
        cc.setPlaneAim?.(newAimX, st.aim.y);
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
 * Register `carrel.neighbor` on the command router if not already registered.
 * @param {import('./CommandProvider.jsx').AppRouter} router
 */
export function registerStripCommands(router) {
    if (!router || router._commands?.has?.('carrel.neighbor')) return;

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

export default Strip;
