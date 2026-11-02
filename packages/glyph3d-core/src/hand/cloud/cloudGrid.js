/**
 * cloudGrid — the pixel-graph machinery the cloud tracker's stages share: union-find connected
 * components, a chamfer distance transform, Dijkstra over the 3-D surface the pixels sample,
 * enclosed-region (hole) search. All on flat typed arrays indexed i = row · w + col.
 *
 * Pure: no DOM, no Three.js.
 */

const N4 = [[1, 0], [0, 1], [-1, 0], [0, -1]];
const N8 = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];

/** Union-find root with path halving. @param {Int32Array} p */
function root(p, i) {
    while (p[i] !== i) { p[i] = p[p[i]]; i = p[i]; }
    return i;
}

/**
 * Connected components of the pixels `inSet(i)`, 4-connected where `link(i, j)` holds.
 * @param {number} w @param {number} h
 * @param {(i: number) => boolean} inSet
 * @param {(i: number, j: number) => boolean} link
 * @returns {{label: Int32Array, sizes: Map<number, number>}} label −1 outside the set; labels are root indices
 */
export function components(w, h, inSet, link) {
    const n = w * h;
    const p = new Int32Array(n);
    for (let i = 0; i < n; i++) p[i] = inSet(i) ? i : -1;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = y * w + x;
            if (p[i] < 0) continue;
            if (x + 1 < w && p[i + 1] >= 0 && link(i, i + 1)) { const a = root(p, i), b = root(p, i + 1); if (a !== b) p[Math.max(a, b)] = Math.min(a, b); }
            if (y + 1 < h && p[i + w] >= 0 && link(i, i + w)) { const a = root(p, i), b = root(p, i + w); if (a !== b) p[Math.max(a, b)] = Math.min(a, b); }
        }
    }
    const label = new Int32Array(n);
    const sizes = new Map();
    for (let i = 0; i < n; i++) {
        if (p[i] < 0) { label[i] = -1; continue; }
        const r = root(p, i);
        label[i] = r;
        sizes.set(r, (sizes.get(r) || 0) + 1);
    }
    return { label, sizes };
}

/**
 * Chamfer (3-4) distance of each mask pixel to the nearest non-mask pixel (outside the grid
 * counts as non-mask), in PIXELS.
 * @param {number} w @param {number} h @param {Uint8Array} mask - 1 inside
 * @returns {Float32Array}
 */
export function distanceTransform(w, h, mask) {
    const n = w * h, BIG = 1e9;
    const d = new Float32Array(n);
    for (let i = 0; i < n; i++) d[i] = mask[i] ? BIG : 0;
    const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : d[y * w + x]);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!d[i]) continue;
        d[i] = Math.min(d[i], at(x - 1, y) + 3, at(x, y - 1) + 3, at(x - 1, y - 1) + 4, at(x + 1, y - 1) + 4);
    }
    for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
        const i = y * w + x;
        if (!d[i]) continue;
        d[i] = Math.min(d[i], at(x + 1, y) + 3, at(x, y + 1) + 3, at(x + 1, y + 1) + 4, at(x - 1, y + 1) + 4);
    }
    for (let i = 0; i < n; i++) d[i] /= 3;
    return d;
}

/** A binary min-heap of (key, value) on typed arrays, growing as needed. */
class Heap {
    constructor(cap = 1024) { this.k = new Float64Array(cap); this.v = new Int32Array(cap); this.n = 0; }
    push(key, val) {
        if (this.n === this.k.length) {
            const k = new Float64Array(this.n * 2), v = new Int32Array(this.n * 2);
            k.set(this.k); v.set(this.v); this.k = k; this.v = v;
        }
        let i = this.n++;
        const K = this.k, V = this.v;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (K[p] <= key) break;
            K[i] = K[p]; V[i] = V[p]; i = p;
        }
        K[i] = key; V[i] = val;
    }
    /** Pop the min; its key lands in this.topKey. @returns {number} value */
    pop() {
        const K = this.k, V = this.v;
        const topV = V[0];
        this.topKey = K[0];
        const key = K[--this.n], val = V[this.n];
        let i = 0;
        for (;;) {
            let c = 2 * i + 1;
            if (c >= this.n) break;
            if (c + 1 < this.n && K[c + 1] < K[c]) c++;
            if (K[c] >= key) break;
            K[i] = K[c]; V[i] = V[c]; i = c;
        }
        K[i] = key; V[i] = val;
        return topV;
    }
}

/**
 * Geodesic distance over the surface the pixels sample: Dijkstra on the 8-connected pixel
 * graph of `mask`, an edge where `link(i, j)`, weighted by the 3-D distance between the two
 * pixels' points. Relaxes `dist` IN PLACE from `sources` (each at 0) — so a second call with a
 * new source lowers distances toward it and leaves the rest (the AGEX extremum search).
 * @param {number} w @param {number} h @param {Uint8Array} mask
 * @param {Float32Array} xyz - 3 per pixel
 * @param {Float32Array} dist - Infinity where unreached
 * @param {number[]} sources
 * @param {(i: number, j: number) => boolean} link
 * @param {Heap} [heap]
 */
export function geodesic(w, h, mask, xyz, dist, sources, link, heap = new Heap()) {
    heap.n = 0;
    for (const s of sources) { if (mask[s]) { dist[s] = 0; heap.push(0, s); } }
    while (heap.n) {
        const i = heap.pop();
        const di = heap.topKey;
        if (di > dist[i]) continue;
        const x = i % w, y = (i - x) / w;
        for (const [dx, dy] of N8) {
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
            const j = yy * w + xx;
            if (!mask[j] || !link(i, j)) continue;
            const ex = xyz[3 * j] - xyz[3 * i], ey = xyz[3 * j + 1] - xyz[3 * i + 1], ez = xyz[3 * j + 2] - xyz[3 * i + 2];
            const nd = di + Math.sqrt(ex * ex + ey * ey + ez * ez);
            // Queue the STORED (Float32) value, or the pop would look stale against it and skip.
            if (nd < dist[j]) { dist[j] = nd; heap.push(dist[j], j); }
        }
    }
    return dist;
}
export { Heap };

/**
 * The regions of non-mask pixels the mask ENCLOSES: what a flood from the grid's border
 * through non-mask pixels can't reach, as 4-connected components.
 * @param {number} w @param {number} h @param {Uint8Array} mask
 * @returns {number[][]} each enclosed region's pixel indices
 */
export function enclosedRegions(w, h, mask) {
    const n = w * h;
    const seen = new Uint8Array(n);
    const stack = [];
    const seed = (i) => { if (!mask[i] && !seen[i]) { seen[i] = 1; stack.push(i); } };
    for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
    const flood = () => {
        const out = [];
        while (stack.length) {
            const i = stack.pop();
            out.push(i);
            const x = i % w, y = (i - x) / w;
            for (const [dx, dy] of N4) {
                const xx = x + dx, yy = y + dy;
                if (xx >= 0 && yy >= 0 && xx < w && yy < h) seed(yy * w + xx);
            }
        }
        return out;
    };
    flood(); // the outside
    const regions = [];
    for (let i = 0; i < n; i++) {
        if (mask[i] || seen[i]) continue;
        seed(i);
        regions.push(flood());
    }
    return regions;
}

/** The crop pixel index nearest (k, j) whose class passes `want`, searching out to `r` px; −1 if none. */
export function nearestPixel(c, cls, k, j, r, want) {
    const k0 = Math.round(k), j0 = Math.round(j);
    let best = -1, bd = Infinity;
    for (let dj = -r; dj <= r; dj++) {
        const jj = j0 + dj;
        if (jj < 0 || jj >= c.rh) continue;
        for (let dk = -r; dk <= r; dk++) {
            const kk = k0 + dk;
            if (kk < 0 || kk >= c.rw) continue;
            const d = dk * dk + dj * dj;
            if (d < bd && want(cls[jj * c.rw + kk])) { bd = d; best = jj * c.rw + kk; }
        }
    }
    return best;
}
