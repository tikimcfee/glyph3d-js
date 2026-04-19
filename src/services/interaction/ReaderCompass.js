/**
 * ReaderCompass — camera-attached HUD that shows the four cardinal jump
 * targets (up / down / left / right) from the current reader-mode grid.
 *
 * Four small CanvasTexture planes live as children of the camera, so they
 * stay pinned to the viewport edges regardless of camera position. Each
 * plane renders an arrow glyph + destination label + key hint. Indicators
 * for directions with no adjacent grid are hidden.
 *
 * Lifecycle:
 *   const compass = new ReaderCompass({ THREE, camera });
 *   compass.update({ up, down, left, right });  // resolved entries or null
 *   compass.setVisible(true);                   // reader on
 *   compass.setVisible(false);                  // explorer
 *   compass.dispose();
 */

const DIRECTIONS = ['up', 'down', 'left', 'right'];
const ARROW = { up: '\u2191', down: '\u2193', left: '\u2190', right: '\u2192' };
const KEY_HINT = { up: '↑', down: '↓', left: '←', right: '→' };

// Layout anchors in viewport fraction space (origin at screen center,
// +x right, +y up). Each indicator nudges toward its edge.
const ANCHOR = {
    up:    { fx: 0,     fy:  0.78 },
    down:  { fx: 0,     fy: -0.78 },
    left:  { fx: -0.82, fy:  0    },
    right: { fx:  0.82, fy:  0    },
};

const PLANE_WORLD_SIZE = 1.1;    // world units at HUD distance
const HUD_DISTANCE = 5.0;        // camera-local -Z
const CANVAS_W = 256;
const CANVAS_H = 128;

export class ReaderCompass {
    constructor({ THREE, camera }) {
        this.THREE = THREE;
        this.camera = camera;
        this.root = new THREE.Group();
        this.root.name = 'ReaderCompass';
        this.root.visible = false;
        // renderOrder high so it draws on top of scene content
        this.root.renderOrder = 999;
        this.camera.add(this.root);

        /** @type {Record<string, {mesh: THREE.Mesh, canvas: HTMLCanvasElement, texture: THREE.CanvasTexture, ctx: CanvasRenderingContext2D}>} */
        this.indicators = {};
        for (const dir of DIRECTIONS) {
            this.indicators[dir] = this._buildIndicator(dir);
            this.root.add(this.indicators[dir].mesh);
        }

        this._lastAspect = camera.aspect;
        this._lastFov = camera.fov;
        this._layout();
    }

    /** Update which entry each direction points to (null = hide that arrow). */
    update(adjacencies = {}) {
        for (const dir of DIRECTIONS) {
            const entry = adjacencies[dir] || null;
            const ind = this.indicators[dir];
            if (!entry) {
                ind.mesh.visible = false;
                continue;
            }
            ind.mesh.visible = true;
            this._paint(ind, dir, entry);
        }
    }

    /** Show/hide the whole HUD. */
    setVisible(on) {
        this.root.visible = !!on;
    }

    /** Call when camera FOV/aspect changes so HUD re-anchors to the new viewport. */
    relayout() {
        if (this.camera.aspect === this._lastAspect &&
            this.camera.fov    === this._lastFov) {
            return;
        }
        this._lastAspect = this.camera.aspect;
        this._lastFov    = this.camera.fov;
        this._layout();
    }

    dispose() {
        for (const dir of DIRECTIONS) {
            const ind = this.indicators[dir];
            ind.mesh.geometry.dispose();
            ind.mesh.material.dispose();
            ind.texture.dispose();
        }
        this.camera.remove(this.root);
        this.indicators = {};
    }

    // ─── internals ──────────────────────────────────────────────

    _buildIndicator(dir) {
        const THREE = this.THREE;
        const canvas = document.createElement('canvas');
        canvas.width = CANVAS_W;
        canvas.height = CANVAS_H;
        const ctx2d = canvas.getContext('2d');
        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = 4;
        const mat = new THREE.MeshBasicMaterial({
            map: texture,
            transparent: true,
            depthTest: false,
            depthWrite: false,
        });
        const geom = new THREE.PlaneGeometry(
            PLANE_WORLD_SIZE,
            PLANE_WORLD_SIZE * (CANVAS_H / CANVAS_W),
        );
        const mesh = new THREE.Mesh(geom, mat);
        mesh.visible = false;
        mesh.renderOrder = 1000;
        mesh.name = `ReaderCompass:${dir}`;
        return { mesh, canvas, texture, ctx: ctx2d };
    }

    _layout() {
        // Compute world-space viewport half-extents at HUD_DISTANCE, then
        // place each indicator at the anchor fractions of those extents.
        const fovRad = this.camera.fov * Math.PI / 180;
        const halfH = Math.tan(fovRad / 2) * HUD_DISTANCE;
        const halfW = halfH * this.camera.aspect;
        for (const dir of DIRECTIONS) {
            const a = ANCHOR[dir];
            this.indicators[dir].mesh.position.set(
                a.fx * halfW,
                a.fy * halfH,
                -HUD_DISTANCE,
            );
        }
    }

    _paint({ canvas, ctx, texture }, dir, entry) {
        const w = canvas.width, h = canvas.height;
        ctx.clearRect(0, 0, w, h);

        // Semi-transparent panel
        ctx.fillStyle = 'rgba(8, 12, 20, 0.78)';
        ctx.fillRect(0, 0, w, h);
        ctx.strokeStyle = 'rgba(90, 180, 140, 0.55)';
        ctx.lineWidth = 2;
        ctx.strokeRect(1, 1, w - 2, h - 2);

        // Big arrow on the left
        ctx.fillStyle = '#78f0a8';
        ctx.font = 'bold 78px "JetBrains Mono", monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(ARROW[dir], 44, h / 2);

        // Destination label on the right (up to 2 lines)
        const label = this._labelFor(entry);
        ctx.fillStyle = '#d8e4f0';
        ctx.textAlign = 'left';
        ctx.font = '500 22px "JetBrains Mono", monospace';
        const lines = this._wrap(ctx, label, w - 100);
        const startY = h / 2 - ((lines.length - 1) * 26) / 2;
        lines.forEach((ln, i) => {
            ctx.fillText(ln, 92, startY + i * 26);
        });

        // Key hint (small, top-right corner)
        ctx.fillStyle = 'rgba(216,228,240,0.65)';
        ctx.font = '500 16px "JetBrains Mono", monospace';
        ctx.textAlign = 'right';
        ctx.fillText(KEY_HINT[dir], w - 10, 22);

        texture.needsUpdate = true;
    }

    _labelFor(entry) {
        const meta = entry.meta || {};
        return meta.title || meta.filename || entry.id || '?';
    }

    _wrap(ctx, text, maxWidth) {
        // Cheap word-wrap — good enough for short titles.
        const words = String(text).split(/\s+/);
        const lines = [];
        let line = '';
        for (const word of words) {
            const test = line ? line + ' ' + word : word;
            if (ctx.measureText(test).width > maxWidth && line) {
                lines.push(line);
                line = word;
            } else {
                line = test;
            }
            if (lines.length >= 1) break; // cap at 2 lines total
        }
        if (line) lines.push(line);
        return lines.slice(0, 2);
    }
}

export default ReaderCompass;
