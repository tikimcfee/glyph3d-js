import * as THREE from 'three';
import FieldLabel from '@glyph3d/core/collections/FieldLabel.js';
import { createPanelMaterial } from '@glyph3d/core/collections/panelMaterial.js';
import { enrollPanel } from '@glyph3d/core/collections/PanelBatch.js';
import { RENDER_ORDER } from '@glyph3d/core/core/renderOrder.js';

/** Title bar height on screen (CSS px) — constant, so names read at any zoom. */
export const TITLE_BAR_PX = 22;
/** Name text height as a fraction of the bar. */
const TEXT_FRACTION = 0.6;
/** Left inset of the name, in bar heights. */
const TEXT_INSET = 0.45;
/**
 * The strip colour AS DISPLAYED. The panel material is a raw ShaderMaterial: it writes its fill
 * uniform without three's output colour conversion, while `new THREE.Color(hex)` converts sRGB →
 * linear — so a hex fill displays darker than its hex (true engine-wide). Handing it a colour
 * already marked linear, holding the display values, writes exactly what's meant.
 * @param {number} hex @returns {THREE.Color}
 */
function displayColor(hex) {
    return new THREE.Color().setRGB(((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255, THREE.LinearSRGBColorSpace);
}
const FILL = { idle: displayColor(0x1f2633), focused: displayColor(0x16402c) };
const TEXT = { idle: 0xc4ccd8, focused: 0x8ef0b8 };

/**
 * TitleBar — a terminal's name strip, sitting on its top border. A child of the TerminalGrid, so it
 * rides every move; laid out in the grid's local units each time the zoom changes, at a constant
 * on-screen height (capped in world units so a far zoom-out can't stack a bar over the terminal
 * above). The strip is a batched panel and the name a batched FieldLabel — all bars together cost
 * one panel draw and one glyph draw. Names wider than the terminal truncate with "…".
 */
export default class TitleBar extends THREE.Object3D {
    /**
     * @param {{ atlas: any, maxWorldHeight: number }} o - maxWorldHeight: the bar never grows past
     *   this many world units (the flow gap), however far out the camera zooms.
     */
    constructor({ atlas, maxWorldHeight }) {
        super();
        this.name = 'TitleBar';
        this._maxWorldHeight = maxWorldHeight;
        this._panel = createPanelMaterial({ color: FILL.idle, opacity: 1, depthWrite: true });
        this.strip = enrollPanel(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this._panel.material));
        this.strip.renderOrder = RENDER_ORDER.GRID_BACKGROUND;
        this.add(this.strip);
        this.label = new FieldLabel({ atlas, text: '', lineHeight: 1, textColor: TEXT.idle });
        this.add(this.label);
        this._name = '';
        this._shown = null;     // the (possibly truncated) text the label holds
        this._focused = false;
        this._key = '';         // layout inputs last applied — skip when unchanged
    }

    /** The world height the bar occupies at `zoom` (CSS px per world unit). */
    worldHeight(zoom) {
        return Math.min(TITLE_BAR_PX / zoom, this._maxWorldHeight);
    }

    setName(name) {
        if (name === this._name) return;
        this._name = name;
        this._key = '';   // re-truncate on the next layout
    }

    /** Show or hide the name text (a map label carries the name when the bar is too small). */
    setNameVisible(on) {
        this.label.visible = !!on;
    }

    setFocused(on) {
        if (on === this._focused) return;
        this._focused = on;
        this._panel.setFill(on ? FILL.focused : FILL.idle, 1);
        this.label.setTextColor(on ? TEXT.focused : TEXT.idle);
    }

    /**
     * Lay the bar along the grid's top edge for this zoom. Grid-local units: the parent grid's
     * scale is divided out so the on-screen height stays TITLE_BAR_PX.
     * @param {any} grid - the parent TerminalGrid
     * @param {number} zoom
     */
    layout(grid, zoom) {
        const lb = grid.getLocalBounds();
        const sy = grid.scale.y;
        const h = this.worldHeight(zoom) / sy;
        const w = lb.max.x - lb.min.x;
        const key = `${zoom.toFixed(4)}|${w}|${lb.max.y}|${sy}|${this._name}`;
        if (key === this._key) return;
        this._key = key;

        this.strip.position.set(lb.min.x + w / 2, lb.max.y + h / 2, 0);
        this.strip.scale.set(w, h, 1);

        this.label.setLineHeight(h * TEXT_FRACTION);
        this._fitText(w - 2 * h * TEXT_INSET);
        this.label.position.set(lb.min.x + h * TEXT_INSET + this.label.width / 2, lb.max.y + h / 2, 0.01);
    }

    /** Show as much of the name as fits `maxWidth` (local units), ending in "…" when cut. */
    _fitText(maxWidth) {
        const full = this._name;
        if (this._shown !== full) { this.label.setText(full); this._shown = full; }
        if (!full || this.label.width <= maxWidth) return;
        const perChar = this.label.width / full.length;
        const fits = Math.max(1, Math.floor(maxWidth / perChar) - 1);
        const cut = full.slice(0, fits) + '…';
        this.label.setText(cut);
        this._shown = cut;
    }

    dispose() {
        this.label.dispose();
        this.strip.geometry.dispose();
        this._panel.material.dispose();
        this.parent?.remove(this);
    }
}
