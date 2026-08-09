// label-substrate-mock.mjs — the headless substrate double for FieldLabel tests:
// a REAL PanelField (lane writes are the observable) over a mock arena/mega whose
// stage()/views record their calls. Install with setPipelineArena(sub.arena).

import * as THREE from 'three';
import PanelField from '../packages/glyph3d-core/src/collections/PanelField.js';

export function makeSubstrate() {
    const scene = new THREE.Scene();
    const panels = new PanelField({ scene, field: { _groupTexture: null }, capacity: 8 });
    const arena = {
        worldScale: 0.025,
        trie: null,               // mono measure path (the headless atlas is shaper-less)
        staged: [], flushes: 0,
        stage(p) {
            const item = { params: p, disposed: false, dispose() { this.disposed = true; } };
            arena.staged.push(item);
            return item;
        },
        requestFlush() { arena.flushes++; return Promise.resolve(); },
    };
    let nextGroup = 1;
    const mega = {
        arena, panels,
        labelPanels: panels,   // one instance stands in for both fields headless
        views: [],
        createView({ node, color }) {
            const view = {
                mega, node, color, groupId: nextGroup++,
                alpha: 1, cleared: 0, dead: false, byteCount: 0, paints: [],
                setGroupAlpha(_g, a) { view.alpha = a; },
                setGlyphColorRange(start, count, c) { view.paints.push({ start, count, c }); },
                clear() { view.cleared++; },
                dispose() { view.dead = true; },
            };
            mega.views.push(view);
            return view;
        },
    };
    arena.megaField = mega;
    return { scene, arena, mega, panels };
}
