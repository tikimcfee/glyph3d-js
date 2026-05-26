/**
 * ReaderCompass — camera-attached HUD that shows where the other files
 * are relative to the current reader-mode grid.
 *
 * Model: one marker per nearby file. Each marker is a fixed-size card:
 *   ┌──────────────────────────┬───────────┐
 *   │  ↗  path/filename.ext    │  (icon)   │
 *   └──────────────────────────┴───────────┘
 *
 * The left side is the focused view — the filename (which is what the
 * user reads first). The right side is a square-ish *icon* that renders
 * the entire file scaled-to-fit. A short config ends up almost-readable
 * at its natural size; a 500-line source file compresses into a
 * silhouette where indentation, blank lines, and line-length patterns
 * become the visual fingerprint.
 *
 * Position: each marker projects the target's world position through the
 * camera, clamps to the viewport-edge rectangle along the outward ray,
 * and relaxes angularly so clustered neighbours fan out instead of
 * stacking.
 *
 * Clicks: markers are hit-testable via hitTest(clientX, clientY). Call
 * it from a canvas mousedown; it returns the matching registry entry
 * or null.
 */

import { RENDER_ORDER } from '../../core/renderOrder.js';

const MAX_MARKERS = 5;               // top-K by world distance
const HUD_DISTANCE = 5.0;            // camera-local -Z
const EDGE_INSET = 0.80;             // center fraction of NDC extents
const MIN_ANGULAR_GAP = 0.50;        // ~29° between markers
const REPULSION_PASSES = 5;

// Fixed-size card layout. Canvas pixels. The card is *stacked* — name
// on top, icon below — so the filename reads clean and the icon keeps
// its constrained footprint regardless of content.
const CANVAS_W       = 208;
const HEADER_H       = 34;
const ICON_W         = CANVAS_W - 16;               // icon fills the body, 8px margin each side
const ICON_H         = 120;
const CANVAS_H       = HEADER_H + ICON_H + 16;      // 8 top pad, 8 bot pad, 34 header, 120 icon
const ICON_X         = (CANVAS_W - ICON_W) / 2;
const ICON_Y         = HEADER_H + 8;
const NAME_X0        = 40;                          // right of the arrow badge
const NAME_X1        = CANVAS_W - 8;
const HEADER_FONT_PX = 17;
const ARROW_FONT_PX  = 22;

// Icon preview render tuning.
const ICON_MIN_FONT  = 0.6;          // sub-pixel renders as pattern
const ICON_MAX_FONT  = 11;           // readable cap for short files
const ICON_CHAR_W    = 0.60;         // monospace width/font ratio
const ICON_LINE_RATIO = 1.15;        // line height / font size
const ICON_MAX_LINES = 800;          // subsample above this to keep fillText cheap

// Plane size is fixed; marker shape no longer tells you the file size.
const PLANE_WORLD_W = 1.25;
const PLANE_WORLD_H = PLANE_WORLD_W * (CANVAS_H / CANVAS_W);

export class ReaderCompass {
    constructor({ THREE, camera }) {
        this.THREE = THREE;
        this.camera = camera;
        this.root = new THREE.Group();
        this.root.name = 'ReaderCompass';
        this.root.renderOrder = RENDER_ORDER.COMPASS_ROOT;
        this.root.visible = false;
        this.camera.add(this.root);

        this._raycaster = new THREE.Raycaster();
        this._mouseNdc  = new THREE.Vector2();

        /** @type {Array<{mesh, canvas, texture, ctx, entry: null|object}>} */
        this.pool = [];
        for (let i = 0; i < MAX_MARKERS; i++) {
            const m = this._buildMarker(i);
            this.pool.push(m);
            this.root.add(m.mesh);
        }

        this._lastParams = null;
    }

    /**
     * Recompute marker positions and contents.
     * @param {{ currentId: string|null, entries: Array<{id:string, grid:any, type:string, meta?:object}> }} params
     */
    update(params) {
        this._lastParams = params;
        const { currentId, entries = [] } = params;
        const camera = this.camera;

        const THREE = this.THREE;
        const scratchVec = new THREE.Vector3();
        const candidates = [];
        for (const entry of entries) {
            if (!entry || entry.id === currentId) continue;
            if (entry.type !== 'grid' && entry.type !== 'agent') continue;
            const center = this._worldCenter(entry.grid);
            if (!center) continue;
            scratchVec.copy(center).project(camera);
            const ndcX = scratchVec.x;
            const ndcY = scratchVec.y;
            const ndcZ = scratchVec.z;
            const onScreen = ndcZ <= 1 && ndcX >= -1 && ndcX <= 1 && ndcY >= -1 && ndcY <= 1;
            if (onScreen) continue;
            let dirX = ndcX, dirY = ndcY;
            if (ndcZ > 1 || (ndcX === 0 && ndcY === 0)) {
                const worldDir = center.clone().sub(camera.position);
                const localDir = worldDir.applyMatrix4(
                    new THREE.Matrix4().copy(camera.matrixWorldInverse),
                );
                dirX = localDir.x;
                dirY = localDir.y;
            }
            candidates.push({
                entry,
                dist: camera.position.distanceTo(center),
                angle: Math.atan2(dirY, dirX),
            });
        }

        candidates.sort((a, b) => a.dist - b.dist);
        const selected = candidates.slice(0, MAX_MARKERS);
        this._relaxAngles(selected);

        const fovRad = camera.fov * Math.PI / 180;
        const halfH  = Math.tan(fovRad / 2) * HUD_DISTANCE;
        const halfW  = halfH * camera.aspect;
        for (let i = 0; i < this.pool.length; i++) {
            const marker = this.pool[i];
            if (i >= selected.length) {
                marker.mesh.visible = false;
                marker.entry = null;
                continue;
            }
            const { entry, angle } = selected[i];
            this._paint(marker, entry, angle);
            const { nx, ny } = this._edgeClamp(angle, EDGE_INSET);
            marker.mesh.position.set(nx * halfW, ny * halfH, -HUD_DISTANCE);
            marker.mesh.visible = true;
            marker.entry = entry;
        }
    }

    /** Show/hide the whole HUD. */
    setVisible(on) {
        this.root.visible = !!on;
    }

    /** Re-run the last update (e.g. after window resize changed camera.aspect). */
    relayout() {
        if (this._lastParams) this.update(this._lastParams);
    }

    /**
     * Hit-test a client-space (CSS pixel) point against the visible
     * markers. Returns the registry entry for the marker under the
     * cursor, or null.
     */
    hitTest(clientX, clientY, viewportSize) {
        if (!this.root.visible) return null;
        const { width, height } = viewportSize;
        this._mouseNdc.x =  (clientX / width)  * 2 - 1;
        this._mouseNdc.y = -(clientY / height) * 2 + 1;
        this._raycaster.setFromCamera(this._mouseNdc, this.camera);
        const meshes = [];
        for (const m of this.pool) {
            if (m.mesh.visible && m.entry) meshes.push(m.mesh);
        }
        const hits = this._raycaster.intersectObjects(meshes, false);
        if (hits.length === 0) return null;
        const mesh = hits[0].object;
        const marker = this.pool.find(m => m.mesh === mesh);
        return marker ? marker.entry : null;
    }

    dispose() {
        for (const m of this.pool) {
            m.mesh.geometry.dispose();
            m.mesh.material.dispose();
            m.texture.dispose();
        }
        this.camera.remove(this.root);
        this.pool = [];
    }

    // ─── internals ──────────────────────────────────────────────

    _buildMarker(i) {
        const THREE = this.THREE;
        const canvas = document.createElement('canvas');
        canvas.width  = CANVAS_W;
        canvas.height = CANVAS_H;
        const ctx2d = canvas.getContext('2d');
        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = 4;
        const material = new THREE.MeshBasicMaterial({
            map: texture,
            transparent: true,
            depthTest: false,
            depthWrite: false,
        });
        const geometry = new THREE.PlaneGeometry(PLANE_WORLD_W, PLANE_WORLD_H);
        const mesh = new THREE.Mesh(geometry, material);
        mesh.visible = false;
        mesh.renderOrder = RENDER_ORDER.COMPASS_MARKER_BASE + i;
        mesh.name = `ReaderCompass:marker-${i}`;
        return { mesh, canvas, texture, ctx: ctx2d, entry: null };
    }

    _worldCenter(grid) {
        if (!grid) return null;
        if (grid.getBounds) {
            if (grid.updateWorldMatrix) grid.updateWorldMatrix(true, true);
            const box = grid.getBounds();
            if (!box || box.isEmpty?.()) return null;
            const THREE = this.THREE;
            const c = new THREE.Vector3();
            box.getCenter(c);
            return c;
        }
        const THREE = this.THREE;
        const p = new THREE.Vector3();
        grid.getWorldPosition?.(p);
        return p;
    }

    _relaxAngles(list) {
        if (list.length < 2) return;
        for (let pass = 0; pass < REPULSION_PASSES; pass++) {
            list.sort((a, b) => a.angle - b.angle);
            let moved = false;
            for (let i = 0; i < list.length; i++) {
                const cur  = list[i];
                const next = list[(i + 1) % list.length];
                let gap = next.angle - cur.angle;
                if (i === list.length - 1) gap += Math.PI * 2;
                if (gap < MIN_ANGULAR_GAP) {
                    const nudge = (MIN_ANGULAR_GAP - gap) / 2;
                    cur.angle  -= nudge;
                    next.angle += nudge;
                    moved = true;
                }
            }
            if (!moved) break;
        }
    }

    _edgeClamp(angle, inset) {
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const tx = Math.abs(cos) > 1e-6 ? inset / Math.abs(cos) : Infinity;
        const ty = Math.abs(sin) > 1e-6 ? inset / Math.abs(sin) : Infinity;
        const t  = Math.min(tx, ty);
        return { nx: t * cos, ny: t * sin };
    }

    _paint({ canvas, ctx, texture }, entry, angle) {
        const w = canvas.width, h = canvas.height;
        ctx.clearRect(0, 0, w, h);

        // Card background
        ctx.fillStyle   = 'rgba(8, 12, 20, 0.94)';
        ctx.fillRect(0, 0, w, h);
        ctx.strokeStyle = 'rgba(90, 180, 140, 0.6)';
        ctx.lineWidth   = 2;
        ctx.strokeRect(1, 1, w - 2, h - 2);

        // Header row: arrow (rotating) + filename, stacked above the icon.
        // Base glyph "→" points +X in canvas space; canvas Y grows
        // downward, so rotate by -angle to match world-CCW angles.
        const headerCy = HEADER_H / 2;
        ctx.fillStyle = 'rgba(120, 240, 168, 0.10)';
        ctx.fillRect(1, 1, w - 2, HEADER_H);
        ctx.strokeStyle = 'rgba(90, 180, 140, 0.35)';
        ctx.beginPath();
        ctx.moveTo(1, HEADER_H);
        ctx.lineTo(w - 1, HEADER_H);
        ctx.stroke();

        ctx.save();
        ctx.translate(20, headerCy);
        ctx.rotate(-angle);
        ctx.fillStyle    = '#78f0a8';
        ctx.font         = `bold ${ARROW_FONT_PX}px "JetBrains Mono", monospace`;
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('\u2192', 0, 0);
        ctx.restore();

        // Filename — the focused view item for this card.
        ctx.fillStyle    = '#e8efe0';
        ctx.textAlign    = 'left';
        ctx.textBaseline = 'middle';
        ctx.font         = `600 ${HEADER_FONT_PX}px "JetBrains Mono", monospace`;
        const nameText = this._fitTextTailPriority(ctx,
            this._labelFor(entry), NAME_X1 - NAME_X0);
        ctx.fillText(nameText, NAME_X0, headerCy);

        // Icon body: fixed-dimension rectangle below the header, full file
        // rendered fit-to-scale so short files read as text and huge files
        // compress into silhouette patterns.
        ctx.fillStyle   = 'rgba(30, 44, 60, 0.65)';
        ctx.fillRect(ICON_X, ICON_Y, ICON_W, ICON_H);
        ctx.strokeStyle = 'rgba(90, 180, 140, 0.35)';
        ctx.lineWidth   = 1;
        ctx.strokeRect(ICON_X + 0.5, ICON_Y + 0.5, ICON_W - 1, ICON_H - 1);
        this._paintIcon(ctx, entry);

        texture.needsUpdate = true;
    }

    /**
     * Ellipsize a path-like string by preserving the *tail* (filename)
     * instead of the head. Falls back to leading-head ellipsis for names
     * without a separator so short strings still degrade gracefully.
     */
    _fitTextTailPriority(ctx, text, maxWidth) {
        text = String(text);
        if (ctx.measureText(text).width <= maxWidth) return text;
        const ell = '\u2026';
        // Try trimming from the front until it fits; the tail is the file.
        let lo = 0, hi = text.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (ctx.measureText(ell + text.slice(mid)).width <= maxWidth) hi = mid;
            else lo = mid + 1;
        }
        return ell + text.slice(lo);
    }

    /**
     * Render the full file into the icon region with an auto-fit font
     * size. The font picks whichever constraint (width or height) is
     * tighter; sub-pixel fonts are allowed, which gives huge files their
     * pattern/silhouette look.
     */
    _paintIcon(ctx, entry) {
        const raw = this._linesFor(entry);
        if (raw.length === 0) return;

        // Subsample very large files so fillText isn't called thousands of
        // times per frame. The icon can't resolve more lines than its
        // pixel height anyway, so striding by (raw.length / ICON_MAX_LINES)
        // preserves the overall shape.
        const lines = raw.length > ICON_MAX_LINES
            ? this._subsample(raw, ICON_MAX_LINES)
            : raw;

        // Longest line drives horizontal fit. Cap to a sensible upper bound
        // so a single 10k-char line doesn't squash the whole icon to zero.
        let maxChars = 1;
        for (const line of lines) {
            if (line.length > maxChars) maxChars = line.length;
            if (maxChars > 400) break;
        }
        maxChars = Math.min(maxChars, 400);

        const innerW = ICON_W - 8;
        const innerH = ICON_H - 8;
        const fsW = innerW / (maxChars * ICON_CHAR_W);
        const fsH = innerH / (lines.length * ICON_LINE_RATIO);
        let fs   = Math.min(fsW, fsH, ICON_MAX_FONT);
        if (fs < ICON_MIN_FONT) fs = ICON_MIN_FONT;

        ctx.fillStyle    = '#8fd9a8';
        ctx.textBaseline = 'top';
        ctx.textAlign    = 'left';
        ctx.font         = `400 ${fs.toFixed(2)}px "JetBrains Mono", monospace`;

        const x0 = ICON_X + 4;
        const y0 = ICON_Y + 4;
        const lineH = fs * ICON_LINE_RATIO;
        for (let i = 0; i < lines.length; i++) {
            ctx.fillText(lines[i], x0, y0 + i * lineH);
        }
    }

    _subsample(arr, n) {
        const step = arr.length / n;
        const out  = new Array(n);
        for (let i = 0; i < n; i++) out[i] = arr[Math.floor(i * step)];
        return out;
    }

    _labelFor(entry) {
        const meta = entry.meta || {};
        const grid = entry.grid || {};
        const name = grid.getFilename?.() || grid.title || meta.filename || meta.title || entry.id || '?';
        const id = entry.id || '';
        if (id.includes('/') && name && !name.includes('/')) {
            const parts = id.split('/');
            const parent = parts[parts.length - 2];
            if (parent) return `${parent}/${name}`;
        }
        return name;
    }

    _linesFor(entry) {
        const grid = entry.grid;
        if (!grid) return [];
        const src = grid.lines || grid._lines || [];
        const out = [];
        for (let i = 0; i < src.length; i++) {
            out.push(String(src[i] ?? '').replace(/\t/g, '    ').replace(/\r/g, ''));
        }
        return out;
    }

    _fitText(ctx, text, maxWidth) {
        text = String(text);
        if (ctx.measureText(text).width <= maxWidth) return text;
        const ell = '\u2026';
        let lo = 0, hi = text.length;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (ctx.measureText(text.slice(0, mid) + ell).width <= maxWidth) lo = mid;
            else hi = mid - 1;
        }
        return text.slice(0, lo) + ell;
    }
}

export default ReaderCompass;
