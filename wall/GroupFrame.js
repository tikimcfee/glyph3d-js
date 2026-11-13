import * as THREE from 'three';
import { createPanelMaterial, BORDER_FLAGS } from '@glyph3d/core/collections/panelMaterial.js';
import { enrollPanel } from '@glyph3d/core/collections/PanelBatch.js';
import { RENDER_ORDER } from '@glyph3d/core/core/renderOrder.js';
import TitleBar, { displayColor } from './TitleBar.js';
import { BAR_ROOM } from './wallLayout.js';

/** A group's backdrop: a shade lighter than the canvas, with a hairline. */
const BACKDROP = { fill: 0x0d1017, border: { color: 0x262d3a, width: 1, intensity: 1 } };
/** A group's header: quieter than a terminal's bar; its name lights when a member has focus. */
const HEADER_STYLE = Object.freeze({
    fill: Object.freeze({ idle: 0x121722, focused: 0x12261d }),
    text: Object.freeze({ idle: 0x8b95a7, focused: 0x8ef0b8 }),
});
/** World depth of a group under the terminals (they sit at 0, the focused one at 1). */
const GROUP_Z = -1;

/**
 * GroupFrame — how a group shows on the canvas: a quiet backdrop behind its members' windows and a
 * header strip above them carrying its name (a TitleBar, so the name is whole and shrinks to fit
 * like a terminal's). Both are batched panels; the name a batched label. Sits directly under the
 * scene at unit scale, so its local units are world units. The header is the group's handle
 * (WallPointer drags it).
 */
export default class GroupFrame extends THREE.Object3D {
    /** @param {{ atlas: any }} o */
    constructor({ atlas }) {
        super();
        this.name = 'GroupFrame';
        this.position.z = GROUP_Z;
        this._panel = createPanelMaterial({ color: displayColor(BACKDROP.fill), opacity: 1, depthWrite: true });
        this._panel.setBorder(BACKDROP.border);
        this._panel.setBorderFlag(BORDER_FLAGS.EDGE, true);
        this.backdrop = enrollPanel(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this._panel.material));
        this.backdrop.renderOrder = RENDER_ORDER.BACKDROP_BASE;
        this.add(this.backdrop);
        this.header = new TitleBar({ atlas, maxWorldHeight: BAR_ROOM, minTextPx: 0, style: HEADER_STYLE });
        this.add(this.header);
        this._key = '';
    }

    /** The header's world height at `zoom`. */
    headerHeight(zoom) { return this.header.worldHeight(zoom); }

    /**
     * Lay the frame over `rect` (the members' windows, padded) with its header on top.
     * @param {import('./wallLayout.js').Rect} rect @param {number} zoom @param {string} name @param {boolean} focused
     */
    layout(rect, zoom, name, focused) {
        this.header.setName(name);
        this.header.setFocused(focused);
        this.header.layout({ minX: rect.minX, maxX: rect.maxX, maxY: rect.maxY, sy: 1 }, zoom);
        const key = `${rect.minX}|${rect.minY}|${rect.maxX}|${rect.maxY}`;
        if (key === this._key) return;
        this._key = key;
        this.backdrop.position.set((rect.minX + rect.maxX) / 2, (rect.minY + rect.maxY) / 2, 0);
        this.backdrop.scale.set(rect.maxX - rect.minX, rect.maxY - rect.minY, 1);
    }

    dispose() {
        this.header.dispose();
        this.backdrop.geometry.dispose();
        this._panel.material.dispose();
        this.parent?.remove(this);
    }
}
