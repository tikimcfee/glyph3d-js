import TitleBar from './TitleBar.js';
import MapLabels from './MapLabels.js';
import { BAR_ROOM } from './wallLayout.js';

/** Room a bar keeps clear at its right end for the hover buttons (agent, hide, close), in bar heights. */
const BAR_BUTTON_ROOM = 3.15;

/** A terminal narrower than this on screen (CSS px) shows its name as a map label instead of in
 *  its bar; wider than MAP_LABEL_OFF_PX, back in the bar. The band between is hysteresis. */
const MAP_LABEL_ON_PX = 140;
const MAP_LABEL_OFF_PX = 170;

/**
 * WallNames — how terminals wear their names: a TitleBar on each terminal's top edge, and, when a
 * terminal's bar can't carry its name — the terminal is too narrow on screen, or the whole name
 * would have to shrink past the bar's text floor (TitleBar.nameFits) — a map label instead (placed
 * so no two overlap, with a trace line when detached). Updated once per frame from the same camera
 * the canvas renders with.
 */
export default class WallNames {
    /**
     * @param {{ atlas: any, host: HTMLElement, camera: import('./WallCamera.js').default,
     *           onLabelPress: (id: string, e: PointerEvent) => void, minTextPx?: number }} o
     *   minTextPx: the bars' text floor (TitleBar), CSS px; TitleBar's default when absent
     */
    constructor({ atlas, host, camera, onLabelPress, minTextPx }) {
        this._atlas = atlas;
        this._camera = camera;
        this._minTextPx = minTextPx;
        /** @type {Map<string, TitleBar>} */
        this._bars = new Map();
        /** Terminals whose name is currently a map label. @type {Set<string>} */
        this._mapMode = new Set();
        /** Terminals whose bar a split governs: the room it may take, 0 for no bar (absent: BAR_ROOM). @type {Map<string, number>} */
        this._room = new Map();
        this.mapLabels = new MapLabels(host, onLabelPress);
    }

    /** Give a newly arrived terminal its title bar. */
    attach(id, grid) {
        const bar = new TitleBar({ atlas: this._atlas, maxWorldHeight: BAR_ROOM, minTextPx: this._minTextPx, reserveBars: BAR_BUTTON_ROOM });
        grid.add(bar);
        this._bars.set(id, bar);
        if (this._room.has(id)) this.setBarRoom(id, this._room.get(id));   // a split set it before the grid arrived
    }

    /** Drop the bars of terminals that are gone. @param {(id: string) => boolean} isLive */
    prune(isLive) {
        for (const [id, bar] of this._bars) {
            if (!isLive(id)) { bar.dispose(); this._bars.delete(id); this._mapMode.delete(id); this._room.delete(id); }
        }
    }

    /**
     * Give a terminal's bar the room a split pane leaves it (world units), or no bar at all (0), or
     * back the room every other terminal's bar has (null).
     * @param {string} id @param {number|null} room
     */
    setBarRoom(id, room) {
        const bar = this._bars.get(id);
        if (room == null) this._room.delete(id); else this._room.set(id, room);
        if (!bar) return;
        bar.setMaxWorldHeight(room || BAR_ROOM);
        bar.visible = room !== 0;
        if (room === 0) this._mapMode.delete(id);
    }

    /** The title bar's world height at `zoom` (0 for a terminal without one). */
    barHeight(id, zoom) {
        if (this._room.get(id) === 0) return 0;
        return this._bars.get(id)?.worldHeight(zoom) ?? 0;
    }

    /**
     * Per frame: lay out every shown terminal's bar, decide bar-vs-map-label per terminal, and place
     * the labels. `order` is the SHOWN terminals (a hidden one's grid, bar included, isn't drawn).
     * @param {{ order: string[], terminals: Map<string, any>, focusedId: string|null, hoveredId: string|null,
     *           nameOf: (id: string) => string, windowRect: (id: string) => object }} s
     */
    update(s) {
        const zoom = this._camera.zoom;
        for (const id of s.order) {
            const bar = this._bars.get(id), grid = s.terminals.get(id);
            if (!bar || !grid || this._room.get(id) === 0) continue;
            bar.setName(s.nameOf(id));
            bar.setFocused(id === s.focusedId);
            const lb = grid.getLocalBounds();
            bar.layout({ minX: lb.min.x, maxX: lb.max.x, maxY: lb.max.y, sy: grid.scale.y }, zoom);
        }

        const view = { w: this._camera.view.w, h: this._camera.view.h, margin: 4, gap: 4 };
        const boxes = new Map();
        for (const id of s.order) {
            if (this._room.get(id) === 0) continue;   // a split pane without bars: its group's header names it
            const b = this._camera.toScreenBox(s.windowRect(id));
            if (b.right < 0 || b.left > view.w || b.bottom < 0 || b.top > view.h) continue;
            boxes.set(id, b);
            const wpx = b.right - b.left;
            const fits = this._bars.get(id)?.nameFits ?? true;
            if (wpx < MAP_LABEL_ON_PX || !fits) this._mapMode.add(id);
            else if (wpx > MAP_LABEL_OFF_PX) this._mapMode.delete(id);
        }
        const rank = (id) => (id === s.focusedId ? 0 : id === s.hoveredId ? 1 : 2);
        const items = [];
        for (const id of s.order) {
            this._bars.get(id)?.setNameVisible(!this._mapMode.has(id));
            if (this._mapMode.has(id) && boxes.has(id)) {
                items.push({ id, name: s.nameOf(id), focused: id === s.focusedId, target: boxes.get(id) });
            }
        }
        items.sort((a, b) => rank(a.id) - rank(b.id));
        this.mapLabels.update(items, view, [...boxes.values()]);
    }

    dispose() {
        this.mapLabels.dispose();
        for (const bar of this._bars.values()) bar.dispose();
        this._bars.clear();
    }
}
