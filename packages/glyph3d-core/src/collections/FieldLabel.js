import * as THREE from 'three';
import { getPipelineArena } from '../compute/GlyphLayoutCompute.js';
import { ensureMegaField } from '../MegaGlyphField.js';
import { bakeFile } from '../compute/glyphBake.js';
import { computeCellMetrics } from '../core/cellMetrics.js';

// Plate overhang around the text block, in text-row units (a pill needs breathing room).
const PLATE_PAD_X = 0.72, PLATE_PAD_Y = 0.42;
// Corner radius as a fraction of plate height — the bakePillCanvas look (r = min(0.34h, 22px)
// at the 96px bake ≈ 0.23h).
const PLATE_RADIUS = 0.23;

const _encoder = new TextEncoder();

/**
 * FieldLabel — an editable, addressable text label on the SHARED substrates: the
 * text is an arena item + mega-field view (the FileRow filename pattern, wrap 0),
 * the optional pill plate is a PanelField slot riding the same group texel. A
 * label costs attribute writes, not meshes — no private GlyphField, no baked
 * CanvasTexture, no draw calls of its own.
 *
 * Measure is CPU truth, synchronous: `bakeFile` folds the label's bytes through
 * the arena's trie — the exact advances the GPU lays (the bake gate proves them
 * bit-identical) — so `.width`/`.height` answer in the construction tick even
 * though glyph staging lands on the next arena flush. Shaper-less (headless)
 * the mono cell advance stands in, mirroring the trie's own missing-block rule.
 *
 * Layout: the label's ORIGIN is the center of its block (text + plate), so
 * callers place it like the baked plates did. `lineHeight` is the world-unit row
 * pitch at scale 1 — an internal anchor node scales the staged metrics-pitch
 * rows to it, and the anchor IS the view's pose source (label moves/scales/
 * billboards are ordinary Object3D transforms the pose sweep mirrors; node
 * visibility mirrors into the view's alpha the same way). Multi-line ('\n')
 * stacks natively. Pick-inert (isMarker): addressability is registry/verbs.
 */
export default class FieldLabel extends THREE.Object3D {
    /**
     * @param {Object} o
     * @param {Object} o.atlas            GlyphAtlas (metrics + the substrate's shaping identity)
     * @param {string} [o.text='']        label text ('\n' stacks lines)
     * @param {number} [o.lineHeight=1]   world-unit row pitch at scale 1
     * @param {Object} [o.textColor={r,g,b}] glyph color (dark reads on the bright pill)
     * @param {Object|null} [o.plate]     { color:hex, opacity:0..1 } — the backing pill; null = bare text
     */
    constructor({ atlas, text = '', lineHeight = 1, textColor = { r: 0.03, g: 0.04, b: 0.06 }, plate = null } = {}) {
        super();
        this.atlas = atlas;
        this.textColor = textColor;
        this.lineHeight = lineHeight;
        this._plateCfg = plate;
        this._plateAlpha = plate?.opacity ?? 0.85;
        this._text = '';
        this._block = { wu: 0, rows: 1 };   // text block in STAGE units (metrics pitch)
        this._plateDims = null;             // { w, h } in stage units, when plated
        this._mLine = 1;                    // metrics row pitch (stage-unit lineHeight)
        this._view = null;                  // MegaFieldView (created on first staging)
        this._pipeline = null;              // the staged arena item
        this._panelSlot = null;             // PanelField slot, when plated
        this._panels = null;                // the panel field the slot came from
        this._staged = false;
        this.userData.isMarker = true;      // pick-inert: addressability is registry/verbs, not clicks
        this.name = 'FieldLabel';

        // The staged rows live under a scaled anchor: stage-space (metrics pitch,
        // rows down from y=0) → block-centered label space at `lineHeight` pitch.
        this._anchor = new THREE.Object3D();
        this._anchor.name = 'FieldLabel:anchor';
        this.add(this._anchor);

        // A label is usually built BEFORE it is parented — the substrate needs a
        // scene root, so staging retries when the label lands in one.
        this.addEventListener('added', () => { if (!this._staged) this._restage(); });

        this.setText(text);
    }

    /** @returns {string} the current text */
    get text() { return this._text; }

    /** Plate width/height at scale 1 (the text block's when plateless) — the placement
     *  contract baked-plate callers (CameraDock._placeLabel) already use. */
    get width() {
        const s = this.lineHeight / this._mLine;
        return (this._plateDims ? this._plateDims.w : this._block.wu) * s;
    }
    get height() {
        const s = this.lineHeight / this._mLine;
        return (this._plateDims ? this._plateDims.h : this._block.rows * this._mLine) * s;
    }

    /** Replace the text — measure is synchronous (the CPU fold); the glyphs land
     *  on the next arena flush. THE labeling primitive label.set/append drive. */
    setText(text) {
        text = String(text ?? '');
        if (text === this._text && this._staged) return;
        this._text = text;
        this._restage();
    }

    /** Re-pitch the label (rebind path). Pure geometry: the staged bytes live at
     *  the metrics pitch and only the anchor/plate transforms carry lineHeight. */
    setLineHeight(lh) {
        if (!(lh > 0) || lh === this.lineHeight) return;
        this.lineHeight = lh;
        this._applyGeometry();
    }

    /** Repaint the plate in a new color (no-op when plateless or unchanged). */
    setPlateColor(hex) {
        if (!this._plateCfg || hex === this._plateCfg.color) return;
        this._plateCfg.color = hex;
        this._applyPlateStyle();
    }

    /** Fade the whole label: the view's alpha lane fades glyphs AND the plate
     *  (the plate's fill alpha resets to 1 so the net plate opacity IS v). */
    setOpacity(v) {
        this._view?.setGroupAlpha(0, v);
        if (this._plateCfg) { this._plateAlpha = v > 0 ? 1 : 0; this._applyPlateStyle(); }
    }

    /** Local-space bounds of the whole label (plate, or the text block when plateless). */
    getLocalBounds() {
        const w = this.width / 2, h = this.height / 2;
        return new THREE.Box3(new THREE.Vector3(-w, -h, 0), new THREE.Vector3(w, h, 0));
    }

    dispose() {
        this._pipeline?.dispose?.();
        this._pipeline = null;
        if (this._panelSlot != null) {
            this._panels?.free(this._panelSlot);
            this._panelSlot = null;
            this._panels = null;
        }
        this._view?.dispose();
        this._view = null;
        this._staged = false;
    }

    // ============ Private ============

    /** The plate's fill write (Tab3D's hover/active opacity rides this). @protected */
    _setPlateAlpha(a) {
        this._plateAlpha = a;
        this._applyPlateStyle();
    }

    /** @private */
    _applyPlateStyle() {
        if (this._panelSlot == null) return;
        this._panels.setFill(this._panelSlot, this._plateCfg.color, this._plateAlpha);
    }

    /**
     * The substrate seam: the arena's one mega field, created here only when the
     * label is already scene-rooted (the mesh needs a scene). @private
     * @returns {import('../MegaGlyphField.js').default|null}
     */
    _substrate() {
        const arena = getPipelineArena();
        if (!arena) {
            if (!FieldLabel._noArenaNoted) {
                FieldLabel._noArenaNoted = true;
                console.error('FieldLabel: no pipeline arena — labels need the byte pipeline (WebGPU); text renders EMPTY');
            }
            return null;
        }
        if (!arena.megaField) {
            let root = this;
            while (root.parent) root = root.parent;
            if (!root.isScene) return null;   // not in a scene yet — the 'added' listener retries
            ensureMegaField(arena, {
                scene: root, atlas: this.atlas, worldScale: arena.worldScale,
                slugData: this.atlas?._slugData, shaper: this.atlas?._shaper,
            });
        }
        return arena.megaField;
    }

    /** Measure the block in stage units — the trie fold (exact GPU advances) or,
     *  shaper-less, the mono cell advance the trie's missing block would use. @private */
    _measure() {
        const arena = getPipelineArena();
        const ws = arena?.worldScale ?? 0.025;
        const cm = computeCellMetrics(this.atlas.getCharSize(), ws);
        this._mLine = cm.lineSpacing;
        const rows = Math.max(this._text.split('\n').length, 1);
        let wu = 0;
        if (this._text) {
            if (arena?.trie) {
                wu = bakeFile(_encoder.encode(this._text), arena.trie, { lineHeight: cm.lineSpacing }).maxLineWidth;
            } else {
                for (const line of this._text.split('\n')) {
                    wu = Math.max(wu, [...line].length * cm.charWidth);
                }
            }
        }
        this._block = { wu, rows };
        this._plateDims = this._plateCfg
            ? { w: Math.max(wu + 2 * PLATE_PAD_X * this._mLine, this._mLine), h: rows * this._mLine + 2 * PLATE_PAD_Y * this._mLine }
            : null;
    }

    /** Land the anchor transform + the plate's geometry lanes from the current
     *  measure. Stage space: rows hang DOWN from y=0, row k cell = [-kL, -kL+L),
     *  x ∈ [0, wu]; the anchor maps the block's center onto the label origin at
     *  `lineHeight` pitch. @private */
    _applyGeometry() {
        const { wu, rows } = this._block;
        const L = this._mLine;
        const s = this.lineHeight / L;
        const cx = wu / 2, cy = L * (2 - rows) / 2;
        this._anchor.scale.setScalar(s);
        this._anchor.position.set(-cx * s, -cy * s, 0);
        if (this._panelSlot != null && this._plateDims) {
            const p = this._plateDims;
            this._panels.setRect(this._panelSlot, cx, cy, p.w, p.h, -0.01 / s);
            this._panels.setRadius(this._panelSlot, p.h * PLATE_RADIUS);
        }
    }

    /** Measure + re-anchor + (re)stage text and plate. Measure always lands (the
     *  sync contract); staging lands when the substrate is reachable. @private */
    _restage() {
        this._measure();
        const mega = this._substrate();
        if (!mega) {
            this._applyGeometry();   // the anchor is still true — only staging waits
            return;
        }
        const arena = mega.arena;
        if (!this._view) this._view = mega.createView({ node: this._anchor, color: this.textColor });

        this._pipeline?.dispose?.();
        this._pipeline = null;
        if (this._text) {
            this._pipeline = arena.stage({
                bytes: _encoder.encode(this._text),
                origin: { x: 0, y: 0, z: 0 },
                page: null, wrapWidth: 0, lineHeight: this._mLine, zStep: 0,
                field: this._view,
            });
            arena.requestFlush();
        } else {
            this._view.clear();
        }

        if (this._plateCfg && this._panelSlot == null) {
            this._panels = mega.labelPanels ?? mega.panels;
            this._panelSlot = this._panels.alloc(null, this._view.groupId);
            this._panels.setVisible(this._panelSlot, true);
        }
        this._applyGeometry();
        if (this._plateCfg) this._applyPlateStyle();
        this._staged = true;
    }
}
