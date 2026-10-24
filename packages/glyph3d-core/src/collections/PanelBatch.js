/**
 * PanelBatch — the scene's backdrop surfaces drawn as instances of a few meshes instead of one
 * draw call each: flat panels (window backgrounds, page faces, label plates), and the
 * translucent boxes and box outlines (book covers, directory prisms).
 *
 * A panel stays a real THREE.Mesh / LineSegments: a unit geometry posed by the scene graph,
 * painted by its own material, registered for picking, owned and disposed by whoever made it.
 * `enrollPanel(object)` marks it batchable. While a PanelBatch serves its scene, the object
 * leaves the view camera's layer 0 — the pick channels are their own layers, so picking still
 * draws it — and the batch draws an instance in its place, read off the object every frame:
 * matrixWorld, the material's colours and render state, and the visibility of the object and
 * every ancestor (SceneTransforms' isShown: walked again only when some `visible` or the tree's
 * shape changes, so the scene needs a SceneTransforms). Owners keep writing the object; nothing
 * else changes.
 *
 * Three kinds, each one unit geometry and one shader:
 *   panel — a 1×1 PlaneGeometry in a createPanelMaterial (fill, border, flags, state colours)
 *   fill  — a 1×1×1 BoxGeometry in a MeshBasicMaterial (colour, opacity)
 *   edge  — the EdgesGeometry of that box in a LineBasicMaterial (colour, opacity)
 *
 * The batch refreshes from `scene.onBeforeRender` — after three's matrix update, before it culls,
 * sorts, and uploads — so an instance carries this frame's pose (a camera-locked dock panel never
 * trails its text). Pick passes (cameras that don't see layer 0) don't refresh it.
 *
 * One draw per kind × render state (render order, transparency, depth write/test, side,
 * blending), each instance frustum-culled by its unit geometry's sphere as three culls objects.
 * A translucent bucket's instances are sorted the way three sorts objects (projected
 * depth far→near, then id). A bucket draws just before its render-order band — panels at −0.5,
 * fills at −0.4, edges at −0.3 — so within a band the backdrops land before the glyph fields
 * (a panel's own text is in front of it), and a box's fill before its outline. Instance matrices
 * are camera-relative (the mesh sits at the eye), so big world coordinates never reach the f32
 * lanes.
 */

import * as THREE from 'three';
import { rootOf, isShown, isTracked } from './SceneTransforms.js';

/** The view camera renders layer 0; an enrolled object leaves it while a batch draws it. */
const VIEW_LAYER = 0;

/** @type {Set<THREE.Object3D>} enrolled objects currently attached to a parent */
const _panels = new Set();
/** @type {WeakMap<THREE.Object3D, Kind>} */
const _kindOf = new WeakMap();

function onAdded(e) { _panels.add(e.target); }
function onRemoved(e) { release(e.target); }
function onMaterialDispose(e) { for (const m of _panels) if (m.material === e.target) release(m); }
function release(obj) {
    _panels.delete(obj);
    if (!obj.layers.isEnabled(VIEW_LAYER)) obj.layers.enable(VIEW_LAYER);
}

const isUnitBox = (g) => g?.type === 'BoxGeometry' && g.parameters.width === 1 && g.parameters.height === 1
    && g.parameters.depth === 1 && g.parameters.widthSegments === 1 && g.parameters.heightSegments === 1
    && g.parameters.depthSegments === 1;

// ── the kinds ─────────────────────────────────────────────────────────────────────────────

const PANEL_VS = `
in mat4 aInstance;
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
    gl_Position = projectionMatrix * modelViewMatrix * aInstance * vec4(position, 1.0);
}
`;

// panelMaterial's fragment shader, its uniforms read from the instance.
const PANEL_FS = `
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

const BASIC_VS = `
in mat4 aInstance;
in vec4 aColor;     // rgb, opacity
flat out vec4 vColor;
void main() {
    vColor = aColor;
    gl_Position = projectionMatrix * modelViewMatrix * aInstance * vec4(position, 1.0);
}
`;

// MeshBasicMaterial / LineBasicMaterial with no map, light, or fog: colour × opacity, then the
// renderer's tone mapping + output colour space, as the built-ins do.
const BASIC_FS = `
flat in vec4 vColor;
void main() {
    vec4 diffuseColor = vColor;
    #ifdef OPAQUE
    diffuseColor.a = 1.0;
    #endif
    gl_FragColor = diffuseColor;
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}
`;

function setRgb(arr, i, c) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
/** A basic material's colour + opacity into aColor. */
function readColor(a, i, p) {
    const m = p.material, c = m.color;
    a.aColor[i * 4] = c.r; a.aColor[i * 4 + 1] = c.g; a.aColor[i * 4 + 2] = c.b; a.aColor[i * 4 + 3] = m.opacity;
}

/**
 * @typedef {Object} Kind
 * @property {string} name
 * @property {number} order - added to the band's render order − 0.5 (draw order within a band)
 * @property {boolean} lines - drawn as LineSegments (else a Mesh)
 * @property {() => THREE.BufferGeometry} geometry - the unit geometry every instance scales
 * @property {number} radius - that geometry's bounding radius about its origin (the cull sphere)
 * @property {(obj: THREE.Object3D) => string|null} refuse - why `obj` can't enroll, or null
 * @property {(m: THREE.Material) => boolean} accepts - the material still fits (checked per frame)
 * @property {boolean} glsl3 - the shader writes its own `out` (else three's dialect: gl_FragColor + output chunks)
 * @property {boolean} fogless - drawn without fog: under a fogged scene its objects draw themselves
 * @property {Object<string, number>} lanes - per-instance attribute → item size
 * @property {string} vs
 * @property {string} fs
 * @property {(arrays: Object<string, Float32Array>, i: number, obj: THREE.Object3D) => void} read
 */

/** @type {Object<string, Kind>} */
const KINDS = {
    panel: {
        name: 'panel', order: 0, lines: false, glsl3: true, fogless: false, radius: Math.SQRT1_2,
        geometry: () => new THREE.PlaneGeometry(1, 1),
        refuse(o) {
            const g = o.geometry, p = g?.parameters;
            if (!o.isMesh || g?.type !== 'PlaneGeometry' || p.width !== 1 || p.height !== 1 || p.widthSegments !== 1 || p.heightSegments !== 1) {
                return `a panel is a Mesh of a 1×1 single-segment PlaneGeometry, got ${o.type} of ${g?.type} ${JSON.stringify(p ?? null)}`;
            }
            return o.material?.uniforms?.uFill ? null : `a panel wears a createPanelMaterial material, got ${o.material?.type}`;
        },
        accepts: (m) => !!m.uniforms?.uFill,
        lanes: { aFill: 4, aBorder: 4, aMisc: 2, aHover: 3, aFocus: 3, aInput: 3, aCapture: 3 },
        vs: PANEL_VS, fs: PANEL_FS,
        read(a, i, p) {
            const u = p.material.uniforms, f = u.uFill.value, b = u.uBorderColor.value;
            a.aFill[i * 4] = f.r; a.aFill[i * 4 + 1] = f.g; a.aFill[i * 4 + 2] = f.b; a.aFill[i * 4 + 3] = u.uOpacity.value;
            a.aBorder[i * 4] = b.r; a.aBorder[i * 4 + 1] = b.g; a.aBorder[i * 4 + 2] = b.b; a.aBorder[i * 4 + 3] = u.uBorderWidth.value;
            a.aMisc[i * 2] = u.uBorderIntensity.value; a.aMisc[i * 2 + 1] = u.uFlags.value;
            setRgb(a.aHover, i, u.uHoverColor.value); setRgb(a.aFocus, i, u.uFocusColor.value);
            setRgb(a.aInput, i, u.uInputColor.value); setRgb(a.aCapture, i, u.uCaptureColor.value);
        },
    },
    fill: {
        name: 'fill', order: 0.1, lines: false, glsl3: false, fogless: true, radius: Math.sqrt(3) / 2,
        geometry: () => new THREE.BoxGeometry(1, 1, 1),
        refuse(o) {
            if (!o.isMesh || !isUnitBox(o.geometry)) return `a fill is a Mesh of a 1×1×1 single-segment BoxGeometry, got ${o.type} of ${o.geometry?.type}`;
            return basicRefusal(o.material, 'isMeshBasicMaterial');
        },
        accepts: (m) => m.isMeshBasicMaterial && !m.map,
        lanes: { aColor: 4 },
        vs: BASIC_VS, fs: BASIC_FS,
        read: readColor,
    },
    edge: {
        name: 'edge', order: 0.2, lines: true, glsl3: false, fogless: true, radius: Math.sqrt(3) / 2,
        geometry: () => new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
        refuse(o) {
            const g = o.geometry;
            if (!o.isLineSegments || g?.type !== 'EdgesGeometry' || !isUnitBox(g.parameters.geometry) || g.parameters.thresholdAngle !== 1) {
                return `an edge is a LineSegments of the default EdgesGeometry of a unit BoxGeometry, got ${o.type} of ${g?.type}`;
            }
            return basicRefusal(o.material, 'isLineBasicMaterial');
        },
        accepts: (m) => m.isLineBasicMaterial && !m.map,
        lanes: { aColor: 4 },
        vs: BASIC_VS, fs: BASIC_FS,
        read: readColor,
    },
};

function basicRefusal(m, is) {
    if (!m?.[is]) return `needs a ${is.slice(2)}, got ${m?.type}`;
    if (m.map || m.alphaMap || m.vertexColors) return `its ${m.type} uses a map or vertex colours — the batch draws colour × opacity only`;
    return null;
}

function kindFor(o) {
    if (o.isLineSegments) return KINDS.edge;
    if (o.geometry?.type === 'BoxGeometry') return KINDS.fill;
    return KINDS.panel;
}

/**
 * Mark an object batchable: a panel, a box fill, or a box outline (see the kinds above).
 * Throws when the object isn't one of them.
 * @template {THREE.Object3D} T
 * @param {T} obj
 * @returns {T} the object
 */
export function enrollPanel(obj) {
    const kind = kindFor(obj);
    const why = kind.refuse(obj);
    if (why) throw new Error(`enrollPanel: ${why}`);
    _kindOf.set(obj, kind);
    obj.addEventListener('added', onAdded);
    obj.addEventListener('removed', onRemoved);
    if (!obj.material.userData.panelBatchDispose) {
        obj.material.userData.panelBatchDispose = true;
        obj.material.addEventListener('dispose', onMaterialDispose);
    }
    if (obj.parent) _panels.add(obj);
    return obj;
}

/** The enrolled objects attached to a parent. */
export function enrolledPanels() {
    return _panels;
}

const _proj = new THREE.Matrix4();
const _eye = new THREE.Vector3();
const _frustum = new THREE.Frustum();
const _sphere = new THREE.Sphere();

/** The bucket an object draws in: its kind and every GL state the batch can't vary per instance. */
function stateKey(kind, obj, m) {
    return `${kind.name}|${obj.renderOrder}|${m.transparent ? 1 : 0}|${m.depthWrite ? 1 : 0}|${m.depthTest ? 1 : 0}|${m.side}|${m.blending}`;
}

/** Whether an object's cached bucket still matches its render state. */
function sameState(c, obj, m) {
    return c.renderOrder === obj.renderOrder && c.transparent === m.transparent && c.depthWrite === m.depthWrite
        && c.depthTest === m.depthTest && c.side === m.side && c.blending === m.blending;
}

class Bucket {
    /**
     * @param {PanelBatch} batch
     * @param {Kind} kind
     * @param {THREE.Object3D} obj - the first member: its render order and material state
     */
    constructor(batch, kind, obj) {
        const m = obj.material;
        this.batch = batch;
        this.kind = kind;
        this.renderOrder = obj.renderOrder;
        this.transparent = m.transparent;
        this.material = new THREE.ShaderMaterial({
            glslVersion: kind.glsl3 ? THREE.GLSL3 : null,
            vertexShader: kind.vs,
            fragmentShader: kind.fs,
            uniforms: kind === KINDS.panel ? { uTime: batch._time } : {},
            transparent: m.transparent,
            depthWrite: m.depthWrite,
            depthTest: m.depthTest,
            side: m.side,
            blending: m.blending,
            forceSinglePass: true,
        });
        /** @type {THREE.Object3D[]} this frame's members, in draw order once sorted */
        this.members = [];
        /** @type {THREE.Object3D[]} the sort's scratch list (swapped with members) */
        this.sorted = [];
        /** projected depth per member (the sort key), and the sorted member order */
        this.depth = new Float64Array(64);
        this.order = new Uint32Array(64);
        this.capacity = 0;
        /** @type {THREE.Mesh|THREE.LineSegments|null} */
        this.mesh = null;
        this._grow(64);
    }

    _grow(capacity) {
        const old = this.mesh;
        const geometry = new THREE.InstancedBufferGeometry().copy(this.batch._unit(this.kind));
        const lanes = { aInstance: 16, ...this.kind.lanes };
        for (const [name, size] of Object.entries(lanes)) {
            const a = new THREE.InstancedBufferAttribute(new Float32Array(capacity * size), size);
            a.setUsage(THREE.DynamicDrawUsage);
            geometry.setAttribute(name, a);
        }
        geometry.instanceCount = 0;
        const mesh = this.kind.lines ? new THREE.LineSegments(geometry, this.material) : new THREE.Mesh(geometry, this.material);
        mesh.name = `panel-batch:${this.kind.name}`;
        mesh.frustumCulled = false;           // one box can't bound instances all over the world
        mesh.matrixAutoUpdate = false;
        mesh.matrixWorldAutoUpdate = false;   // posed at the eye by write(), after three's update
        mesh.renderOrder = this.renderOrder - 0.5 + this.kind.order;
        mesh.visible = false;
        if (old) {
            old.parent?.remove(old);
            old.geometry.dispose();
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
        const mesh = this.mesh, g = mesh.geometry, attrs = g.attributes;
        mesh.matrixWorld.makeTranslation(eye.x, eye.y, eye.z);
        const arrays = {};
        for (const name in this.kind.lanes) arrays[name] = attrs[name].array;
        const im = attrs.aInstance.array;
        for (let i = 0; i < n; i++) {
            const p = this.members[i];
            const e = p.matrixWorld.elements, o = i * 16;
            for (let k = 0; k < 12; k++) im[o + k] = e[k];
            im[o + 12] = e[12] - eye.x; im[o + 13] = e[13] - eye.y; im[o + 14] = e[14] - eye.z; im[o + 15] = e[15];
            this.kind.read(arrays, i, p);
        }
        g.instanceCount = n;
        mesh.visible = n > 0;
        if (n > 0) {
            attrs.aInstance.addUpdateRange(0, n * 16);
            attrs.aInstance.needsUpdate = true;
            for (const name in this.kind.lanes) {
                attrs[name].addUpdateRange(0, n * this.kind.lanes[name]);
                attrs[name].needsUpdate = true;
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
        this.material.dispose();
    }
}

export default class PanelBatch {
    /**
     * @param {THREE.Scene} scene - the scene whose enrolled objects this batch draws
     */
    constructor(scene) {
        if (!scene?.isScene) throw new Error('PanelBatch: needs a THREE.Scene (it hooks scene.onBeforeRender)');
        if (!isTracked(scene)) throw new Error('PanelBatch: the scene needs a SceneTransforms first (rootOf / isShown read its marks)');
        this.scene = scene;
        /** @type {Map<Kind, THREE.BufferGeometry>} each kind's unit geometry */
        this._units = new Map();
        this._time = { value: 0 };
        /** @type {Map<string, Bucket>} */
        this._buckets = new Map();
        /** @type {WeakMap<THREE.Object3D, Object>} each object's bucket and the render state that chose it */
        this._bucketOf = new WeakMap();
        /** Last refresh: objects drawn as instances, hidden, outside the view frustum, drawing
         *  themselves (material no longer batchable, or fog), under another root, and the buckets. */
        this.stats = { enrolled: 0, drawn: 0, hidden: 0, culled: 0, own: 0, elsewhere: 0, buckets: 0 };
        const prev = scene.onBeforeRender;
        this._prevHook = prev;
        scene.onBeforeRender = (renderer, sc, camera, target) => {
            prev.call(sc, renderer, sc, camera, target);
            if (camera.layers.isEnabled(VIEW_LAYER)) this.update(camera);
        };
    }

    /** @private */
    _unit(kind) {
        let g = this._units.get(kind);
        if (!g) { g = kind.geometry(); this._units.set(kind, g); }
        return g;
    }

    /**
     * Gather every visible enrolled object in this scene into its bucket and write the instances.
     * Runs from scene.onBeforeRender; callable directly (tests, probes).
     * @param {THREE.Camera} camera - the view camera, matrices current
     */
    update(camera) {
        for (const b of this._buckets.values()) b.members.length = 0;
        let drawn = 0, hidden = 0, culled = 0, own = 0, elsewhere = 0;
        _proj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        _frustum.setFromProjectionMatrix(_proj, THREE.WebGLCoordinateSystem, camera.reversedDepth);
        const fogged = !!this.scene.fog;
        if (fogged && !this._foggedWarned) {
            this._foggedWarned = true;
            console.warn('PanelBatch: the scene has fog, which the box fill/edge shader does not draw — those objects draw themselves (one draw each) while it is set');
        }
        for (const p of _panels) {
            if (rootOf(p) !== this.scene) { elsewhere++; continue; }
            const kind = _kindOf.get(p), m = p.material;
            if (!kind.accepts(m) || (fogged && kind.fogless)) {
                // re-materialled into something the batch can't draw, or fogged: it draws itself
                if (!p.layers.isEnabled(VIEW_LAYER)) p.layers.enable(VIEW_LAYER);
                own++;
                continue;
            }
            if (p.layers.isEnabled(VIEW_LAYER)) p.layers.disable(VIEW_LAYER);
            if (!isShown(p) || !m.visible) { hidden++; continue; }
            // three's per-object cull, kept: the unit geometry's sphere through the world matrix
            const e = p.matrixWorld.elements;
            _sphere.center.set(e[12], e[13], e[14]);
            _sphere.radius = kind.radius * p.matrixWorld.getMaxScaleOnAxis();
            if (!_frustum.intersectsSphere(_sphere)) { culled++; continue; }
            let c = this._bucketOf.get(p);
            if (!c || !sameState(c, p, m)) {
                const key = stateKey(kind, p, m);
                let b = this._buckets.get(key);
                if (!b) { b = new Bucket(this, kind, p); this._buckets.set(key, b); }
                c = { bucket: b, renderOrder: p.renderOrder, transparent: m.transparent, depthWrite: m.depthWrite,
                    depthTest: m.depthTest, side: m.side, blending: m.blending };
                this._bucketOf.set(p, c);
            }
            c.bucket.members.push(p);
            drawn++;
        }
        const eye = camera.getWorldPosition(_eye);
        for (const b of this._buckets.values()) b.write(eye, _proj);
        this.stats = { enrolled: _panels.size, drawn, hidden, culled, own, elsewhere, buckets: this._buckets.size };
        return this.stats;
    }

    /** Unhook, drop the batch's meshes, and hand every enrolled object back its own draw. */
    dispose() {
        this.scene.onBeforeRender = this._prevHook;
        for (const p of _panels) if (!p.layers.isEnabled(VIEW_LAYER)) p.layers.enable(VIEW_LAYER);
        for (const b of this._buckets.values()) b.dispose();
        this._buckets.clear();
        for (const g of this._units.values()) g.dispose();
        this._units.clear();
    }
}
