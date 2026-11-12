/**
 * FlatRenderRoot — a camera renders a flat list of what actually draws, not the scene tree
 * (docs/RENDER-WALK.md). One serves the view (layer 0, installed at the renderer); the
 * picking system keeps one per channel (its layer).
 *
 * three's `render(scene, camera)` walks every visible node every frame (`projectObject`) to build its
 * render list; on the agents' display that is ~6.5k visits for ~1.3k drawables on layer 0 — the rest
 * are containers and objects the batches draw (off layer 0) — and a pick pass walks the same 6.5k
 * for the few hundred meshes on its channel's layer. This keeps a stand-in `Scene` whose `children`
 * is the list of SHOWN drawables the camera sees, and the camera renders that instead. The
 * logical tree is untouched — nothing is reparented: three's walk never reads `parent`, so each
 * object draws with its own matrixWorld, material, renderOrder and frustum culling. The root shares
 * the scene's background / fog / environment, never updates matrices itself (the scene's
 * `updateMatrixWorld` — SceneTransforms — runs first, as three's render would run it), and forwards
 * the scene's onBeforeRender / onAfterRender (the batches take objects off layer 0 there; the list
 * is collected after them).
 *
 * The list is rebuilt only when something it depends on moved — the KEY:
 *   - membership and visibility: SceneTransforms' show generation (a `visible` flip, a tracked node
 *     gaining or losing a child);
 *   - layers: this module's layer generations, one per layer bit — every THREE.Layers write method
 *     (set, enable, enableAll, toggle, disable, disableAll) bumps the bits it changes, and a list
 *     reads only the bits its camera sees (the batches' idempotent per-frame `disable` moves
 *     nothing; a pick registration moves only its channel's bit). A direct `layers.mask =` write is
 *     not seen: write layers through their methods (tools/flat-root.test.mjs scans the source). A
 *     camera's layers never change what is in a list (the camera's mask is in the key itself):
 *     `unwatchLayers` takes a camera whose layers are set per pass (the pick camera) out of the count;
 *   - the camera's own layer mask.
 *
 * What three's walk does beyond pushing a drawable is kept exact by handing three that node WHOLE —
 * it is a list entry and three walks its subtree as it always did: a Group with a non-zero renderOrder
 * (three hands the nearest Group's renderOrder down as the group order; the list has no groups to
 * carry it), a light, an LOD (it picks its children's levels as it is walked), a light-probe grid.
 * Sprites are drawables like meshes. Every list entry is walked by three WITH its subtree (its
 * projectObject recurses into children), so nothing under an entry is listed again — a drawable's
 * drawable child (a box fill's edges) would otherwise draw twice; under a drawable the camera doesn't
 * see (a batched fill), the child is its own entry. Draw order doesn't depend on the list's order:
 * three sorts by group order, renderOrder, program, depth and id.
 *
 * REFUSED (the flat list would draw differently, so it doesn't serve): a drawable with its own
 * onBeforeRender — three hands it the scene being rendered, which would be the root (the hooks known
 * never to read it — three's no-op, the fat lines' resolution hook — pass); a shadow-casting
 * light — the shadow pass walks the scene it is given for casters on the light's layers. A refusal is
 * a loud record naming the object (console.error, `refused`, `stats.refusals`), and the view renders
 * the scene itself until the scene changes again (each key move re-checks) — never silently. (The
 * frame the refusal is found on is already inside the root's render: it draws three's full walk
 * through the root.)
 *
 * Gate: tools/flat-root.test.mjs (rebuild counts, refusals); tools/flat-root-check.mjs (byte-identical
 * frames flat vs full on the GPU).
 */

import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { showGeneration, isTracked } from './SceneTransforms.js';

/** Per layer bit: how many times some object's bit changed through a THREE.Layers method. */
const _bitGeneration = new Uint32Array(32);
const UNWATCHED = Symbol('layersUnwatched');

/**
 * The layer generation a camera with `mask` reads: moves whenever a bit in `mask` changes on any
 * watched object (a sum of per-bit counters that only grow).
 * @param {number} mask
 */
export function layerGeneration(mask) {
    let g = 0;
    for (let m = mask >>> 0, b = 0; m !== 0; m >>>= 1, b++) if (m & 1) g += _bitGeneration[b];
    return g;
}

/**
 * Take a Layers object out of the generations: a camera's, set per pass (it never changes what is
 * in a list — a list keys on its camera's mask directly).
 * @param {THREE.Layers} layers
 */
export function unwatchLayers(layers) { layers[UNWATCHED] = true; }

// Hook every Layers write method once (a hot reload re-running this module must not wrap twice).
const HOOKED = '_flatRootLayersHooked';
if (!THREE.Layers.prototype[HOOKED]) {
    for (const name of ['set', 'enable', 'enableAll', 'toggle', 'disable', 'disableAll']) {
        const base = THREE.Layers.prototype[name];
        THREE.Layers.prototype[name] = function (...a) {
            const was = this.mask;
            const r = base.apply(this, a);
            const changed = (this.mask ^ was) >>> 0;
            if (changed !== 0 && !this[UNWATCHED]) {
                for (let m = changed, b = 0; m !== 0; m >>>= 1, b++) if (m & 1) _bitGeneration[b]++;
            }
            return r;
        };
    }
    Object.defineProperty(THREE.Layers.prototype, HOOKED, { value: true });
}

/**
 * Per-object onBeforeRender hooks that never read the scene they are handed: three's own no-op, and
 * the fat lines' (LineSegments2 / Line2: it sets the material's resolution from the renderer's
 * viewport). Any other hook is a refusal.
 */
const SCENE_BLIND_HOOKS = new Set([THREE.Object3D.prototype.onBeforeRender, LineSegments2.prototype.onBeforeRender]);

/** A readable path for an object: its name/class and up to 4 ancestors. */
export function pathOf(obj) {
    const parts = [];
    for (let o = obj, i = 0; o && i < 5; o = o.parent, i++) parts.push(o.name || o.constructor?.name || o.type);
    return parts.join(' ← ');
}

export default class FlatRenderRoot {
    /**
     * @param {THREE.Scene} scene  the logical scene (it needs a SceneTransforms: the show generation)
     * @param {{layer?: number, name?: string}} [opts]  the layer a camera must see to be served (0:
     *   the view; a pick channel's layer), and a name for records
     */
    constructor(scene, { layer = 0, name = 'view' } = {}) {
        if (!scene?.isScene) throw new Error('FlatRenderRoot: needs a THREE.Scene');
        if (!isTracked(scene)) throw new Error('FlatRenderRoot: the scene needs a SceneTransforms (its show generation keys the list)');
        if (!(Number.isInteger(layer) && layer >= 0 && layer < 32)) throw new Error(`FlatRenderRoot: layer must be an integer in [0, 32) (got ${layer})`);
        this.scene = scene;
        this.layer = layer;
        this.name = name;
        /** Just this root's layer: what verify() checks with when handed no camera. */
        this._ownLayers = new THREE.Layers();
        unwatchLayers(this._ownLayers);
        this._ownLayers.set(layer);
        /** Whether cameras are served the flat list (render.flatRoot / pick.flatRoot). */
        this.enabled = true;
        /** @type {{reason: string, object: string}|null} a refusal — the full scene renders (through the root) */
        this.refused = null;
        const root = new THREE.Scene();
        root.name = `flat-render-root:${name}`;
        root.matrixAutoUpdate = false;
        root.matrixWorldAutoUpdate = false;
        root.onBeforeRender = (renderer, _s, camera, target) => {
            scene.onBeforeRender(renderer, scene, camera, target);
            this._refresh(camera);
        };
        root.onAfterRender = (renderer, _s, camera, target) => { scene.onAfterRender(renderer, scene, camera, target); };
        this.root = root;
        /** The key the list was built at (show generation, layer generation, camera mask). */
        this._show = -1; this._layers = -1; this._mask = -1;
        /** Lists built, and checks that refused (one per key move while refused); the last list: drawables, and nodes carried whole. */
        this.stats = { rebuilds: 0, refusals: 0, drawables: 0, carried: 0 };
    }

    /**
     * What to render for the scene through `camera`: the flat root when it serves (enabled, no
     * broken precondition, a camera that sees this root's layer), else the scene itself.
     * @param {THREE.Camera} camera @returns {THREE.Scene}
     */
    target(camera) {
        if (!this.enabled || !camera.layers.isEnabled(this.layer)) return this.scene;
        if (this.refused && !this._recheck(camera)) return this.scene;
        const s = this.scene, root = this.root;
        if (s.matrixWorldAutoUpdate === true) s.updateMatrixWorld();
        root.background = s.background; root.fog = s.fog; root.environment = s.environment;
        root.backgroundBlurriness = s.backgroundBlurriness; root.backgroundIntensity = s.backgroundIntensity;
        root.overrideMaterial = s.overrideMaterial;
        return root;
    }

    /**
     * Check the list against a fresh walk now (scene.render): what a rebuild would hold that the
     * list doesn't, and the reverse. Stale = the list missed a change its key never saw (a direct
     * `layers.mask` write, a child spliced into `children` by hand).
     * @param {THREE.Camera} [camera]  default: a camera that sees just this root's layer
     * @returns {{missing: THREE.Object3D[], extra: THREE.Object3D[], refused: {reason: string, object: string}|null}}
     */
    verify(camera) {
        const fresh = [];
        this._carried = 0;
        const refused = this._collect(this.scene, fresh, camera?.layers ?? this._ownLayers, false);
        if (refused || this.refused || this.root.children === this.scene.children) return { missing: [], extra: [], refused: refused ?? this.refused };
        const have = new Set(this.root.children), want = new Set(fresh);
        return {
            missing: fresh.filter((o) => !have.has(o)),
            extra: this.root.children.filter((o) => !want.has(o)),
            refused: null,
        };
    }

    /** Whether the key moved since the refusal and the scene now passes. @private */
    _recheck(camera) {
        if (!this._keyMoved(camera)) return false;
        this._carried = 0;
        const why = this._collect(this.scene, [], camera.layers, false);
        if (why) { this._refuse(why); return false; }
        console.warn(`[flat-root:${this.name}] serving again (the refusal is gone: ${this.refused.object})`);
        this.refused = null;
        this._show = -1;   // the list is rebuilt inside this render
        return true;
    }

    /** Takes the key; true when it moved. @private */
    _keyMoved(camera) {
        const mask = camera.layers.mask, show = showGeneration();
        const layers = layerGeneration(mask);
        if (show === this._show && layers === this._layers && mask === this._mask) return false;
        this._show = show; this._layers = layers; this._mask = mask;
        return true;
    }

    /** Record a refusal (logged when it names something new). @private */
    _refuse(why) {
        if (this.refused?.object !== why.object || this.refused?.reason !== why.reason) {
            console.error(`[flat-root:${this.name}] REFUSED — ${why.reason}: ${why.object}. It renders the scene itself until the scene changes again.`);
        }
        this.refused = why;
        this.stats.refusals++;
    }

    /** Rebuild the list if the key moved (runs inside the render, after the scene's hooks). @private */
    _refresh(camera) {
        if (!this._keyMoved(camera)) return;
        const out = [];
        this._carried = 0;
        const why = this._collect(this.scene, out, camera.layers, false);
        if (why) {
            this._refuse(why);
            this.root.children = this.scene.children;   // this frame: three's full walk, through the root
            return;
        }
        this.root.children = out;
        this.stats.rebuilds++;
        this.stats.drawables = out.length - this._carried;
        this.stats.carried = this._carried;
    }

    /**
     * three's walk (projectObject) up to what the list can stand for: drawables the camera sees are
     * pushed; a node three must walk itself is pushed whole. Under any entry, three walks the subtree
     * itself: it is checked, never collected.
     * @param {THREE.Object3D} o @param {THREE.Object3D[]} out @param {THREE.Layers} layers
     * @param {boolean} inside  under a list entry (check, don't collect)
     * @returns {{reason: string, object: string}|null} the first broken precondition @private
     */
    _collect(o, out, layers, inside) {
        if (o.visible === false) return null;
        if (o.layers.test(layers)) {
            if (o.isLight && o.castShadow) return { reason: `a shadow-casting ${o.type} (the shadow pass walks the scene it is given)`, object: pathOf(o) };
            if (o.isMesh || o.isLine || o.isPoints || o.isSprite) {
                if (!SCENE_BLIND_HOOKS.has(o.onBeforeRender)) return { reason: 'a drawable with its own onBeforeRender (three would hand it the flat root as its scene)', object: pathOf(o) };
                if (!inside) { out.push(o); inside = true; }   // three walks its children under it
            } else if (!inside && ((o.isGroup && o.renderOrder !== 0) || o.isLight || o.isLOD || o.isLightProbeGrid)) {
                out.push(o);
                this._carried++;
                inside = true;
            }
        }
        const ch = o.children;
        for (let i = 0; i < ch.length; i++) {
            const why = this._collect(ch[i], out, layers, inside);
            if (why) return why;
        }
        return null;
    }
}
