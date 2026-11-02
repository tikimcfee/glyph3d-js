import * as THREE from 'three';
import { measureOverlayText, snapOverlayOrigin } from './PlaneOverlay.js';
import { pxPerUnitAtPoint } from '@glyph3d/core/services/spatial/spatialMath.js';
/** @import { AppContext } from './CommandProvider.jsx' */

/**
 * Priority classes P0–P8 (§3.10 / §3.14):
 *   P0: deixis (points / deictic references)
 *   P1: waiting on Ivan (agent with beacon or status === 'waiting')
 *   P2: attention chain (key, primary, hover, or their container)
 *   P3: carrel (reading desk)
 *   P4: live agent (active / processing / idle / stalled)
 *   P5: terminal
 *   P6: file (open code grid or library volume)
 *   P7: directory (content tree dir)
 *   P8: ended agent (done / stopped / ended)
 */
export const PRIORITY_CLASSES = ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8'];

/** @type {Record<string, number>} */
export const CLASS_RANK = {
    P0: 0,
    P1: 1,
    P2: 2,
    P3: 3,
    P4: 4,
    P5: 5,
    P6: 6,
    P7: 7,
    P8: 8,
};

/** Discrete pixel steps allowed for map labels (floor 11 px). */
export const DISCRETE_PX_STEPS = [16, 14, 13, 12, 11];

/** Canonical variable anchor order tried around a screen point. */
export const ANCHOR_ORDER = ['above', 'right', 'below', 'left'];

export const MAP_LABELS_DEFAULTS = {
    enabled: true,
    px: 13,
    minPx: 11,
    placeHz: 8,
    fadeMs: 200,
    gridPx: 32,
    hysteresisPx: 4,
    selfNameHysteresisPx: 1.5,
    anchorGapPx: 6,
    edgeMarginPx: 24,
    dotPx: 5,
    pxP0: 16,
    pxP1: 16,
    pxP2: 14,
    pxP3: 14,
    pxP4: 13,
    pxP5: 13,
    pxP6: 12,
    pxP7: 12,
    pxP8: 11,
};

/** Default palette per priority class (glyph color + plate fill). */
const CLASS_STYLE = {
    P0: { color: { r: 1.00, g: 0.92, b: 0.55 }, plate: { color: 0x3a2c0a, opacity: 0.92, hairline: true }, dotColor: 0xffd866 },
    P1: { color: { r: 1.00, g: 0.86, b: 0.42 }, plate: { color: 0x3b2408, opacity: 0.92, hairline: true }, dotColor: 0xffb830 },
    P2: { color: { r: 0.65, g: 0.90, b: 1.00 }, plate: { color: 0x10283b, opacity: 0.88, hairline: true }, dotColor: 0x66ccff },
    P3: { color: { r: 0.88, g: 0.93, b: 1.00 }, plate: { color: 0x1b2838, opacity: 0.86, hairline: true }, dotColor: 0x8ab4f8 },
    P4: { color: { r: 0.82, g: 0.92, b: 0.86 }, plate: { color: 0x12261e, opacity: 0.84, hairline: true }, dotColor: 0x6fcf97 },
    P5: { color: { r: 0.78, g: 0.90, b: 0.94 }, plate: { color: 0x102229, opacity: 0.84, hairline: true }, dotColor: 0x56ccf2 },
    P6: { color: { r: 0.82, g: 0.86, b: 0.93 }, plate: { color: 0x111722, opacity: 0.82, hairline: true }, dotColor: 0x8fa0b8 },
    P7: { color: { r: 0.72, g: 0.78, b: 0.88 }, plate: { color: 0x0e131d, opacity: 0.78, hairline: true }, dotColor: 0x6c7d96 },
    P8: { color: { r: 0.58, g: 0.62, b: 0.70 }, plate: { color: 0x0c0f16, opacity: 0.72, hairline: false }, dotColor: 0x525866 },
};

const _v3 = new THREE.Vector3();
const _camPos = new THREE.Vector3();
const _camDir = new THREE.Vector3();
const _camQuat = new THREE.Quaternion();
const _box = new THREE.Box3();

/**
 * Snap any requested pixel size to the nearest discrete step in `DISCRETE_PX_STEPS`
 * while enforcing the floor `minPx` (never shrinks below `minPx`).
 *
 * @param {number} px
 * @param {number} [minPx=11]
 * @returns {number}
 */
export function snapDiscretePx(px, minPx = 11) {
    const floor = Math.max(11, Math.round(Number(minPx) || 11));
    const target = Math.max(floor, Number(px) || 13);
    let best = DISCRETE_PX_STEPS[0];
    let bestDist = Math.abs(target - best);
    for (const step of DISCRETE_PX_STEPS) {
        if (step < floor) continue;
        const d = Math.abs(target - step);
        if (d < bestDist) {
            best = step;
            bestDist = d;
        }
    }
    return Math.max(floor, best);
}

/**
 * Check whether two device-pixel rectangles overlap (with optional padding `pad`).
 *
 * @param {{ x: number, y: number, w: number, h: number }} a
 * @param {{ x: number, y: number, w: number, h: number }} b
 * @param {number} [pad=0]
 * @returns {boolean}
 */
export function rectsOverlap(a, b, pad = 0) {
    return !(
        a.x + a.w + pad <= b.x ||
        b.x + b.w + pad <= a.x ||
        a.y + a.h + pad <= b.y ||
        b.y + b.h + pad <= a.y
    );
}

/**
 * Compute the text top-left `(x, y)` and full bounding `rect` for a candidate
 * placed at anchor direction `anchor` (`'above'|'right'|'below'|'left'`) relative
 * to device-pixel screen anchor `(sx, sy)`.
 *
 * @param {Object} atlas
 * @param {string} text
 * @param {number} sx
 * @param {number} sy
 * @param {number} px
 * @param {'above'|'right'|'below'|'left'} anchor
 * @param {number} [gapPx=6]
 * @param {Object|null} [plate=null]
 */
export function computeAnchoredPlacement(atlas, text, sx, sy, px, anchor, gapPx = 6, plate = null) {
    const base = measureOverlayText(atlas, text, 0, 0, px, plate);
    const padX = base.textRect.x - base.rect.x;
    const padY = base.textRect.y - base.rect.y;
    const w = base.rect.w;
    const h = base.rect.h;

    let rectX = sx - w * 0.5;
    let rectY = sy - gapPx - h;
    if (anchor === 'above') {
        rectX = sx - w * 0.5;
        rectY = sy - gapPx - h;
    } else if (anchor === 'below') {
        rectX = sx - w * 0.5;
        rectY = sy + gapPx;
    } else if (anchor === 'right') {
        rectX = sx + gapPx;
        rectY = sy - h * 0.5;
    } else if (anchor === 'left') {
        rectX = sx - gapPx - w;
        rectY = sy - h * 0.5;
    }

    const snappedText = snapOverlayOrigin(rectX + padX, rectY + padY);
    return measureOverlayText(atlas, text, snappedText.x, snappedText.y, px, plate);
}

/**
 * Project a world-space point `worldPos` into device-pixel screen coordinates `(x, y)`
 * (`(0, 0)` at top-left, `+x` right, `+y` down).
 *
 * @param {THREE.Vector3|{x:number,y:number,z:number}} worldPos
 * @param {THREE.Camera} camera
 * @param {{ width: number, height: number }} viewport
 * @returns {{ x: number, y: number, ndcZ: number, behind: boolean, onScreen: boolean, dist: number }}
 */
export function projectWorldToDevicePx(worldPos, camera, viewport) {
    const W = viewport.width || 1600;
    const H = viewport.height || 1000;
    _v3.set(worldPos.x, worldPos.y, worldPos.z);
    camera.getWorldPosition(_camPos);
    camera.getWorldDirection(_camDir);
    const dx = _v3.x - _camPos.x;
    const dy = _v3.y - _camPos.y;
    const dz = _v3.z - _camPos.z;
    const dist = Math.hypot(dx, dy, dz);
    const forwardDot = dx * _camDir.x + dy * _camDir.y + dz * _camDir.z;
    const behind = forwardDot <= 1e-3;

    _v3.project(camera);
    let x = (_v3.x * 0.5 + 0.5) * W;
    let y = (-_v3.y * 0.5 + 0.5) * H;
    if (behind) {
        // Flip across viewport center when behind the eye so edge clamping points the right way.
        x = W - x;
        y = H - y;
    }
    const onScreen = !behind && x >= 0 && x <= W && y >= 0 && y <= H;
    return { x, y, ndcZ: _v3.z, behind, onScreen, dist };
}

/**
 * Format a cluster label (`<group> · N agents · M waiting`).
 * Invariant (§3.10 / §3.14): a waiting count NEVER aggregates away.
 *
 * @param {string} groupName
 * @param {number} totalAgents
 * @param {number} waitingCount
 * @param {string} [noun='agent']
 * @returns {string}
 */
export function formatClusterLabel(groupName, totalAgents, waitingCount, noun = 'agent') {
    const plural = totalAgents === 1 ? noun : `${noun}s`;
    const base = `${groupName} · ${totalAgents} ${plural}`;
    if (waitingCount > 0) {
        return `${base} · ${waitingCount} waiting`;
    }
    return base;
}

/**
 * Spatial collision grid at `gridPx` device-pixel cell resolution, paired with exact
 * bounding-rect checks so no two placed labels can ever overlap and same-cell priority
 * competition is deterministic.
 */
class CollisionGrid {
    /**
     * @param {number} gridPx
     */
    constructor(gridPx = 32) {
        this.gridPx = Math.max(4, Number(gridPx) || 32);
        /** @type {Map<string, string>} "gx,gy" -> occupant candidate id that anchored in this cell */
        this.anchorCells = new Map();
        /** @type {Map<string, string[]>} "gx,gy" -> occupant candidate ids whose rects touch this cell */
        this.cells = new Map();
        /** @type {Array<{ id: string, rect: { x: number, y: number, w: number, h: number } }>} */
        this.placedRects = [];
    }

    /**
     * @param {number} x
     * @param {number} y
     */
    cellKeyAt(x, y) {
        const gx = Math.floor(x / this.gridPx);
        const gy = Math.floor(y / this.gridPx);
        return `${gx},${gy}`;
    }

    /**
     * Check if another higher-priority candidate already claimed this 32px anchor cell.
     * @param {string|null} anchorCellKey
     * @returns {string|null}
     */
    findAnchorCellBlocker(anchorCellKey) {
        if (!anchorCellKey) return null;
        return this.anchorCells.get(anchorCellKey) || null;
    }

    /**
     * Test whether `rect` collides with any already-placed label rect.
     * @param {{ x: number, y: number, w: number, h: number }} rect
     * @param {number} [padPx=2]
     * @returns {string|null} blocking candidate id, or null if clear
     */
    findBlocker(rect, padPx = 2) {
        const gx0 = Math.floor((rect.x - padPx) / this.gridPx);
        const gy0 = Math.floor((rect.y - padPx) / this.gridPx);
        const gx1 = Math.floor((rect.x + rect.w + padPx) / this.gridPx);
        const gy1 = Math.floor((rect.y + rect.h + padPx) / this.gridPx);

        for (let gy = gy0; gy <= gy1; gy++) {
            for (let gx = gx0; gx <= gx1; gx++) {
                const list = this.cells.get(`${gx},${gy}`);
                if (!list) continue;
                for (const occ of list) {
                    const hit = this.placedRects.find((p) => p.id === occ);
                    if (hit && rectsOverlap(rect, hit.rect, padPx)) {
                        return occ;
                    }
                }
            }
        }
        for (const p of this.placedRects) {
            if (rectsOverlap(rect, p.rect, padPx)) {
                return p.id;
            }
        }
        return null;
    }

    /**
     * Claim `rect` and optional `anchorCellKey` for candidate `id`.
     * @param {string} id
     * @param {{ x: number, y: number, w: number, h: number }} rect
     * @param {string|null} [anchorCellKey=null]
     */
    insert(id, rect, anchorCellKey = null) {
        this.placedRects.push({ id, rect: { ...rect } });
        if (anchorCellKey && !this.anchorCells.has(anchorCellKey)) {
            this.anchorCells.set(anchorCellKey, id);
        }
        const gx0 = Math.floor(rect.x / this.gridPx);
        const gy0 = Math.floor(rect.y / this.gridPx);
        const gx1 = Math.floor((rect.x + rect.w) / this.gridPx);
        const gy1 = Math.floor((rect.y + rect.h) / this.gridPx);
        for (let gy = gy0; gy <= gy1; gy++) {
            for (let gx = gx0; gx <= gx1; gx++) {
                const key = `${gx},${gy}`;
                let list = this.cells.get(key);
                if (!list) {
                    list = [];
                    this.cells.set(key, list);
                }
                if (!list.includes(id)) list.push(id);
            }
        }
    }
}

/**
 * MapLabels — screen-space decluttered map labels (§3.10 / §3.14).
 */
export default class MapLabels {
    /**
     * @param {AppContext} ctx
     * @param {Partial<typeof MAP_LABELS_DEFAULTS>} [opts]
     */
    constructor(ctx, opts = {}) {
        this.ctx = ctx;
        this.cfg = { ...MAP_LABELS_DEFAULTS, ...opts };
        this.frozen = false;

        /** @type {Map<string, Object>} id -> persistent state across frames (opacity, prevAnchor, selfNamed, solveScreen, etc.) */
        this._records = new Map();

        /** @type {Array<Object>|null} optional synthetic candidates injected by headless tests */
        this._syntheticCandidates = null;

        /** @type {Array<Object>} latest solved candidate snapshot */
        this._lastCandidates = [];
        /** @type {Array<Object>} latest placed cluster labels */
        this._lastClusters = [];

        this._accumMs = 0;
        this._hasSolvedOnce = false;
        this._cameraMoving = false;
        this._lastCamPos = new THREE.Vector3(NaN, NaN, NaN);
        this._lastCamQuat = new THREE.Quaternion(NaN, NaN, NaN, NaN);
    }

    /**
     * Update live configuration from Settings (`labels.*`).
     * @param {Partial<typeof MAP_LABELS_DEFAULTS>} patch
     */
    configure(patch = {}) {
        Object.assign(this.cfg, patch);
        if (!this.cfg.enabled) {
            this.ctx?.planeOverlay?.clear(null, { kind: 'map' });
        }
    }

    /**
     * Freeze or unfreeze placement (`label.freeze on|off`).
     * While frozen, placement decisions hold still while per-frame re-projection continues.
     * @param {boolean} flag
     */
    setFrozen(flag) {
        this.frozen = Boolean(flag);
        return this.frozen;
    }

    /**
     * Inject synthetic candidates for deterministic headless declutter tests (`tools/map-labels.test.mjs`).
     * Pass `null` to return to live scene candidate collection.
     * @param {Array<Object>|null} list
     */
    setSyntheticCandidates(list) {
        this._syntheticCandidates = Array.isArray(list) ? list : null;
        this._hasSolvedOnce = false;
    }

    /**
     * Clear hysteresis history (used in tests when resetting between independent scenarios).
     */
    resetHistory() {
        this._records.clear();
        this._lastCandidates = [];
        this._lastClusters = [];
        this._hasSolvedOnce = false;
        this.ctx?.planeOverlay?.clear(null, { kind: 'map' });
    }

    /**
     * Return the discrete pixel height configured for priority class `cls` (`P0..P8`).
     * @param {string} cls
     * @returns {number}
     */
    pxForClass(cls) {
        const key = `px${cls}`;
        const raw = this.cfg[key] ?? this.cfg.px ?? 13;
        return snapDiscretePx(raw, this.cfg.minPx);
    }

    /**
     * Gather all live candidates from `ctx` (or `_syntheticCandidates` when set).
     * @returns {Array<Object>}
     */
    collectCandidates() {
        if (this._syntheticCandidates) {
            return this._syntheticCandidates.map((c) => {
                const cls = PRIORITY_CLASSES.includes(c.class) ? c.class : 'P6';
                const sourceText = String(c.sourceText ?? c.text ?? c.id);
                return {
                    id: String(c.id),
                    class: cls,
                    classRank: CLASS_RANK[cls] ?? 6,
                    sourceText,
                    text: sourceText, // NEVER truncated
                    px: snapDiscretePx(c.px ?? this.pxForClass(cls), this.cfg.minPx),
                    worldPos: {
                        x: Number(c.worldPos?.x ?? c.x ?? 0),
                        y: Number(c.worldPos?.y ?? c.y ?? 0),
                        z: Number(c.worldPos?.z ?? c.z ?? 0),
                    },
                    interest: Number(c.interest ?? 1),
                    titleRowWorld: c.titleRowWorld != null ? Number(c.titleRowWorld) : 0,
                    titleObject: c.titleObject ?? null,
                    groupKey: c.groupKey ?? null,
                    isWaiting: Boolean(c.isWaiting || cls === 'P1'),
                    isAgent: Boolean(c.isAgent || cls === 'P1' || cls === 'P4' || cls === 'P8'),
                };
            });
        }

        const ctx = this.ctx;
        if (!ctx) return [];

        /** @type {Array<Object>} */
        const out = [];
        const seenIds = new Set();

        // Attention slot lookup -> P2 promotion
        const att = ctx.attentionManager;
        const keyId = att?.get?.('key')?.id ?? null;
        const primaryId = att?.get?.('primary')?.id ?? null;
        const hoverId = att?.get?.('hover')?.id ?? null;
        const attendedIds = new Set([keyId, primaryId, hoverId].filter(Boolean));

        const attentionBonusFor = (id) => {
            if (id === keyId) return 30;
            if (id === primaryId) return 20;
            if (id === hoverId) return 15;
            return 0;
        };

        // 0. Deictic points (P0)
        const points = ctx.points ?? ctx.deixis?.points ?? null;
        if (points instanceof Map) {
            for (const [id, pt] of points.entries()) {
                if (!pt || !pt.worldPos) continue;
                const cid = `point:${id}`;
                seenIds.add(cid);
                const text = String(pt.text || pt.say || pt.label || id);
                out.push({
                    id: cid,
                    class: 'P0',
                    classRank: CLASS_RANK.P0,
                    sourceText: text,
                    text,
                    px: this.pxForClass('P0'),
                    worldPos: { x: pt.worldPos.x, y: pt.worldPos.y, z: pt.worldPos.z },
                    interest: 100,
                    titleRowWorld: 0,
                    titleObject: null,
                    groupKey: null,
                    isWaiting: false,
                    isAgent: false,
                });
            }
        }

        // 1. Carrels (P3, or P2 if active/attended)
        if (ctx.carrels instanceof Map) {
            for (const [name, carrel] of ctx.carrels.entries()) {
                if (!carrel || carrel._dead || carrel._dissolving || !carrel.visible) continue;
                const cid = `carrel:${name}`;
                seenIds.add(cid);
                const isAttended = attendedIds.has(cid) || ctx.activeCarrel === name;
                const cls = isAttended ? 'P2' : 'P3';
                const pos = this._worldAnchorOf(carrel, 'top');
                const titleText = String(carrel.title?.text || name).split('\n')[0];
                const worldScaleY = carrel.matrixWorld ? _v3.setFromMatrixScale(carrel.matrixWorld).y : (carrel.scale?.y || 1);
                const titleRowWorld = carrel.title ? (Number(carrel.title.lineHeight) || 0) * worldScaleY : 0;
                out.push({
                    id: cid,
                    class: cls,
                    classRank: CLASS_RANK[cls],
                    sourceText: titleText,
                    text: titleText,
                    px: this.pxForClass(cls),
                    worldPos: pos,
                    interest: 40 + (carrel.size || 0) * 2 + attentionBonusFor(cid),
                    titleRowWorld,
                    titleObject: null,
                    groupKey: null,
                    isWaiting: false,
                    isAgent: false,
                });
            }
        }

        // 2. Agent books (P1 waiting, P2 attended, P4 live, P8 ended)
        const lanes = ctx.agentBooks?.lanes;
        if (lanes instanceof Map) {
            for (const [agentId, lane] of lanes.entries()) {
                if (!lane?.book || !lane.book.visible) continue;
                const cid = lane.groupId || `agent:book:${agentId}`;
                seenIds.add(cid);
                const gx = lane.meta?.gomux;
                const status = String(gx?.status || lane.state || 'active').toLowerCase();
                const isWaiting = Boolean(lane.beacon || status === 'waiting');
                const isEnded = !isWaiting && (status === 'ended' || status === 'done' || status === 'stopped');
                const isAttended = attendedIds.has(cid) || attendedIds.has(agentId);

                let cls = 'P4';
                if (isWaiting) cls = 'P1';
                else if (isAttended) cls = 'P2';
                else if (isEnded) cls = 'P8';

                const readout = ctx.agentBooks.readout?.(lane);
                const rawName = String(readout?.name || gx?.name || agentId);
                const text = isWaiting && lane.beacon
                    ? `${rawName} · ${lane.beacon}`
                    : rawName;

                const pos = this._worldAnchorOf(lane.book, 'top');
                const nameLabel = lane.label?.nameLabel;
                const bookWorldScaleY = lane.book.matrixWorld
                    ? _v3.setFromMatrixScale(lane.book.matrixWorld).y
                    : (lane.book.scale?.y || 1);
                const titleRowWorld = nameLabel
                    ? (Number(nameLabel.lineHeight) || 0) * bookWorldScaleY
                    : 0;
                const holder = ctx.holding?.holderOf?.(cid);
                const groupKey = holder?.carrelName || (gx ? 'gomux' : 'agents');

                out.push({
                    id: cid,
                    class: cls,
                    classRank: CLASS_RANK[cls],
                    sourceText: text,
                    text,
                    px: this.pxForClass(cls),
                    worldPos: pos,
                    interest: (isWaiting ? 90 : isEnded ? 5 : 30) + attentionBonusFor(cid),
                    titleRowWorld,
                    titleObject: null,
                    groupKey,
                    isWaiting,
                    isAgent: true,
                });
            }
        }

        // 3. Terminals (P5, or P2 if attended)
        const terminals = ctx.registry?.findByType?.('terminal') ?? [];
        for (const entry of terminals) {
            const obj = entry.grid;
            if (!obj || !obj.visible) continue;
            const cid = entry.id;
            if (seenIds.has(cid)) continue;
            seenIds.add(cid);
            const isAttended = attendedIds.has(cid);
            const cls = isAttended ? 'P2' : 'P5';
            const text = String(entry.meta?.title || entry.meta?.name || cid);
            const pos = this._worldAnchorOf(obj, 'top');
            out.push({
                id: cid,
                class: cls,
                classRank: CLASS_RANK[cls],
                sourceText: text,
                text,
                px: this.pxForClass(cls),
                worldPos: pos,
                interest: 25 + attentionBonusFor(cid),
                titleRowWorld: Number(obj.titleLineHeight || 0),
                titleObject: null,
                groupKey: null,
                isWaiting: false,
                isAgent: false,
            });
        }

        // 4. Files (P6, or P2 if attended)
        const grids = ctx.registry?.findByType?.('grid') ?? [];
        for (const entry of grids) {
            if (entry.role === 'card') continue;
            const obj = entry.grid;
            if (!obj || !obj.visible) continue;
            const cid = entry.id;
            if (seenIds.has(cid)) continue;
            seenIds.add(cid);
            const isAttended = attendedIds.has(cid);
            const cls = isAttended ? 'P2' : 'P6';
            const rawPath = String(entry.meta?.filename || entry.meta?.sourcePath || obj.name || cid);
            const text = rawPath.split('/').pop() || rawPath;
            const pos = this._worldAnchorOf(obj, 'top');
            const dirPath = rawPath.includes('/') ? rawPath.slice(0, rawPath.lastIndexOf('/')) : null;
            out.push({
                id: cid,
                class: cls,
                classRank: CLASS_RANK[cls],
                sourceText: text,
                text,
                px: this.pxForClass(cls),
                worldPos: pos,
                interest: 15 + attentionBonusFor(cid),
                titleRowWorld: Number(obj.userData?.titleLineHeight || 0),
                titleObject: null,
                groupKey: dirPath,
                isWaiting: false,
                isAgent: false,
            });
        }

        // 5. Directories (P7, or P2 if attended)
        const dirs = ctx.contentTree?.dirs;
        if (dirs instanceof Map) {
            for (const [path, rec] of dirs.entries()) {
                if (!path) continue; // skip root ''
                const node = rec?.node ?? rec;
                if (!node || !node.visible) continue;
                const cid = `dir:${path}`;
                if (seenIds.has(cid)) continue;
                seenIds.add(cid);
                const isAttended = attendedIds.has(cid);
                const cls = isAttended ? 'P2' : 'P7';
                const text = String(node.userData?.name || path.split('/').pop() || path);
                const pos = this._worldAnchorOf(node, 'top');
                out.push({
                    id: cid,
                    class: cls,
                    classRank: CLASS_RANK[cls],
                    sourceText: text,
                    text,
                    px: this.pxForClass(cls),
                    worldPos: pos,
                    interest: 10 + attentionBonusFor(cid),
                    titleRowWorld: 0,
                    titleObject: null,
                    groupKey: null,
                    isWaiting: false,
                    isAgent: false,
                });
            }
        }

        return out;
    }

    /**
     * Compute a stable world-space anchor point for a 3D Object3D.
     * @private
     */
    _worldAnchorOf(obj, edge = 'top') {
        if (!obj) return { x: 0, y: 0, z: 0 };
        if (typeof obj.getWorldBounds === 'function') {
            const b = obj.getWorldBounds();
            if (b && !b.isEmpty?.()) {
                return {
                    x: (b.min.x + b.max.x) * 0.5,
                    y: edge === 'top' ? b.max.y : (b.min.y + b.max.y) * 0.5,
                    z: (b.min.z + b.max.z) * 0.5,
                };
            }
        }
        if (typeof obj.getLocalBounds === 'function') {
            const lb = obj.getLocalBounds();
            if (lb && !lb.isEmpty?.()) {
                _box.copy(lb).applyMatrix4(obj.matrixWorld);
                return {
                    x: (_box.min.x + _box.max.x) * 0.5,
                    y: edge === 'top' ? _box.max.y : (_box.min.y + _box.max.y) * 0.5,
                    z: (_box.min.z + _box.max.z) * 0.5,
                };
            }
        }
        obj.getWorldPosition?.(_v3);
        return { x: _v3.x, y: _v3.y, z: _v3.z };
    }

    /**
     * Per-frame update:
     *   1. Detects camera motion vs camera rest.
     *   2. Runs placement solver at `labels.placeHz` (`8` Hz) while moving, and immediately on camera rest.
     *   3. Re-projects placed labels every frame so they stay locked to world anchors.
     *   4. Advances opacity fades (`labels.fadeMs`) and syncs visible items into `ctx.planeOverlay`.
     *
     * @param {THREE.Camera} [camera]
     * @param {number} [dt=0.016] - frame delta in seconds
     */
    update(camera = this.ctx?.camera, dt = 0.016) {
        if (!this.cfg.enabled) return;
        const overlay = this.ctx?.planeOverlay;
        if (!overlay || !camera) return;

        camera.updateMatrixWorld?.();
        camera.getWorldPosition(_camPos);
        camera.getWorldQuaternion(_camQuat);

        const posDelta = Number.isNaN(this._lastCamPos.x)
            ? 0
            : _camPos.distanceTo(this._lastCamPos);
        const quatDot = Number.isNaN(this._lastCamQuat.x)
            ? 1
            : Math.min(1, Math.abs(_camQuat.dot(this._lastCamQuat)));
        const angleDelta = 2 * Math.acos(quatDot);
        const movingNow = posDelta > 1e-3 || angleDelta > 1e-4;
        const justRested = this._cameraMoving && !movingNow;
        this._cameraMoving = movingNow;
        this._lastCamPos.copy(_camPos);
        this._lastCamQuat.copy(_camQuat);

        const periodMs = 1000 / Math.max(1, Number(this.cfg.placeHz) || 8);
        this._accumMs += Math.max(0, Number(dt) || 0) * 1000;

        if (!this.frozen && (!this._hasSolvedOnce || justRested || this._accumMs >= periodMs)) {
            this._accumMs = 0;
            this.solvePlacement(camera);
        } else {
            this._reprojectPlaced(camera);
        }

        this._stepFadesAndSyncOverlay(dt);
    }

    /**
     * Run a full placement & declutter pass immediately.
     * @param {THREE.Camera} [camera]
     */
    solvePlacement(camera = this.ctx?.camera) {
        const overlay = this.ctx?.planeOverlay;
        const vp = overlay ? overlay.syncCamera() : { width: 1600, height: 1000, cssWidth: 1600, cssHeight: 1000, dpr: 1 };
        const atlas = this.ctx?.atlas ?? overlay?.atlas ?? null;
        if (!camera) return this.snapshot();

        camera.updateMatrixWorld?.();
        const rawCandidates = this.collectCandidates();
        const planeActive = Boolean(this.ctx?.cameraController?.planeState?.()?.active);
        const gridPx = Math.max(8, Number(this.cfg.gridPx) || 32);
        const hystPx = Math.max(0, Number(this.cfg.hysteresisPx) ?? 4);
        const selfHystPx = Math.max(0, Number(this.cfg.selfNameHysteresisPx) ?? 1.5);
        const gapPx = Math.max(0, Number(this.cfg.anchorGapPx) ?? 6);
        const edgeMargin = Math.max(8, Number(this.cfg.edgeMarginPx) ?? 24);

        const centerX = vp.width * 0.5;
        const centerY = vp.height * 0.5;
        const maxDiag = Math.hypot(centerX, centerY) || 1;

        /** @type {Array<Object>} */
        const prepared = [];

        for (const c of rawCandidates) {
            const prev = this._records.get(c.id) || null;
            const proj = projectWorldToDevicePx(c.worldPos, camera, vp);
            const ppu = pxPerUnitAtPoint(camera, c.worldPos, Number(vp.height) || 1000);
            const worldTitlePx = c.titleRowWorld > 0 ? c.titleRowWorld * ppu : 0;

            // Self-naming handoff with hysteresis (§3.10 / §3.14):
            // Far away the map names a thing; once its own title projects >= labelPx, the thing names itself.
            let selfNamed = false;
            if (planeActive && c.classRank >= CLASS_RANK.P3) {
                selfNamed = true;
            } else if (c.titleRowWorld > 0) {
                if (prev?.selfNamed) {
                    selfNamed = worldTitlePx >= (c.px - selfHystPx);
                } else {
                    selfNamed = worldTitlePx >= c.px;
                }
            }

            // Screen-space solver coordinate with sub-cell deadband hysteresis:
            const wasPlaced = prev && (prev.state === 'placed' || prev.state === 'edge');
            let solveX = proj.x;
            let solveY = proj.y;
            if (prev?.solveScreen && hystPx > 0) {
                const drift = Math.hypot(proj.x - prev.solveScreen.x, proj.y - prev.solveScreen.y);
                if (drift <= hystPx) {
                    solveX = prev.solveScreen.x;
                    solveY = prev.solveScreen.y;
                }
            }

            // Degree of interest: base interest + screen-center proximity + incumbent hysteresis bonus
            const centerBonus = Math.max(0, 1 - Math.hypot(solveX - centerX, solveY - centerY) / maxDiag) * 5;
            const incumbentBonus = wasPlaced ? hystPx * 2.5 : 0;
            const effectiveInterest = c.interest + centerBonus + incumbentBonus;

            prepared.push({
                ...c,
                screen: proj,
                solveScreen: { x: solveX, y: solveY },
                worldTitlePx,
                selfNamed,
                effectiveInterest,
                prev,
                state: 'hidden',
                anchor: null,
                rect: null,
                textRect: null,
                whyHidden: null,
                clusterId: null,
                triedAnchors: [],
                worldTitleShown: false,
            });
        }

        // Greedy sort: classRank ASC (P0 beats P1 beats ... P8), then effectiveInterest DESC, then id ASC
        prepared.sort((a, b) => {
            if (a.classRank !== b.classRank) return a.classRank - b.classRank;
            if (Math.abs(b.effectiveInterest - a.effectiveInterest) > 1e-6) {
                return b.effectiveInterest - a.effectiveInterest;
            }
            return a.id.localeCompare(b.id);
        });

        const grid = new CollisionGrid(gridPx);
        /** @type {Map<string, Array<Object>>} groupKey -> collided candidates in that group */
        const collidedByGroup = new Map();

        for (const item of prepared) {
            // 1. Self-named handoff (world title and map label are NEVER both shown)
            if (item.selfNamed && !item.screen.behind) {
                item.state = 'hidden';
                item.whyHidden = 'self-named';
                item.worldTitleShown = true;
                if (item.titleObject) item.titleObject.visible = true;
                continue;
            }
            if (item.titleObject) {
                item.titleObject.visible = false;
                item.worldTitleShown = false;
            }

            // 2. Off-screen handling: P0 and P1 get viewport-clamped edge markers; P2–P8 hide
            if (!item.screen.onScreen) {
                if (item.class === 'P0' || item.class === 'P1') {
                    this._placeEdgeMarker(item, vp, atlas, grid, edgeMargin);
                } else {
                    item.state = 'hidden';
                    item.whyHidden = 'offscreen';
                }
                continue;
            }

            // 3. On-screen variable-anchor placement with incumbent anchor stickiness
            const style = CLASS_STYLE[item.class] || CLASS_STYLE.P6;
            const prevAnchor = item.prev?.anchor;
            const anchorList = (prevAnchor && ANCHOR_ORDER.includes(prevAnchor))
                ? [prevAnchor, ...ANCHOR_ORDER.filter((a) => a !== prevAnchor)]
                : ANCHOR_ORDER;

            const anchorCellKey = grid.cellKeyAt(item.solveScreen.x, item.solveScreen.y);
            const cellBlocker = grid.findAnchorCellBlocker(anchorCellKey);
            let placed = false;
            let firstBlocker = cellBlocker;

            if (cellBlocker) {
                for (const anchor of anchorList) {
                    item.triedAnchors.push({ anchor, ok: false, blockedBy: cellBlocker });
                }
            } else {
                for (const anchor of anchorList) {
                    const measured = computeAnchoredPlacement(
                        atlas,
                        item.text,
                        item.solveScreen.x,
                        item.solveScreen.y,
                        item.px,
                        /** @type {'above'|'right'|'below'|'left'} */ (anchor),
                        gapPx,
                        style.plate
                    );
                    const inViewport =
                        measured.rect.x >= 2 &&
                        measured.rect.y >= 2 &&
                        measured.rect.x + measured.rect.w <= vp.width - 2 &&
                        measured.rect.y + measured.rect.h <= vp.height - 2;

                    const blocker = grid.findBlocker(measured.rect, 2);
                    item.triedAnchors.push({
                        anchor,
                        ok: !blocker && inViewport,
                        blockedBy: blocker || (!inViewport ? 'viewport-edge' : null),
                    });

                    if (!blocker && inViewport) {
                        grid.insert(item.id, measured.rect, anchorCellKey);
                        item.state = 'placed';
                        item.anchor = anchor;
                        item.x = measured.x;
                        item.y = measured.y;
                        item.rect = measured.rect;
                        item.textRect = measured.textRect;
                        item.whyHidden = null;
                        placed = true;
                        break;
                    }
                    if (!firstBlocker && blocker) firstBlocker = blocker;
                }

                // If all in-viewport anchors clipped the viewport edge but one was collision-free, allow the collision-free one
                if (!placed && !firstBlocker) {
                    for (const anchor of anchorList) {
                        const measured = computeAnchoredPlacement(
                            atlas,
                            item.text,
                            item.solveScreen.x,
                            item.solveScreen.y,
                            item.px,
                            /** @type {'above'|'right'|'below'|'left'} */ (anchor),
                            gapPx,
                            style.plate
                        );
                        const blocker = grid.findBlocker(measured.rect, 2);
                        if (!blocker) {
                            grid.insert(item.id, measured.rect, anchorCellKey);
                            item.state = 'placed';
                            item.anchor = anchor;
                            item.x = measured.x;
                            item.y = measured.y;
                            item.rect = measured.rect;
                            item.textRect = measured.textRect;
                            item.whyHidden = null;
                            placed = true;
                            break;
                        }
                    }
                }
            }

            if (!placed) {
                const blockerId = firstBlocker || 'collision';
                if (item.groupKey) {
                    if (!collidedByGroup.has(item.groupKey)) collidedByGroup.set(item.groupKey, []);
                    collidedByGroup.get(item.groupKey).push(item);
                }
                item.state = 'dot';
                item.anchor = 'center';
                const dotS = Math.max(2, Number(this.cfg.dotPx) || 5);
                const snappedDot = snapOverlayOrigin(item.screen.x, item.screen.y);
                item.x = snappedDot.x;
                item.y = snappedDot.y;
                item.rect = { x: snappedDot.x - dotS * 0.5, y: snappedDot.y - dotS * 0.5, w: dotS, h: dotS };
                item.textRect = { ...item.rect };
                item.whyHidden = `collided:${blockerId}`;
            }
        }

        // 4. Cluster labels for groups with multiple members where collisions occurred:
        //    e.g. `gomux · 7 agents · 2 waiting` — a waiting count NEVER aggregates away!
        /** @type {Array<Object>} */
        const clusters = [];
        for (const [groupKey, lostMembers] of collidedByGroup.entries()) {
            const allGroupMembers = prepared.filter((c) => c.groupKey === groupKey);
            if (allGroupMembers.length < 2 || lostMembers.length < 1) continue;

            const waitingCount = allGroupMembers.filter((c) => c.isWaiting || c.class === 'P1').length;
            const noun = allGroupMembers.some((c) => c.isAgent) ? 'agent' : 'item';
            const clusterText = formatClusterLabel(groupKey, allGroupMembers.length, waitingCount, noun);
            const clusterId = `cluster:${groupKey}`;
            const clusterClass = waitingCount > 0 ? 'P1' : 'P3';
            const clusterPx = this.pxForClass(clusterClass);
            const style = CLASS_STYLE[clusterClass];

            // Centroid of lost members
            let sx = 0, sy = 0, wx = 0, wy = 0, wz = 0;
            for (const m of lostMembers) {
                sx += m.solveScreen.x;
                sy += m.solveScreen.y;
                wx += m.worldPos.x;
                wy += m.worldPos.y;
                wz += m.worldPos.z;
            }
            sx /= lostMembers.length;
            sy /= lostMembers.length;
            wx /= lostMembers.length;
            wy /= lostMembers.length;
            wz /= lostMembers.length;

            let clusterPlaced = null;
            for (const anchor of ANCHOR_ORDER) {
                const measured = computeAnchoredPlacement(atlas, clusterText, sx, sy, clusterPx, /** @type {any} */ (anchor), gapPx, style.plate);
                const blocker = grid.findBlocker(measured.rect, 2);
                if (!blocker) {
                    grid.insert(clusterId, measured.rect, null);
                    clusterPlaced = { anchor, measured };
                    break;
                }
            }

            if (clusterPlaced) {
                for (const m of lostMembers) {
                    m.state = 'clustered';
                    m.clusterId = clusterId;
                    if (!m.whyHidden) m.whyHidden = `clustered:${clusterId}`;
                }
                clusters.push({
                    id: clusterId,
                    class: clusterClass,
                    classRank: CLASS_RANK[clusterClass],
                    sourceText: clusterText,
                    text: clusterText,
                    px: clusterPx,
                    worldPos: { x: wx, y: wy, z: wz },
                    screen: { x: sx, y: sy, onScreen: true },
                    state: 'placed',
                    anchor: clusterPlaced.anchor,
                    x: clusterPlaced.measured.x,
                    y: clusterPlaced.measured.y,
                    rect: clusterPlaced.measured.rect,
                    textRect: clusterPlaced.measured.textRect,
                    whyHidden: null,
                    groupKey,
                    memberCount: allGroupMembers.length,
                    waitingCount,
                    isCluster: true,
                });
            }
        }

        // Update persistent records for hysteresis and opacity fades
        const nextIds = new Set();
        for (const item of [...prepared, ...clusters]) {
            nextIds.add(item.id);
            const prev = this._records.get(item.id);
            const visibleState = item.state === 'placed' || item.state === 'edge' || item.state === 'dot';
            const targetOpacity = visibleState ? 1 : 0;
            const fadeMs = Number(this.cfg.fadeMs) || 0;
            const initialOpacity = fadeMs <= 0 ? targetOpacity : (prev ? prev.opacity : (visibleState ? 1 : 0));

            const rec = {
                id: item.id,
                class: item.class,
                classRank: item.classRank,
                interest: item.effectiveInterest ?? item.interest ?? 0,
                sourceText: item.sourceText,
                text: item.text,
                px: item.px,
                worldPos: { ...item.worldPos },
                screen: item.screen ? { ...item.screen } : null,
                solveScreen: item.solveScreen ? { ...item.solveScreen } : null,
                worldTitlePx: item.worldTitlePx ?? 0,
                selfNamed: Boolean(item.selfNamed),
                worldTitleShown: Boolean(item.worldTitleShown),
                state: item.state,
                anchor: item.anchor,
                x: item.x ?? 0,
                y: item.y ?? 0,
                rect: item.rect ? { ...item.rect } : null,
                textRect: item.textRect ? { ...item.textRect } : null,
                whyHidden: item.whyHidden ?? null,
                clusterId: item.clusterId ?? null,
                triedAnchors: item.triedAnchors ?? [],
                waitingCount: item.waitingCount ?? (item.isWaiting ? 1 : 0),
                isCluster: Boolean(item.isCluster),
                opacity: initialOpacity,
                targetOpacity,
            };
            this._records.set(item.id, rec);
            item.opacity = rec.opacity;
        }

        for (const [oldId, oldRec] of this._records.entries()) {
            if (!nextIds.has(oldId)) {
                oldRec.targetOpacity = 0;
                oldRec.state = 'hidden';
                if ((Number(this.cfg.fadeMs) || 0) <= 0) {
                    this._records.delete(oldId);
                    overlay?.remove(oldId);
                }
            }
        }

        this._lastCandidates = prepared;
        this._lastClusters = clusters;
        this._hasSolvedOnce = true;
        this._stepFadesAndSyncOverlay(0);
        return this.snapshot();
    }

    /**
     * Place an off-screen P0/P1 candidate as a viewport-clamped edge marker.
     * Discrete edge sizes: 16 / 14 / 12 px based on world distance.
     * @private
     */
    _placeEdgeMarker(item, vp, atlas, grid, edgeMargin) {
        const dist = item.screen.dist || 0;
        const edgePx = dist < 1200 ? 16 : dist < 3000 ? 14 : 12;
        item.px = snapDiscretePx(edgePx, this.cfg.minPx);

        const style = CLASS_STYLE[item.class] || CLASS_STYLE.P1;
        const baseMeasured = measureOverlayText(atlas, item.text, 0, 0, item.px, style.plate);
        const w = baseMeasured.rect.w;
        const h = baseMeasured.rect.h;
        const padX = baseMeasured.textRect.x - baseMeasured.rect.x;
        const padY = baseMeasured.textRect.y - baseMeasured.rect.y;

        const clampedX = Math.max(edgeMargin, Math.min(vp.width - edgeMargin - w, item.screen.x - w * 0.5));
        const clampedY = Math.max(edgeMargin, Math.min(vp.height - edgeMargin - h, item.screen.y - h * 0.5));

        let edgeAnchor = 'edge-right';
        if (item.screen.x < 0) edgeAnchor = 'edge-left';
        else if (item.screen.x > vp.width) edgeAnchor = 'edge-right';
        else if (item.screen.y < 0) edgeAnchor = 'edge-top';
        else edgeAnchor = 'edge-bottom';

        const snapped = snapOverlayOrigin(clampedX + padX, clampedY + padY);
        const measured = measureOverlayText(atlas, item.text, snapped.x, snapped.y, item.px, style.plate);
        grid.insert(item.id, measured.rect, null);

        item.state = 'edge';
        item.anchor = edgeAnchor;
        item.x = measured.x;
        item.y = measured.y;
        item.rect = measured.rect;
        item.textRect = measured.textRect;
        item.whyHidden = null;
    }

    /**
     * Re-project placed labels every frame so screen positions track camera motion smoothly
     * between `placeHz` declutter passes.
     * @private
     */
    _reprojectPlaced(camera) {
        const overlay = this.ctx?.planeOverlay;
        if (!overlay || !camera) return;
        const vp = overlay.syncCamera();
        const atlas = this.ctx?.atlas ?? overlay.atlas;
        const gapPx = Math.max(0, Number(this.cfg.anchorGapPx) ?? 6);

        for (const rec of this._records.values()) {
            if (rec.state !== 'placed' && rec.state !== 'dot') continue;
            const proj = projectWorldToDevicePx(rec.worldPos, camera, vp);
            rec.screen = proj;
            if (rec.state === 'placed' && ANCHOR_ORDER.includes(rec.anchor)) {
                const style = CLASS_STYLE[rec.class] || CLASS_STYLE.P6;
                const measured = computeAnchoredPlacement(
                    atlas,
                    rec.text,
                    proj.x,
                    proj.y,
                    rec.px,
                    rec.anchor,
                    gapPx,
                    style.plate
                );
                rec.x = measured.x;
                rec.y = measured.y;
                rec.rect = measured.rect;
                rec.textRect = measured.textRect;
            } else if (rec.state === 'dot') {
                const dotS = Math.max(2, Number(this.cfg.dotPx) || 5);
                const snapped = snapOverlayOrigin(proj.x, proj.y);
                rec.x = snapped.x;
                rec.y = snapped.y;
                rec.rect = { x: snapped.x - dotS * 0.5, y: snapped.y - dotS * 0.5, w: dotS, h: dotS };
                rec.textRect = { ...rec.rect };
            }
        }
    }

    /**
     * Advance per-id opacity fades and sync visible items into `PlaneOverlay`.
     * @private
     */
    _stepFadesAndSyncOverlay(dt) {
        const overlay = this.ctx?.planeOverlay;
        if (!overlay) return;
        const fadeMs = Math.max(0, Number(this.cfg.fadeMs) || 0);
        const step = fadeMs <= 0 ? 1 : Math.min(1, (Math.max(0, Number(dt) || 0) * 1000) / fadeMs);

        for (const [id, rec] of [...this._records.entries()]) {
            if (fadeMs <= 0 || dt <= 0) {
                rec.opacity = rec.targetOpacity;
            } else if (rec.opacity < rec.targetOpacity) {
                rec.opacity = Math.min(rec.targetOpacity, rec.opacity + step);
            } else if (rec.opacity > rec.targetOpacity) {
                rec.opacity = Math.max(rec.targetOpacity, rec.opacity - step);
            }

            if (rec.opacity <= 0.001 && rec.targetOpacity === 0) {
                overlay.remove(id);
                continue;
            }

            const style = CLASS_STYLE[rec.class] || CLASS_STYLE.P6;
            const zOrder = 20 - (rec.classRank ?? 6);
            if (rec.state === 'placed' || rec.state === 'edge') {
                overlay.setText(id, {
                    x: rec.x,
                    y: rec.y,
                    px: rec.px,
                    text: rec.text,
                    color: style.color,
                    plate: style.plate,
                    opacity: rec.opacity,
                    z: zOrder,
                    kind: 'map',
                });
            } else if (rec.state === 'dot') {
                overlay.setDot(id, {
                    x: rec.x,
                    y: rec.y,
                    sizePx: Number(this.cfg.dotPx) || 5,
                    color: style.dotColor,
                    opacity: rec.opacity * 0.85,
                    z: zOrder - 10,
                    kind: 'map',
                });
            } else {
                overlay.remove(id);
            }
        }
    }

    /**
     * Return a serializable snapshot of all candidates and clusters for `label.list`.
     */
    snapshot() {
        if (!this._hasSolvedOnce && this.ctx?.camera) {
            this.solvePlacement(this.ctx.camera);
        }
        const all = [...this._lastCandidates, ...this._lastClusters].map((c) => {
            const rec = this._records.get(c.id);
            return {
                id: c.id,
                class: c.class,
                classRank: c.classRank,
                sourceText: c.sourceText,
                text: c.text,
                px: c.px,
                state: rec?.state ?? c.state,
                anchor: rec?.anchor ?? c.anchor ?? null,
                rect: (rec?.rect ?? c.rect) ? { ...(rec?.rect ?? c.rect) } : null,
                textRect: (rec?.textRect ?? c.textRect) ? { ...(rec?.textRect ?? c.textRect) } : null,
                whyHidden: rec?.whyHidden ?? c.whyHidden ?? null,
                clusterId: rec?.clusterId ?? c.clusterId ?? null,
                worldTitlePx: c.worldTitlePx ?? 0,
                worldTitleShown: Boolean(c.worldTitleShown),
                opacity: rec?.opacity ?? c.opacity ?? 0,
                waitingCount: c.waitingCount ?? (c.isWaiting ? 1 : 0),
                isCluster: Boolean(c.isCluster),
            };
        });
        const placedCount = all.filter((c) => c.state === 'placed' || c.state === 'edge').length;
        return {
            candidates: all,
            clusters: this._lastClusters.map((cl) => ({ ...cl })),
            count: all.length,
            placedCount,
            frozen: this.frozen,
        };
    }

    /**
     * Return detailed placement explanation for candidate `id` (`label.explain <id>`).
     * @param {string} id
     */
    explain(id) {
        if (!this._hasSolvedOnce && this.ctx?.camera) {
            this.solvePlacement(this.ctx.camera);
        }
        const rec = this._records.get(id);
        if (!rec) return null;
        return {
            id: rec.id,
            class: rec.class,
            classRank: rec.classRank,
            interest: rec.interest,
            sourceText: rec.sourceText,
            text: rec.text,
            px: rec.px,
            worldPos: { ...rec.worldPos },
            screen: rec.screen ? { ...rec.screen } : null,
            worldTitlePx: rec.worldTitlePx,
            worldTitleShown: rec.worldTitleShown,
            state: rec.state,
            anchor: rec.anchor,
            rect: rec.rect ? { ...rec.rect } : null,
            textRect: rec.textRect ? { ...rec.textRect } : null,
            opacity: rec.opacity,
            whyHidden: rec.whyHidden,
            clusterId: rec.clusterId,
            triedAnchors: (rec.triedAnchors || []).map((t) => ({ ...t })),
        };
    }

    dispose() {
        this.resetHistory();
    }
}
