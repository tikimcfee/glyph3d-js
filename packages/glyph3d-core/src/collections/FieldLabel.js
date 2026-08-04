import * as THREE from 'three';
import GlyphField from '../GlyphField.js';
import { bakePillTexture } from '../components/plateBake.js';

// Plate bake resolution (pixels). Resolution only — world size comes from the plate geometry.
const PLATE_PX_H = 96;
// Plate overhang around the text block, in text-row units (a pill needs breathing room).
const PLATE_PAD_X = 0.72, PLATE_PAD_Y = 0.42;

/**
 * FieldLabel — an editable, addressable text label: a GlyphField text layer (the same
 * instanced pipeline as grid content) over an optional baked pill plate. The special case of
 * a CodeGrid with labeling primitives instead of code primitives: no file backing, no syntax
 * colorizer, no caret — just setText().
 *
 * Why a field and not a baked texture (Label3D): edits are LIVE (setText rebuilds the
 * label's handful of glyphs synchronously — sub-ms, no worker round trip) and the label is
 * an ordinary entity — registered under an id, moved/docked/deleted by the same verbs as
 * anything else. The plate stays baked (it only changes with color/size); the TEXT is what
 * needed the field.
 *
 * Layout: the label's ORIGIN is the center of its block (text + plate), so callers place it
 * like the baked plates did. `lineHeight` is the world-unit row pitch at scale 1 — callers
 * size text in cell rows of a related grid (the dock's labelLines rule). Multi-line text
 * ('\n') stacks natively. Pick-inert (isMarker): addressability is registry/verbs, not
 * clicks. Frustum culling works — the label states its own extent in closed form.
 */
export default class FieldLabel extends THREE.Object3D {
    /**
     * @param {Object} o
     * @param {Object} o.atlas            GlyphAtlas (shaper optional — mono fallback without it)
     * @param {string} [o.text='']        label text ('\n' stacks lines)
     * @param {number} [o.lineHeight=1]   world-unit row pitch at scale 1
     * @param {Object} [o.textColor={r,g,b}] glyph color (dark reads on the bright pill)
     * @param {Object|null} [o.plate]     { color:hex, opacity:0..1 } — the backing pill; null = bare text
     * @param {number} [o.maxInstances=512] field capacity; the field is recreated on overflow
     */
    constructor({ atlas, text = '', lineHeight = 1, textColor = { r: 0.03, g: 0.04, b: 0.06 }, plate = null, maxInstances = 512 } = {}) {
        super();
        this.atlas = atlas;
        this.textColor = textColor;
        this.lineHeight = lineHeight;
        this._plateCfg = plate;
        this._maxInstances = maxInstances;
        this._field = null;
        this._plate = null;      // { mesh, key } — key tracks color+aspect to skip idle rebakes
        this._text = '';
        this._textBlock = { w: 0, h: 0 }; // measured text extent at scale 1
        this.userData.isMarker = true;    // pick-inert: addressability is registry/verbs, not clicks
        this.name = 'FieldLabel';
        this.setText(text);
    }

    /** @returns {string} the current text */
    get text() { return this._text; }

    /** Plate width/height at scale 1 (the text block's when plateless) — the placement
     *  contract baked-plate callers (CameraDock._placeLabel) already use. */
    get width() { return this._plate ? this._plate.mesh.geometry.parameters.width : this._textBlock.w; }
    get height() { return this._plate ? this._plate.mesh.geometry.parameters.height : this._textBlock.h; }

    /** Replace the text — a synchronous rebuild of the label's few glyphs. Live-editable:
     *  this is THE labeling primitive the verbs (label.set / label.append) drive. */
    setText(text) {
        text = String(text ?? '');
        if (text === this._text && this._field) return;
        this._text = text;
        this._rebuildField();
    }

    /** Repaint the plate in a new color (no-op when plateless or unchanged). */
    setPlateColor(hex) {
        if (!this._plateCfg || hex === this._plateCfg.color) return;
        this._plateCfg.color = hex;
        this._refreshPlate(true);
    }

    /** Fade the whole label (plate opacity + text group alpha). */
    setOpacity(v) {
        if (this._plate) this._plate.mesh.material.opacity = v;
        this._field?.setGroupAlpha(0, v);
    }

    /** Local-space bounds of the whole label (plate, or the text block when plateless). */
    getLocalBounds() {
        const w = this.width / 2, h = this.height / 2;
        return new THREE.Box3(new THREE.Vector3(-w, -h, 0), new THREE.Vector3(w, h, 0));
    }

    dispose() {
        this._disposeField();
        if (this._plate) {
            this.remove(this._plate.mesh);
            this._plate.mesh.geometry.dispose();
            this._plate.mesh.material.map?.dispose();
            this._plate.mesh.material.dispose();
            this._plate = null;
        }
    }

    // ============ Private ============

    /** (Re)build the text field from scratch: dispose + recreate + render + measure + center
     *  + state the cull extent. Wholesale rebuild is the architecture's honest edit path
     *  (ContentTreeLabels does the same) — at label scale it's sub-millisecond. @private */
    _rebuildField() {
        this._disposeField();
        const lineCount = Math.max(this._text.split('\n').length, 1);
        const needed = Math.max(this._text.length + 16, 64); // grows past maxInstances on overflow
        this._field = new GlyphField(this, this.atlas, {
            maxInstances: Math.max(needed, this._maxInstances),
            defaultColor: this.textColor,
            worldScale: 1,
            frustumCulled: true,
        });

        if (this._text) {
            const scale = this.lineHeight / this._rowPitch();
            this._field.render(this._text, { x: 0, y: 0, z: 0 }, { color: this.textColor, scale });
        }

        // Measure the text block from the instance buffers (exact for the shaped AND mono paths),
        // then center the block on the origin by offsetting the mesh — no buffer rewrites.
        const { minX, maxX, count } = this._measureGlyphs();
        const blockW = count ? maxX - minX : 0;
        const blockH = lineCount * this.lineHeight;
        const mesh = this._field.instanceMesh;
        mesh.position.set(
            count ? -(minX + maxX) / 2 : 0,
            (lineCount - 1) * this.lineHeight / 2, // lines advance DOWN from y=0 → recenter the stack
            0,
        );
        this._textBlock = { w: blockW, h: blockH };

        // State the cull extent in field-local space (positions only — the mesh offset above
        // is an ordinary Object3D transform three sees on its own).
        if (count) {
            this._field.setLayoutExtent({
                min: { x: minX, y: -blockH + this.lineHeight / 2, z: -0.01 },
                max: { x: maxX, y: this.lineHeight / 2, z: 0.01 },
            });
        }
        this._refreshPlate(false);
    }

    /** The field's row pitch at scale 1, mirroring GlyphField's own line math (shaped when a
     *  shaper is live, the mono metric otherwise) — so scale = lineHeight / pitch is exact. @private */
    _rowPitch() {
        const shaper = this._field._shaper;
        if (shaper) {
            const fe = shaper.fontExtents();
            return ((fe.ascender - fe.descender + fe.lineGap) / shaper.upem) * this._field.metrics.pixelHeight;
        }
        return this._field.metrics.lineSpacing;
    }

    /** Min/max glyph X (left edges + advance widths) over the live instance buffers. @private */
    _measureGlyphs() {
        const geom = this._field.instanceMesh.geometry;
        const pos = geom.attributes.instancePosition, siz = geom.attributes.instanceSize;
        const stride = pos.itemSize;
        let minX = Infinity, maxX = -Infinity;
        for (let i = 0; i < geom.instanceCount; i++) {
            const x = pos.array[i * stride];
            minX = Math.min(minX, x);
            maxX = Math.max(maxX, x + siz.array[i * 2]);
        }
        return { minX, maxX, count: geom.instanceCount };
    }

    /** Size/rebake the plate around the measured text block (origin-centered, behind the
     *  glyphs). Rebakes the texture only when color or rounded pixel dims change. @private */
    _refreshPlate(force) {
        if (!this._plateCfg) return;
        const w = Math.max(this._textBlock.w + PLATE_PAD_X * this.lineHeight * 2, this.lineHeight);
        const h = this._textBlock.h + PLATE_PAD_Y * this.lineHeight * 2;
        const pxW = Math.max(Math.round((w / h) * PLATE_PX_H), 8);
        const key = `${pxW}x${PLATE_PX_H}:${this._plateCfg.color}`;
        if (!this._plate) {
            const texture = bakePillTexture(pxW, PLATE_PX_H, this._plateCfg.color);
            const mesh = new THREE.Mesh(
                new THREE.PlaneGeometry(w, h),
                new THREE.MeshBasicMaterial({ map: texture, transparent: true, opacity: this._plateCfg.opacity ?? 0.85, depthTest: true, depthWrite: false }),
            );
            mesh.position.z = -0.01; // behind the glyphs
            mesh.userData.isMarker = true;
            this.add(mesh);
            this._plate = { mesh, key };
            return;
        }
        const mesh = this._plate.mesh;
        mesh.geometry.dispose();
        mesh.geometry = new THREE.PlaneGeometry(w, h);
        if (force || key !== this._plate.key) {
            mesh.material.map?.dispose();
            mesh.material.map = bakePillTexture(pxW, PLATE_PX_H, this._plateCfg.color);
            mesh.material.needsUpdate = true;
            this._plate.key = key;
        }
    }

    /** @private */
    _disposeField() {
        if (!this._field) return;
        this.remove(this._field.instanceMesh);
        this._field.dispose();
        this._field = null;
    }
}
