/**
 * OcclusionCuller — hardware occlusion-query culling on three's NATIVE r183 seam
 * (`object.occlusionTest` + `renderer.isOccluded()`), no custom kernels.
 *
 * Every tracked candidate (a grid / terminal / frame / agent book) gets an invisible
 * PROXY: a unit box scaled to the candidate's live world AABB, drawn at the END of the
 * opaque pass (colorWrite off, depthWrite off, RENDER_ORDER.OCCLUSION_PROXY) with
 * `occlusionTest = true`. The GPU counts whether ANY of the proxy's fragments survive
 * the depth test — against a depth buffer that at that point holds exactly the OPAQUE
 * occluder set (fully-opaque page faces, panels, occluder-LOD fields). Translucent
 * surfaces render later and can never false-occlude, so a candidate visible through a
 * 0.85 page keeps drawing; behind a 1.0 page it goes dark. The AABB is conservative
 * (larger than the content), so verdicts only ever UNDER-cull.
 *
 * Verdict plumbing: `renderer.isOccluded()` answers only while a render context is
 * current, so each proxy samples ITSELF in its own onAfterRender (mid-pass, context
 * live) and the per-frame update() applies the verdicts with ASYMMETRIC hysteresis —
 * cull only after `holdFrames` consecutive occluded samples, un-cull on the FIRST
 * visible sample. Query results resolve asynchronously (a frame or two of latency);
 * the asymmetry makes staleness safe: worst case is drawing something hidden briefly,
 * i.e. today. The proxy keeps drawing while its candidate is culled — that is how the
 * candidate learns it is visible again.
 *
 * The culler only re-shows what IT hid: a candidate hidden by anyone else (group.hide,
 * a knob) is left alone and not tested. Disabled, it un-culls everything and its proxy
 * group stops rendering — zero queries, zero overhead.
 */

import * as THREE from 'three';
import { RENDER_ORDER } from '../../core/renderOrder.js';

/** One geometry + one material serve every proxy (no per-proxy GPU state). */
let _proxyGeo = null;
let _proxyMat = null;
function proxyResources() {
    if (!_proxyGeo) {
        _proxyGeo = new THREE.BoxGeometry(1, 1, 1);
        _proxyMat = new THREE.MeshBasicMaterial({
            colorWrite: false,   // invisible — the draw exists only to be depth-tested
            depthWrite: false,   // never occludes anyone else
            depthTest: true,
            transparent: false,  // OPAQUE pass — tests against the real occluder depth
            side: THREE.DoubleSide,
        });
    }
    return { geo: _proxyGeo, mat: _proxyMat };
}

export class OcclusionCuller {
    /**
     * @param {Object} opts
     * @param {Object} opts.renderer - the live WebGPURenderer (isOccluded source)
     * @param {Object} opts.scene    - proxies live under one group at the scene root
     * @param {number} [opts.holdFrames=8] - consecutive occluded samples before a cull
     */
    constructor({ renderer, scene, holdFrames = 8 }) {
        this.renderer = renderer;
        this.holdFrames = holdFrames;
        this.enabled = false;

        /** Optional gate: return false to exempt an id (e.g. docked tiles — camera
         *  chrome is never occluded and must never flicker). @type {(id:string)=>boolean|null} */
        this.shouldTest = null;

        this.group = new THREE.Group();
        this.group.name = 'occlusion-proxies';
        this.group.visible = false;              // disabled ⇒ proxies don't draw ⇒ no queries
        scene.add(this.group);

        /** @type {Map<string, {id, target, proxy, streak:number, culled:boolean,
         *                      sampled:boolean, lastOccluded:boolean}>} */
        this.entries = new Map();
        this._box = new THREE.Box3();
        this._size = new THREE.Vector3();
        this._center = new THREE.Vector3();
    }

    /** Track a candidate (idempotent). The proxy is built once and follows the
     *  candidate's LIVE world bounds every frame it draws. */
    track(id, target) {
        if (!target || this.entries.has(id)) return;
        const { geo, mat } = proxyResources();
        const proxy = new THREE.Mesh(geo, mat);
        proxy.name = `occl:${id}`;
        proxy.renderOrder = RENDER_ORDER.OCCLUSION_PROXY;
        proxy.occlusionTest = true;
        proxy.userData.isMarker = true;
        proxy.raycast = () => {};
        const entry = { id, target, proxy, streak: 0, culled: false, sampled: false, lastOccluded: false };
        // Sample mid-pass — isOccluded only answers while a render context is current.
        // Reads the latest RESOLVED query set (async, a frame or two behind); the
        // hysteresis in update() absorbs the staleness.
        proxy.onAfterRender = (renderer) => {
            entry.sampled = true;
            entry.lastOccluded = renderer.isOccluded(proxy);
        };
        this.group.add(proxy);
        this.entries.set(id, entry);
    }

    /** Stop tracking (un-culls first — never leave a hidden orphan behind). */
    untrack(id) {
        const e = this.entries.get(id);
        if (!e) return;
        this._show(e);
        e.proxy.onAfterRender = null;
        this.group.remove(e.proxy);
        this.entries.delete(id);
    }

    /** Drop every candidate whose id is no longer live (registry change cascade). */
    pruneMissing(isLive) {
        for (const id of [...this.entries.keys()]) {
            if (!isLive(id)) this.untrack(id);
        }
    }

    /** @param {boolean} v Off ⇒ everything un-culls and proxies stop drawing entirely. */
    setEnabled(v) {
        this.enabled = !!v;
        this.group.visible = this.enabled;
        if (!this.enabled) {
            for (const e of this.entries.values()) { this._show(e); e.streak = 0; e.sampled = false; }
        }
    }

    /** @private un-cull if WE culled it. */
    _show(e) {
        if (e.culled) { e.target.visible = true; e.culled = false; }
    }

    /**
     * Per-frame, BEFORE render: apply last pass's verdicts (asymmetric hysteresis),
     * then refit each proxy to its candidate's live world AABB for this pass's queries.
     */
    update() {
        if (!this.enabled) return;
        for (const e of this.entries.values()) {
            // Exempt (docked etc.): un-cull, stop testing until it returns.
            if (this.shouldTest && !this.shouldTest(e.id)) {
                this._show(e);
                e.streak = 0;
                e.proxy.visible = false;
                continue;
            }
            // Hidden by someone ELSE (group.hide, a knob): hands off — not ours to show,
            // pointless to test.
            if (!e.culled && !e.target.visible) {
                e.streak = 0;
                e.proxy.visible = false;
                continue;
            }

            // Verdict from the last drawn pass: first visible sample SHOWS immediately;
            // occlusion must hold for `holdFrames` consecutive samples to cull.
            if (e.sampled) {
                e.sampled = false;
                if (e.lastOccluded) {
                    e.streak++;
                    if (!e.culled && e.streak >= this.holdFrames) {
                        e.target.visible = false;
                        e.culled = true;
                    }
                } else {
                    e.streak = 0;
                    this._show(e);
                }
            }

            // Refit the proxy to the candidate's LIVE world box (conservative volume).
            const b = e.target.getBounds?.(this._box);
            if (!b || b.isEmpty()) { e.proxy.visible = false; continue; }
            e.proxy.visible = true;
            b.getCenter(this._center);
            b.getSize(this._size);
            e.proxy.position.copy(this._center);
            e.proxy.scale.set(Math.max(this._size.x, 1e-3), Math.max(this._size.y, 1e-3), Math.max(this._size.z, 1e-3));
        }
    }

    /** @returns {{enabled:boolean, tracked:number, culled:string[]}} */
    stats() {
        const culled = [];
        for (const e of this.entries.values()) if (e.culled) culled.push(e.id);
        return { enabled: this.enabled, tracked: this.entries.size, culled };
    }

    dispose() {
        this.setEnabled(false);
        for (const id of [...this.entries.keys()]) this.untrack(id);
        this.group.parent?.remove(this.group);
    }
}

export default OcclusionCuller;
