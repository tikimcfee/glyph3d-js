/**
 * ContentTreeLabels — the directory tree learns to name itself.
 *
 * Every visible directory (the CONTAINERS — durable, path-keyed dir nodes) gets a glyph
 * label above the top-left corner of its subtree's content box: the chain-compressed
 * joined name where layout compression applies (userData.displayName — this is that
 * seam's long-promised label consumer), the plain dir name otherwise, with a stat line
 * ("N files") beneath it. With showFiles, every BOOK wears its file name the same way
 * (collectBookLabels): the same container-fit against the book's own bound, the
 * gradient one step deeper than its directory, no stat line — and since a book's path
 * IS its registry id, hovering a book swells its own name and its whole ancestor
 * chain at once. With plate, every label wears a solid BACKPLATE (the page-face
 * treatment): one fill-cell quad in the label's own group (renderBatch's quad item),
 * so it rides every fade and grow with zero extra bookkeeping — still one draw call.
 * All labels live in ONE shared GlyphField (a single instanced
 * draw call) parented under the tree root, so they ride floor-rest and world moves for
 * free. Each label's glyphs bake LABEL-LOCAL with the anchor in its group offset, so
 * hovering anything inside a container eases its label up to hoverBoost — the name
 * swells in place with O(1) group-scale writes, no rebuild.
 *
 * LOD is PHYSICAL, not thresholded: a label is painted ON its container at container
 * scale — glyphs sized so the text spans a `fit` fraction of the container's width
 * (clamped by scaleMin/scaleMax). Wide containers wear big names readable from across
 * the room; deep, narrow ones resolve as you approach — legibility arrives with
 * proximity, the same way it does on a paper map, and hierarchy is encoded by
 * construction (a parent is always wider than its children). The only per-frame work
 * is the approach SPECTRUM: across fadeStart→fadeEnd of camera distance, alpha and
 * glyph scale both ease (smoothstepped) from the resting presentation — container-fit
 * size at `opacity` — to the arrived one: the name at `nearScale` (the name-tag
 * size) and `minAlpha`. Arrived, a directory keeps a readable name tag instead of
 * vanishing; dial minAlpha or nearScale to 0 for the old yield-to-content. Every
 * write is O(1) per label and made only when its quantized value changes.
 *
 * Color is the family's depth gradient (colorA → colorB over normalized visible depth,
 * the markers' ramp language, lifted brighter) so a label reads as kin to its prism.
 *
 * Rebuilds are driven by ContentTree.onRelayout — labels can never observe a stale
 * layout, and chain compression has always already run (it happens inside the layout
 * pass), so displayName is fresh. The field's instanceMesh carries userData.isMarker:
 * layout schemes ignore it (partitionChildren), tree bounds exclude it, and it is never
 * registered with picking.
 */

import * as THREE from 'three';
import GlyphField from '../GlyphField.js';
import { getWorkerBridge } from '../workers/WorkerBridge.js';
import { computeCellMetrics } from '../core/cellMetrics.js';
import { subtreeContentBounds } from './layouts/nodeUtils.js';

export const LABEL_DEFAULTS = {
    fit: 0.65,         // the fraction of its container's width a label's name spans
    scaleMin: 0.6,     // glyph-scale floor — a long name on a narrow container stays visible
    scaleMax: 44,      // glyph-scale cap — a short name on a vast container stays a label
    countScale: 0.6,   // the stat line's glyph scale, as a fraction of the name's
    hoverBoost: 1.4,   // how much a label grows while its container holds the hover
    hoverEase: 13,     // the grow/shrink rate (1/s) — higher snaps, lower breathes
    colorA: 0x9fc2e8,  // gradient start — the shallowest containers (kin to the prism ramp)
    colorB: 0xd0a6e0,  // gradient end — the deepest
    opacity: 0.86,     // resting label alpha (the far side of the approach band)
    minAlpha: 0.54,    // alpha once fully approached — 0 restores the full vanish
    nearScale: 7.3,    // glyph scale once fully approached (the arrived name-tag size) — 0 shrinks away
    fadeStart: 320,    // world distance where the approach band begins
    fadeEnd: 110,      // world distance where it completes — you've arrived at the container
    gapY: 1.2,         // lift above the container's top edge, in label row heights
    zLift: 44,         // world units in front of the subtree's front plane
    showCount: 1,      // 1 → a stat line under the name: "N files"
    showFiles: 1,      // 1 → every BOOK wears its file name too (same fit, no stat line)
    plate: 1,          // 1 → a solid backplate behind each label (the page-face treatment)
    plateColor: 0x0c0f16, // the plate's fill — dark kin of the grid/page backgrounds
    plateOpacity: 0.62,   // the plate's fill opacity (group fades multiply on top)
    platePad: 0.3,     // plate margin past the text, in label row heights
    worldScale: 0.025, // the field's glyph world scale (the canonical default)
};

// Opts that shape the BAKED field (glyph text/scale/placement/color): a configure()
// touching one of these rebuilds. Everything else — the approach spectrum and the
// hover grow — just steers the next frame's update(), so dial drags stay rebuild-free.
const BUILD_OPTS = new Set(['fit', 'scaleMin', 'scaleMax', 'countScale', 'colorA', 'colorB', 'gapY', 'zLift', 'showCount', 'showFiles', 'plate', 'plateColor', 'plateOpacity', 'platePad', 'worldScale']);

/** Total file leaves under a node — descends child dirs and layout-inserted groups
 *  (jellyfish rows hold the books after its pass), skips markers. A library VOLUME
 *  counts by its pages (the dir's books ride its sheets). */
function countFiles(node) {
    let n = 0;
    for (const c of node.children) {
        if (c.userData?.isMarker) continue;
        if (c.userData?.isVolume) n += c.contentLeaves().length;
        else if (c.userData?.isDir || c.userData?.isLayoutGroup) n += countFiles(c);
        else n++;
    }
    return n;
}

/** How many non-pass-through dir levels deep a node sits, counting itself — the
 *  VISIBLE depth: chain compression makes a four-segment path a depth-1 container. */
function visibleDepth(node, root) {
    let d = 0;
    for (let n = node; n && n !== root; n = n.parent) {
        if (n.userData?.isDir && !n.userData.isPassThrough) d++;
    }
    return d;
}

/**
 * Collect one label item per visible directory — pure (no GPU, mock-tree friendly).
 * Glyph scale is the container fit: text spans `fit` of the subtree's width, clamped
 * to [scaleMin, scaleMax]. Positions are in the TREE-ROOT-LOCAL frame: the top-left-
 * front corner of the dir's subtree content box, lifted by gapY label-rows, carried
 * through the node's ancestor transforms (layout has just placed them).
 * @param {import('./ContentTree.js').default} tree
 * @param {object} opts LABEL_DEFAULTS overrides
 * @param {{rowH:number,charW:number}} metrics world height of one text row and width
 *        of one glyph cell at scale 1 (from the atlas via computeCellMetrics)
 * @returns {Array<{path:string,depth:number,text:string,scale:number,x:number,y:number,z:number}>}
 */
export function collectDirLabels(tree, opts, metrics) {
    const o = { ...LABEL_DEFAULTS, ...opts };
    const { rowH, charW } = metrics;
    const items = [];
    const box = new THREE.Box3();
    const p = new THREE.Vector3();
    for (const [path, node] of tree._dirs.entries()) {
        if (path === '' || node.userData?.isPassThrough) continue;
        const bounds = subtreeContentBounds(node, box);
        if (bounds.isEmpty()) continue;
        const depth = visibleDepth(node, tree.root);
        const text = String(node.userData.displayName ?? node.userData.name ?? '');
        // A volume'd dir composes ONE title block: its stat line becomes the PAGE line —
        // the open file's name and position ("b.js · 2/4" — the count lives in the
        // denominator). Separate in-volume book labels don't exist (collectBookLabels),
        // so nothing collides in the title area; the line re-bakes on every turn.
        let countText = null;
        if (o.showCount) {
            const vol = node.userData._volume;
            if (vol?.sheets.length) {
                const h = vol.headState();
                const open = vol.sheets[h.head];
                const openName = String((open?.recto ?? open?.verso)?.userData?.name ?? '');
                countText = `${openName} · ${h.head + 1}/${h.count}`;
            } else {
                const count = countFiles(node);
                countText = count > 0 ? `${count} ${count === 1 ? 'file' : 'files'}` : null;
            }
        }
        const cps = [...text].length;   // codepoints ≈ cells (labels are path-ish text)
        const w = bounds.max.x - bounds.min.x;
        const scale = Math.min(Math.max((o.fit * w) / Math.max(cps * charW, 1e-6), o.scaleMin), o.scaleMax);
        p.set(bounds.min.x, bounds.max.y + o.gapY * rowH * scale, bounds.max.z + o.zLift);
        for (let n = node; n && n !== tree.root; n = n.parent) {
            n.updateMatrix();
            p.applyMatrix4(n.matrix);
        }
        items.push({ path, depth, text, countText, scale, x: p.x, y: p.y, z: p.z });
    }
    return items;
}

/**
 * Collect one label item per BOOK — the file's name on its durable carrier, pure like
 * collectDirLabels. Same container-fit sizing against the book's own bound (the page
 * while fitted, the content box released), same root-local anchoring walked through
 * whatever the active scheme parented the book under (dir nodes, jellyfish rows).
 * A book whose leaf is away from home (docked to the camera bar) is skipped — the
 * empty home has no face to name. Depth is the owning chain's visible depth plus one,
 * so a file label wears the gradient one step deeper than its directory.
 * @param {import('./ContentTree.js').default} tree
 * @param {object} opts LABEL_DEFAULTS overrides
 * @param {{rowH:number,charW:number}} metrics see collectDirLabels
 * @returns {Array<{path:string,depth:number,text:string,countText:null,scale:number,x:number,y:number,z:number}>}
 */
export function collectBookLabels(tree, opts, metrics) {
    const o = { ...LABEL_DEFAULTS, ...opts };
    if (!o.showFiles) return [];
    const { rowH, charW } = metrics;
    const items = [];
    const p = new THREE.Vector3();
    for (const book of tree.books()) {
        if (!book.parent || !book.hasLeafAtHome()) continue;   // detached / empty home
        // Books riding a library VOLUME carry no label of their own — the volume's dir
        // title block names the OPEN page (collectDirLabels' page line), so a deck's
        // worth of co-located names never exists.
        let inVolume = false;
        for (let n = book.parent; n && n !== tree.root; n = n.parent) {
            if (n.userData?.isVolume) { inVolume = true; break; }
        }
        if (inVolume) continue;
        const text = String(book.userData.name ?? '');
        if (!text) continue;
        const b = book.layoutBounds();
        if (!b || b.isEmpty()) continue;
        const cps = [...text].length;
        const w = b.max.x - b.min.x;
        const scale = Math.min(Math.max((o.fit * w) / Math.max(cps * charW, 1e-6), o.scaleMin), o.scaleMax);
        const depth = visibleDepth(book, tree.root) + 1;
        p.set(b.min.x, b.max.y + o.gapY * rowH * scale, b.max.z + o.zLift);
        for (let n = book; n && n !== tree.root; n = n.parent) {
            n.updateMatrix();
            p.applyMatrix4(n.matrix);
        }
        items.push({ path: book.userData.path, depth, text, countText: null, scale, x: p.x, y: p.y, z: p.z });
    }
    return items;
}

export default class ContentTreeLabels {
    /**
     * @param {import('./ContentTree.js').default} tree
     * @param {import('../GlyphAtlas.js').default} atlas the live glyph atlas (label text
     *        is encoded into it on first sighting)
     * @param {object} [opts] overrides for LABEL_DEFAULTS
     */
    constructor(tree, atlas, opts = {}) {
        this.tree = tree;
        this.atlas = atlas;
        this.opts = { ...LABEL_DEFAULTS, ...opts };
        this.enabled = true;
        /** @type {GlyphField|null} the one shared field — rebuilt per relayout */
        this._field = null;
        this._items = [];
        this._alphaQ = [];        // groupId → last quantized alpha written
        this._seenCodepoints = new Set();
        this._v = new THREE.Vector3();
        this._offRelayout = tree.onRelayout(() => this.rebuild());
        this.rebuild();
    }

    /** Patch options. Build-shaping opts (BUILD_OPTS) trigger a rebuild; spectrum and
     *  hover dials just steer the next frame — an unchanged value is a no-op either way. */
    configure(patch = {}) {
        let rebuild = false;
        for (const [k, v] of Object.entries(patch)) {
            if (this.opts[k] === v) continue;
            this.opts[k] = v;
            if (BUILD_OPTS.has(k)) rebuild = true;
        }
        if (rebuild) this.rebuild();
        return this;
    }

    setEnabled(on) {
        on = !!on;
        if (on === this.enabled) return this;
        this.enabled = on;
        if (on) this.rebuild();
        else if (this._field?.instanceMesh) this._field.instanceMesh.visible = false;
        return this;
    }

    /** Rebuild every label from the tree's current layout (the onRelayout driver). */
    rebuild() {
        if (!this.enabled) return;
        const o = this.opts;
        const cm = computeCellMetrics(this.atlas.getCharSize(), o.worldScale);
        const metrics = { rowH: cm.charHeight, charW: cm.charWidth };
        const items = [...collectDirLabels(this.tree, o, metrics), ...collectBookLabels(this.tree, o, metrics)];
        this._teardown();
        this._items = items;
        if (!items.length) return;

        this._ensureGlyphsEncoded(items);

        const glyphCount = items.reduce((n, it) => n + it.text.length + (it.countText?.length ?? 0), 0)
            + (o.plate ? items.length : 0);   // one fill-cell instance per plated label
        const field = new GlyphField(this.tree.root, this.atlas, {
            maxInstances: Math.max(glyphCount, 64),
            maxGroups: items.length + 1,
            worldScale: o.worldScale,
            defaultColor: { r: 1, g: 1, b: 1 },
            // Glyphs bake LABEL-LOCAL and the anchors ride group offsets, so this one mesh
            // spans the whole tree via offsets the CPU-side bounds can't see — its bounding
            // sphere is false, and culling every label as one unit is both wrong and worthless.
            frustumCulled: false,
        });
        this._field = field;

        const maxDepth = items.reduce((m, it) => Math.max(m, it.depth), 1);
        const cA = new THREE.Color(o.colorA), cB = new THREE.Color(o.colorB), c = new THREE.Color();
        const pc = new THREE.Color(o.plateColor);
        const plateFill = { color: { r: pc.r, g: pc.g, b: pc.b }, opacity: o.plateOpacity };
        const rowH = cm.charHeight;
        const batch = [];
        for (const it of items) {
            // Glyphs bake LABEL-LOCAL; the anchor rides the group offset — so the group
            // scale (the hover grow) swells the label in place, one O(1) write, no rebuild.
            it.groupId = field.createGroup();
            it.boost = 1;
            it.scaleQ = 1024;   // groups are born at scale 1 — quantized ×1024, like alpha's ×255
            field.setGroupOffset(it.groupId, { x: it.x, y: it.y, z: it.z });
            field.setGroupAlpha(it.groupId, o.opacity);
            const t = maxDepth > 1 ? (it.depth - 1) / (maxDepth - 1) : 0;
            c.lerpColors(cA, cB, t);
            const color = { r: c.r, g: c.g, b: c.b };
            if (o.plate) {
                // The backplate: one fill-cell quad in the SAME group, sized over the text
                // block (mono advance ≈ charW — the label font is monospace), padded, pushed
                // just behind the glyphs on z. Buffer order puts it first, so the text always
                // composites over it; the group carries it through every fade and grow.
                const half = rowH * it.scale / 2;
                const nameW = [...it.text].length * cm.charWidth * it.scale;
                const countW = it.countText ? [...it.countText].length * cm.charWidth * it.scale * o.countScale : 0;
                const bot = it.countText ? -rowH * it.scale - (rowH * it.scale * o.countScale) / 2 : -half;
                const pad = o.platePad * rowH * it.scale;
                batch.push({
                    quad: { w: Math.max(nameW, countW) + 2 * pad, h: (half - bot) + 2 * pad, fill: plateFill },
                    position: { x: -pad, y: (half + bot) / 2, z: -1 },
                    options: { color: plateFill.color, groupId: it.groupId },
                });
            }
            batch.push({ text: it.text, position: { x: 0, y: 0, z: 0 }, options: { color, scale: it.scale, groupId: it.groupId } });
            if (it.countText) {
                batch.push({
                    text: it.countText,
                    position: { x: 0, y: -rowH * it.scale, z: 0 },
                    options: { color, scale: it.scale * o.countScale, groupId: it.groupId },
                });
            }
        }
        field.renderBatch(batch);
        this._alphaQ = [];

        // The mesh is a direct child of tree.root: the isMarker flag keeps it out of
        // layout partitioning, tree bounds, and pruning — same contract as the prisms.
        if (field.instanceMesh) field.instanceMesh.userData.isMarker = true;
    }

    /**
     * Per-frame work (call from the frame loop): the approach spectrum and the hover
     * grow. Camera distance runs the spectrum — outside fadeStart a label rests at
     * container-fit scale and `opacity`; across fadeStart→fadeEnd both alpha and scale
     * ease (smoothstepped, so the band has no corners) toward `minAlpha` and `nearScale`.
     * Arrived, the name holds as a readable name tag rather than vanishing — unless
     * dialed to 0. The hover grow — the label whose container holds the hovered entity
     * (any descendant path) easing toward hoverBoost — multiplies on top. All writes
     * are O(1) group writes, made only on actual quantized change: a still camera with
     * a still pointer costs a distance check per label and nothing.
     * @param {THREE.Camera} camera
     * @param {number} [dt] seconds since the last frame (eases the hover grow)
     * @param {string|null} [hoverId] the hovered entity's registry id (a canonical path)
     */
    update(camera, dt = 1 / 60, hoverId = null) {
        const f = this._field;
        if (!this.enabled || !f || !this._items.length || !camera) return;
        const o = this.opts;
        const m = this.tree.root.matrixWorld;
        const span = Math.max(o.fadeStart - o.fadeEnd, 1e-6);
        const ease = Math.min(1, (dt || 1 / 60) * o.hoverEase);
        for (const it of this._items) {
            const d = this._v.set(it.x, it.y, it.z).applyMatrix4(m).distanceTo(camera.position);
            let t = Math.min(Math.max((d - o.fadeEnd) / span, 0), 1);
            t = t * t * (3 - 2 * t);
            const a = o.minAlpha + (o.opacity - o.minAlpha) * t;
            const q = Math.round(a * 255);
            if (this._alphaQ[it.groupId] !== q) {
                this._alphaQ[it.groupId] = q;
                f.setGroupAlpha(it.groupId, q / 255);
            }
            const hovered = !!hoverId && (hoverId === it.path || hoverId.startsWith(it.path + '/'));
            const target = hovered ? o.hoverBoost : 1;
            if (Math.abs(it.boost - target) > 1e-3) {
                it.boost += (target - it.boost) * ease;
                if (Math.abs(it.boost - target) < 1e-3) it.boost = target;
            }
            // The scale flow: ×1 (container-fit) far → nearScale/it.scale arrived, the
            // hover grow riding on top — one group-scale write when it actually moves.
            const nearF = o.nearScale / Math.max(it.scale, 1e-6);
            const s = it.boost * (nearF + (1 - nearF) * t);
            const sq = Math.round(s * 1024);
            if (it.scaleQ !== sq) {
                it.scaleQ = sq;
                f.setGroupScale(it.groupId, { x: s, y: s, z: s });
            }
        }
    }

    /** @private First sighting of a label codepoint encodes its Slug curves into the
     *  live atlas (and resyncs the worker shape cache on growth) — the same live-encode
     *  contract CodeGrid and TerminalGrid keep. No-op without a live atlas (mock/test). */
    _ensureGlyphsEncoded(items) {
        const atlas = this.atlas;
        const live = atlas && atlas._live;
        if (!live || !atlas._shapeCache) return;
        let fresh = null;
        for (const it of items) {
            for (let i = 0; i < it.text.length;) {
                const cp = it.text.codePointAt(i);
                i += cp > 0xFFFF ? 2 : 1;
                if (cp > 32 && !this._seenCodepoints.has(cp)) {
                    this._seenCodepoints.add(cp);
                    (fresh ?? (fresh = [])).push(cp);
                }
            }
        }
        if (fresh) {
            const before = live.size;
            live.ensureCodepoints(fresh, atlas._shapeCache);
            if (live.size !== before) getWorkerBridge().resyncShapeCache();
        }
    }

    /** @private */
    _teardown() {
        this._field?.dispose();
        this._field = null;
        this._items = [];
        this._alphaQ = [];
    }

    dispose() {
        this._offRelayout?.();
        this._teardown();
    }
}
