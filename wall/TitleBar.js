import * as THREE from 'three';
import FieldLabel from '@glyph3d/core/collections/FieldLabel.js';
import { createPanelMaterial } from '@glyph3d/core/collections/panelMaterial.js';
import { enrollPanel } from '@glyph3d/core/collections/PanelBatch.js';
import { RENDER_ORDER } from '@glyph3d/core/core/renderOrder.js';

/** Title bar height on screen (CSS px) — constant, so names read at any zoom. */
export const TITLE_BAR_PX = 22;
/**
 * The smallest a name's line may shrink to in a bar, in CSS px on screen (TitleBar's `minTextPx`).
 * The default sits at the glyph tiers' greek threshold (`glyph.greekPx`, 8 px): smaller, a name
 * would draw as bars, not letters — the map label carries it instead.
 */
export const MIN_TEXT_PX = 8;
/** Name text height as a fraction of the bar. */
const TEXT_FRACTION = 0.6;
/** Left inset of the name, in bar heights. */
const TEXT_INSET = 0.45;
/** A name that went to the map label comes back only once it fits this much above the floor —
 *  hysteresis, so a zoom resting at the floor can't flip it back and forth. */
const FIT_HYSTERESIS = 1.1;
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
 * one panel draw and one glyph draw.
 *
 * The name is always whole. Too wide for the bar, its text shrinks to fit (a scale, not a
 * re-layout); shrunk below `minTextPx` on screen it doesn't fit at all (`nameFits` false), and
 * WallNames hands the name to a map label — as it does for a terminal too narrow for its bar.
 */
export default class TitleBar extends THREE.Object3D {
    /**
     * @param {{ atlas: any, maxWorldHeight: number, minTextPx?: number }} o
     *   maxWorldHeight: the bar never grows past this many world units (the flow gap), however far
     *   out the camera zooms. minTextPx: the smallest the name's line may shrink to, in CSS px on
     *   screen, before the bar gives the name up (default MIN_TEXT_PX).
     */
    constructor({ atlas, maxWorldHeight, minTextPx = MIN_TEXT_PX }) {
        super();
        this.name = 'TitleBar';
        this._maxWorldHeight = maxWorldHeight;
        this._minTextPx = minTextPx;
        this._panel = createPanelMaterial({ color: FILL.idle, opacity: 1, depthWrite: true });
        this.strip = enrollPanel(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this._panel.material));
        this.strip.renderOrder = RENDER_ORDER.GRID_BACKGROUND;
        this.add(this.strip);
        this.label = new FieldLabel({ atlas, text: '', lineHeight: 1, textColor: TEXT.idle });
        this.add(this.label);
        this._name = '';
        this._focused = false;
        this._fits = true;
        this._key = '';         // layout inputs last applied — skip when unchanged
    }

    /** The world height the bar occupies at `zoom` (CSS px per world unit). */
    worldHeight(zoom) {
        return Math.min(TITLE_BAR_PX / zoom, this._maxWorldHeight);
    }

    /** Whether the whole name reads in the bar at the last layout (shrunk no smaller than minTextPx). */
    get nameFits() { return this._fits; }

    setName(name) {
        if (name === this._name) return;
        this._name = name;
        this.label.setText(name);
        this._key = '';   // refit on the next layout
    }

    /** Show or hide the name text (a map label carries the name when the bar can't). */
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

        // The name's natural line, shrunk to the room it has — FieldLabel's width scales with its
        // line height, so the fit is one division.
        const natural = h * TEXT_FRACTION;
        const room = w - 2 * h * TEXT_INSET;
        const full = this.label.width * natural / this.label.lineHeight;
        const line = full <= room ? natural : room > 0 ? natural * room / full : 0;
        const px = line * sy * zoom;
        this._fits = px >= this._minTextPx * (this._fits ? 1 : FIT_HYSTERESIS);
        this.label.setLineHeight(line > 0 ? line : natural);
        this.label.position.set(lb.min.x + h * TEXT_INSET + this.label.width / 2, lb.max.y + h / 2, 0.01);
    }

    dispose() {
        this.label.dispose();
        this.strip.geometry.dispose();
        this._panel.material.dispose();
        this.parent?.remove(this);
    }
}
