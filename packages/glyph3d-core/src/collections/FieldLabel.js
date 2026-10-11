import * as THREE from 'three';
import { computeCellMetrics } from '../core/cellMetrics.js';
import { BORDER_FLAGS, createPanelMaterial } from './panelMaterial.js';
import InstancedField from './InstancedField.js';

// Plate overhang around the text block, in text-row units (a pill needs breathing room).
const PLATE_PAD_X = 0.72, PLATE_PAD_Y = 0.42;

function normalizeTextColor(c, plate) {
    if (c != null) {
        if (typeof c === 'number') {
            return {
                r: ((c >> 16) & 0xFF) / 255,
                g: ((c >> 8) & 0xFF) / 255,
                b: (c & 0xFF) / 255,
                a: 1.0,
            };
        }
        return {
            r: c.r ?? 1,
            g: c.g ?? 1,
            b: c.b ?? 1,
            a: c.a ?? 1,
        };
    }
    return plate ? { r: 0.03, g: 0.04, b: 0.06 } : { r: 0.95, g: 0.95, b: 0.98 };
}

/**
 * FieldLabel — an editable, addressable text label using InstancedField and
 * panelMaterial in pure WebGL2.
 */
export default class FieldLabel extends THREE.Object3D {
    /**
     * @param {Object} o
     * @param {Object} o.atlas            GlyphAtlas (metrics + shaping)
     * @param {string} [o.text='']        label text ('\n' stacks lines)
     * @param {number} [o.lineHeight=1]   world-unit row pitch at scale 1
     * @param {number|Object} [o.textColor] glyph color (hex or {r,g,b})
     * @param {Object|null} [o.plate]     { color:hex, opacity:0..1, hairline:true } — backing pill
     */
    constructor({ atlas, text = '', lineHeight = 1, textColor = null, plate = null } = {}) {
        super();
        this.atlas = atlas;
        this.textColor = normalizeTextColor(textColor, plate);
        this.lineHeight = lineHeight;
        this._plateCfg = plate;
        this._plateAlpha = plate?.opacity ?? 0.85;
        this._text = '';
        this._block = { wu: 0, rows: 1 };
        this._plateDims = null;
        this._mLine = 1;
        this._instancedField = null;
        this._plateMesh = null;
        this._platePanel = null;
        this._staged = false;
        this.userData.isMarker = true;
        this.name = 'FieldLabel';

        this._anchor = new THREE.Object3D();
        this._anchor.name = 'FieldLabel:anchor';
        this.add(this._anchor);

        if (text) this.setText(text);
        else this._measure();
    }

    get text() { return this._text; }
    get width() {
        const s = this.lineHeight / this._mLine;
        return (this._plateDims ? this._plateDims.w : this._block.wu) * s;
    }
    get height() {
        const s = this.lineHeight / this._mLine;
        return (this._plateDims ? this._plateDims.h : this._block.rows * this._mLine) * s;
    }

    setText(text) {
        text = String(text ?? '');
        if (text === this._text && this._staged) return;
        this._text = text;
        this._restage();
    }

    setLineHeight(lh) {
        if (!(lh > 0) || lh === this.lineHeight) return;
        this.lineHeight = lh;
        this._applyGeometry();
    }

    setPlateColor(hex) {
        if (!this._plateCfg || hex === this._plateCfg.color) return;
        this._plateCfg.color = hex;
        this._applyPlateStyle();
    }

    setTextColor(color) {
        this.textColor = normalizeTextColor(color, this._plateCfg);
        if (this._instancedField) {
            this._instancedField.setGlyphColorRange(0, this._instancedField.getGlyphCount(), this.textColor);
        }
    }

    setOpacity(v) {
        this.opacity = v;
        if (this._instancedField?.instanceMesh) {
            this._instancedField.instanceMesh.visible = v > 0;
        }
        if (this._plateMesh) {
            this._plateAlpha = v;
            this._applyPlateStyle();
        }
    }

    getLocalBounds() {
        const w = this.width / 2, h = this.height / 2;
        return new THREE.Box3(new THREE.Vector3(-w, -h, 0), new THREE.Vector3(w, h, 0));
    }

    dispose() {
        this._instancedField?.dispose();
        this._instancedField = null;
        if (this._plateMesh) {
            this._plateMesh.geometry.dispose();
            this._plateMesh.material.dispose();
            this._plateMesh.parent?.remove(this._plateMesh);
            this._plateMesh = null;
            this._platePanel = null;
        }
        this._staged = false;
        this.parent?.remove(this);
    }

    /** The plate's fill write (Tab3D's hover/active opacity rides this). @protected */
    _setPlateAlpha(a) {
        this._plateAlpha = a;
        this._applyPlateStyle();
    }

    _applyPlateStyle() {
        if (!this._platePanel) return;
        this._platePanel.setFill(this._plateCfg.color, this._plateAlpha);
    }

    _measure() {
        const ws = 0.025;
        const cm = computeCellMetrics(this.atlas?.getCharSize?.() || { width: 9.6, height: 18 }, ws);
        this._mLine = cm.lineSpacing;
        const rows = Math.max(this._text.split('\n').length, 1);
        let wu = 0;
        if (this._text) {
            for (const line of this._text.split('\n')) {
                wu = Math.max(wu, [...line].length * cm.charWidth);
            }
        }
        this._block = { wu, rows };
        this._plateDims = this._plateCfg
            ? { w: Math.max(wu + 2 * PLATE_PAD_X * this._mLine, this._mLine), h: rows * this._mLine + 2 * PLATE_PAD_Y * this._mLine }
            : null;
    }

    _applyGeometry() {
        const { wu, rows } = this._block;
        const L = this._mLine;
        const s = this.lineHeight / L;
        const cx = wu / 2, cy = -rows * L / 2;
        this._anchor.scale.setScalar(s);
        this._anchor.position.set(-cx * s, -cy * s, 0);

        if (this._instancedField?.instanceMesh) {
            this._instancedField.instanceMesh.position.set(0, 0, 1 / s);
        }

        if (this._plateMesh && this._plateDims) {
            const p = this._plateDims;
            this._plateMesh.scale.set(p.w, p.h, 1);
            this._plateMesh.position.set(cx, cy, 0);
        }
    }

    _restage() {
        this._measure();
        if (!this._instancedField) {
            this._instancedField = new InstancedField(null, this.atlas, {
                worldScale: 0.025,
                slugData: this.atlas?._slugData,
                shaper: this.atlas?._shapeCache || this.atlas?._shaper,
                defaultColor: this.textColor,
            });
            this._anchor.add(this._instancedField.instanceMesh);
        }

        if (this._text) {
            this._instancedField.loadText(this._text, {
                color: this.textColor,
                origin: { x: 0, y: 0, z: 0 },
                wrapWidth: 0,
            });
        } else {
            this._instancedField.clear();
        }

        if (this._plateCfg && !this._plateMesh) {
            const geo = new THREE.PlaneGeometry(1, 1);
            this._platePanel = createPanelMaterial({
                color: this._plateCfg.color,
                opacity: this._plateAlpha,
                side: THREE.DoubleSide,
                depthWrite: true,
            });
            if (this._plateCfg.hairline !== false) {
                this._platePanel.setBorderFlag(BORDER_FLAGS.EDGE, true);
            }
            this._plateMesh = new THREE.Mesh(geo, this._platePanel.material);
            this._anchor.add(this._plateMesh);
        }

        this._applyGeometry();
        if (this._plateCfg) this._applyPlateStyle();
        this._staged = true;
    }
}
