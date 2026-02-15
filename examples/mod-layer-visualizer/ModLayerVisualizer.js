import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ---------------------------------------------------------------------------
// Grid sizing
// ---------------------------------------------------------------------------

/**
 * Compute near-square grid dimensions for a given element count.
 * Minimizes wasted cells while keeping the grid roughly square.
 * @param {number} count
 * @returns {{ cols: number, rows: number }}
 */
function computeGridSize(count) {
    const rows = Math.ceil(Math.sqrt(count));
    const cols = Math.ceil(count / rows);
    return { cols, rows };
}

// ---------------------------------------------------------------------------
// Color utilities
// ---------------------------------------------------------------------------

/**
 * Convert HSL values to a CSS rgb() string.
 * @param {number} h - Hue in [0, 360]
 * @param {number} s - Saturation in [0, 100]
 * @param {number} l - Lightness in [0, 100]
 * @returns {string}
 */
function hslToRgb(h, s, l) {
    h /= 360;
    s /= 100;
    l /= 100;
    let r, g, b;
    if (s === 0) {
        r = g = b = l;
    } else {
        const hue2rgb = (p, q, t) => {
            if (t < 0) t += 1;
            if (t > 1) t -= 1;
            if (t < 1 / 6) return p + (q - p) * 6 * t;
            if (t < 1 / 2) return q;
            if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
            return p;
        };
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        const p = 2 * l - q;
        r = hue2rgb(p, q, h + 1 / 3);
        g = hue2rgb(p, q, h);
        b = hue2rgb(p, q, h - 1 / 3);
    }
    return `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
}

/** Available color schemes mapping mod-remainder values to CSS colors. */
const COLOR_SCHEMES = {
    rainbow:   (v, m) => hslToRgb((v / m) * 360, 80, 48),
    warm:      (v, m) => hslToRgb((v / m) * 60, 85, 45),
    cool:      (v, m) => hslToRgb(200 + (v / m) * 80, 75, 45),
    neon:      (v, m) => hslToRgb((v / m) * 300 + 20, 100, 50),
    grayscale: (v, m) => {
        const c = Math.round((v / Math.max(m - 1, 1)) * 220 + 20);
        return `rgb(${c},${c},${c})`;
    },
};

/** Names of all available color schemes. */
export const AVAILABLE_COLOR_SCHEMES = Object.keys(COLOR_SCHEMES);

/**
 * Get a representative CSS color string for a given value/mod/scheme combo.
 * Useful for building UI swatches.
 * @param {number} value
 * @param {number} mod
 * @param {string} scheme
 * @returns {string}
 */
export function getSchemeColor(value, mod, scheme) {
    const fn = COLOR_SCHEMES[scheme] || COLOR_SCHEMES.rainbow;
    return fn(value, mod);
}

// ---------------------------------------------------------------------------
// Canvas texture generation
// ---------------------------------------------------------------------------

const CELL_SIZE = 8; // px per cell in the canvas texture

/**
 * Paint a canvas with the mod-colored grid for a single layer.
 * @param {number[]} data
 * @param {number} cols
 * @param {number} rows
 * @param {number} mod
 * @param {string} scheme - color scheme key
 * @returns {HTMLCanvasElement}
 */
function generateLayerCanvas(data, cols, rows, mod, scheme) {
    const canvas = document.createElement('canvas');
    canvas.width = cols * CELL_SIZE;
    canvas.height = rows * CELL_SIZE;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#080810';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const colorFn = COLOR_SCHEMES[scheme] || COLOR_SCHEMES.rainbow;
    for (let i = 0; i < data.length; i++) {
        const col = i % cols;
        const row = Math.floor(i / cols);
        if (row >= rows) break;
        const modValue = ((data[i] % mod) + mod) % mod;
        ctx.fillStyle = colorFn(modValue, mod);
        ctx.fillRect(col * CELL_SIZE, row * CELL_SIZE, CELL_SIZE, CELL_SIZE);
    }

    return canvas;
}

// ---------------------------------------------------------------------------
// Main visualizer class
// ---------------------------------------------------------------------------

/**
 * 3D modular arithmetic layer visualizer.
 *
 * Renders a stack of transparent planes, one per modulus value. Each plane
 * is textured with a grid where cells are colored by their dataset value's
 * remainder under that modulus. The result is a layered view that reveals
 * structural patterns in the data across multiple modular bases.
 */
export default class ModLayerVisualizer {
    /**
     * @param {HTMLElement} container - DOM element to attach the renderer to
     * @param {typeof import('three')} THREE - Three.js namespace
     */
    constructor(container, THREE) {
        this.container = container;
        this.THREE = THREE;

        /** @type {number[]} */
        this.data = [];
        /** @type {{ mod: number, mesh: THREE.Mesh, visible: boolean }[]} */
        this.layers = [];

        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.controls = null;

        this.spacing = 1.0;
        this.opacity = 0.85;

        this._rafId = null;
        this._onResize = null;
    }

    /** Set up scene, camera, renderer, and orbit controls. */
    async init() {
        const THREE = this.THREE;
        const w = this.container.clientWidth;
        const h = this.container.clientHeight;

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x0a0a0f);

        this.camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 500);
        this.camera.position.set(12, 10, 20);

        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setSize(w, h);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.container.appendChild(this.renderer.domElement);

        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.08;

        this.scene.add(new THREE.AmbientLight(0xffffff, 1));

        this._onResize = () => {
            const w = this.container.clientWidth;
            const h = this.container.clientHeight;
            this.camera.aspect = w / h;
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(w, h);
        };
        window.addEventListener('resize', this._onResize);

        this._animate();
    }

    /** @private */
    _animate() {
        this._rafId = requestAnimationFrame(() => this._animate());
        this.controls.update();
        this.renderer.render(this.scene, this.camera);
    }

    /**
     * Replace the current dataset.
     * Call build() afterwards to regenerate layers.
     * @param {number[]} numbers
     */
    setData(numbers) {
        this.data = numbers;
    }

    /**
     * Build (or rebuild) all mod layers from the current data.
     * @param {Object} options
     * @param {number} [options.minMod=2]
     * @param {number} [options.maxMod=12]
     * @param {string} [options.colorScheme='rainbow']
     * @returns {{ cols: number, rows: number, layers: { mod: number, swatchColor: string }[] }}
     */
    build({ minMod = 2, maxMod = 12, colorScheme = 'rainbow' } = {}) {
        this._clearLayers();
        const THREE = this.THREE;

        if (this.data.length === 0) {
            return { cols: 0, rows: 0, layers: [] };
        }

        const { cols, rows } = computeGridSize(this.data.length);

        const planeWidth = 10;
        const planeHeight = 10 * rows / cols;

        const layerInfos = [];

        for (let mod = minMod; mod <= maxMod; mod++) {
            const layerIndex = mod - minMod;
            const canvas = generateLayerCanvas(this.data, cols, rows, mod, colorScheme);

            const texture = new THREE.CanvasTexture(canvas);
            texture.minFilter = THREE.NearestFilter;
            texture.magFilter = THREE.NearestFilter;

            const geometry = new THREE.PlaneGeometry(planeWidth, planeHeight);
            const material = new THREE.MeshBasicMaterial({
                map: texture,
                transparent: true,
                opacity: this.opacity,
                side: THREE.DoubleSide,
                depthWrite: false,
            });

            const mesh = new THREE.Mesh(geometry, material);
            mesh.position.set(0, 0, layerIndex * this.spacing);
            this.scene.add(mesh);

            this.layers.push({ mod, mesh, visible: true });

            const swatchColor = getSchemeColor(1, mod, colorScheme);
            layerInfos.push({ mod, swatchColor });
        }

        // Center orbit target on middle of the stack
        const midZ = (this.layers.length - 1) * this.spacing / 2;
        this.controls.target.set(0, 0, midZ);

        return { cols, rows, layers: layerInfos };
    }

    /** @private Remove all layer meshes and release GPU resources. */
    _clearLayers() {
        for (const layer of this.layers) {
            this.scene.remove(layer.mesh);
            layer.mesh.geometry.dispose();
            if (layer.mesh.material.map) layer.mesh.material.map.dispose();
            layer.mesh.material.dispose();
        }
        this.layers = [];
    }

    /**
     * Adjust spacing between layers without rebuilding.
     * @param {number} spacing - World units between adjacent layers
     */
    setSpacing(spacing) {
        this.spacing = spacing;
        this.layers.forEach((layer, i) => {
            layer.mesh.position.z = i * spacing;
        });
        const midZ = Math.max(0, (this.layers.length - 1) * spacing / 2);
        this.controls.target.set(0, 0, midZ);
    }

    /**
     * Adjust opacity of all layers without rebuilding.
     * @param {number} opacity - Opacity value in [0, 1]
     */
    setOpacity(opacity) {
        this.opacity = opacity;
        for (const layer of this.layers) {
            layer.mesh.material.opacity = opacity;
        }
    }

    /**
     * Show or hide a specific layer by its modulus.
     * @param {number} mod
     * @param {boolean} visible
     */
    setLayerVisible(mod, visible) {
        const layer = this.layers.find(l => l.mod === mod);
        if (layer) {
            layer.visible = visible;
            layer.mesh.visible = visible;
        }
    }

    /** Clean up all resources. */
    dispose() {
        if (this._rafId) cancelAnimationFrame(this._rafId);
        if (this._onResize) window.removeEventListener('resize', this._onResize);
        this._clearLayers();
        if (this.renderer) {
            this.renderer.dispose();
            if (this.renderer.domElement.parentNode) {
                this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
            }
        }
    }
}
