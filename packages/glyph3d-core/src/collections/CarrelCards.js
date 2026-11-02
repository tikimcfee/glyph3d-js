/**
 * CarrelCards — Impostor cards for carrels (docs/planes/DESIGN.md §3.16, Slice 11).
 *
 * One card per carrel: an orthographic render of its plane rect (`Carrel.getPlaneRect()` for
 * plane desks; bounds face for ring/wall desks) into a `WebGLRenderTarget` at a power-of-two
 * tier (`256 / 512 / 1024 / 2048` on the long edge, aspect-matched on the short edge, or native
 * 1:1 device pixels), displayed as a `1×1` `FrameGrid` of the target's texture.
 *
 * Layer discipline (§3.16):
 *   - `PanelBatch` and `GlyphBatch` remove enrolled panels and labels from `VIEW_LAYER = 0` and
 *     draw them from single arena meshes on layer 0, refreshed in `scene.onBeforeRender` only when
 *     `camera.layers.isEnabled(0)` is true.
 *   - `GlyphFarLod` toggles layer 0 on glyph fields by screen row height (never `.visible`).
 *   - `CarrelCards` renders on a dedicated `CARD_LAYER = 29` with layer 0 disabled on its
 *     orthographic camera (`cardCamera.layers.set(CARD_LAYER)`). Therefore `scene.onBeforeRender`
 *     never triggers `GlyphBatch.update` or `PanelBatch.update` during a card pass (zero repacks),
 *     and `PlaneOverlay.onAfterRender` skips the FBO pass.
 *   - During the card pass, `CarrelCards` temporarily enables `CARD_LAYER` on the target carrel's
 *     live member meshes (their `InstancedField` glyph meshes, `FieldLabel` glyph/plate meshes,
 *     and enrolled panel/box/edge meshes — skipping `glyph-far-lod` quads and `carrel._shadow`)
 *     and restores all layer bits and render orders in a `finally` block.
 */

import * as THREE from 'three';
import FrameGrid from './FrameGrid.js';
import { cutRect, cutMatrix } from '../core/panelCut.js';
import { unwatchLayers } from './FlatRenderRoot.js';
import { isTracked, showGeneration } from './SceneTransforms.js';
import { pxPerUnitAtPoint } from '../services/spatial/spatialMath.js';

/** Dedicated camera layer for offscreen carrel card passes (layer 0 disabled). */
export const CARD_LAYER = 29;

/** Power-of-two resolution tiers (long edge in texels). */
export const CARD_TIERS = Object.freeze([256, 512, 1024, 2048]);

export const CARREL_CARDS_DEFAULTS = Object.freeze({
    enabled: true,
    budgetMs: 1.5,
    live: 6,
    nearLiveHz: 2,
    maxBytes: 64 * 1024 * 1024, // 64 MB RGBA8 cap across pooled WebGLRenderTargets
    swapInRatio: 1.0,           // card -> live when screen px per texel >= 1.0
    swapOutRatio: 0.85,         // live -> card when screen px per texel < 0.85 (hysteresis)
});

const _v3 = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _box = new THREE.Box3();
const _memberBox = new THREE.Box3();
const _invCarrel = new THREE.Matrix4();
const _savedClearColor = new THREE.Color();
const _srgbClearColor = new THREE.Color();

/**
 * Choose the smallest power-of-two tier in `CARD_TIERS` >= `projectedLongPx`.
 *
 * @param {number} projectedLongPx
 * @returns {number}
 */
export function tierForProjectedPx(projectedLongPx) {
    const px = Math.max(1, Number(projectedLongPx) || 256);
    for (const tier of CARD_TIERS) {
        if (tier >= px) return tier;
    }
    return CARD_TIERS[CARD_TIERS.length - 1];
}

/**
 * Compute aspect-matched `{ width, height, tier }` for a carrel rect and requested tier.
 * When `tier === 'native'` and `rect.nativeW > 0 && rect.nativeH > 0`, returns the exact
 * native device-pixel dimensions.
 *
 * @param {{ width: number, height: number, nativeW?: number, nativeH?: number }} rect
 * @param {number|'native'} [tier=512]
 * @returns {{ width: number, height: number, tier: number|'native' }}
 */
export function dimsForTier(rect, tier = 512) {
    if (tier === 'native' && rect?.nativeW > 0 && rect?.nativeH > 0) {
        return {
            width: Math.max(1, Math.round(rect.nativeW)),
            height: Math.max(1, Math.round(rect.nativeH)),
            tier: 'native',
        };
    }
    const longEdge = tierForProjectedPx(typeof tier === 'number' ? tier : 512);
    const wWorld = Math.max(1e-3, Number(rect?.width) || 1);
    const hWorld = Math.max(1e-3, Number(rect?.height) || 1);
    const aspect = wWorld / hWorld;
    if (aspect >= 1) {
        return {
            width: longEdge,
            height: Math.max(1, Math.round(longEdge / aspect)),
            tier: longEdge,
        };
    }
    return {
        width: Math.max(1, Math.round(longEdge * aspect)),
        height: longEdge,
        tier: longEdge,
    };
}

/**
 * Compute the world-space capture rectangle and depth slab for any `Carrel`.
 * - For plane desks (`carrel.mode === 'plane'` with `getPlaneRect()`), uses `carrel.getPlaneRect()`
 *   and records `nativeW / nativeH` from `carrel.planeK`.
 * - For ring/wall desks, computes the bounds face of the live seated members in carrel-local
 *   frame (falling back to `carrel.getLocalBounds()` when empty).
 *
 * @param {Object} carrel
 * @returns {{
 *   center: THREE.Vector3,
 *   localCenter: THREE.Vector3,
 *   normal: THREE.Vector3,
 *   up: THREE.Vector3,
 *   right: THREE.Vector3,
 *   width: number,
 *   height: number,
 *   depth: number,
 *   nativeW: number|null,
 *   nativeH: number|null
 * } | null}
 */
export function getCardRect(carrel) {
    if (!carrel) return null;
    carrel.updateWorldMatrix?.(true, false);
    const q = carrel.getWorldQuaternion(new THREE.Quaternion());
    const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(q).normalize();
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q).normalize();
    const right = new THREE.Vector3().crossVectors(up, normal).normalize();

    const planeRect = typeof carrel.getPlaneRect === 'function' ? carrel.getPlaneRect() : null;
    if (planeRect && planeRect.width > 0 && planeRect.height > 0) {
        const scale = Number.isFinite(planeRect.scale) && planeRect.scale > 0 ? planeRect.scale : 1;
        const pxPerUnit = Number.isFinite(planeRect.pxPerUnit) && planeRect.pxPerUnit > 0
            ? planeRect.pxPerUnit
            : (carrel.planeK ? carrel.planeK / scale : null);
        const center = new THREE.Vector3(planeRect.center.x, planeRect.center.y, planeRect.center.z);
        const localCenter = carrel.worldToLocal(center.clone());
        // Include any background padding overhang of seated members in depth.
        const depth = Math.max((carrel._layoutD ?? 0) * 2 * scale + 8, 32);
        return {
            center,
            localCenter,
            normal,
            up,
            right,
            width: planeRect.width,
            height: planeRect.height,
            localWidth: planeRect.width / scale,
            localHeight: planeRect.height / scale,
            scale,
            pxPerUnit,
            depth,
            nativeW: pxPerUnit ? Math.max(1, Math.round(planeRect.width * pxPerUnit)) : null,
            nativeH: pxPerUnit ? Math.max(1, Math.round(planeRect.height * pxPerUnit)) : null,
        };
    }

    // Ring or wall (grid) desk: read carrel.getLocalBounds first (O(1), no child matrix walk).
    _box.makeEmpty();
    carrel.getLocalBounds?.(_box);
    if (_box.isEmpty()) {
        _invCarrel.copy(carrel.matrixWorld).invert();
        for (const e of carrel.entries?.values?.() || []) {
            if (!e?.grid || e.grid.parent !== carrel || e._borrowed) continue;
            const lb = e.grid.getBounds?.(_memberBox);
            if (!lb || lb.isEmpty()) continue;
            lb.applyMatrix4(_invCarrel);
            _box.union(lb);
        }
    }
    if (_box.isEmpty()) return null;

    const worldScaleVec = carrel.getWorldScale ? carrel.getWorldScale(_v3) : _v3.set(1, 1, 1);
    const scale = Math.max(1e-6, Math.abs(worldScaleVec.x) || 1);
    const localWidth = Math.max(1e-3, _box.max.x - _box.min.x);
    const localHeight = Math.max(1e-3, _box.max.y - _box.min.y);
    const width = localWidth * scale;
    const height = localHeight * scale;
    const depth = Math.max(32, (_box.max.z - _box.min.z) * scale + 16);
    const localCenter = new THREE.Vector3(
        (_box.min.x + _box.max.x) * 0.5,
        (_box.min.y + _box.max.y) * 0.5,
        carrel.mode === 'grid' ? -Math.max(carrel.radius || 0, 1e-3) : (_box.min.z + _box.max.z) * 0.5,
    );
    const center = carrel.localToWorld(localCenter.clone());

    return {
        center,
        localCenter,
        normal,
        up,
        right,
        width,
        height,
        localWidth,
        localHeight,
        scale,
        pxPerUnit: null,
        depth,
        nativeW: null,
        nativeH: null,
    };
}

function isCarrelNode(obj) {
    return Boolean(obj && (obj.isCarrel || typeof obj.carrelName === 'string'));
}

/**
 * Compute a lightweight structural/content signature for a carrel so `CarrelCards` can detect
 * when a carrel's members or layout have changed and mark its card dirty.
 *
 * @param {Object} carrel
 * @returns {string}
 */
function computeCarrelSignature(carrel) {
    if (!carrel) return '';
    const parts = [
        carrel.mode,
        carrel.planeArrange,
        carrel._footprint || '',
        carrel.entries?.size || 0,
    ];
    for (const e of carrel.entries?.values?.() || []) {
        const g = e?.grid;
        if (!g || g.parent !== carrel || e._borrowed || isCarrelNode(g)) continue;
        const field = g._renderer || g._instancedField || g.scrollDoc?.bodyField || null;
        const slotVer = field?.slotBuffer?.version ?? field?._cachedGlyphCount ?? field?.slotBuffer?.count ?? 0;
        const hlVer = field?._highlightTexture?.version ?? 0;
        const scrolled = g.linesScrolled ?? g._scrolled ?? g.scrollDoc?.stats?.scrolls ?? 0;
        const flushes = g.scrollDoc?.stats?.flushes ?? 0;
        const curX = g._cursor?.x ?? 0;
        const curY = g._cursor?.y ?? 0;
        const sheetsN = Array.isArray(g.sheets) ? g.sheets.length : 0;
        const curSheet = g.head ?? g.current ?? 0;
        let openGlyphs = 0;
        if (sheetsN > 0) {
            const s = g.sheets[Math.min(Math.max(0, curSheet), sheetsN - 1)];
            const rf = s?.recto?._renderer;
            const vf = s?.verso?._renderer;
            openGlyphs = (rf?._cachedGlyphCount ?? rf?.slotBuffer?.count ?? 0)
                + (vf?._cachedGlyphCount ?? vf?.slotBuffer?.count ?? 0);
        }
        parts.push(`${e.id}:${slotVer}:${hlVer}:${scrolled}:${flushes}:${curX},${curY}:${sheetsN},${curSheet},${openGlyphs}`);
    }
    return parts.join('|');
}

/**
 * Return true when `carrel` has at least one own non-Carrel surface and no nested child Carrels.
 * Outer hub container carrels (like `gomux` or `agents`) hold child Carrels and are not carded as a single flat quad.
 * @param {Object} carrel
 * @returns {boolean}
 */
function isCardableCarrel(carrel) {
    if (!carrel || carrel._dissolving || carrel._dead || !carrel.entries?.size) return false;
    if (carrel.derived && carrel.mode === 'ring') return false;
    let hasOwnSurface = false;
    for (const e of carrel.entries.values()) {
        if (!e?.grid || e.grid.parent !== carrel || e._borrowed) continue;
        if (isCarrelNode(e.grid) || String(e.id).startsWith('carrel:')) return false;
        hasOwnSurface = true;
    }
    return hasOwnSurface;
}

export class CarrelCards {
    /**
     * @param {Object} ctx - application or core context `{ scene, renderer, atlas, carrels, cameraController, gomuxHub, agentBooks }`
     * @param {Partial<typeof CARREL_CARDS_DEFAULTS> & { now?: () => number, estimateCaptureMs?: (carrel: Object, tier: number, entry: Object) => number }} [opts]
     */
    constructor(ctx, opts = {}) {
        this.ctx = ctx;
        this.cfg = { ...CARREL_CARDS_DEFAULTS, ...opts };
        this._now = typeof opts.now === 'function' ? opts.now : () => performance.now();

        /** @type {Map<string, Object>} carrelName -> card entry */
        this.cards = new Map();

        /** Orthographic camera dedicated to `CARD_LAYER` (layer 0 disabled). */
        this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
        this.camera.name = 'carrel-card-camera';
        unwatchLayers(this.camera.layers);
        this.camera.layers.set(CARD_LAYER);

        /** Stand-in scene so `capture()` renders only the target carrel's drawables instead of walking all scene nodes. */
        this._cardScene = new THREE.Scene();
        this._cardScene.name = 'carrel-card-root';
        this._cardScene.matrixAutoUpdate = false;
        this._cardScene.matrixWorldAutoUpdate = false;

        /** Total bytes currently allocated across pooled `WebGLRenderTarget`s. */
        this.totalBytes = 0;

        /** Round-robin cursor for budgeted near-live refreshes. */
        this._rrIndex = 0;

        /** Track our own showGeneration deltas so we can detect when external scene loading settles. */
        this._ownShowGen = 0;
        this._lastExtShowGen = -1;
        this._createdAt = this._now();
        this._sceneChangedAt = this._createdAt;
        this._anyDeskDirtyAt = this._createdAt;

        /** Last entered plane carrel name, so `carrel.leave` captures its postcard. */
        this._lastEnteredCarrel = null;
        this._planeListenerArmed = false;
        this._armPlaneListener();
    }

    /**
     * Update live configuration dials (`carrel.card.*`).
     * @param {Partial<typeof CARREL_CARDS_DEFAULTS> & { nearLiveCount?: number }} patch
     */
    configure(patch = {}) {
        Object.assign(this.cfg, patch);
        if (typeof patch.now === 'function') {
            this._now = patch.now;
        }
        if (patch.nearLiveCount !== undefined && patch.live === undefined) {
            this.cfg.live = patch.nearLiveCount;
        }
        if (patch.budgetMs !== undefined) {
            const b = Math.max(0, Number(this.cfg.budgetMs) ?? CARREL_CARDS_DEFAULTS.budgetMs);
            for (const entry of this.cards.values()) {
                entry.maxTier = CARD_TIERS[CARD_TIERS.length - 1];
                entry.overBudget = false;
                if (b > 0 && entry.tierCosts instanceof Map) {
                    for (let i = CARD_TIERS.length - 1; i >= 0; i--) {
                        const t = CARD_TIERS[i];
                        const c = entry.tierCosts.get(t);
                        if (c !== undefined && c > b) {
                            if (i > 0) entry.maxTier = Math.min(entry.maxTier, CARD_TIERS[i - 1]);
                            else { entry.maxTier = CARD_TIERS[0]; entry.overBudget = true; }
                        }
                    }
                }
            }
        }
        if (!this.cfg.enabled) {
            for (const entry of this.cards.values()) {
                if (entry.showing === 'card') {
                    this.setDisplayMode(entry.name, 'live');
                }
            }
        }
        this._enforceByteCap();
    }

    /**
     * Hook `cameraController.addPlaneListener` once so leaving a plane captures the postcard.
     * @private
     */
    _armPlaneListener() {
        const cc = this.ctx?.cameraController;
        if (!cc?.addPlaneListener || this._planeListenerArmed) return;
        this._planeListenerArmed = true;
        this._planeListener = (on) => {
            if (on) {
                this._lastEnteredCarrel = this.ctx?.enteredCarrel ?? null;
                if (this._lastEnteredCarrel) {
                    const entry = this.cards.get(this._lastEnteredCarrel);
                    if (entry) this.setDisplayMode(this._lastEnteredCarrel, 'live');
                }
            } else {
                const leavingName = this._lastEnteredCarrel || this.ctx?.enteredCarrel;
                this._lastEnteredCarrel = null;
                if (leavingName && this.cfg.enabled) {
                    const carrel = this._resolveCarrel(leavingName);
                    if (carrel && !carrel._dissolving) {
                        const entry = this._ensureEntry(carrel);
                        const budgetMs = Math.max(0, Number(this.cfg.budgetMs) ?? CARREL_CARDS_DEFAULTS.budgetMs);
                        const baseTier = typeof entry.tier === 'number' ? entry.tier : 1024;
                        const leaveTier = this.pickTierForBudget(carrel, baseTier, budgetMs, entry) ?? CARD_TIERS[0];
                        this.capture(carrel, { tier: leaveTier, reason: 'leave' });
                    }
                }
            }
        };
        cc.addPlaneListener(this._planeListener);
    }

    /**
     * Resolve a carrel instance from a name or Carrel reference.
     * @param {string|Object} carrelOrName
     * @returns {Object|null}
     */
    _resolveCarrel(carrelOrName) {
        if (!carrelOrName) return null;
        if (typeof carrelOrName === 'object' && carrelOrName.carrelName) return carrelOrName;
        const name = String(carrelOrName).replace(/^carrel:/, '');
        return this.ctx?.carrels?.get?.(name) ?? null;
    }

    /**
     * Get or create the card record for `carrel`.
     * @param {Object} carrel
     * @returns {Object}
     */
    _ensureEntry(carrel) {
        const name = carrel.carrelName;
        let entry = this.cards.get(name);
        if (entry && entry.carrel !== carrel) {
            this._disposeEntry(entry);
            entry = null;
        }
        if (!entry) {
            const now = this._now();
            entry = {
                name,
                carrel,
                target: null,
                frame: null,
                tier: null,
                maxTier: CARD_TIERS[CARD_TIERS.length - 1],
                tierCosts: new Map(),
                overBudget: false,
                width: 0,
                height: 0,
                bytes: 0,
                capturedAt: 0,
                captureMs: 0,
                lastUsedAt: now,
                dirty: true,
                dirtyAt: now,
                dirtyFrame: this.ctx?.renderPasses?.frames ?? -1,
                lastSeenSig: '',
                stale: false,
                nearLive: true,
                showing: 'live', // 'live' | 'card'
                reason: null,
                signature: '',
                savedVis: new Map(),
            };
            this.cards.set(name, entry);
        }
        return entry;
    }

    /**
     * Pick the highest tier `<= min(rawWantTier, entry.maxTier)` whose measured or estimated capture
     * cost fits within `budgetMs` (stepping down `2048 -> 1024 -> 512 -> 256`). Returns `null` and marks
     * `entry.overBudget = true` when even the cheapest tier (`256`) is known to exceed `budgetMs`.
     *
     * @param {Object} carrel
     * @param {number} rawWantTier
     * @param {number} budgetMs
     * @param {Object} [entry]
     * @returns {number|null}
     */
    pickTierForBudget(carrel, rawWantTier, budgetMs, entry = null) {
        const rec = entry || this._ensureEntry(carrel);
        const cap = Math.min(Number(rawWantTier) || CARD_TIERS[0], rec.maxTier || CARD_TIERS[CARD_TIERS.length - 1]);
        let startIdx = 0;
        for (let i = 0; i < CARD_TIERS.length; i++) {
            if (CARD_TIERS[i] <= cap) startIdx = i;
        }
        const estFn = typeof this.cfg.estimateCaptureMs === 'function' ? this.cfg.estimateCaptureMs : null;
        for (let i = startIdx; i >= 0; i--) {
            const t = CARD_TIERS[i];
            const known = rec.tierCosts.get(t) ?? (estFn ? estFn(carrel, t, rec) : undefined);
            if (budgetMs > 0 && known !== undefined && known > budgetMs) {
                rec.tierCosts.set(t, known);
                if (i > 0) {
                    rec.maxTier = Math.min(rec.maxTier, CARD_TIERS[i - 1]);
                } else {
                    rec.maxTier = CARD_TIERS[0];
                    rec.overBudget = true;
                    return null;
                }
                continue;
            }
            return t;
        }
        return CARD_TIERS[0];
    }

    /**
     * Record a desk's measured capture cost at `resolvedTier` and step `entry.maxTier` down
     * (`2048 -> 1024 -> 512 -> 256`) if `ms > cfg.budgetMs`. If the cheapest tier (`256`) still
     * exceeds `cfg.budgetMs`, mark `entry.overBudget = true` so periodic near-live refresh skips it.
     * @private
     */
    _recordCaptureCost(entry, resolvedTier, ms) {
        const budgetMs = Math.max(0, Number(this.cfg.budgetMs) ?? CARREL_CARDS_DEFAULTS.budgetMs);
        const numTier = typeof resolvedTier === 'number'
            ? resolvedTier
            : tierForProjectedPx(Math.max(entry.width || 0, entry.height || 0));
        entry.tierCosts.set(numTier, ms);
        if (budgetMs > 0 && ms > budgetMs) {
            let nextMax = null;
            for (let i = CARD_TIERS.length - 1; i >= 0; i--) {
                const t = CARD_TIERS[i];
                if (t >= numTier) continue;
                const known = entry.tierCosts.get(t);
                if (known !== undefined && known > budgetMs) continue;
                nextMax = t;
                break;
            }
            if (nextMax !== null) {
                entry.maxTier = Math.min(entry.maxTier, nextMax);
                entry.dirty = true;
            } else {
                entry.maxTier = CARD_TIERS[0];
                entry.overBudget = true;
            }
        } else if (budgetMs > 0 && ms <= budgetMs) {
            entry.overBudget = false;
        }
    }

    /**
     * Allocate or resize `entry.target` (`WebGLRenderTarget`) within the byte-capped LRU pool.
     * Validates `width` and `height` against `maxTextureSize` / `maxRenderbufferSize` at the seam.
     * @private
     */
    _acquireTarget(entry, width, height) {
        const w = Math.round(Number(width));
        const h = Math.round(Number(height));
        const caps = this.ctx?.renderer?.capabilities;
        const maxTex = Number(caps?.maxTextureSize) > 0 ? Number(caps.maxTextureSize) : 4096;
        const maxRb = Number(caps?.maxRenderbufferSize) > 0 ? Number(caps.maxRenderbufferSize) : maxTex;
        const maxDim = Math.min(maxTex, maxRb);
        if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1 || w > maxDim || h > maxDim) {
            throw new RangeError(
                `CarrelCards._acquireTarget: invalid render-target size ${width}x${height} for "${entry?.name ?? '?'}" (allowed 1..${maxDim}, maxTextureSize=${maxTex}, maxRenderbufferSize=${maxRb})`,
            );
        }
        const neededBytes = w * h * 4;

        if (entry.target && entry.width === w && entry.height === h) {
            entry.lastUsedAt = performance.now();
            return entry.target;
        }

        // Release old target first if resizing.
        if (entry.target) {
            this._releaseTarget(entry);
        }

        // Evict least-recently-used targets until `neededBytes` fits under `maxBytes`.
        this._enforceByteCap(neededBytes, entry.name);

        const target = new THREE.WebGLRenderTarget(w, h, {
            minFilter: THREE.LinearFilter,
            magFilter: THREE.LinearFilter,
            format: THREE.RGBAFormat,
            type: THREE.UnsignedByteType,
            depthBuffer: true,
            stencilBuffer: false,
            generateMipmaps: false,
        });
        // FBO attachment has v=1 at the top (+y) and v=0 at the bottom (-y).
        // Setting flipY = true tells InstancedField.setFrameTexture to set uFrameFlipY = 1
        // so FrameGrid's top (vGlyphUV.y = 1) samples v = 1 of the FBO texture.
        target.texture.flipY = true;

        entry.target = target;
        entry.width = w;
        entry.height = h;
        entry.bytes = neededBytes;
        entry.lastUsedAt = performance.now();
        this.totalBytes += neededBytes;
        return target;
    }

    /**
     * Free a card entry's `WebGLRenderTarget` and revert the carrel to `'live'` (far-LOD fallback).
     * @private
     */
    _releaseTarget(entry) {
        if (!entry?.target) return;
        if (entry.showing === 'card') {
            this.setDisplayMode(entry.name, 'live');
        }
        entry.frame?.setFrameTexture?.(null);
        this.totalBytes = Math.max(0, this.totalBytes - (entry.bytes || 0));
        entry.target.dispose();
        entry.target = null;
        entry._targetWarm = false;
        entry.bytes = 0;
        entry.width = 0;
        entry.height = 0;
    }

    /**
     * Evict least-recently-used card targets when `totalBytes + incomingBytes > cfg.maxBytes`.
     * @private
     */
    _enforceByteCap(incomingBytes = 0, protectName = null) {
        const maxBytes = Math.max(1024 * 1024, Number(this.cfg.maxBytes) || CARREL_CARDS_DEFAULTS.maxBytes);
        if (this.totalBytes + incomingBytes <= maxBytes) return;

        const candidates = [...this.cards.values()]
            .filter((e) => e.target && e.name !== protectName)
            .sort((a, b) => a.lastUsedAt - b.lastUsedAt);

        for (const victim of candidates) {
            if (this.totalBytes + incomingBytes <= maxBytes) break;
            this._releaseTarget(victim);
            victim.dirty = true;
        }
    }

    /**
     * Ensure `entry.frame` (`1×1` `FrameGrid`) exists and is sized/posed to `rect` with `entry.target.texture`.
     * @private
     */
    _syncFrameGrid(entry, rect, oneToOne = true) {
        const carrel = entry.carrel;
        const atlas = this.ctx?.atlas ?? null;
        const localW = rect.localWidth ?? rect.width;
        const localH = rect.localHeight ?? rect.height;
        const aspect = localW / Math.max(1e-3, localH);
        let changed = false;

        const sg0 = showGeneration();
        if (!entry.frame) {
            const frame = new FrameGrid(null, atlas, {
                name: `carrel-card:${entry.name}`,
                cols: 1,
                rows: 1,
                width: localW,
                aspect,
                backgroundColor: 0x000000,
                backgroundOpacity: 0,
            });
            frame.name = `carrel-card:${entry.name}`;
            frame.userData.isCarrelCard = true;
            frame.userData.carrelName = entry.name;
            frame._disposePanel?.();
            frame.visible = entry.showing === 'card';
            carrel.add(frame);
            entry.frame = frame;
            changed = true;
        } else {
            const frame = entry.frame;
            if (frame.parent !== carrel) {
                carrel.add(frame);
                changed = true;
            }
            if (Math.abs(frame.width - localW) > 1e-4 || Math.abs(frame.aspect - aspect) > 1e-4) {
                frame.width = localW;
                frame.aspect = aspect;
                frame._build();
                changed = true;
            }
        }
        this._ownShowGen += (showGeneration() - sg0);

        const frame = entry.frame;
        if (frame.position.distanceToSquared(rect.localCenter) > 1e-8) {
            frame.position.copy(rect.localCenter);
            changed = true;
        }
        if (frame._oneToOne !== Boolean(oneToOne)) {
            frame.setOneToOne(oneToOne);
            changed = true;
        }
        if (entry.target && (frame._texture !== entry.target.texture || entry._syncedFrameAt !== entry.capturedAt)) {
            frame.setFrameTexture(entry.target.texture);
            frame.noteFrame({ width: entry.width, height: entry.height });
            entry._syncedFrameAt = entry.capturedAt;
            changed = true;
        }
        if (changed) {
            frame.updateWorldMatrix(true, true);
        }
    }

    /**
     * Switch a carrel between showing its live members (`'live'`) and showing its `1×1`
     * `FrameGrid` impostor card (`'card'`).
     *
     * @param {string|Object} carrelOrName
     * @param {'live'|'card'} mode
     * @returns {boolean}
     */
    setDisplayMode(carrelOrName, mode) {
        const carrel = this._resolveCarrel(carrelOrName);
        if (!carrel) return false;
        const entry = this._ensureEntry(carrel);
        const want = (mode === 'card' && entry.target && entry.frame) ? 'card' : 'live';
        if (entry.showing === want) {
            if (entry.frame && entry.frame.visible !== (want === 'card')) {
                const sg0 = showGeneration();
                entry.frame.visible = want === 'card';
                this._ownShowGen += (showGeneration() - sg0);
            }
            return true;
        }

        const sg0 = showGeneration();
        if (want === 'card') {
            entry.savedVis.clear();
            for (const e of carrel.entries?.values?.() || []) {
                if (!e?.grid || e.grid.parent !== carrel || e._borrowed) continue;
                entry.savedVis.set(e.id, e.grid.visible);
                if (e.grid.visible !== false) e.grid.visible = false;
            }
            if (entry.frame && !entry.frame.visible) entry.frame.visible = true;
            entry.showing = 'card';
        } else {
            for (const e of carrel.entries?.values?.() || []) {
                if (!e?.grid || e.grid.parent !== carrel || e._borrowed) continue;
                const prevVis = entry.savedVis.has(e.id) ? entry.savedVis.get(e.id) : true;
                if (e.grid.visible !== prevVis) e.grid.visible = prevVis;
            }
            entry.savedVis.clear();
            if (entry.frame && entry.frame.visible) entry.frame.visible = false;
            entry.showing = 'live';
        }
        this._ownShowGen += (showGeneration() - sg0);
        return true;
    }

    /**
     * Incrementally warm cold WebGL shader programs, VBOs/VAOs, DataTextures, and the target FBO
     * across frames (into a 1x1 FBO on CARD_LAYER) so the first full card capture never stalls the
     * main thread with one-time shader compilation or bulk buffer uploads.
     *
     * @param {Object} carrel
     * @param {Object} entry
     * @param {number|'native'} chosenTier
     * @param {Object} rect
     * @returns {boolean} true when all candidate meshes and the target FBO are warm and ready to capture
     * @private
     */
    _warmCarrelStep(carrel, entry, chosenTier, rect) {
        const renderer = this.ctx?.renderer;
        const scene = this.ctx?.scene;
        if (!renderer?.isWebGLRenderer || !scene) return true;

        const d = dimsForTier(rect, chosenTier);
        const texelsPerUnit = d.height / Math.max(rect.height, 1e-3);
        const skipBookSubtrees = new Set();
        const coldMeshes = [];
        let hasColdShader = false;

        const visit = (obj, ignoreSelfVis = false, inTab = false) => {
            if (!obj || (!ignoreSelfVis && !obj.visible) || skipBookSubtrees.has(obj)) return;
            if (isCarrelNode(obj) || obj.name === 'glyph-far-lod' || obj.userData?.isCarrelCard) return;
            const nowInTab = inTab || Boolean(obj.userData?.isTab);
            if (nowInTab && d.tier !== 'native') return;
            if (obj.userData?.isBook && obj.form === 'deck' && !obj._scroll && Array.isArray(obj.sheets) && obj.sheets.length > 1) {
                const head = Math.min(Math.max(0, obj.head), obj.sheets.length - 1);
                const order = obj.deck?.order === 1 ? 1 : -1;
                const rawMaxRank = (obj.deck?.rise || 0) !== 0
                    ? (obj.deck.riseRows > 0 ? obj.deck.riseRows : obj.sheets.length)
                    : 0;
                const maxRank = d.tier === 'native' ? rawMaxRank : Math.min(rawMaxRank, 1);
                for (let i = 0; i < obj.sheets.length; i++) {
                    const rank = order * (i - head);
                    const s = obj.sheets[i];
                    if (rank < 0 || rank > maxRank) {
                        if (s?.node) skipBookSubtrees.add(s.node);
                        if (obj.tabs?.[i]?.tab) skipBookSubtrees.add(obj.tabs[i].tab);
                    } else if (rank > 0 && s?.rectoMount) {
                        skipBookSubtrees.add(s.rectoMount);
                    }
                }
            }
            if (obj.isMesh || obj.isLineSegments) {
                if (obj.material && obj.material.visible === false) return;
                const field = obj.userData?.glyphField;
                if (field && d.tier !== 'native') {
                    if (!obj.userData?.glyphBatched && !obj.layers.isEnabled(0)) return;
                    if (field.rowHeight > 0) {
                        const rowWorld = field.rowHeight * obj.matrixWorld.getMaxScaleOnAxis();
                        if (rowWorld * texelsPerUnit < 1.0) return;
                    }
                }
                const wantVer = (field?._instanceBuffer?.version ?? 0) + 1;
                const mat = obj.material;
                const matCold = Boolean(mat && !mat.userData?._cardMatWarm);
                if (obj.userData?._cardWarmVer !== wantVer || matCold) {
                    coldMeshes.push({ obj, wantVer, mat });
                    if (matCold) hasColdShader = true;
                }
            }
            const children = obj.children;
            if (children) {
                for (let i = 0; i < children.length; i++) {
                    if (coldMeshes.length >= 12) break;
                    visit(children[i], false, nowInTab);
                }
            }
        };

        const wasShowing = entry.showing;
        for (const e of carrel.entries?.values?.() || []) {
            if (!e?.grid || e.grid.parent !== carrel || e._borrowed || isCarrelNode(e.grid)) continue;
            const liveVis = wasShowing === 'card'
                ? (entry.savedVis.has(e.id) ? entry.savedVis.get(e.id) : true)
                : e.grid.visible;
            if (!liveVis) continue;
            visit(e.grid, true);
            if (coldMeshes.length >= 12) break;
        }
        if (coldMeshes.length < 12 && carrel._edgeMarks instanceof Map) {
            for (const mark of carrel._edgeMarks.values()) {
                visit(mark);
                if (coldMeshes.length >= 12) break;
            }
        }

        if (coldMeshes.length > 0) {
            const firstColdShader = hasColdShader
                ? coldMeshes.find((m) => m.mat && !m.mat.userData?._cardMatWarm)
                : null;
            const batch = firstColdShader ? [firstColdShader] : coldMeshes.slice(0, 10);
            if (!this._warmTarget) {
                this._warmTarget = new THREE.WebGLRenderTarget(1, 1, {
                    depthBuffer: true,
                    stencilBuffer: false,
                    generateMipmaps: false,
                });
            }
            const cam = this.camera;
            cam.layers.set(CARD_LAYER);
            const saved = [];
            const meshes = [];
            for (const item of batch) {
                const m = item.obj;
                saved.push({ m, fc: m.frustumCulled, hadLayer: m.layers.isEnabled(CARD_LAYER) });
                m.frustumCulled = false;
                m.layers.enable(CARD_LAYER);
                meshes.push(m);
            }
            const prevTarget = renderer.getRenderTarget();
            const prevAutoClear = renderer.autoClear;
            const prevSceneBg = scene.background;
            const prevCheckShader = renderer.debug?.checkShaderErrors;
            if (renderer.debug) renderer.debug.checkShaderErrors = false;
            const cardScene = this._cardScene;
            cardScene.children = meshes;
            cardScene.onBeforeRender = (r, _s, c, t) => scene.onBeforeRender?.(r, scene, c, t);
            cardScene.onAfterRender = (r, _s, c, t) => scene.onAfterRender?.(r, scene, c, t);
            try {
                scene.background = null;
                cardScene.background = null;
                renderer.setRenderTarget(this._warmTarget);
                renderer.autoClear = false;
                renderer.render(cardScene, cam);
                for (const item of batch) {
                    if (item.obj.userData) item.obj.userData._cardWarmVer = item.wantVer;
                    if (item.mat) {
                        item.mat.userData ??= {};
                        item.mat.userData._cardMatWarm = true;
                    }
                }
            } finally {
                if (renderer.debug && prevCheckShader !== undefined) renderer.debug.checkShaderErrors = prevCheckShader;
                cardScene.children = [];
                scene.background = prevSceneBg;
                renderer.setRenderTarget(prevTarget);
                renderer.autoClear = prevAutoClear;
                for (const s of saved) {
                    s.m.frustumCulled = s.fc;
                    if (!s.hadLayer) s.m.layers.disable(CARD_LAYER);
                }
            }
            return false;
        }

        if (!entry.target || entry.width !== d.width || entry.height !== d.height || !entry._targetWarm) {
            const target = this._acquireTarget(entry, d.width, d.height);
            const prevTarget = renderer.getRenderTarget();
            try {
                renderer.setRenderTarget(target);
                renderer.clear(true, true, false);
                entry._targetWarm = true;
            } finally {
                renderer.setRenderTarget(prevTarget);
            }
            return false;
        }

        return true;
    }

    /**
     * Render a carrel's live members orthographically into its card `WebGLRenderTarget` on `CARD_LAYER`.
     *
     * @param {string|Object} carrelOrName
     * @param {Object} [opts]
     * @param {number|'native'} [opts.tier] - power-of-two tier (`256|512|1024|2048`) or `'native'`
     * @param {number} [opts.width] - explicit target width in px (overrides tier)
     * @param {number} [opts.height] - explicit target height in px (overrides tier)
     * @param {number} [opts.halfPxOffset=0] - optional pixel offset on ortho frustum (for gate teeth test)
     * @param {string} [opts.reason='manual'] - capture trigger reason (`'leave'|'budget'|'manual'`)
     * @returns {Object|null} card snapshot `{ name, tier, width, height, bytes, captureMs, ageMs, showing, stale, reason }`
     */
    capture(carrelOrName, opts = {}) {
        const carrel = this._resolveCarrel(carrelOrName);
        const renderer = this.ctx?.renderer;
        const scene = this.ctx?.scene;
        if (!carrel || !renderer || !scene) return null;

        this._armPlaneListener();
        const entry = this._ensureEntry(carrel);
        const wasShowing = entry.showing;

        // Ensure any in-flight member seat animations are evaluated at their current pose.
        if (isTracked(scene)) {
            scene.updateMatrixWorld();
            carrel.updateWorldMatrix?.(true, false);
        } else {
            carrel.updateWorldMatrix(true, true);
        }
        const rect = getCardRect(carrel);
        if (!rect) {
            return null;
        }

        // Determine target pixel dimensions.
        let targetW, targetH, resolvedTier;
        if (opts.width > 0 && opts.height > 0) {
            targetW = Math.max(1, Math.round(opts.width));
            targetH = Math.max(1, Math.round(opts.height));
            resolvedTier = opts.tier ?? Math.max(targetW, targetH);
        } else {
            const defaultTier = opts.tier ?? (rect.nativeW && rect.nativeH && Math.max(rect.nativeW, rect.nativeH) <= 2048 ? 'native' : 1024);
            const d = dimsForTier(rect, defaultTier);
            targetW = d.width;
            targetH = d.height;
            resolvedTier = d.tier;
        }

        const target = this._acquireTarget(entry, targetW, targetH);
        entry.tier = resolvedTier;

        // Configure orthographic camera tightly around `rect`.
        const halfW = rect.width * 0.5;
        const halfH = rect.height * 0.5;
        const offsetPx = Number(opts.halfPxOffset) || 0;
        const shiftX = offsetPx * (rect.width / targetW);
        const shiftY = offsetPx * (rect.height / targetH);

        const dist = Math.max(rect.depth * 0.5 + 16, 32);
        const cam = this.camera;
        cam.layers.set(CARD_LAYER);
        cam.left = -halfW + shiftX;
        cam.right = halfW + shiftX;
        cam.top = halfH + shiftY;
        cam.bottom = -halfH + shiftY;
        cam.near = 0.1;
        cam.far = dist * 2 + rect.depth;
        cam.up.copy(rect.up);
        cam.position.copy(rect.center).addScaledVector(rect.normal, dist);
        cam.lookAt(rect.center);
        cam.updateProjectionMatrix();
        cam.updateMatrixWorld(true);

        // Collect all visible renderable meshes/lines belonging to this carrel's live members
        // and temporarily enable CARD_LAYER on them. Do not descend into hidden subtrees,
        // nested Carrels, glyph-far-lod quads, or FrameGrid impostor cards.
        // Note: when `wasShowing === 'card'`, direct member grids have `e.grid.visible === false`
        // (their true visibility is in `entry.savedVis`); we read `entry.savedVis` and pass
        // `ignoreSelfVis = true` at the member root so `.visible` is never flipped during capture
        // (keeping SceneTransforms' `showGeneration` and FlatRenderRoot's list untouched).
        const texelsPerUnit = targetH / Math.max(rect.height, 1e-3);
        const touchedMeshes = [];
        const savedOrders = [];
        const savedPanelCuts = [];
        const savedColors = [];
        const seenMaterials = new Set();
        const skipBookSubtrees = new Set();
        const isBudgetPass = opts.reason === 'budget' || opts.reason === 'leave';
        const visitMemberNode = (obj, ignoreSelfVis = false, inTab = false) => {
            if (!obj || (!ignoreSelfVis && !obj.visible) || skipBookSubtrees.has(obj)) return;
            if (isCarrelNode(obj) || obj.name === 'glyph-far-lod' || obj.userData?.isCarrelCard) return;
            const nowInTab = inTab || Boolean(obj.userData?.isTab);
            if (nowInTab && resolvedTier !== 'native') return;
            if (obj.userData?.isBook && obj.form === 'deck' && !obj._scroll && Array.isArray(obj.sheets) && obj.sheets.length > 1) {
                const head = Math.min(Math.max(0, obj.head), obj.sheets.length - 1);
                const order = obj.deck?.order === 1 ? 1 : -1;
                const rawMaxRank = (obj.deck?.rise || 0) !== 0
                    ? (obj.deck.riseRows > 0 ? obj.deck.riseRows : obj.sheets.length)
                    : 0;
                const maxRank = resolvedTier === 'native' ? rawMaxRank : Math.min(rawMaxRank, 1);
                for (let i = 0; i < obj.sheets.length; i++) {
                    const rank = order * (i - head);
                    const s = obj.sheets[i];
                    if (rank < 0 || rank > maxRank) {
                        if (s?.node) skipBookSubtrees.add(s.node);
                        if (obj.tabs?.[i]?.tab) skipBookSubtrees.add(obj.tabs[i].tab);
                    } else if (rank > 0 && s?.rectoMount) {
                        skipBookSubtrees.add(s.rectoMount);
                    }
                }
            }
            if (obj.isMesh || obj.isLineSegments) {
                if (obj.material && obj.material.visible === false) return;
                const field = obj.userData?.glyphField;
                if (field && resolvedTier !== 'native') {
                    // In budget card captures, skip non-batched glyph fields that GlyphFarLod already
                    // culled off layer 0 (their rows are < 1 px on screen and their VBOs are cold).
                    if (isBudgetPass && !obj.userData?.glyphBatched && !obj.layers.isEnabled(0)) return;
                    if (nowInTab && texelsPerUnit * 7 < 4.0) return;
                    if (field.rowHeight > 0) {
                        const rowWorld = field.rowHeight * obj.matrixWorld.getMaxScaleOnAxis();
                        if (rowWorld * texelsPerUnit < 1.0) return;
                    }
                }
                if (obj.userData?.panelClip) {
                    if (!cutRect(obj)) return;
                    const savedMw = obj.matrixWorld.clone();
                    const savedAuto = obj.matrixWorldAutoUpdate;
                    cutMatrix(obj, obj.matrixWorld);
                    obj.matrixWorldAutoUpdate = false;
                    savedPanelCuts.push({ obj, savedMw, savedAuto });
                }
                if (obj.material?.uniforms?.uFrameTex?.value === target.texture || obj.material?.map === target.texture) {
                    throw new Error(`CarrelCards.capture: feedback loop detected on "${entry.name}" — mesh "${obj.name}" samples its own render target`);
                }
                if (!obj.layers.isEnabled(CARD_LAYER)) {
                    obj.layers.enable(CARD_LAYER);
                    touchedMeshes.push(obj);
                }
                // Preserve PanelBatch's intra-band backdrop draw order (-0.5 panel, -0.4 fill, -0.3 edge)
                // and GlyphBatch's label draw order (+0.5) so enrolled panels and labels draw in the
                // exact same relative order as the live batched pass.
                if (obj.material?.uniforms?.uFill || obj.material?.userData?.panelBatchDispose) {
                    const origOrder = obj.renderOrder;
                    const delta = obj.isLineSegments ? -0.3 : (obj.geometry?.type === 'BoxGeometry' ? -0.4 : -0.5);
                    savedOrders.push({ obj, origOrder });
                    obj.renderOrder = origOrder + delta;
                } else if (obj.userData?.glyphBatched) {
                    const origOrder = obj.renderOrder;
                    savedOrders.push({ obj, origOrder });
                    obj.renderOrder = (origOrder || 0) + 0.5;
                }
                const mat = obj.material;
                if (mat && (mat.isMeshBasicMaterial || mat.isLineBasicMaterial) && !mat.map && mat.color?.isColor && !seenMaterials.has(mat)) {
                    seenMaterials.add(mat);
                    savedColors.push({ color: mat.color, r: mat.color.r, g: mat.color.g, b: mat.color.b });
                    mat.color.convertLinearToSRGB();
                }
            }
            const children = obj.children;
            if (children) {
                for (let i = 0; i < children.length; i++) {
                    visitMemberNode(children[i], false, nowInTab);
                }
            }
        };
        for (const e of carrel.entries?.values?.() || []) {
            if (!e?.grid || e.grid.parent !== carrel || e._borrowed || isCarrelNode(e.grid)) continue;
            const liveVis = wasShowing === 'card'
                ? (entry.savedVis.has(e.id) ? entry.savedVis.get(e.id) : true)
                : e.grid.visible;
            if (!liveVis) continue;
            visitMemberNode(e.grid, true);
        }
        if (carrel._edgeMarks instanceof Map) {
            for (const mark of carrel._edgeMarks.values()) {
                visitMemberNode(mark);
            }
        }

        const prevTarget = renderer.getRenderTarget();
        const prevAutoClear = renderer.autoClear;
        const prevClearAlpha = renderer.getClearAlpha();
        const prevSceneBg = scene.background;
        const prevCheckShader = renderer.debug?.checkShaderErrors;
        if (renderer.debug) renderer.debug.checkShaderErrors = false;
        renderer.getClearColor(_savedClearColor);

        const cardScene = this._cardScene;
        cardScene.children = touchedMeshes;
        cardScene.onBeforeRender = (r, _s, c, t) => scene.onBeforeRender?.(r, scene, c, t);
        cardScene.onAfterRender = (r, _s, c, t) => scene.onAfterRender?.(r, scene, c, t);

        const t0 = this._now();
        try {
            // Standard WebGLRenderTargets evaluate clear colors in ColorManagement.workingColorSpace
            // ('srgb-linear') without linearToSRGB conversion. Converting the clear color to sRGB and
            // suppressing WebGLBackground's scene.background force-clear emits the exact same sRGB
            // backdrop bytes as the default canvas framebuffer on a stock WebGLRenderTarget.
            _srgbClearColor.copy(prevSceneBg?.isColor ? prevSceneBg : _savedClearColor).convertLinearToSRGB();
            scene.background = null;
            cardScene.background = null;
            renderer.setRenderTarget(target);
            renderer.autoClear = false;
            renderer.setClearColor(_srgbClearColor, 1.0);
            renderer.clear(true, true, false);
            renderer.render(cardScene, cam);
        } finally {
            if (renderer.debug && prevCheckShader !== undefined) renderer.debug.checkShaderErrors = prevCheckShader;
            cardScene.children = [];
            scene.background = prevSceneBg;
            renderer.setRenderTarget(prevTarget);
            renderer.autoClear = prevAutoClear;
            renderer.setClearColor(_savedClearColor, prevClearAlpha);
            for (let i = 0; i < savedPanelCuts.length; i++) {
                const pc = savedPanelCuts[i];
                pc.obj.matrixWorld.copy(pc.savedMw);
                pc.obj.matrixWorldAutoUpdate = pc.savedAuto;
            }
            for (let i = 0; i < savedColors.length; i++) {
                const sc = savedColors[i];
                sc.color.setRGB(sc.r, sc.g, sc.b);
            }
            for (let i = 0; i < savedOrders.length; i++) {
                savedOrders[i].obj.renderOrder = savedOrders[i].origOrder;
            }
            for (let i = 0; i < touchedMeshes.length; i++) {
                touchedMeshes[i].layers.disable(CARD_LAYER);
            }
        }
        const t1 = this._now();
        const estFn = typeof this.cfg.estimateCaptureMs === 'function' ? this.cfg.estimateCaptureMs : null;
        const measuredMs = estFn
            ? Math.max(t1 - t0, Number(estFn(carrel, resolvedTier, entry)) || 0)
            : (t1 - t0);

        entry.captureMs = +measuredMs.toFixed(3);
        this._recordCaptureCost(entry, resolvedTier, entry.captureMs);
        this.ctx?.renderPasses?.record('cards', measuredMs);   // drawn on its own schedule; the frame owner reports it
        entry.capturedAt = t1;
        entry.lastUsedAt = t1;
        entry.dirty = entry.tier > entry.maxTier;
        entry.reason = opts.reason ?? 'manual';
        const sigNow = computeCarrelSignature(carrel);
        entry.signature = sigNow;
        entry.lastSeenSig = sigNow;

        const isOneToOne = resolvedTier === 'native' || (rect.nativeW === targetW && rect.nativeH === targetH);
        this._syncFrameGrid(entry, rect, isOneToOne);

        if (wasShowing === 'card') {
            this.setDisplayMode(carrel, 'card');
        }

        return this._describeEntry(entry, t1);
    }

    /**
     * Estimate the projected long-edge size (in device pixels) of `rect` under `camera`.
     *
     * @param {{ center: THREE.Vector3, width: number, height: number }} rect
     * @param {THREE.Camera} camera
     * @param {number} viewportH
     * @returns {number}
     */
    projectedLongPx(rect, camera, viewportH = 1000) {
        if (!rect || !camera) return 0;
        const pxPerUnit = pxPerUnitAtPoint(camera, rect.center, Number(viewportH) || 1000);
        return Math.max(rect.width, rect.height) * pxPerUnit;
    }

    /**
     * Ensure a card record exists for `carrelOrName` when enabled (used by Strip).
     * Never triggers an FBO capture when `cfg.enabled` is false.
     *
     * @param {string|Object} carrelOrName
     * @returns {Object|null}
     */
    ensureCard(carrelOrName) {
        const carrel = this._resolveCarrel(carrelOrName);
        if (!carrel || !isCardableCarrel(carrel)) return null;
        if (!this.cfg.enabled) return this.cards.get(carrel.carrelName) ?? null;
        return this._ensureEntry(carrel);
    }

    /**
     * Per-frame update (gated on `cfg.enabled`, default `false`):
     * 1. Sweeps dissolved carrels.
     * 2. Ranks standing carrels (top `cfg.live` are near-live; rest are static postcards marked stale when changed).
     * 3. Swaps `'live'` ↔ `'card'` at `texel >= pixel` with hysteresis (`swapInRatio` / `swapOutRatio`).
     * 4. Refreshes dirty near-live cards round-robin within `cfg.budgetMs` and `cfg.nearLiveHz`.
     *
     * @param {THREE.Camera} camera
     * @param {number} [viewportH=1000]
     */
    update(camera, viewportH = 1000) {
        this._armPlaneListener();
        const carrels = this.ctx?.carrels;
        if (!(carrels instanceof Map) || !camera) return;

        if (this.ctx?.enteredCarrel) {
            this._lastEnteredCarrel = this.ctx.enteredCarrel;
        }

        // Sweep removed/dissolved carrels (or container carrels that gained child Carrels).
        for (const [name, entry] of this.cards) {
            const liveCarrel = carrels.get(name);
            if (!liveCarrel || liveCarrel._dissolving || liveCarrel._dead) {
                this._disposeEntry(entry);
                this.cards.delete(name);
            }
        }

        if (!this.cfg.enabled) {
            for (const entry of this.cards.values()) {
                if (entry.showing === 'card') {
                    this.setDisplayMode(entry.name, 'live');
                }
            }
            return;
        }

        const entered = this.ctx?.enteredCarrel ?? null;
        const ranked = [];
        const now = this._now();
        const curFrame = this.ctx?.renderPasses?.frames ?? -1;
        const extShowGen = showGeneration() - this._ownShowGen;
        if (extShowGen !== this._lastExtShowGen) {
            this._lastExtShowGen = extShowGen;
            this._sceneChangedAt = now;
        }

        for (const [name, carrel] of carrels) {
            if (!isCardableCarrel(carrel)) {
                const existing = this.cards.get(name);
                if (existing) {
                    this._disposeEntry(existing);
                    this.cards.delete(name);
                }
                continue;
            }

            const entry = this._ensureEntry(carrel);
            const rect = getCardRect(carrel);
            if (!rect) continue;

            const sig = computeCarrelSignature(carrel);
            if (sig !== entry.signature) {
                entry.dirty = true;
            }
            if (sig !== entry.lastSeenSig) {
                entry.lastSeenSig = sig;
                entry.dirtyAt = now;
                entry.dirtyFrame = curFrame;
                this._anyDeskDirtyAt = now;
            }

            const projLongPx = this.projectedLongPx(rect, camera, viewportH);
            const isEntered = name === entered;
            ranked.push({ name, carrel, entry, rect, projLongPx, isEntered });
        }

        // Top `cfg.live` non-entered carrels by projected size are near-live; rest are static postcards.
        ranked.sort((a, b) => b.projLongPx - a.projLongPx);
        const liveCap = Math.max(0, Math.floor(Number(this.cfg.live) ?? CARREL_CARDS_DEFAULTS.live));
        let nonEnteredIdx = 0;
        for (const item of ranked) {
            if (item.isEntered) {
                item.entry.nearLive = true;
                item.entry.stale = false;
                continue;
            }
            item.entry.nearLive = nonEnteredIdx < liveCap;
            item.entry.stale = !item.entry.nearLive && item.entry.dirty;
            nonEnteredIdx++;
        }

        // Budgeted refresh of dirty near-live cards (round-robin, throttled by nearLiveHz, fitted to cfg.budgetMs).
        const budgetMs = Math.max(0, Number(this.cfg.budgetMs) ?? CARREL_CARDS_DEFAULTS.budgetMs);
        const nearLiveHz = Math.max(0.1, Number(this.cfg.nearLiveHz) || CARREL_CARDS_DEFAULTS.nearLiveHz);
        const minIntervalMs = 1000 / nearLiveHz;
        let spentMs = 0;
        let capturesThisFrame = 0;
        const swapOut = Math.max(0.1, Number(this.cfg.swapOutRatio) || CARREL_CARDS_DEFAULTS.swapOutRatio);
        const hasRenderLoop = Boolean(this.ctx?.renderPasses);
        if (ranked.length > 0 && budgetMs > 0) {
            for (let k = 0; k < ranked.length; k++) {
                const idx = (this._rrIndex + k) % ranked.length;
                const item = ranked[idx];
                const { entry, carrel, rect, projLongPx, isEntered } = item;
                if (isEntered || !entry.nearLive) continue;
                // A desk whose cheapest tier (256) still exceeds budgetMs is not near-live-refreshed;
                // it refreshes on leave or explicit capture only.
                if (entry.overBudget) continue;
                const isAnimating = typeof carrel.animator?.isAnimating === 'function'
                    ? carrel.animator.isAnimating()
                    : Boolean(carrel.animator?.isAnimating);
                if (isAnimating) continue;
                if (hasRenderLoop && (curFrame <= entry.dirtyFrame || (now - this._createdAt) < 2200 || (now - entry.dirtyAt) < 350 || (now - this._anyDeskDirtyAt) < 450 || (now - this._sceneChangedAt) < 350)) {
                    continue;
                }
                const maxTexels = rect.nativeW && rect.nativeH
                    ? Math.max(rect.nativeW, rect.nativeH)
                    : CARD_TIERS[CARD_TIERS.length - 1];
                if (projLongPx >= maxTexels * this.cfg.swapInRatio) continue;
                const rawWantTier = tierForProjectedPx(projLongPx / swapOut);
                const wantTier = this.pickTierForBudget(carrel, rawWantTier, budgetMs, entry);
                if (wantTier === null) continue;
                const chosenTier = wantTier;
                const estFn = typeof this.cfg.estimateCaptureMs === 'function' ? this.cfg.estimateCaptureMs : null;
                const estMs = entry.tierCosts.get(chosenTier) ?? (estFn ? estFn(carrel, chosenTier, entry) : 0);
                if (capturesThisFrame > 0 && spentMs + estMs > budgetMs) continue;
                const tierChanged = entry.target && entry.capturedAt > 0 && typeof entry.tier === 'number'
                    && (chosenTier > entry.tier || entry.tier > entry.maxTier);
                const cooldownElapsed = entry.capturedAt <= 0 || (now - entry.capturedAt) >= minIntervalMs;
                if (!entry.target || entry.capturedAt <= 0 || ((tierChanged || entry.dirty) && cooldownElapsed)) {
                    if (hasRenderLoop && !this._warmCarrelStep(carrel, entry, chosenTier, rect)) {
                        break;
                    }
                    const res = this.capture(carrel, { tier: chosenTier, reason: 'budget' });
                    spentMs += res?.captureMs ?? 0;
                    capturesThisFrame++;
                    this._rrIndex = (idx + 1) % ranked.length;
                    if (spentMs >= budgetMs || capturesThisFrame >= 1) break;
                }
            }
        }

        // Swap live <-> card at texel >= pixel with hysteresis.
        for (const item of ranked) {
            const { entry, carrel, rect, projLongPx, isEntered } = item;
            if (isEntered || !entry.target || entry.capturedAt <= 0 || !entry.frame) {
                if (entry.showing !== 'live') this.setDisplayMode(carrel, 'live');
                continue;
            }
            const cardLongTexels = Math.max(entry.width, entry.height, 1);
            const maxTexels = rect.nativeW && rect.nativeH
                ? Math.max(rect.nativeW, rect.nativeH)
                : CARD_TIERS[CARD_TIERS.length - 1];
            const effectiveTexels = entry.maxTier < CARD_TIERS[CARD_TIERS.length - 1]
                ? Math.max(cardLongTexels, Math.min(maxTexels, CARD_TIERS[CARD_TIERS.length - 1]))
                : cardLongTexels;
            const pxPerTexel = projLongPx / effectiveTexels;
            if (entry.showing === 'card') {
                if (pxPerTexel >= this.cfg.swapInRatio) {
                    this.setDisplayMode(carrel, 'live');
                } else {
                    const sg0 = showGeneration();
                    for (const e of carrel.entries?.values?.() || []) {
                        if (!e?.grid || e.grid.parent !== carrel || e._borrowed) continue;
                        if (e.grid.visible) {
                            if (!entry.savedVis.has(e.id)) entry.savedVis.set(e.id, true);
                            e.grid.visible = false;
                        }
                    }
                    this._ownShowGen += (showGeneration() - sg0);
                    this._syncFrameGrid(entry, rect, entry.tier === 'native');
                }
            } else if (pxPerTexel < this.cfg.swapOutRatio) {
                this._syncFrameGrid(entry, rect, entry.tier === 'native');
                this.setDisplayMode(carrel, 'card');
            }
        }
    }

    /**
     * Format one card entry for `card.list` / `carrel.card`.
     * @private
     */
    _describeEntry(entry, now = performance.now()) {
        const ageMs = entry.capturedAt > 0 ? Math.max(0, Math.round(now - entry.capturedAt)) : null;
        return {
            name: entry.name,
            mode: entry.carrel?.mode ?? null,
            showing: entry.showing,
            tier: entry.tier,
            width: entry.width,
            height: entry.height,
            bytes: entry.bytes,
            ageMs,
            stale: Boolean(entry.stale || (entry.dirty && !entry.nearLive)),
            dirty: Boolean(entry.dirty),
            nearLive: Boolean(entry.nearLive),
            captureMs: entry.captureMs,
            reason: entry.reason,
            hasTarget: Boolean(entry.target),
        };
    }

    /**
     * Return the card record for `name`, or null.
     * @param {string} name
     */
    get(name) {
        const clean = String(name ?? '').replace(/^carrel:/, '');
        return this.cards.get(clean) ?? null;
    }

    /**
     * Report all carrel cards and pool telemetry (`card.list`).
     * @param {number} [now=performance.now()]
     */
    list(now = performance.now()) {
        const cards = [...this.cards.values()].map((e) => this._describeEntry(e, now));
        return {
            cards,
            count: cards.length,
            totalBytes: this.totalBytes,
            maxBytes: this.cfg.maxBytes,
            budgetMs: this.cfg.budgetMs,
            liveCap: this.cfg.live,
        };
    }

    /** @private */
    _disposeEntry(entry) {
        if (!entry) return;
        const sg0 = showGeneration();
        this._releaseTarget(entry);
        if (entry.frame) {
            entry.frame.dispose?.();
            entry.frame = null;
        }
        entry.savedVis.clear();
        this._ownShowGen += (showGeneration() - sg0);
    }

    /** Dispose all targets, FrameGrids, and listeners. */
    dispose() {
        if (this._planeListener && this.ctx?.cameraController?.removePlaneListener) {
            this.ctx.cameraController.removePlaneListener(this._planeListener);
        }
        this._planeListener = null;
        this._planeListenerArmed = false;
        for (const entry of this.cards.values()) {
            this._disposeEntry(entry);
        }
        if (this._warmTarget) {
            this._warmTarget.dispose();
            this._warmTarget = null;
        }
        this.cards.clear();
        this.totalBytes = 0;
    }
}

export default CarrelCards;
