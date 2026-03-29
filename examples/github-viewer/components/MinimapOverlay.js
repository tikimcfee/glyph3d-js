/**
 * MinimapOverlay — 2D canvas overview in bottom-left corner
 *
 * Renders a schematic top-down view of the current layout:
 * - Colored rectangles for each file (hue based on file index)
 * - A semi-transparent white rectangle showing the camera viewport footprint
 *
 * Click or drag on the minimap to jump the camera to that world position.
 * Toggle visibility with the M key (wired by ShortcutManager in GitHubRepoViewer).
 *
 * GPU cost: zero. The canvas is 2D only. The viewport rectangle is recomputed
 * each frame from camera position + FOV + aspect ratio.
 *
 * Coordinate mapping:
 *   minimapPixel → worldXY via the inverse of the worldBounds → minimapRect mapping.
 *   The minimap always uses a uniform scale (same pixels-per-world-unit on X and Y)
 *   to preserve spatial relationships.
 */

const DEFAULT_WIDTH  = 180;
const DEFAULT_HEIGHT = 120;
const ASPECT_RATIO   = DEFAULT_WIDTH / DEFAULT_HEIGHT;  // 1.5
const PADDING        = 8;  // inner padding inside the canvas

export class MinimapOverlay {
    /**
     * @param {Object} opts
     * @param {THREE} opts.THREE         - Three.js module reference
     * @param {THREE.Camera} opts.camera - Main perspective camera
     * @param {Function} opts.getGrids   - Returns current CodeGrid array
     * @param {Function} opts.getLayoutBounds - Returns THREE.Box3 of total layout
     * @param {Function} opts.onNavigate - Called with world {x, y} when user clicks minimap
     */
    constructor({ THREE, camera, getGrids, getLayoutBounds, onNavigate }) {
        this._THREE = THREE;
        this._camera = camera;
        this._getGrids = getGrids;
        this._getLayoutBounds = getLayoutBounds;
        this._onNavigate = onNavigate;

        this._visible = true;
        this._isDragging = false;

        // Layout data: built once per layout change, used each frame
        this._gridRects = [];    // [{ x, y, w, h, color }] in world space
        this._worldBounds = null; // THREE.Box3 of total layout

        // Canvas dimensions (updated dynamically on mobile via resize)
        this._width = DEFAULT_WIDTH;
        this._height = DEFAULT_HEIGHT;

        this._buildCanvas();
        this._wireEvents();
        this._wireResize();
    }

    // ============ Public API ============

    /**
     * Show or hide the minimap.
     * @param {boolean} visible
     */
    setVisible(visible) {
        this._visible = visible;
        this._container.style.display = visible ? 'block' : 'none';
    }

    /**
     * Toggle visibility.
     * @returns {boolean} New visibility state
     */
    toggle() {
        this.setVisible(!this._visible);
        return this._visible;
    }

    /**
     * Recompute grid rectangles from current layout. Call after layout changes.
     */
    rebuildLayout() {
        this._gridRects = [];
        this._worldBounds = null;

        const bounds = this._getLayoutBounds();
        if (!bounds || bounds.isEmpty()) return;

        this._worldBounds = bounds;

        const grids = this._getGrids();
        for (let i = 0; i < grids.length; i++) {
            const grid = grids[i];
            const gb = grid.getBounds();
            if (gb.isEmpty()) continue;

            // Color by file index — a simple hue rotation keeps files visually distinct
            const hue = (i / grids.length) * 360;
            this._gridRects.push({
                x:  gb.min.x,
                y:  gb.min.y,
                w:  gb.max.x - gb.min.x,
                h:  gb.max.y - gb.min.y,
                color: `hsl(${hue.toFixed(0)},70%,50%)`
            });
        }
    }

    /**
     * Draw one frame. Call from the main animation loop.
     * Rebuilds grid rects from live positions every frame — simple, always correct.
     */
    update() {
        if (!this._visible) return;

        // Rebuild from live grid positions every frame (cheap — just reading positions)
        const grids = this._getGrids();
        if (!grids || grids.length === 0) return;

        this._gridRects = [];
        const worldMin = { x: Infinity, y: Infinity };
        const worldMax = { x: -Infinity, y: -Infinity };

        for (let i = 0; i < grids.length; i++) {
            const grid = grids[i];
            if (!grid.visible) continue;
            const pos = grid.position;
            const gb = grid.getBounds();
            if (gb.isEmpty()) continue;

            const x = gb.min.x;
            const y = gb.min.y;
            const w = gb.max.x - gb.min.x;
            const h = gb.max.y - gb.min.y;

            worldMin.x = Math.min(worldMin.x, x);
            worldMin.y = Math.min(worldMin.y, y);
            worldMax.x = Math.max(worldMax.x, x + w);
            worldMax.y = Math.max(worldMax.y, y + h);

            const hue = (i / grids.length) * 360;
            this._gridRects.push({ x, y, w, h, color: `hsl(${hue.toFixed(0)},70%,50%)` });
        }

        if (this._gridRects.length === 0) return;

        // Update world bounds from live data
        this._worldBounds = new this._THREE.Box3(
            new this._THREE.Vector3(worldMin.x, worldMin.y, 0),
            new this._THREE.Vector3(worldMax.x, worldMax.y, 0)
        );

        const ctx = this._ctx;
        const cw = this._width;
        const ch = this._height;

        ctx.clearRect(0, 0, cw, ch);

        // Dark background
        ctx.fillStyle = 'rgba(10,10,20,0.88)';
        ctx.fillRect(0, 0, cw, ch);

        // Compute world → minimap transform
        const { scaleX, scaleY, offsetX, offsetY } = this._computeTransform();

        // Draw file rectangles
        for (const rect of this._gridRects) {
            const px = offsetX + rect.x * scaleX;
            const py = offsetY - rect.y * scaleY;
            const pw = Math.max(rect.w * scaleX, 1);
            const ph = Math.max(rect.h * scaleY, 1);

            ctx.fillStyle = rect.color;
            ctx.globalAlpha = 0.7;
            ctx.fillRect(px, py - ph, pw, ph);
        }

        ctx.globalAlpha = 1.0;

        // Draw viewport rectangle
        this._drawViewport(ctx, scaleX, scaleY, offsetX, offsetY);

        // Border
        ctx.strokeStyle = 'rgba(0,255,136,0.4)';
        ctx.lineWidth = 1;
        ctx.strokeRect(0.5, 0.5, cw - 1, ch - 1);
    }

    /**
     * Dispose DOM elements and listeners.
     */
    dispose() {
        this._canvas.removeEventListener('mousedown', this._onMouseDown);
        this._canvas.removeEventListener('mousemove', this._onMouseMove);
        this._canvas.removeEventListener('mouseup',   this._onMouseUp);
        this._canvas.removeEventListener('mouseleave',this._onMouseLeave);
        if (this._resizeObserver) {
            this._resizeObserver.disconnect();
        }
        if (this._container.parentNode) {
            this._container.parentNode.removeChild(this._container);
        }
    }

    // ============ Private ============

    /** @private */
    _buildCanvas() {
        // Reuse existing DOM elements if present (e.g., IDE shell pre-creates them)
        this._container = document.getElementById('minimap-container');
        if (!this._container) {
            this._container = document.createElement('div');
            this._container.id = 'minimap-container';
            document.body.appendChild(this._container);
        }

        this._canvas = document.getElementById('minimap-canvas');
        if (!this._canvas) {
            this._canvas = document.createElement('canvas');
            this._canvas.id = 'minimap-canvas';
            this._container.appendChild(this._canvas);
        }
        this._canvas.width  = this._width;
        this._canvas.height = this._height;

        this._ctx = this._canvas.getContext('2d');
    }

    /** @private Observe container size changes to resize canvas on mobile */
    _wireResize() {
        this._resizeObserver = new ResizeObserver(() => {
            const cw = this._container.clientWidth;
            if (cw <= 0 || cw === this._width) return;
            this._width = cw;
            this._height = Math.round(cw / ASPECT_RATIO);
            this._canvas.width = this._width;
            this._canvas.height = this._height;
        });
        this._resizeObserver.observe(this._container);
    }

    /** @private */
    _wireEvents() {
        this._onMouseDown = (e) => {
            e.stopPropagation();
            this._isDragging = true;
            this._handleMinimapClick(e);
        };
        this._onMouseMove = (e) => {
            if (!this._isDragging) return;
            e.stopPropagation();
            this._handleMinimapClick(e);
        };
        this._onMouseUp = (e) => {
            e.stopPropagation();
            this._isDragging = false;
        };
        this._onMouseLeave = () => { this._isDragging = false; };

        this._canvas.addEventListener('mousedown',  this._onMouseDown);
        this._canvas.addEventListener('mousemove',  this._onMouseMove);
        this._canvas.addEventListener('mouseup',    this._onMouseUp);
        this._canvas.addEventListener('mouseleave', this._onMouseLeave);
    }

    /**
     * Convert a minimap click to world XY and fire onNavigate.
     * @private
     */
    _handleMinimapClick(e) {
        if (!this._worldBounds) return;

        const rect  = this._canvas.getBoundingClientRect();
        const px    = e.clientX - rect.left;
        const py    = e.clientY - rect.top;

        const { scaleX, scaleY, offsetX, offsetY } = this._computeTransform();

        // Invert the transform: minimap pixel → world coordinate
        const worldX = (px - offsetX) / scaleX;
        const worldY = -(py - offsetY) / scaleY;  // Y is inverted

        if (this._onNavigate) {
            this._onNavigate({ x: worldX, y: worldY });
        }
    }

    /**
     * Compute the uniform scale and offset that maps world bounds to minimap canvas.
     * @private
     * @returns {{ scaleX, scaleY, offsetX, offsetY }}
     */
    _computeTransform() {
        const b   = this._worldBounds;
        const ww  = b.max.x - b.min.x;
        const wh  = b.max.y - b.min.y;

        const availW = this._width  - 2 * PADDING;
        const availH = this._height - 2 * PADDING;

        // Uniform scale: fit the taller/wider dimension
        const scale  = Math.min(availW / Math.max(ww, 1), availH / Math.max(wh, 1));
        const scaleX = scale;
        const scaleY = scale;

        // Center within canvas
        const offsetX = PADDING + (availW - ww * scaleX) / 2 - b.min.x * scaleX;
        const offsetY = this._height - PADDING - (availH - wh * scaleY) / 2 + b.min.y * scaleY;

        return { scaleX, scaleY, offsetX, offsetY };
    }

    /**
     * Draw the camera viewport rectangle on the minimap.
     * @private
     */
    _drawViewport(ctx, scaleX, scaleY, offsetX, offsetY) {
        const cam = this._camera;

        // Compute the half-extents of the camera frustum projected onto Z=0
        const cz = cam.position.z;
        if (cz <= 0) return;

        const fovRad   = cam.fov * Math.PI / 180;
        const halfH    = Math.tan(fovRad / 2) * cz;
        const halfW    = halfH * cam.aspect;

        // Camera center in world XY
        const cx = cam.position.x;
        const cy = cam.position.y;

        // World rect
        const wx  = cx - halfW;
        const wy  = cy - halfH;
        const ww  = halfW * 2;
        const wh  = halfH * 2;

        // Map to minimap pixels (Y inverted)
        const px  = offsetX + wx * scaleX;
        const py  = offsetY - (wy + wh) * scaleY;
        const pw  = ww * scaleX;
        const ph  = wh * scaleY;

        ctx.strokeStyle = 'rgba(255,255,255,0.7)';
        ctx.fillStyle   = 'rgba(255,255,255,0.08)';
        ctx.lineWidth   = 1.5;
        ctx.fillRect(px, py, pw, ph);
        ctx.strokeRect(px, py, pw, ph);
    }
}

export default MinimapOverlay;
