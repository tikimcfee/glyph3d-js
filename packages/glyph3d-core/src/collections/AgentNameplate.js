/**
 * AgentNameplate — an agent book's identity + live status, parked above its cover.
 *
 * Two FieldLabels stacked and centered: the NAME (large, on the lane's palette-hue plate)
 * over the STATUS block (smaller, a darker plate edged in the same hue) — what the
 * session is doing, how far along, how long ago, and where it runs. Both are glyph
 * fields drawn from the GlyphBatch arena, so a long title instances glyphs rather than
 * baking a texture.
 *
 * Sizing is the owner's: set(name, status, {nameLh, statusLh}) takes world line heights
 * (AgentBooks container-fits the name to the book's width) and text already wrapped to
 * its columns — the plate never cuts text. Book.syncCover places it each frame through
 * the Label3D-shaped surface it reads: `height`, `visible`, `dispose()`.
 */

import * as THREE from 'three';
import FieldLabel from './FieldLabel.js';

export default class AgentNameplate extends THREE.Object3D {
    /**
     * @param {{atlas:Object, color:number, statusOpacity?:number, gap?:number}} o
     *   color — the lane's palette hue (the name plate's fill, the status plate's edge);
     *   statusOpacity — the status plate's fill alpha; gap — world gap between the two,
     *   in name-line units
     */
    constructor({ atlas, color, statusOpacity = 0.78, gap = 0.25 }) {
        super();
        this.name = 'agent-nameplate';
        this.userData.isMarker = true;
        this.gap = gap;
        this.nameLabel = new FieldLabel({ atlas, lineHeight: 1, plate: { color, opacity: 0.85 } });
        this.statusLabel = new FieldLabel({
            atlas, lineHeight: 1,
            textColor: { r: 0.86, g: 0.89, b: 0.94 },
            plate: { color: 0x0b0e14, opacity: statusOpacity },
        });
        this.add(this.nameLabel, this.statusLabel);
    }

    /** The name line(s). */
    get nameText() { return this.nameLabel.text; }
    /** The status block. */
    get statusText() { return this.statusLabel.text; }
    /** Everything the plate reads, name first — one string for assertions and search. */
    get text() { return this.statusLabel.text ? `${this.nameLabel.text}\n${this.statusLabel.text}` : this.nameLabel.text; }

    get width() { return Math.max(this.nameLabel.width, this.statusLabel.text ? this.statusLabel.width : 0); }
    get height() {
        const s = this.statusLabel.text ? this.statusLabel.height + this.gap * this.nameLabel.lineHeight : 0;
        return this.nameLabel.height + s;
    }

    /**
     * Restage both blocks and re-stack them. Identical text and sizes are no-ops in the
     * labels themselves (FieldLabel.setText / setLineHeight short-circuit).
     * @param {string} name @param {string} status
     * @param {{nameLh:number, statusLh:number}} sizes world line heights
     */
    set(name, status, { nameLh, statusLh }) {
        this.nameLabel.setText(name);
        this.nameLabel.setLineHeight(nameLh);
        this.statusLabel.setText(status);
        this.statusLabel.setLineHeight(statusLh);
        this.statusLabel.visible = !!status;
        const H = this.height;
        this.nameLabel.position.set(0, H / 2 - this.nameLabel.height / 2, 0);
        this.statusLabel.position.set(0, -H / 2 + this.statusLabel.height / 2, 0);
        return this;
    }

    dispose() {
        this.nameLabel.dispose();
        this.statusLabel.dispose();
        this.parent?.remove(this);
    }
}
