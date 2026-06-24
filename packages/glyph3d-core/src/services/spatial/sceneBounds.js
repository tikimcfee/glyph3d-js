/**
 * sceneBounds — the shared "world extent" computation.
 *
 * Unioning the world AABBs of every bounds-bearing object ("how big is everything, and
 * where is it") is the spine several features hang off: the minimap frames it, the
 * grounding arena will draw it, soft camera bounds will clamp against it, fit-all uses it.
 * It was open-coded in the minimap and across the layout managers (getTotalBounds); this
 * is the one place.
 *
 * On-demand BY DESIGN — no cache, no dirty flag. Each consumer recomputes at its own
 * cadence (the minimap every frame, the arena on a content change), because content bounds
 * move continuously (drag / resize / relayout) and an observed/cached extent is exactly the
 * over-build that bit us before (the BoundsObject3D lesson — on-demand beat the cache). Pass
 * a reusable `target` to stay allocation-free in a hot loop.
 */

/**
 * Union the world bounds of `objects` into `target`.
 *
 * @param {Iterable<{ getBounds?: () => { isEmpty?: () => boolean } }>} objects
 *        anything exposing getBounds() → a THREE.Box3 (CodeGrid / TerminalGrid / FrameGrid …).
 *        Entries that are null, lack getBounds, or whose bounds are empty are skipped.
 * @param {import('three').Box3} target  reused output box (caller owns it) — emptied first.
 * @param {object} [opts]
 * @param {import('three').Vector3} [opts.expandToInclude]  also stretch the box to cover this
 *        point (e.g. the camera eye, so the minimap keeps the cone in frame). Do NOT pass it
 *        when the box is a camera CONSTRAINT — including the eye would defeat the leash.
 * @returns {import('three').Box3} target — left empty if nothing qualified.
 */
export function worldBounds(objects, target, opts = {}) {
    target.makeEmpty();
    for (const o of objects) {
        const b = o?.getBounds?.();
        if (b && !(b.isEmpty?.())) target.union(b);
    }
    if (opts.expandToInclude) target.expandByPoint(opts.expandToInclude);
    return target;
}
