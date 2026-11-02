/**
 * depthWire — the hand's depth crop on the wire, and its unprojection to the PHONE frame.
 *
 * A capture device sends, with each hand it sees, the region of its DEPTH MAP around that
 * hand (Vision's keypoint box, padded): raw depth, nothing segmented or filtered, the
 * background included. The pixel grid is the point: neighbours, connected components, edges
 * and holes come straight from it, and the crop is smaller than a list of points. The relay
 * forwards source frames as JSON text, so the planes ride as base64 inside the handFrame:
 *
 *   hands[i].cloud = {
 *     v: 1,                    // required
 *     w, h,                    // the full depth map's size, pixels
 *     roi: [x0, y0, rw, rh],   // the crop, in depth-map pixels
 *     intr: [fx, fy, cx, cy],  // pinhole intrinsics AT THE DEPTH MAP's resolution; pixel
 *                              // (u, v) — integer column/row — sees camera ray ((u−cx)/fx, (v−cy)/fy, 1)
 *     toPhone: [9],            // row-major rotation, camera frame (x right, y down, z forward)
 *                              // → PHONE frame (hand-wire v2); the optical centre is both origins
 *     depth: base64,           // u16 little-endian per crop pixel, row-major, 0.1 mm units of
 *                              // camera z-depth; 0 = no depth
 *     conf: base64 | absent,   // u8 per crop pixel: the sensor's confidence 0 (low) / 1 / 2 (high)
 *     t, filtered,             // the depth map's capture time; whether the device filtered it (read by status)
 *   }
 *
 * Pure: no DOM, no Three.js; typed arrays throughout (it decodes every frame).
 */

export const CLOUD_WIRE_V = 1;
/** Meters per depth count on the wire (0.1 mm; u16 tops out at 6.5535 m). */
export const DEPTH_UNIT = 1e-4;

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_DEC = (() => {
    const t = new Int16Array(128).fill(-1);
    for (let i = 0; i < 64; i++) t[B64.charCodeAt(i)] = i;
    return t;
})();

/** Standard base64 (with padding) of bytes. @param {Uint8Array} u8 @returns {string} */
export function b64encode(u8) {
    const n = u8.length;
    const out = new Array(Math.ceil(n / 3));
    let k = 0;
    for (let i = 0; i < n; i += 3) {
        const a = u8[i], b = i + 1 < n ? u8[i + 1] : 0, c = i + 2 < n ? u8[i + 2] : 0;
        const t = (a << 16) | (b << 8) | c;
        out[k++] = B64[(t >> 18) & 63] + B64[(t >> 12) & 63]
            + (i + 1 < n ? B64[(t >> 6) & 63] : '=') + (i + 2 < n ? B64[t & 63] : '=');
    }
    return out.join('');
}

/** Bytes of a base64 string; throws on a character outside the alphabet. @param {string} s */
export function b64decode(s) {
    let len = s.length;
    while (len > 0 && s.charCodeAt(len - 1) === 61) len--; // '='
    const out = new Uint8Array(Math.floor((len * 3) / 4));
    let acc = 0, bits = 0, o = 0;
    for (let i = 0; i < len; i++) {
        const c = s.charCodeAt(i);
        const v = c < 128 ? B64_DEC[c] : -1;
        if (v < 0) throw new Error(`depthWire: bad base64 character ${JSON.stringify(s[i])} at ${i}`);
        acc = (acc << 6) | v;
        bits += 6;
        if (bits >= 8) { bits -= 8; out[o++] = (acc >> bits) & 255; }
    }
    return out;
}

/**
 * @typedef {Object} DepthCloud
 * @property {number} w @property {number} h - the full depth map
 * @property {number} x0 @property {number} y0 @property {number} rw @property {number} rh - the crop
 * @property {number} fx @property {number} fy @property {number} cx @property {number} cy
 * @property {Float64Array} R - row-major camera → PHONE rotation
 * @property {Float32Array} depth - camera z-depth per crop pixel, meters; 0 = none
 * @property {Uint8Array|null} conf - per crop pixel 0/1/2, or null when not sent
 */

/**
 * The wire block for a crop (what a device sends; DepthSim emits exactly this).
 * @param {{w: number, h: number, roi: number[], intr: number[], toPhone: ArrayLike<number>,
 *   depth: Float32Array, conf?: Uint8Array|null}} c - depth in meters, 0 = none
 */
export function encodeDepthCloud({ w, h, roi, intr, toPhone, depth, conf = null }) {
    const [, , rw, rh] = roi;
    const n = rw * rh;
    if (depth.length !== n) throw new Error(`depthWire: depth has ${depth.length} values for a ${rw}×${rh} crop`);
    const bytes = new Uint8Array(n * 2);
    const dv = new DataView(bytes.buffer);
    for (let i = 0; i < n; i++) {
        const d = depth[i];
        const q = d > 0 ? Math.min(65535, Math.max(1, Math.round(d / DEPTH_UNIT))) : 0;
        dv.setUint16(i * 2, q, true);
    }
    const out = { v: CLOUD_WIRE_V, w, h, roi: [...roi], intr: [...intr], toPhone: Array.from(toPhone), depth: b64encode(bytes) };
    if (conf) {
        if (conf.length !== n) throw new Error(`depthWire: conf has ${conf.length} values for a ${rw}×${rh} crop`);
        out.conf = b64encode(conf);
    }
    return out;
}

const finite = (a, n) => Array.isArray(a) && a.length === n && a.every(Number.isFinite);

/**
 * Read a wire block. Absent → null; malformed → throws with the reason (a seam: the device
 * and this decoder disagree, and that must be loud, not a hand that silently stops tracking).
 * @param {Object|null|undefined} wire
 * @returns {DepthCloud|null}
 */
export function decodeDepthCloud(wire) {
    if (wire == null) return null;
    if (wire.v !== CLOUD_WIRE_V) throw new Error(`depthWire: cloud ${wire.v == null ? 'with no version' : `v${wire.v}`}, this decoder reads v${CLOUD_WIRE_V}`);
    if (!finite(wire.roi, 4)) throw new Error(`depthWire: roi ${JSON.stringify(wire.roi)} is not [x0, y0, w, h]`);
    if (!finite(wire.intr, 4)) throw new Error(`depthWire: intr ${JSON.stringify(wire.intr)} is not [fx, fy, cx, cy]`);
    if (!finite(wire.toPhone, 9)) throw new Error('depthWire: toPhone is not 9 numbers (row-major 3×3)');
    const [x0, y0, rw, rh] = wire.roi;
    const n = rw * rh;
    if (!(rw > 0 && rh > 0)) throw new Error(`depthWire: empty crop ${rw}×${rh}`);
    const bytes = b64decode(String(wire.depth ?? ''));
    if (bytes.length !== n * 2) throw new Error(`depthWire: depth carries ${bytes.length} bytes, a ${rw}×${rh} crop of u16 needs ${n * 2}`);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const depth = new Float32Array(n);
    for (let i = 0; i < n; i++) depth[i] = dv.getUint16(i * 2, true) * DEPTH_UNIT;
    let conf = null;
    if (wire.conf != null) {
        conf = b64decode(String(wire.conf));
        if (conf.length !== n) throw new Error(`depthWire: conf carries ${conf.length} bytes for a ${rw}×${rh} crop`);
    }
    const [fx, fy, cx, cy] = wire.intr;
    return {
        w: wire.w, h: wire.h, x0, y0, rw, rh, fx, fy, cx, cy,
        R: Float64Array.from(wire.toPhone), depth, conf,
    };
}

/**
 * Every crop pixel as a PHONE-frame point (meters): xyz[3i..3i+2]; (0,0,0) where there's no
 * depth. Writes into `out` when it is big enough.
 * @param {DepthCloud} c @param {Float32Array} [out]
 */
export function unprojectCloud(c, out) {
    const n = c.rw * c.rh;
    const xyz = out && out.length >= n * 3 ? out : new Float32Array(n * 3);
    const R = c.R;
    for (let j = 0, i = 0; j < c.rh; j++) {
        const ry = (c.y0 + j - c.cy) / c.fy;
        for (let k = 0; k < c.rw; k++, i++) {
            const z = c.depth[i];
            if (!(z > 0)) { xyz[3 * i] = 0; xyz[3 * i + 1] = 0; xyz[3 * i + 2] = 0; continue; }
            const X = ((c.x0 + k - c.cx) / c.fx) * z, Y = ry * z;
            xyz[3 * i] = R[0] * X + R[1] * Y + R[2] * z;
            xyz[3 * i + 1] = R[3] * X + R[4] * Y + R[5] * z;
            xyz[3 * i + 2] = R[6] * X + R[7] * Y + R[8] * z;
        }
    }
    return xyz;
}

/**
 * Where a PHONE-frame point lands in the depth map: {u, v} (full-map pixels, fractional) and
 * its camera z-depth; null behind the camera.
 * @param {DepthCloud} c @param {{x: number, y: number, z: number}} p
 */
export function projectToCloud(c, p) {
    const R = c.R;
    // camera = Rᵀ · phone
    const X = R[0] * p.x + R[3] * p.y + R[6] * p.z;
    const Y = R[1] * p.x + R[4] * p.y + R[7] * p.z;
    const Z = R[2] * p.x + R[5] * p.y + R[8] * p.z;
    if (!(Z > 1e-6)) return null;
    return { u: c.fx * (X / Z) + c.cx, v: c.fy * (Y / Z) + c.cy, z: Z };
}

/** The PHONE-frame unit ray through crop pixel (k, j). @param {DepthCloud} c */
export function pixelRay(c, k, j) {
    const X = (c.x0 + k - c.cx) / c.fx, Y = (c.y0 + j - c.cy) / c.fy;
    const R = c.R;
    const x = R[0] * X + R[1] * Y + R[2], y = R[3] * X + R[4] * Y + R[5], z = R[6] * X + R[7] * Y + R[8];
    const l = Math.hypot(x, y, z);
    return { x: x / l, y: y / l, z: z / l };
}
