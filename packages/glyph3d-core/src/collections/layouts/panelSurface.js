/**
 * panelSurface — the physical backing FACE for a jellyfish panel.
 *
 * A panel (panelPack.js) groups a few file grids into one tile of a column's cylinder. On its own
 * the panel is an invisible transform container: the fields float, held together only by their own
 * window walls. This gives the panel a real SURFACE — a mesh the fields mount onto — so a column
 * reads as a solid faceted cylinder, not a scatter of cards.
 *
 * The face conforms to how the panel's fields are placed (jellyfishLayout.place decides which):
 *   - FLAT  — the panel is one rigid chord-face; the surface is a plane sized to the panel box,
 *             a hair behind the fields (local −Z, toward the pole). Rides the panel's face transform.
 *   - WARP  — the fields are distributed across the panel's arc slice; the surface is a matching
 *             CYLINDER SEGMENT (curved rectangle) at a slightly smaller radius, pole-centered (the
 *             panel sits at identity at the core in warp mode). The apothem math that curves the
 *             fields curves the face too.
 *
 * The look is the shared window material (panelMaterial): a fill + an optional in-shader hairline rim
 * at the face edge, screen-measured so it stays crisp at any distance. One material and one flat
 * geometry are shared across every face (the face is a uniform skin for now); a warped face owns its
 * curved geometry and frees it when the panel is dropped (disposePanelSurfaces, from _flattenGroups).
 *
 * The mesh is tagged userData.isMarker so it is NOT content — layout schemes skip it
 * (partitionChildren), subtreeContentBounds skips it (no bounds pollution), and it lives on the
 * default render layer only, so the opt-in GPU picking pass never sees it.
 */

import * as THREE from 'three';
import { createPanelMaterial, BORDER_FLAGS } from '../panelMaterial.js';
import { RENDER_ORDER } from '../../core/renderOrder.js';
import { LAYER_BAND } from '../../core/layerBands.js';
import { getPipelineArena } from '../../compute/GlyphLayoutCompute.js';

export const PANEL_SURFACE_DEFAULTS = {
    surface: true,            // master toggle — give each panel a rendered backing face
    surfaceColor: 0x0a0a1e,   // face fill (a dark window wall; matches the frame-grid backing)
    surfaceOpacity: 0.9,      // face opacity — a hair of translucency lets overlapping faces read
    surfaceDepth: 8,          // how far behind the fields the face sits (radially, toward the pole)
    surfacePad: 12,           // world-unit margin the face extends beyond the fields it backs
    surfaceSegments: 16,      // arc subdivisions of a warped (curved) face
    surfaceBorder: true,      // paint the hairline rim at the face edge
    surfaceBorderColor: 0x3a4a6a, // rim hue (low-key, defines the face without shouting)
};

// Shared, module-level: one uniform skin for every face this pass. The flat unit plane is scaled
// per panel; the material's fill/border are updated to the current opts on each add (all faces in a
// relayout share one opts, so last-writer is that opts). A warped face brings its OWN geometry.
let _unitPlane = null;
const unitPlane = () => (_unitPlane ??= new THREE.PlaneGeometry(1, 1));

/** Push the surface* opts into a panel-material wrapper (fill, rim, rim toggle). */
function applySurfaceOpts(mat, opts) {
    mat.setFill(opts.surfaceColor, opts.surfaceOpacity);
    mat.setBorder({ color: opts.surfaceBorderColor, width: 1 });
    // The DOCKED bit shows the resting rim (uBorderColor) when a border is wanted; clearing every bit
    // (flags == 0) is a plain fill with no rim — see panelMaterial.
    mat.setBorderFlag(BORDER_FLAGS.DOCKED, !!opts.surfaceBorder);
    return mat;
}

let _mat = null;
function surfaceMaterial(opts) {
    _mat ??= createPanelMaterial({
        color: opts.surfaceColor, opacity: opts.surfaceOpacity,
        side: THREE.DoubleSide, depthWrite: true,
        layerBand: LAYER_BAND.PANEL_FACE,   // rearmost wall — see core/layerBands.js
    });
    return applySurfaceOpts(_mat, opts).material;
}

/**
 * A caller-OWNED face material — for a face whose fill/rim must differ per owner (an
 * agent book's identity hue), where the shared singleton's last-writer-wins would
 * flatten everyone to one look. The caller keeps the wrapper, re-`apply`s opts when
 * they change, passes `wrapper.material` as `opts.material` to addPanelSurface, and
 * disposes it with the owner.
 * @returns {{material:THREE.Material, apply:(opts:object)=>void, dispose:()=>void}}
 */
export function ownSurfaceMaterial(opts) {
    const mat = createPanelMaterial({
        color: opts.surfaceColor, opacity: opts.surfaceOpacity,
        side: THREE.DoubleSide, depthWrite: true,
        layerBand: LAYER_BAND.PANEL_FACE,
    });
    applySurfaceOpts(mat, opts);
    return {
        material: mat.material,
        apply: (o) => applySurfaceOpts(mat, o),
        dispose: () => mat.material.dispose(),
    };
}

/** A cylinder-segment (curved rectangle) BufferGeometry in POLE-centered coords: radius `r`, spanning
 *  [thetaC−half, thetaC+half] around Y, from `yBot` up to `yTop`, with `seg` faces across the arc.
 *  Normals point radially OUTWARD; uv runs 0..1 across the WHOLE segment (so the material's rim lands
 *  at the four outer edges, not every internal seam). */
function curvedSegment(r, thetaC, half, yTop, yBot, seg) {
    const cols = Math.max(2, Math.floor(seg) + 1);   // vertex columns across the arc
    const pos = [], nor = [], uvs = [], idx = [];
    for (let j = 0; j < cols; j++) {
        const t = j / (cols - 1);
        const phi = thetaC - half + 2 * half * t;
        const cx = Math.cos(phi), sz = Math.sin(phi);
        pos.push(r * cx, yTop, r * sz); nor.push(cx, 0, sz); uvs.push(t, 1); // top
        pos.push(r * cx, yBot, r * sz); nor.push(cx, 0, sz); uvs.push(t, 0); // bottom
    }
    for (let j = 0; j < cols - 1; j++) {
        const a = j * 2, b = a + 1, c = a + 2, d = a + 3;  // topJ, botJ, topJ+1, botJ+1
        idx.push(a, b, c, c, b, d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setIndex(idx);
    return g;
}

/**
 * Give `panel` a backing face (added as a child, and returned). No-op → null when disabled or empty.
 * @param {THREE.Object3D} panel the panel node (a jellyfish VStack) to back
 * @param {{mode:'flat', box:THREE.Box3} | {mode:'warp', apothem:number, theta:number, topY:number, w:number, h:number}} spec
 *   flat: the panel's local content box · warp: the arc the fields ride (apothem/theta), the panel top
 *   (topY, ≤ 0 down the face), and the panel's width/height
 * @param {object} opts merged JELLYFISH opts (surface* fields), plus optional `material` — a
 *   caller-owned face material (ownSurfaceMaterial) used instead of the shared singleton
 * @returns {THREE.Mesh|{isPanelFace: true, slot: number, release: () => void}|null}
 *   A FLAT face on the mega-field's PanelField comes back as a slot HANDLE, not a
 *   mesh — release() frees the instance. Warp faces (curved geometry) and
 *   caller-owned-material faces stay meshes.
 */
export function addPanelSurface(panel, spec, opts) {
    if (!opts.surface) return null;
    // FLAT faces ride the instanced PanelField when the mega-field exists (the
    // booted app always; headless/bun object tests have no arena and keep the
    // mesh path). One instance instead of one Mesh — a bulk load's ~N sheet
    // faces were the largest surviving first-draw/scene-walk population.
    // ownFace callers (opts.material — a bespoke per-book rim/fill wrapper)
    // keep meshes: the field's rim identity is a shared uniform by design.
    if (spec.mode !== 'warp' && !opts.material) {
        const mega = getPipelineArena()?.megaField;
        if (mega) return addFieldFace(panel, spec.box, opts, mega);
    }
    const pad = opts.surfacePad, depth = opts.surfaceDepth;
    let mesh;
    if (spec.mode === 'warp') {
        const { apothem, theta, topY, w, h } = spec;
        if (!(apothem > 0) || w <= 0 || h <= 0) return null;
        const r = Math.max(1, apothem - depth);
        const half = (w / 2 + pad) / apothem;   // the arc half-angle the face subtends at the fields' radius
        const geo = curvedSegment(r, theta, half, topY + pad, topY - h - pad, opts.surfaceSegments);
        mesh = new THREE.Mesh(geo, opts.material || surfaceMaterial(opts));
        mesh.userData.disposeGeometry = true;   // per-panel geometry — freed when the panel is dropped
    } else {
        const b = spec.box;
        if (!b || b.isEmpty()) return null;
        mesh = new THREE.Mesh(unitPlane(), opts.material || surfaceMaterial(opts));
        mesh.scale.set((b.max.x - b.min.x) + 2 * pad, (b.max.y - b.min.y) + 2 * pad, 1);
        mesh.position.set((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, b.min.z - depth);
    }
    mesh.name = 'panelSurface';
    mesh.userData.isPanelSurface = true;
    mesh.userData.isMarker = true;   // NOT content: schemes + subtreeContentBounds + picking skip it
    mesh.renderOrder = RENDER_ORDER.PANEL_SURFACE;
    panel.add(mesh);
    return mesh;
}

/** @private A flat face as a PanelField instance: rect in the panel node's own frame, posed by a
 *  rented group texel tracking the node's matrixWorld. Owner is null — a backing face is not
 *  interactive, so its pick hits resolve to nothing (exactly the un-registered mesh's behavior).
 *  The pose rental is cached on the NODE and reused across face re-creates (group ids retire,
 *  never recycle — renting per relayout would grow the group texture without bound). */
function addFieldFace(panel, b, opts, mega) {
    if (!b || b.isEmpty()) return null;
    const pf = mega.panels;
    const pose = (panel.userData._panelPose ??= mega.createPoseGroup(panel));
    const slot = pf.alloc(null, pose.groupId);
    const pad = opts.surfacePad, depth = opts.surfaceDepth;
    pf.setRect(slot,
        (b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2,
        (b.max.x - b.min.x) + 2 * pad, (b.max.y - b.min.y) + 2 * pad,
        b.min.z - depth);
    pf.setFill(slot, opts.surfaceColor, opts.surfaceOpacity);
    pf.setFlags(slot, opts.surfaceBorder ? BORDER_FLAGS.DOCKED : 0);
    // Rim identity is field-wide (last-writer, the same semantics the shared
    // surface material singleton always had).
    pf.setBorder({ color: opts.surfaceBorderColor });
    pf.setVisible(slot, true);
    let released = false;
    const face = {
        isPanelFace: true,
        slot,
        release() {
            if (released) return;
            released = true;
            pf.free(slot);
            const list = panel.userData._panelFaces;
            const i = list ? list.indexOf(face) : -1;
            if (i >= 0) list.splice(i, 1);
        },
    };
    (panel.userData._panelFaces ??= []).push(face);
    return face;
}

/** Release a node's pose-group rental (call when the NODE dies — a released id retires forever). */
export function releasePanelPose(node) {
    node.userData._panelPose?.release?.();
    node.userData._panelPose = null;
}

/** Free the per-panel (curved) face geometries + panel-field face slots + pose rentals under `root`
 *  before its panels are dropped (ContentTree._flattenGroups, subtree disposal). The shared unit
 *  plane + shared material are module singletons that outlive any one layout, left intact. */
export function disposePanelSurfaces(root) {
    root.traverse((o) => {
        if (o.userData?.isPanelSurface && o.userData?.disposeGeometry) o.geometry.dispose();
        const faces = o.userData?._panelFaces;
        if (faces) for (const f of [...faces]) f.release();
        if (o.userData?._panelPose) releasePanelPose(o);
    });
}
