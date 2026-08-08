/**
 * PanelField — every window background panel as ONE instanced draw.
 *
 * The per-file panel mesh was the last per-file GPU object standing after the
 * mega-field unified the glyphs: a bulk load left ~N panel Meshes in the scene
 * walk, and a fit-all teleport made every never-drawn one pay WebGPU first-draw
 * bind-group creation in a single frame (the measured 2–3s fit wall). Here a
 * panel is an INSTANCE of one quad mesh instead: one geometry, one material,
 * one bind group, one draw — a panel appearing costs an attribute write.
 *
 * Pose comes from the SAME group texels that pose the glyphs (GlyphField's
 * group DataTexture, GROUP_COLS layout): each instance carries its owner view's
 * groupId and the vertex shader applies the identical scale → quat → offset
 * chain, so a panel physically cannot drift from the glyphs it backs, fades
 * with the view's alpha lane for free, and a freed slot pointed at group 0
 * (the dead group) can never ghost. The instance lanes are the panel-local
 * facts only: rect (center + size in the owner node's frame), z, fill color,
 * and the BORDER_FLAGS bit-set — so every panel has live border capability
 * (the fragment is the panelMaterial border shader with per-instance state).
 *
 * Picking: one 'grid'-channel registration for the whole field, ID = block
 * base + instanceIndex, with a pick material built from the SAME vertex
 * transform (the shared-transform law: render and pick cannot drift). A hit
 * resolves through ownerOf(slotIndex) — the mirror of the glyph channel's
 * resolveSlot convention.
 *
 * WebGPU-only, like the byte pipeline it backs (TSL NodeMaterials).
 */

import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
    Fn, attribute, uniform, texture, textureLoad, varying,
    uv, vec2, vec3, vec4, float, int, uint, ivec2,
    positionLocal, instanceIndex, modelViewMatrix, cameraProjectionMatrix,
    If, cross, bitAnd, select, mix, smoothstep, min, max, fwidth, time, sin,
} from 'three/tsl';
import { RENDER_ORDER } from '../core/renderOrder.js';
import { BORDER_FLAGS, PANEL_BORDER_WIDTH } from './panelMaterial.js';

const TAU = Math.PI * 2;
const _fillColor = new THREE.Color();

/**
 * The shared panel-instance → clip transform, emitted into a caller's Fn body.
 * Both the render material and the pick material build from this one graph —
 * the same discipline as core/glyphVertex.js for glyphs.
 *
 * Instance lanes (declared by name, bound to the field's geometry):
 *   panelRect vec4 — center x, center y, width, height (owner-node local)
 *   panelAux  vec4 — z, groupId, visible, reserved
 *
 * Culls (degenerate to outside-NDC — a vertex can't Discard): the visible bit,
 * and the group's alpha lane (a hidden/dead view hides its panel). The glyph
 * clip WINDOW is deliberately not applied — a panel spans the whole window.
 *
 * @param {Object} p
 * @param {Object} p.groupTex - texture node resolving to the field's group DataTexture
 * @returns {{ clipPos, gColor }}
 */
export function buildPanelVertexTransform({ groupTex }) {
    const rect = attribute('panelRect', 'vec4');
    const aux  = attribute('panelAux', 'vec4');

    const grow   = int(aux.y);
    const gPos   = textureLoad(groupTex, ivec2(int(0), grow)); // col 0: offset
    const gQuat  = textureLoad(groupTex, ivec2(int(1), grow)); // col 1: quaternion
    const gColor = textureLoad(groupTex, ivec2(int(2), grow)); // col 2: color (a = visibility)
    const gScale = textureLoad(groupTex, ivec2(int(3), grow)); // col 3: scale

    // Owner-local quad → the group's full TRS (the exact glyph chain, minus the
    // per-glyph sizing): scale about the group origin, quat sandwich, offset.
    const local = vec3(positionLocal.xy.mul(rect.zw).add(rect.xy), aux.x).mul(gScale.xyz);
    const qc    = cross(gQuat.xyz, local).add(local.mul(gQuat.w));
    const posed = local.add(cross(gQuat.xyz, qc).mul(2)).add(gPos.xyz);
    const clipPos = cameraProjectionMatrix.mul(modelViewMatrix.mul(vec4(posed, float(1))));

    const outClip = clipPos.toVar();
    const OFF = () => vec4(float(2), float(2), float(2), float(1));
    If(aux.z.lessThan(0.5).or(gColor.a.lessThan(0.01)), () => { outClip.assign(OFF()); });

    return { clipPos: outClip, gColor };
}

export default class PanelField {
    /**
     * @param {Object} p
     * @param {THREE.Scene} p.scene - the mesh lives at the scene root (pose is all texel)
     * @param {import('../GlyphField.js').default} p.field - the group-texture owner (the mega glyph field)
     * @param {number} [p.capacity=2048] - initial instance capacity (grows ×2)
     */
    constructor({ scene, field, capacity = 2048 }) {
        if (!scene || !field) throw new Error('PanelField: scene + field (group-texture owner) are required');
        this.isPanelField = true;
        this.field = field;

        /** slot → owner (the FileRow/grid a pick hit resolves to). */
        this._owners = [];
        this._freeSlots = [];
        this._count = 0;        // high-water instance count (freed slots stay culled)
        this._capacity = 0;

        const geometry = new THREE.InstancedBufferGeometry();
        const base = new THREE.PlaneGeometry(1, 1);
        geometry.index = base.index;
        geometry.attributes.position = base.attributes.position;
        geometry.attributes.uv = base.attributes.uv;
        geometry.instanceCount = 0;
        this._geometry = geometry;
        this._ensureCapacity(capacity);

        // Shared border/state uniforms — one interaction vocabulary for every
        // panel in the field (per-panel state is the flags LANE; these are the
        // colors/width the states render with). Same defaults as panelMaterial.
        this._u = {
            borderColor: uniform(new THREE.Color(0xffffff)),
            borderWidth: uniform(PANEL_BORDER_WIDTH),
            borderIntensity: uniform(1),
            hover: uniform(new THREE.Color(0x9fd2ff)),
            focus: uniform(new THREE.Color(0x6ee7a0)),
            input: uniform(new THREE.Color(0xf0b45a)),
            capture: uniform(new THREE.Color(0xff7a18)),
        };

        this.mesh = new THREE.Mesh(geometry, this._buildRenderMaterial());
        this.mesh.name = 'panel-field';
        this.mesh.renderOrder = RENDER_ORDER.GRID_BACKGROUND;
        this.mesh.frustumCulled = false;   // spans the whole field, like the mega mesh
        this.mesh.raycast = () => {};      // GPU picking only
        // The group-texture node resolves per object from here — the same seam
        // GlyphField's shared materials use, so texture growth re-binds for free.
        this.mesh.userData.glyphField = field;
        scene.add(this.mesh);

        this._pickingSystem = null;
        this._pickMaterial = null;
        this._pickKey = null;
    }

    // ── Slots ────────────────────────────────────────────────────────────────

    /**
     * Claim a panel slot. Born hidden with zeroed lanes — setRect/setFill/
     * setVisible light it up.
     * @param {*} owner - what a pick hit resolves to (ownerOf)
     * @param {number} groupId - the owner view's group in the field's texture
     * @returns {number} slot
     */
    alloc(owner, groupId) {
        let slot = this._freeSlots.pop();
        if (slot === undefined) {
            if (this._count >= this._capacity) this._ensureCapacity(this._capacity * 2);
            slot = this._count++;
            this._geometry.instanceCount = this._count;
        }
        this._owners[slot] = owner;
        this._writeAux(slot, 0, groupId, 0);
        this._write('panelRect', slot, 0, 0, 0, 0);
        this._write('panelFill', slot, 0, 0, 0, 0);
        this._write('panelFlags', slot, 0);
        return slot;
    }

    /** Release a slot: hidden, pointed at the dead group, owner dropped. */
    free(slot) {
        if (slot == null || this._owners[slot] === undefined) return;
        this._owners[slot] = null;
        this._writeAux(slot, 0, 0, 0);
        this._write('panelFlags', slot, 0);
        this._freeSlots.push(slot);
    }

    /** The pick-resolution mirror of MegaGlyphField.resolveSlot. */
    ownerOf(slot) {
        return this._owners[slot] ?? null;
    }

    // ── Lanes ────────────────────────────────────────────────────────────────

    /** Rect in the owner node's local frame: center + full size + z. */
    setRect(slot, cx, cy, width, height, z = 0) {
        this._write('panelRect', slot, cx, cy, width, height);
        const aux = this._geometry.attributes.panelAux;
        aux.array[slot * 4] = z;
        this._touch(aux, slot, 4);
    }

    /**
     * Fill color (hex int or THREE.Color-compatible) + opacity, as u8 lanes.
     * Stored as raw DISPLAY (sRGB) bytes — exact in u8, no dark-fill banding —
     * and decoded to working space in the fragment (the glyph-color discipline;
     * see the TSL color-management gotcha).
     */
    setFill(slot, color, opacity) {
        _fillColor.set(color).convertLinearToSRGB();   // undo set()'s managed sRGB→linear
        this._write('panelFill', slot,
            Math.round(_fillColor.r * 255), Math.round(_fillColor.g * 255),
            Math.round(_fillColor.b * 255), Math.round(THREE.MathUtils.clamp(opacity, 0, 1) * 255));
    }

    setVisible(slot, v) {
        const aux = this._geometry.attributes.panelAux;
        aux.array[slot * 4 + 2] = v ? 1 : 0;
        this._touch(aux, slot, 4);
    }

    /** Re-point a slot at another group texel (actor swap keeps the panel). */
    setGroup(slot, groupId) {
        const aux = this._geometry.attributes.panelAux;
        aux.array[slot * 4 + 1] = groupId;
        this._touch(aux, slot, 4);
    }

    /** The owner's whole BORDER_FLAGS bit-set (not a mask flip — owners keep their own). */
    setFlags(slot, flags) {
        this._write('panelFlags', slot, flags & 0xFF);
    }

    // ── Field-wide style (the panelMaterial handle surface, shared) ──────────

    /** Identity border color / width(px) / master intensity. */
    setBorder({ color, width, intensity } = {}) {
        if (color != null) this._u.borderColor.value.set(color);
        if (width != null) this._u.borderWidth.value = width;
        if (intensity != null) this._u.borderIntensity.value = intensity;
    }

    /** Restyle the hover/focus/input/capture state colors live. */
    setStateColors({ hover, focus, input, capture } = {}) {
        if (hover != null) this._u.hover.value.set(hover);
        if (focus != null) this._u.focus.value.set(focus);
        if (input != null) this._u.input.value.set(input);
        if (capture != null) this._u.capture.value.set(capture);
    }

    // ── Picking ──────────────────────────────────────────────────────────────

    /**
     * ONE 'grid'-channel registration for the whole field, at CAPACITY (the
     * mega-field discipline: a stable block, hidden slots are vertex-culled so
     * they can never be picked). Re-registers only when capacity grows.
     */
    registerPicking(ps) {
        if (ps) this._pickingSystem = ps;
        const sys = this._pickingSystem;
        const key = `${this._capacity}`;
        if (!sys || this._pickKey === key) return;
        if (!this._pickMaterial) this._pickMaterial = this._buildPickMaterial();
        sys.register('grid', this.mesh, this, { count: this._capacity, material: this._pickMaterial });
        this._pickKey = key;
    }

    // ── Internals ────────────────────────────────────────────────────────────

    /** @private grow the instance lanes to n, preserving existing values. */
    _ensureCapacity(n) {
        if (this._capacity >= n) return;
        const geom = this._geometry;
        for (const [name, itemSize, Ctor, normalized] of [
            ['panelRect', 4, Float32Array, false],
            ['panelAux', 4, Float32Array, false],
            ['panelFill', 4, Uint8Array, true],
            ['panelFlags', 1, Uint8Array, false],
        ]) {
            const old = geom.attributes[name];
            const arr = new Ctor(n * itemSize);
            if (old) arr.set(old.array.subarray(0, Math.min(old.array.length, arr.length)));
            geom.setAttribute(name, new THREE.InstancedBufferAttribute(arr, itemSize, normalized));
        }
        this._capacity = n;
        this.registerPicking(null);   // re-block at the new capacity if registered
    }

    /** @private */
    _write(name, slot, ...values) {
        const attr = this._geometry.attributes[name];
        const base = slot * attr.itemSize;
        for (let i = 0; i < values.length; i++) attr.array[base + i] = values[i];
        this._touch(attr, slot, attr.itemSize);
    }

    /** @private */
    _writeAux(slot, z, groupId, visible) {
        this._write('panelAux', slot, z, groupId, visible, 0);
    }

    /** @private (three clears update ranges after render — never manually) */
    _touch(attr, slot, itemSize) {
        attr.addUpdateRange(slot * itemSize, itemSize);
        attr.needsUpdate = true;
    }

    /** @private texture node resolving the field's LIVE group texture per draw. */
    _groupTexNode() {
        const placeholder = new THREE.DataTexture(new Float32Array(4), 1, 1, THREE.RGBAFormat, THREE.FloatType);
        placeholder.minFilter = placeholder.magFilter = THREE.NearestFilter;
        placeholder.generateMipmaps = false;
        placeholder.needsUpdate = true;
        return texture(placeholder).onObjectUpdate(({ object }, self) => {
            const f = object && object.userData && object.userData.glyphField;
            return (f && f._groupTexture) || self.value;
        });
    }

    /** @private the fill + border fragment (panelMaterial's shader, per-instance state). */
    _buildRenderMaterial() {
        const groupTex = this._groupTexNode();
        const vFill  = varying(vec4(0), 'vPanelFill');
        const vFlags = varying(float(0), 'vPanelFlags');
        const vAlpha = varying(float(1), 'vPanelAlpha');

        const vertexFn = Fn(() => {
            const { clipPos, gColor } = buildPanelVertexTransform({ groupTex });
            vFill.assign(attribute('panelFill', 'vec4'));
            vFlags.assign(attribute('panelFlags', 'float'));
            vAlpha.assign(gColor.a);
            return clipPos;
        });

        const u = this._u;
        const F = BORDER_FLAGS;
        const flags = uint(vFlags.add(0.5));   // u8 lane, exact through interpolation
        const has = (mask) => bitAnd(flags, uint(mask)).greaterThan(uint(0));
        const on = flags.greaterThan(uint(0));
        const anyState = has(F.HOVERED | F.FOCUSED | F.INPUT | F.CAPTURED);
        const accent = has(F.FOCUSED | F.INPUT | F.CAPTURED);

        const stateCol = select(has(F.CAPTURED), u.capture,
                           select(has(F.INPUT), u.input,
                             select(has(F.FOCUSED), u.focus, u.hover)));
        const pulse = select(has(F.HOVERED), sin(time.mul(TAU * 1.1)).mul(0.5).add(0.5).mul(0.2).add(0.85), float(1));
        const borderCol = select(anyState, stateCol, u.borderColor).mul(pulse);

        const w = u.borderWidth.mul(select(has(F.CAPTURED), float(2.6), select(accent, float(1.6), float(1))));
        const edge = vec2(0.5, 0.5).sub(uv().sub(0.5).abs());
        const px = edge.div(max(fwidth(edge), float(1e-6)));
        const d = min(px.x, px.y);
        const band = smoothstep(w.sub(float(0.5)), w.add(float(0.5)), d).oneMinus();
        const rim = band.mul(select(on, u.borderIntensity, float(0)));

        const material = new MeshBasicNodeMaterial();
        material.transparent = true;      // fills are translucent by theme; depth still writes
        material.side = THREE.DoubleSide;
        material.depthWrite = true;
        material.vertexNode = vertexFn();
        // The fill lane carries display (sRGB) bytes — decode to working space so
        // the output encode round-trips it; the border uniforms are already managed.
        material.colorNode = mix(vFill.rgb.pow(vec3(2.2, 2.2, 2.2)), borderCol, rim);
        material.opacityNode = max(vFill.a, rim).mul(vAlpha);
        return material;
    }

    /** @private same vertex transform, ID = block base + instanceIndex. */
    _buildPickMaterial() {
        const groupTex = this._groupTexNode();
        const baseId = uniform(0).onObjectUpdate(({ object }, self) =>
            (object && object.userData.pickStartId != null) ? object.userData.pickStartId : self.value);

        const vertexFn = Fn(() => buildPanelVertexTransform({ groupTex }).clipPos);
        const fragmentFn = Fn(() => {
            const id = int(baseId).add(int(instanceIndex));
            const r = id.shiftRight(16).bitAnd(0xFF);
            const g = id.shiftRight(8).bitAnd(0xFF);
            const b = id.bitAnd(0xFF);
            const a = id.shiftRight(24).bitAnd(0xFF);
            return vec4(float(r).div(255.0), float(g).div(255.0), float(b).div(255.0), float(a).div(255.0));
        });

        const material = new MeshBasicNodeMaterial();
        material.vertexNode = vertexFn();
        material.outputNode = fragmentFn();
        material.side = THREE.DoubleSide;
        material.depthWrite = true;   // nearest panel wins in an overlap
        return material;
    }

    dispose() {
        if (this._pickingSystem) this._pickingSystem.unregister?.('grid', this.mesh);
        this.mesh.parent?.remove(this.mesh);
        this._geometry.dispose();
        this.mesh.material.dispose();
        this._pickMaterial?.dispose();
        this._owners = [];
        this._freeSlots = [];
    }
}
