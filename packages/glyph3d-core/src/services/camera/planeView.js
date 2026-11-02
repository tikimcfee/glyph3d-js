/**
 * planeView — the camera math for READING a flat surface at an exact screen scale.
 *
 * A perspective camera squared to a plane (looking straight down its normal) maps that plane
 * with ONE uniform scale: there is no foreshortening on a surface perpendicular to the view
 * axis. At view depth D the visible height is 2·D·tan(fov/2) world units across the viewport's
 * H CSS pixels, so a plane scale of `pxPerUnit` CSS px per world unit sits at
 *
 *     D = H / (2 · pxPerUnit · tan(fov/2))
 *
 * Narrowing fov while D grows by that law keeps the plane's scale fixed — a dolly zoom. That
 * IS the ease into orthographic: what changes is only how much something OFF the plane (a
 * layer `d` in front of it) drifts — its screen offset from the view center grows by D/(D−d).
 * At a small enough fov that drift is under a pixel everywhere on screen, and the plane reads
 * as orthographic while the camera stays the one perspective camera every system already
 * handles (picking, culling, far-LOD, the batches). A wider fov is the parallax fan: layers
 * spread with depth, and narrowing it flattens them back.
 *
 * Pulled back that far, the camera would look THROUGH everything between it and the plane, so
 * the view carries a depth SLAB: near and far bracket the plane's own depth range, clipping
 * whatever stands in front (the far wall of a ring, other desks) and buying depth precision.
 *
 * Pixel exactness: the plane's ORIGIN (a pane's top-left) lands on a device-pixel corner when
 * the aim point is offset by the fractional part. `snapAim` computes that offset.
 *
 * Pure: plain numbers in, plain numbers out; no THREE. Gate: tools/plane-view.test.mjs.
 */

const DEG = Math.PI / 180;

/**
 * View depth at which a plane shows at `pxPerUnit` CSS px per world unit.
 * @param {{fovDeg:number, viewportH:number, pxPerUnit:number}} p
 * @returns {number} world units from the camera to the plane
 */
export function planeDistance({ fovDeg, viewportH, pxPerUnit }) {
    if (!(fovDeg > 0 && fovDeg < 180) || !(viewportH > 0) || !(pxPerUnit > 0)) {
        throw new Error(`planeDistance: bad input fovDeg=${fovDeg} viewportH=${viewportH} pxPerUnit=${pxPerUnit}`);
    }
    return viewportH / (2 * pxPerUnit * Math.tan((fovDeg * DEG) / 2));
}

/**
 * The plane scale a camera shows at depth D: CSS px per world unit (the inverse of planeDistance).
 * @param {{fovDeg:number, viewportH:number, distance:number}} p
 * @returns {number}
 */
export function planeScale({ fovDeg, viewportH, distance }) {
    return viewportH / (2 * distance * Math.tan((fovDeg * DEG) / 2));
}

/**
 * How far (CSS px) a point `depth` world units IN FRONT of the plane (toward the camera; negative =
 * behind it) drifts from where the orthographic view would draw it, when it sits `offsetPx` CSS px
 * from the view center. Its screen offset scales by D/(D − depth).
 * @param {{fovDeg:number, viewportH:number, pxPerUnit:number, depth:number, offsetPx:number}} p
 * @returns {number} signed drift in CSS px (positive = outward)
 */
export function parallaxPx({ fovDeg, viewportH, pxPerUnit, depth, offsetPx }) {
    const D = planeDistance({ fovDeg, viewportH, pxPerUnit });
    if (depth >= D) return Infinity;   // at or behind the camera
    return offsetPx * (depth / (D - depth));
}

/**
 * The widest fov at which a layer `depth` world units off the plane drifts at most `tolPx` CSS px
 * at the farthest on-screen offset `edgePx` (half the viewport diagonal, say). Solving
 * edge·d/(D−d) ≤ tol for D gives D ≥ d·(edge + tol)/tol; the fov follows from planeDistance.
 * @param {{viewportH:number, pxPerUnit:number, depth:number, edgePx:number, tolPx:number}} p
 * @returns {number} fov in degrees (the plane reads orthographic at or below it)
 */
export function orthoFov({ viewportH, pxPerUnit, depth, edgePx, tolPx }) {
    const d = Math.abs(depth);
    if (d === 0) return 179;
    const Dmin = d * (edgePx + tolPx) / tolPx;
    return 2 * Math.atan(viewportH / (2 * pxPerUnit * Dmin)) / DEG;
}

/**
 * The aim point (in plane coordinates, world units, +y up) moved so that `origin` (a pane's
 * top-left, in the same coordinates) lands on a device-pixel CORNER. The view center sits at
 * (W/2, H/2) CSS px; a plane point p maps to device px  dpr·(W/2 + (p.x − aim.x)·s)  and
 * dpr·(H/2 − (p.y − aim.y)·s). The aim shifts by the fractional remainder so both are integers.
 * @param {{aim:{x:number,y:number}, origin:{x:number,y:number}, viewportW:number,
 *          viewportH:number, dpr:number, pxPerUnit:number}} p
 * @returns {{x:number, y:number}} the snapped aim
 */
export function snapAim({ aim, origin, viewportW, viewportH, dpr, pxPerUnit }) {
    const k = dpr * pxPerUnit;                              // device px per world unit
    const ox = dpr * viewportW / 2 + (origin.x - aim.x) * k;
    const oy = dpr * viewportH / 2 - (origin.y - aim.y) * k;
    const fx = ox - Math.round(ox), fy = oy - Math.round(oy);
    // Moving the aim by +a moves every point by −a·k on x and +a·k on y (screen y grows downward).
    return { x: aim.x + fx / k, y: aim.y - fy / k };
}

/**
 * Where a plane point lands on screen, in device px (top-left origin) — the forward map
 * snapAim inverts. For gates and for measuring.
 * @param {{p:{x:number,y:number}, aim:{x:number,y:number}, viewportW:number, viewportH:number,
 *          dpr:number, pxPerUnit:number}} q
 * @returns {{x:number, y:number}}
 */
export function planeToDevice({ p, aim, viewportW, viewportH, dpr, pxPerUnit }) {
    const k = dpr * pxPerUnit;
    return { x: dpr * viewportW / 2 + (p.x - aim.x) * k, y: dpr * viewportH / 2 - (p.y - aim.y) * k };
}

/**
 * The near/far slab for a view at depth D: everything from `front` world units in front of the
 * plane to `back` behind it draws; the rest is clipped.
 * @param {{distance:number, front:number, back:number}} p
 * @returns {{near:number, far:number}}
 */
export function planeSlab({ distance, front, back }) {
    const near = Math.max(distance - front, distance * 1e-3);
    return { near, far: distance + back };
}

/**
 * The pose and lens of a plane view at fraction t of the way from a starting perspective view.
 * The scale and the fov ease separately: the scale in log space from what the camera saw at its
 * aim to the target (so zooming in feels even), the fov linearly in degrees; the depth follows
 * from both, so the plane's scale is exactly the eased scale at every frame (no swim).
 * @param {{fromFov:number, toFov:number, fromScale:number, toScale:number, viewportH:number, t:number}} p
 * @returns {{fovDeg:number, pxPerUnit:number, distance:number}}
 */
export function dollyAt({ fromFov, toFov, fromScale, toScale, viewportH, t }) {
    const u = Math.min(Math.max(t, 0), 1);
    const fovDeg = fromFov + (toFov - fromFov) * u;
    const pxPerUnit = Math.exp(Math.log(fromScale) + (Math.log(toScale) - Math.log(fromScale)) * u);
    return { fovDeg, pxPerUnit, distance: planeDistance({ fovDeg, viewportH, pxPerUnit }) };
}
