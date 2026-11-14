import * as THREE from 'three';
import { gridLevels } from './wallSnap.js';

/** Below every scene band (core/renderOrder.js; the IDE's sky sits here too): the paper draws first. */
const PAPER_RENDER_ORDER = -1000;

const VS = /* glsl */ `
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

// A device pixel is on a line when a multiple of the spacing falls in its footprint: half-open, so a
// line of width w covers exactly w pixels — crisp, its colour exactly as specified. World coordinates
// are taken relative to uOrigin (the camera's position reduced by the major spacing on the CPU, in
// double precision), so the float math stays small wherever the camera is.
const FS = /* glsl */ `
precision highp float;
uniform vec2 uOrigin;       // camera position mod the major spacing (world)
uniform vec2 uHalfBuf;      // half the drawing buffer (device px)
uniform float uZoom;        // device px per world unit
uniform float uHalfLine;    // half a line's width (device px)
uniform float uMinor;       // minor spacing (world); 0 = the minor level isn't drawn
uniform float uMajor;       // major spacing (world); 0 = the major level isn't drawn
uniform vec3 uMinorColor;
uniform vec3 uMajorColor;
out vec4 fragColor;

bool onLine(vec2 u, float h, float s) {
    if (s <= 0.0) return false;
    vec2 a = floor((u - h) / s), b = floor((u + h) / s);
    return a.x != b.x || a.y != b.y;
}

void main() {
    vec2 u = uOrigin + (gl_FragCoord.xy - uHalfBuf) / uZoom;
    float h = uHalfLine / uZoom;
    vec3 c;
    if (onLine(u, h, uMajor)) c = uMajorColor;
    else if (onLine(u, h, uMinor)) c = uMinorColor;
    else discard;
    fragColor = linearToOutputTexel(vec4(c, 1.0));
}
`;

/**
 * WallPaper — the canvas the wall's terminals sit on: its colour (the renderer's clear colour) and
 * the drafting-paper grid over it, one full-screen quad whose fragment shader finds the lines from
 * the camera (no per-line objects). Opaque lines, the rest discarded, so the clear colour shows
 * between them; drawn first (PAPER_RENDER_ORDER) and without depth, so everything draws over it.
 * Which levels draw is wallSnap.gridLevels: a level denser than `gridMinPx` is simply not drawn, and
 * with neither level drawn (or the grid off) the quad is hidden. Colours are sRGB specified and drawn
 * through three's colour management (docs/architecture/rendering.md "Colour"): the canvas holds them.
 */
export default class WallPaper {
    /**
     * @param {import('three').Scene} scene
     * @param {import('three').WebGLRenderer} renderer
     */
    constructor(scene, renderer) {
        this._renderer = renderer;
        this._scene = scene;
        this._buf = new THREE.Vector2();
        this._background = null;
        this._colors = { minor: null, major: null };
        this.material = new THREE.ShaderMaterial({
            glslVersion: THREE.GLSL3,
            vertexShader: VS,
            fragmentShader: FS,
            uniforms: {
                uOrigin: { value: new THREE.Vector2() },
                uHalfBuf: { value: new THREE.Vector2() },
                uZoom: { value: 1 },
                uHalfLine: { value: 0.5 },
                uMinor: { value: 0 },
                uMajor: { value: 0 },
                uMinorColor: { value: new THREE.Color() },
                uMajorColor: { value: new THREE.Color() },
            },
            depthTest: false,
            depthWrite: false,
        });
        this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
        this.mesh.name = 'WallPaper';
        this.mesh.frustumCulled = false;   // a clip-space quad: always the whole view
        this.mesh.renderOrder = PAPER_RENDER_ORDER;
        this.mesh.visible = false;
        scene.add(this.mesh);
        /** What the last update drew: which levels, at which spacings (world units). */
        this.drawn = { minor: false, major: false, minorStep: 0, majorStep: 0 };
    }

    /**
     * Per frame: the canvas colour, and the grid for this camera.
     * @param {import('./WallCamera.js').default} view
     * @param {import('./wallConfig.js').WallConfig} cfg
     */
    update(view, cfg) {
        if (cfg.background !== this._background) {
            this._background = cfg.background;
            this._renderer.setClearColor(new THREE.Color(cfg.background), 1);
        }
        const levels = gridLevels(cfg, view.zoom);
        const show = cfg.gridShow && (levels.minor || levels.major);
        this.mesh.visible = show;
        this.drawn = {
            minor: show && levels.minor, major: show && levels.major,
            minorStep: cfg.gridMinor, majorStep: cfg.gridMinor * cfg.gridMajorEvery,
        };
        if (!show) return;
        const u = this.material.uniforms;
        const dpr = this._renderer.getPixelRatio();
        const major = this.drawn.majorStep;
        const cam = view.camera.position;
        const mod = (v) => ((v % major) + major) % major;
        u.uOrigin.value.set(mod(cam.x), mod(cam.y));
        this._renderer.getDrawingBufferSize(this._buf);
        u.uHalfBuf.value.set(this._buf.x / 2, this._buf.y / 2);
        u.uZoom.value = view.zoom * dpr;
        u.uHalfLine.value = Math.max(1, Math.round(cfg.gridLinePx * dpr)) / 2;
        u.uMinor.value = this.drawn.minor ? cfg.gridMinor : 0;
        u.uMajor.value = this.drawn.major ? major : 0;
        if (cfg.gridMinorColor !== this._colors.minor) { this._colors.minor = cfg.gridMinorColor; u.uMinorColor.value.set(cfg.gridMinorColor); }
        if (cfg.gridMajorColor !== this._colors.major) { this._colors.major = cfg.gridMajorColor; u.uMajorColor.value.set(cfg.gridMajorColor); }
    }

    dispose() {
        this._scene.remove(this.mesh);
        this.mesh.geometry.dispose();
        this.material.dispose();
    }
}
