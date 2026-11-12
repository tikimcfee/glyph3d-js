/**
 * TextureUploads — the glyph atlas's texture bytes, moved at the renderer seam: only what changed,
 * as rectangles, and never the old contents of a texture that grew.
 *
 * The atlas textures (the Slug curve and glyph-map arrays, the emoji cell grid) are DataTextures
 * over CPU arrays that only ever gain content. Three's own path for a DataTexture is the whole
 * array, or its `updateRanges` — each of which its WebGL backend sends as a ONE-ROW
 * texSubImage2D (a 406-emoji landing was 648 calls). And a texture that grows is a new texture,
 * which three would fill whole from the CPU (35.8 MB for the emoji grid's 24 → 36 rows). Here:
 *
 *   adopt(t)          a texture born fresh: three uploads it whole on its first draw (the live
 *                     array as it is then); from that upload on it is LIVE and takes rects.
 *   rect(t, x,y,w,h)  queue a written rectangle of a live texture (one GL call; adjacent rects of
 *                     the same texture merge). On a texture three hasn't uploaded yet it is a
 *                     no-op — the first upload reads the array, rect included.
 *   grow(prev, next)  `next` replaces `prev` (same width, prev's array as its prefix). When prev
 *                     is live, next is born with its storage allocated but NOT filled
 *                     (`source.dataReady = false`, which both of three's backends honour) and
 *                     prev's rows are copied into it GPU-side — no byte crosses the bus — before
 *                     anything else queued for it; then prev is disposed. When prev never reached
 *                     the GPU, next is simply born fresh (adopt) and prev disposed now.
 *   flush(renderer)   run the queue in order: copies through `renderer.copyTextureToTexture`
 *                     (a framebuffer copy, copyTexSubImage2D), rects through the same call with a
 *                     CPU view of the array as its source (texSubImage2D with row length / skips).
 *
 * The flush runs at the renderer seam — SceneSystems calls it before every top-level render, so
 * what landed since the last frame is on the GPU in the frame that draws it. A grown texture
 * drawn before its copy ran means nothing flushes this queue: that is reported loudly (it draws
 * blank where its old rows should be) — never papered over with a whole upload.
 *
 * WebGPU: three's WebGPU backend ignores DataTexture update ranges and uploads whole; this seam
 * goes through copyTextureToTexture there too, but only the WebGL2 path is measured.
 */

import * as THREE from 'three';

const _box = new THREE.Box2();
const _pos = new THREE.Vector2();

/** Bytes per texel of a DataTexture (RGBA of its component type). @param {THREE.DataTexture} t */
function texelBytes(t) {
    const BPE = t.image.data.BYTES_PER_ELEMENT;
    return 4 * BPE;
}

export default class TextureUploads {
    constructor() {
        /** @private ops in order: {kind:'copy', from, to, rows} | {kind:'rect', tex, x, y, w, h} */
        this._ops = [];
        /** @private texture → 'fresh' (three's first upload pending) | 'live' (queue-fed) */
        this._state = new WeakMap();
        /** @private grown textures whose copy hasn't run */
        this._awaitingCopy = new WeakSet();
        /** @private texture → a never-uploaded DataTexture over its array (copyTextureToTexture's CPU source) */
        this._cpuViews = new WeakMap();
        /** @private */ this._flushing = false;
        /** Accounting: bytes queued as rects and the calls they take; GPU copies and the VRAM bytes they moved. */
        this.stats = { rects: 0, rectBytes: 0, copies: 0, copyBytes: 0, grows: 0, flushes: 0 };
    }

    /** @returns {number} ops waiting for the next flush */
    get pending() { return this._ops.length; }

    /** @param {THREE.DataTexture} t @returns {boolean} whether rects queue for it (it is on the GPU, or will be by its copy) */
    isLive(t) { return this._state.get(t) === 'live'; }

    /**
     * A texture born fresh: three uploads it whole on its first draw, then it is live.
     * @param {THREE.DataTexture} t
     * @returns {THREE.DataTexture} t
     */
    adopt(t) {
        this._state.set(t, 'fresh');
        t.onUpdate = () => this._uploaded(t);
        t.needsUpdate = true;
        return t;
    }

    /**
     * `next` replaces `prev`: the same width, prev's array its prefix. Copies prev's rows GPU-side
     * when prev is live; otherwise next starts fresh. Disposes prev (after its copy, if any).
     * @param {THREE.DataTexture} prev
     * @param {THREE.DataTexture} next
     * @returns {THREE.DataTexture} next
     */
    grow(prev, next) {
        if (next.image.width !== prev.image.width || next.image.height < prev.image.height) {
            throw new Error(`[TextureUploads] grow keeps the width and adds rows: ${prev.image.width}×${prev.image.height} → ${next.image.width}×${next.image.height}`);
        }
        if (!this.isLive(prev)) {
            this.forget(prev);
            prev.dispose();
            return this.adopt(next);
        }
        this._state.set(next, 'live');
        this._awaitingCopy.add(next);
        next.source.dataReady = false;   // three allocates it on first bind and sends no bytes
        next.onUpdate = () => this._uploaded(next);
        next.needsUpdate = true;
        this._ops.push({ kind: 'copy', from: prev, to: next, rows: prev.image.height });
        this.stats.grows++;
        return next;
    }

    /**
     * Queue a written rectangle of `t` (texels). A no-op until three's first upload of `t`.
     * @param {THREE.DataTexture} t @param {number} x @param {number} y @param {number} w @param {number} h
     * @returns {number} bytes queued
     */
    rect(t, x, y, w, h) {
        const state = this._state.get(t);
        if (state === undefined) throw new Error('[TextureUploads] rect on a texture this queue does not feed (adopt or grow it first)');
        if (state !== 'live' || w <= 0 || h <= 0) return 0;
        const { width, height } = t.image;
        if (x < 0 || y < 0 || x + w > width || y + h > height) {
            throw new Error(`[TextureUploads] rect ${x},${y} ${w}×${h} outside its ${width}×${height} texture`);
        }
        const last = this._ops[this._ops.length - 1];
        if (last?.kind === 'rect' && last.tex === t) {
            if (last.x === x && last.w === w && last.y + last.h === y) { last.h += h; return this._count(t, w, h, false); }   // rows below
            if (last.y === y && last.h === h && last.x + last.w === x) { last.w += w; return this._count(t, w, h, false); }   // cells to the right
        }
        this._ops.push({ kind: 'rect', tex: t, x, y, w, h });
        return this._count(t, w, h, true);
    }

    /**
     * Queue the texel span [lo, hi) of a row-major texture: at most three rects (the first row's
     * tail, the whole rows between, the last row's head).
     * @param {THREE.DataTexture} t @param {number} lo @param {number} hi
     * @returns {number} bytes queued
     */
    span(t, lo, hi) {
        if (hi <= lo) return 0;
        const w = t.image.width;
        const r0 = Math.floor(lo / w), r1 = Math.floor((hi - 1) / w);
        if (r0 === r1) return this.rect(t, lo - r0 * w, r0, hi - lo, 1);
        let bytes = this.rect(t, lo - r0 * w, r0, w - (lo - r0 * w), 1);
        if (r1 > r0 + 1) bytes += this.rect(t, 0, r0 + 1, w, r1 - r0 - 1);
        return bytes + this.rect(t, 0, r1, hi - r1 * w, 1);
    }

    /**
     * Drop what is queued for `t` (it is being disposed); a copy into it disposes its source.
     * @param {THREE.DataTexture} t
     */
    forget(t) {
        this._ops = this._ops.filter((op) => {
            if (op.kind === 'rect') return op.tex !== t;
            if (op.to !== t) return true;
            op.from.dispose();
            return false;
        });
        this._cpuViews.delete(t);
    }

    /**
     * Run the queue: GPU copies of grown textures, then (in order) the rects. Called before a
     * top-level render, outside any pass. Restores the render target a copy unbinds.
     * @param {THREE.WebGLRenderer} renderer
     */
    flush(renderer) {
        if (this._ops.length === 0) return;
        const ops = this._ops;
        this._ops = [];
        const target = renderer.getRenderTarget();
        const face = renderer.getActiveCubeFace(), mip = renderer.getActiveMipmapLevel();
        let copied = false;
        this._flushing = true;
        try {
            for (const op of ops) {
                if (op.kind === 'copy') {
                    const w = op.from.image.width;
                    _box.min.set(0, 0);
                    _box.max.set(w, op.rows);
                    renderer.copyTextureToTexture(op.from, op.to, _box, _pos.set(0, 0));
                    this._awaitingCopy.delete(op.to);
                    op.to.source.dataReady = true;   // an ordinary texture from here on
                    op.from.dispose();
                    this._cpuViews.delete(op.from);
                    this.stats.copies++;
                    this.stats.copyBytes += w * op.rows * texelBytes(op.from);
                    copied = true;
                } else {
                    _box.min.set(op.x, op.y);
                    _box.max.set(op.x + op.w, op.y + op.h);
                    renderer.copyTextureToTexture(this._cpuView(op.tex), op.tex, _box, _pos.set(op.x, op.y));
                }
            }
        } finally {
            this._flushing = false;
        }
        // The framebuffer copy leaves no framebuffer bound; put back the one the caller set.
        if (copied) renderer.setRenderTarget(target, face, mip);
        this.stats.flushes++;
    }

    /** @private three's upload of `t` landed (its first whole upload, or a grown texture's allocation) */
    _uploaded(t) {
        if (this._state.get(t) === 'fresh') this._state.set(t, 'live');
        if (this._awaitingCopy.has(t) && !this._flushing) {
            console.error(`[TextureUploads] a grown ${t.image.width}×${t.image.height} texture was drawn before its GPU copy ran — ` +
                'nothing flushes this queue at the renderer (SceneSystems does); its old rows draw blank until a flush');
        }
    }

    /** @private count a queued rect */
    _count(t, w, h, call) {
        const bytes = w * h * texelBytes(t);
        this.stats.rectBytes += bytes;
        if (call) this.stats.rects++;
        return bytes;
    }

    /** @private a never-uploaded DataTexture over `t`'s array: copyTextureToTexture's CPU source */
    _cpuView(t) {
        let v = this._cpuViews.get(t);
        if (!v || v.image.data !== t.image.data) {
            v = new THREE.DataTexture(t.image.data, t.image.width, t.image.height, t.format, t.type);
            this._cpuViews.set(t, v);
        }
        return v;
    }
}
