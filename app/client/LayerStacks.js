/**
 * LayerStacks — the depth layers standing behind (and in front of) members: one LayerStack per
 * member, by registry id. `show` builds a member's stack from its source (layerSources.js) and
 * parents it to the member's text frame (layerFrameOf), so it rides every transform the member
 * does; `front` brings a layer to z = 0; `blink` alternates two at `layers.blinkMs`; `hide` frees
 * it. The plane's orthographic fan (the camera's plane fan listener) slides every stack's pages
 * (LayerStack.setFan). A stack is a snapshot of the member's past when it was shown — `show` again re-reads it.
 * The verbs (layerCommands.js) are the only writers; a session saves `serialize()` (which members
 * have a stack, how deep, which layer is fronted) and `restore` re-shows each once its member
 * stands up again.
 */

import { LayerStack, layerFrameOf } from '@glyph3d/core/collections';
import { layersFor } from './layerSources.js';
import { getSetting } from './settings.js';

/** The LayerStack options from Settings (born with them; a stack shown later reads them anew). */
export function layerStackOpts() {
    return {
        pitchRows: Number(getSetting('layers.pitchRows')),
        riseRows: Number(getSetting('layers.riseRows')),
        riseFrom: String(getSetting('layers.riseFrom')),
        backOpacity: Number(getSetting('layers.backOpacity')),
    };
}

/** The one LayerStacks of an app context (made on first use). @param {import('./CommandProvider.jsx').AppContext} ctx */
export function layerStacksOf(ctx) {
    return (ctx.layerStacks ??= new LayerStacks(ctx));
}

export default class LayerStacks {
    /** @param {import('./CommandProvider.jsx').AppContext} ctx */
    constructor(ctx) {
        this.ctx = ctx;
        /** @type {Map<string, {stack: LayerStack, member: Object, n: number, blink: ReturnType<typeof setInterval>|null}>} */
        this.byId = new Map();
        /** The plane's orthographic fan as it stands (device px per layer, the plane's device px per unit). */
        this.fan = { px: 0, pxPerUnit: null };
        // The fan is the pages' own slide: the camera eases it, every stack takes it (a stack shown
        // while fanned joins at once).
        ctx.cameraController?.addPlaneFanListener((px, pxPerUnit) => {
            this.fan = { px, pxPerUnit };
            for (const r of this.byId.values()) r.stack.setFan(px, pxPerUnit);
        });
    }

    /**
     * Build (or rebuild) a member's stack: its last `n` layers from its source, registered on its
     * cell grid. @param {{id:string, grid:Object}} entry a registry entry @param {{n?:number, opts?:Object}} [o]
     * @returns {Promise<LayerStack>}
     */
    async show(entry, { n = Number(getSetting('layers.count')), opts = layerStackOpts() } = {}) {
        const { layers, opts: own } = await layersFor(this.ctx, entry, { n });
        const { frame, parent } = layerFrameOf(entry.grid);
        this.hide(entry.id);
        const stack = new LayerStack(this.ctx.atlas, frame, { ...opts, ...own });
        stack.name = `layers:${entry.id}`;
        stack.setLayers(layers);
        parent.add(stack);
        stack.setFan(this.fan.px, this.fan.pxPerUnit);
        this.byId.set(entry.id, { stack, member: entry.grid, n, blink: null });
        return stack;
    }

    /** A member's stack, or null. */
    get(id) { return this.byId.get(id)?.stack ?? null; }

    /**
     * Resolve a layer by `n` (1 = the newest history page; suggest strips by their id), 'now', a
     * layer id or a label prefix. @returns {string|null|undefined} the layer id, null = now, undefined = none
     */
    resolveLayer(id, which) {
        const stack = this.get(id);
        if (!stack) return undefined;
        const w = String(which ?? '').trim();
        if (w === 'now' || w === '0') return null;
        const hist = stack.pages.filter((l) => l.kind === 'history').sort((a, b) => a.rank - b.rank);
        if (/^\d+$/.test(w)) return hist[Number(w) - 1]?.id;
        const exact = stack.pages.find((l) => l.id === w);
        if (exact) return exact.id;
        const hits = stack.pages.filter((l) => String(l.label ?? '').startsWith(w) || l.id.startsWith(w));
        return hits.length === 1 ? hits[0].id : undefined;
    }

    /** Bring a layer to z = 0 (null = the member itself); stops a blink. */
    front(id, layerId) {
        const rec = this.byId.get(id);
        if (!rec) return false;
        this.unblink(id);
        return rec.stack.front(layerId);
    }

    /** Alternate two layers at z = 0 every `ms` (born from layers.blinkMs). */
    blink(id, a, b, ms = Number(getSetting('layers.blinkMs'))) {
        const rec = this.byId.get(id);
        if (!rec) return false;
        this.unblink(id);
        let on = false;
        rec.stack.front(a);
        rec.blink = setInterval(() => { on = !on; rec.stack.front(on ? b : a); }, Math.max(50, ms));
        return true;
    }

    /** Stop a member's blink (the layer showing stays fronted). */
    unblink(id) {
        const rec = this.byId.get(id);
        if (rec?.blink) { clearInterval(rec.blink); rec.blink = null; }
    }

    /** What a session keeps: each member with a stack, its depth, and the layer at z = 0 (null = the member). */
    serialize() {
        return [...this.byId].map(([id, r]) => ({ id, n: r.n, front: r.stack.frontId }));
    }

    /**
     * Stand saved stacks back up: each once its member is registered and its source answers (a scroll
     * book needs its form and its window; a file grid, the relay) — retried every `everyMs` for up to
     * `waitMs`, then given up with a warning. The saved front layer is fronted again if it's still there.
     * @param {Array<{id:string, n?:number, front?:string|null}>} list
     * @param {{waitMs?:number, everyMs?:number}} [o]
     * @returns {Promise<number>} stacks restored
     */
    async restore(list, { waitMs = 60000, everyMs = 2000 } = {}) {
        const one = async ({ id, n, front }) => {
            const until = Date.now() + waitMs;
            let why = 'its member never registered';
            while (Date.now() < until) {
                const entry = this.ctx.registry?.get?.(id);
                if (entry) {
                    try {
                        await this.show(entry, Number.isInteger(n) && n > 0 ? { n } : undefined);
                        if (front && this.get(id)?.pages.some((l) => l.id === front)) this.front(id, front);
                        return 1;
                    } catch (e) { why = e?.message || String(e); }
                }
                await new Promise((r) => setTimeout(r, everyMs));
            }
            console.warn(`[layers] ${id}: its saved layers were not restored — ${why}`);
            return 0;
        };
        const done = await Promise.all((Array.isArray(list) ? list : []).filter((x) => x && typeof x.id === 'string').map(one));
        return done.reduce((a, b) => a + b, 0);
    }

    /** Free a member's stack. */
    hide(id) {
        const rec = this.byId.get(id);
        if (!rec) return false;
        this.unblink(id);
        rec.stack.parent?.remove(rec.stack);
        rec.stack.dispose();
        this.byId.delete(id);
        return true;
    }
}
