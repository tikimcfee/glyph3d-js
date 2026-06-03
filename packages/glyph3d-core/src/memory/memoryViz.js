/**
 * memoryViz — turn raw bytes into the two extra visualization channels of the
 * memory viewer ([[project_memory_viewer]] slice 3): color = meaning, and
 * pointers = edges. Pure + worker/node-safe (no THREE, no DOM); the command
 * handler maps the results onto glyph highlights + ConnectionRenderer edges.
 */

/**
 * Category color for a byte — makes structure legible at a glance:
 *   zero (padding) → dark slate, control (0x01–0x1f) → blue,
 *   printable ASCII (0x20–0x7e) → green, high bytes (0x7f–0xff) → warm.
 * So the ELF magic reads as warm-0x7f then green E·L·F against dark padding.
 * @param {number} b - byte value 0–255
 * @returns {{ r: number, g: number, b: number }} 0–1 RGB
 */
export function byteColor(b) {
    if (b === 0x00) return { r: 0.10, g: 0.12, b: 0.18 };          // zero padding
    if (b < 0x20)   return { r: 0.30, g: 0.45, b: 0.85 };          // control
    if (b <= 0x7e) {                                                // printable ASCII
        const t = (b - 0x20) / (0x7e - 0x20);
        return { r: 0.22 + 0.18 * t, g: 0.82, b: 0.34 };
    }
    const t = (b - 0x7f) / (0xff - 0x7f);                           // high / binary
    return { r: 0.92, g: 0.30 + 0.25 * t, b: 0.22 };
}

/**
 * Detect intra-window pointers: little-endian aligned values that land back
 * inside the loaded window's address range. For a file the "address" is the
 * byte offset (windowOffset + index); for real process memory it's the virtual
 * address. Each hit becomes an edge from the value's cell to the cell it
 * references — a linked list draws itself, a bad pointer flies off into nowhere.
 *
 * Values are read as `width`-byte LE. The top two bytes must be zero (a >2^48
 * value can't be an offset inside any window we'd render), which also cheaply
 * rejects most non-pointer data. Null (all-zero) values are skipped.
 *
 * @param {Uint8Array} bytes - the window
 * @param {Object} [opts]
 * @param {number} [opts.windowOffset=0] - address of bytes[0]
 * @param {number} [opts.width=8] - pointer width in bytes (8 = x86-64)
 * @param {number} [opts.align=8] - scan stride
 * @param {number} [opts.minValue=0] - ignore values below this — on file data, tiny
 *   ints (sizes/counts/flags) masquerade as pointers to the first few bytes; raising
 *   this floor cuts that noise and leaves the real structure.
 * @returns {Array<{ from: number, to: number }>} local byte indices (not addresses)
 */
export function findPointers(bytes, opts = {}) {
    const windowOffset = opts.windowOffset ?? 0;
    const width = opts.width ?? 8;
    const align = opts.align ?? 8;
    const minValue = opts.minValue ?? 0;
    const n = bytes.length;
    const lo = Math.max(windowOffset, minValue);
    const hi = windowOffset + n;

    const out = [];
    for (let k = 0; k + width <= n; k += align) {
        let v = 0;
        let tooBig = false;
        for (let j = width - 1; j >= 0; j--) {
            const byte = bytes[k + j];
            if (j >= 6 && byte !== 0) { tooBig = true; break; } // > 2^48 → not an in-window addr
            v = v * 256 + byte;
        }
        if (tooBig || v === 0) continue;                         // skip overflow + null
        if (v >= lo && v < hi && v !== windowOffset + k) {       // in range, not self
            out.push({ from: k, to: v - windowOffset });
        }
    }
    return out;
}
