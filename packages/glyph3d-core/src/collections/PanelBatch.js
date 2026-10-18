/**
 * PanelBatch — every flat panel (window backgrounds, page faces, label plates) drawn as instances
 * of a few InstancedMeshes instead of one draw call each.
 *
 * A panel stays a real THREE.Mesh: a unit PlaneGeometry posed by the scene graph, painted by its
 * createPanelMaterial uniforms, registered for picking, owned and disposed by whoever made it.
 * `enrollPanel(mesh)` marks it batchable. While a PanelBatch serves the mesh's scene, the mesh
 * leaves the view camera's layer 0 — the pick channels are their own layers, so picking still
 * draws it — and the batch draws an instance in its place, read off the mesh every frame:
 * matrixWorld, the material's fill/border/flag/state-colour uniforms, its render state, and the
 * visibility of the mesh and every ancestor. Owners keep writing the mesh; nothing else changes.
 *
 * The batch refreshes from `scene.onBeforeRender` — after three's matrix update, before it culls,
 * sorts, and uploads — so an instance carries this frame's pose (a camera-locked dock panel never
 * trails its text). Pick passes (cameras that don't see layer 0) don't refresh it.
 *
 * One InstancedMesh per render state (render order, transparency, depth write/test, side,
 * blending). A translucent bucket's instances are sorted the way three sorts objects (projected
 * depth far→near, then id), and every bucket draws half a step before its panels' render order —
 * so panels land before the glyph fields that share their band, as a panel's own text is in
 * front of it. Instance matrices are camera-relative (the mesh sits at the eye), so big world
 * coordinates never reach the f32 lanes.
 */

import * as THREE from 'three';

/** The view camera renders layer 0; an enrolled panel leaves it while a batch draws it. */
const VIEW_LAYER = 0;

/** @type {Set<THREE.Mesh>} enrolled panels currently attached to a parent */
const _panels = new Set();

function onAdded(e) { _panels.add(e.target); }
function onRemoved(e) { release(e.target); }
function onMaterialDispose(e) { for (const m of _panels) if (m.material === e.target) release(m); }
function release(mesh) {
    _panels.delete(mesh);
    if (!mesh.layers.isEnabled(VIEW_LAYER)) mesh.layers.enable(VIEW_LAYER);
}

/**
 * Mark a panel mesh batchable. It must be a 1×1 single-segment PlaneGeometry (scaled by its
 * transform) wearing a createPanelMaterial material.
 * @param {THREE.Mesh} mesh
 * @returns {THREE.Mesh} the mesh
 */
export function enrollPanel(mesh) {
    const g = mesh.geometry;
    const p = g?.parameters;
    if (g?.type !== 'PlaneGeometry' || p.width !== 1 || p.height !== 1 || p.widthSegments !== 1 || p.heightSegments !== 1) {
        throw new Error(`enrollPanel: needs a 1×1 single-segment PlaneGeometry, got ${g?.type} ${JSON.stringify(p ?? null)}`);
    }
    if (!mesh.material?.uniforms?.uFill) {
        throw new Error(`enrollPanel: needs a createPanelMaterial material, got ${mesh.material?.type}`);
    }
    mesh.addEventListener('added', onAdded);
    mesh.addEventListener('removed', onRemoved);
    if (!mesh.material.userData.panelBatchDispose) {
        mesh.material.userData.panelBatchDispose = true;
        mesh.material.addEventListener('dispose', onMaterialDispose);
    }
    if (mesh.parent) _panels.add(mesh);
    return mesh;
}

/** The enrolled panels attached to a parent. */
export function enrolledPanels() {
    return _panels;
}

const VS = `
in vec4 aFill;      // fill rgb, opacity
in vec4 aBorder;    // border rgb, width (px)
in vec2 aMisc;      // border intensity, flags
in vec3 aHover;
in vec3 aFocus;
in vec3 aInput;
in vec3 aCapture;
out vec2 vUv;
flat out vec4 vFill;
flat out vec4 vBorder;
flat out float vIntensity;
flat out int vFlags;
flat out vec3 vHover;
flat out vec3 vFocus;
flat out vec3 vInput;
flat out vec3 vCapture;
void main() {
    vUv = uv;
    vFill = aFill;
    vBorder = aBorder;
    vIntensity = aMisc.x;
    vFlags = int(aMisc.y + 0.5);
    vHover = aHover; vFocus = aFocus; vInput = aInput; vCapture = aCapture;
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}
`;

// panelMaterial's fragment shader, its uniforms read from the instance.
const FS = `
precision highp float;
precision highp int;

in vec2 vUv;
flat in vec4 vFill;
flat in vec4 vBorder;
flat in float vIntensity;
flat in int vFlags;
flat in vec3 vHover;
flat in vec3 vFocus;
flat in vec3 vInput;
flat in vec3 vCapture;
out vec4 fragColor;

uniform float uTime;

void main() {
    int F_HOVERED  = 2;
    int F_FOCUSED  = 4;
    int F_INPUT    = 8;
    int F_CAPTURED = 16;

    bool isCaptured = (vFlags & F_CAPTURED) != 0;
    bool isInput    = (vFlags & F_INPUT) != 0;
    bool isFocused  = (vFlags & F_FOCUSED) != 0;
    bool isHovered  = (vFlags & F_HOVERED) != 0;
    bool anyState   = isCaptured || isInput || isFocused || isHovered;
    bool accent     = isCaptured || isInput || isFocused;

    vec3 stateCol = isCaptured ? vCapture : (isInput ? vInput : (isFocused ? vFocus : vHover));
    float pulse = isHovered ? (sin(uTime * 6.9115) * 0.5 + 0.5) * 0.2 + 0.85 : 1.0;
    vec3 borderCol = (anyState ? stateCol : vBorder.rgb) * pulse;

    float scaleFactor = isCaptured ? 2.6 : (accent ? 1.6 : 1.0);
    float w = vBorder.w * scaleFactor;

    vec2 edge = vec2(0.5) - abs(vUv - vec2(0.5));
    vec2 px = edge / max(fwidth(edge), vec2(1e-6));
    float d = min(px.x, px.y);
    float band = 1.0 - smoothstep(w - 0.5, w + 0.5, d);
    float rim = (vFlags > 0) ? (band * vIntensity) : 0.0;

    vec3 finalColor = mix(vFill.rgb, borderCol, rim);
    float finalAlpha = max(vFill.a, rim);

    fragColor = vec4(finalColor, finalAlpha);
}
`;

/** Per-instance lanes: name → item size. */
const LANES = Object.freeze({ aFill: 4, aBorder: 4, aMisc: 2, aHover: 3, aFocus: 3, aInput: 3, aCapture: 3 });

const _proj = new THREE.Matrix4();
const _eye = new THREE.Vector3();

/** The bucket a panel draws in: every GL state the batch can't vary per instance. */
function stateKey(mesh, m) {
    return `${mesh.renderOrder}|${m.transparent ? 1 : 0}|${m.depthWrite ? 1 : 0}|${m.depthTest ? 1 : 0}|${m.side}|${m.blending}`;
}

/** Whether a panel's cached bucket still matches its render state. */
function sameState(c, mesh, m) {
    return c.renderOrder === mesh.renderOrder && c.transparent === m.transparent && c.depthWrite === m.depthWrite
        && c.depthTest === m.depthTest && c.side === m.side && c.blending === m.blending;
}

class Bucket {
    constructor(batch, mesh, material) {
        this.batch = batch;
        this.renderOrder = mesh.renderOrder;
        this.transparent = material.transparent;
        this.material = new THREE.ShaderMaterial({
            glslVersion: THREE.GLSL3,
            vertexShader: VS,
            fragmentShader: FS,
            uniforms: { uTime: batch._time },
            transparent: material.transparent,
            depthWrite: material.depthWrite,
            depthTest: material.depthTest,
            side: material.side,
            blending: material.blending,
            forceSinglePass: true,
        });
        /** @type {THREE.Mesh[]} this frame's members, in draw order once sorted */
        this.members = [];
        /** @type {THREE.Mesh[]} the sort's scratch list (swapped with members) */
        this.sorted = [];
        /** projected depth per member (the sort key), and the sorted member order */
        this.depth = new Float64Array(64);
        this.order = new Uint32Array(64);
        this.capacity = 0;
        this.mesh = null;
        this._grow(64);
    }

    _grow(capacity) {
        const old = this.mesh;
        const geometry = this.batch._plane.clone();
        for (const [name, size] of Object.entries(LANES)) {
            const a = new THREE.InstancedBufferAttribute(new Float32Array(capacity * size), size);
            a.setUsage(THREE.DynamicDrawUsage);
            geometry.setAttribute(name, a);
        }
        const mesh = new THREE.InstancedMesh(geometry, this.material, capacity);
        mesh.name = 'panel-batch';
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.frustumCulled = false;           // one box can't bound panels all over the world
        mesh.matrixAutoUpdate = false;
        mesh.matrixWorldAutoUpdate = false;   // posed at the eye by write(), after three's update
        mesh.renderOrder = this.renderOrder - 0.5;
        mesh.count = 0;
        mesh.visible = false;
        if (old) {
            old.parent?.remove(old);
            old.geometry.dispose();
            old.dispose();
        }
        this.batch.scene.add(mesh);
        this.mesh = mesh;
        this.capacity = capacity;
    }

    /** Write this frame's members as instances, eye-relative. */
    write(eye, proj) {
        const n = this.members.length;
        if (n > this.capacity) this._grow(Math.max(n, this.capacity * 2));
        if (this.transparent && n > 1) this._sort(proj);
        const mesh = this.mesh;
        mesh.matrixWorld.makeTranslation(eye.x, eye.y, eye.z);
        const im = mesh.instanceMatrix.array;
        const g = mesh.geometry.attributes;
        const fill = g.aFill.array, border = g.aBorder.array, misc = g.aMisc.array;
        const hover = g.aHover.array, focus = g.aFocus.array, input = g.aInput.array, capture = g.aCapture.array;
        for (let i = 0; i < n; i++) {
            const p = this.members[i];
            const e = p.matrixWorld.elements, o = i * 16;
            for (let k = 0; k < 12; k++) im[o + k] = e[k];
            im[o + 12] = e[12] - eye.x; im[o + 13] = e[13] - eye.y; im[o + 14] = e[14] - eye.z; im[o + 15] = e[15];
            const u = p.material.uniforms;
            const f = u.uFill.value, b = u.uBorderColor.value;
            fill[i * 4] = f.r; fill[i * 4 + 1] = f.g; fill[i * 4 + 2] = f.b; fill[i * 4 + 3] = u.uOpacity.value;
            border[i * 4] = b.r; border[i * 4 + 1] = b.g; border[i * 4 + 2] = b.b; border[i * 4 + 3] = u.uBorderWidth.value;
            misc[i * 2] = u.uBorderIntensity.value; misc[i * 2 + 1] = u.uFlags.value;
            setRgb(hover, i, u.uHoverColor.value); setRgb(focus, i, u.uFocusColor.value);
            setRgb(input, i, u.uInputColor.value); setRgb(capture, i, u.uCaptureColor.value);
        }
        mesh.count = n;
        mesh.visible = n > 0;
        if (n > 0) {
            mesh.instanceMatrix.addUpdateRange(0, n * 16);
            mesh.instanceMatrix.needsUpdate = true;
            for (const name in LANES) {
                const a = g[name];
                a.addUpdateRange(0, n * LANES[name]);
                a.needsUpdate = true;
            }
        }
    }

    /** three's transparent order: projected depth far→near, ties by object id. */
    _sort(proj) {
        const members = this.members, n = members.length;
        if (this.depth.length < n) {
            this.depth = new Float64Array(Math.max(n, this.depth.length * 2));
            this.order = new Uint32Array(this.depth.length);
        }
        const pe = proj.elements, depth = this.depth, order = this.order.subarray(0, n);
        for (let i = 0; i < n; i++) {
            const e = members[i].matrixWorld.elements, x = e[12], y = e[13], z = e[14];
            const w = pe[3] * x + pe[7] * y + pe[11] * z + pe[15];
            depth[i] = (pe[2] * x + pe[6] * y + pe[10] * z + pe[14]) / w;
            order[i] = i;
        }
        order.sort((a, b) => (depth[b] - depth[a]) || (members[a].id - members[b].id));
        const sorted = this.sorted;
        sorted.length = n;
        for (let i = 0; i < n; i++) sorted[i] = members[order[i]];
        this.sorted = members;
        this.members = sorted;
    }

    dispose() {
        this.mesh.parent?.remove(this.mesh);
        this.mesh.geometry.dispose();
        this.mesh.dispose();
        this.material.dispose();
    }
}

function setRgb(arr, i, c) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }

export default class PanelBatch {
    /**
     * @param {THREE.Scene} scene - the scene whose enrolled panels this batch draws
     */
    constructor(scene) {
        if (!scene?.isScene) throw new Error('PanelBatch: needs a THREE.Scene (it hooks scene.onBeforeRender)');
        this.scene = scene;
        this._plane = new THREE.PlaneGeometry(1, 1);
        this._time = { value: 0 };
        /** @type {Map<string, Bucket>} */
        this._buckets = new Map();
        /** @type {WeakMap<THREE.Mesh, Object>} each panel's bucket and the render state that chose it */
        this._bucketOf = new WeakMap();
        /** Last refresh: panels attached anywhere, drawn as instances, hidden, and the buckets. */
        this.stats = { enrolled: 0, drawn: 0, hidden: 0, elsewhere: 0, buckets: 0 };
        const prev = scene.onBeforeRender;
        this._prevHook = prev;
        scene.onBeforeRender = (renderer, sc, camera, target) => {
            prev.call(sc, renderer, sc, camera, target);
            if (camera.layers.isEnabled(VIEW_LAYER)) this.update(camera);
        };
    }

    /**
     * Gather every visible enrolled panel in this scene into its bucket and write the instances.
     * Runs from scene.onBeforeRender; callable directly (tests, probes).
     * @param {THREE.Camera} camera - the view camera, matrices current
     */
    update(camera) {
        for (const b of this._buckets.values()) b.members.length = 0;
        let drawn = 0, hidden = 0, elsewhere = 0;
        for (const p of _panels) {
            let shown = true, o = p;
            for (; o.parent; o = o.parent) if (!o.visible) shown = false;
            if (o !== this.scene) { elsewhere++; continue; }
            if (p.layers.isEnabled(VIEW_LAYER)) p.layers.disable(VIEW_LAYER);
            const m = p.material;
            if (!shown || !o.visible || !m.visible || !m.uniforms?.uFill) { hidden++; continue; }
            let c = this._bucketOf.get(p);
            if (!c || !sameState(c, p, m)) {
                const key = stateKey(p, m);
                let b = this._buckets.get(key);
                if (!b) { b = new Bucket(this, p, m); this._buckets.set(key, b); }
                c = { bucket: b, renderOrder: p.renderOrder, transparent: m.transparent, depthWrite: m.depthWrite,
                    depthTest: m.depthTest, side: m.side, blending: m.blending };
                this._bucketOf.set(p, c);
            }
            c.bucket.members.push(p);
            drawn++;
        }
        _proj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        const eye = camera.getWorldPosition(_eye);
        for (const b of this._buckets.values()) b.write(eye, _proj);
        this.stats = { enrolled: _panels.size, drawn, hidden, elsewhere, buckets: this._buckets.size };
        return this.stats;
    }

    /** Unhook, drop the instanced meshes, and hand every panel back its own draw. */
    dispose() {
        this.scene.onBeforeRender = this._prevHook;
        for (const p of _panels) if (!p.layers.isEnabled(VIEW_LAYER)) p.layers.enable(VIEW_LAYER);
        for (const b of this._buckets.values()) b.dispose();
        this._buckets.clear();
        this._plane.dispose();
    }
}
