/**
 * pixel-metrics.mjs — Pixel-exactness analysis over PNG screenshots (or cropped regions).
 *
 * Measures the four felt properties required for orthographic plane carrels (1 world unit =
 * 1 device pixel):
 *   (a) text row pitch in device px (horizontal ink projection profile -> autocorrelation +
 *       segmented row-band center regression),
 *   (b) edge crispness — ink transition width across vertical and horizontal glyph stems
 *       (1-px step on integer-snapped stems vs 2-px ramp under half-pixel offset or perspective),
 *   (c) stillness — exact frame-to-frame pixel difference between two captures N ms apart,
 *       with a non-empty ink guard so blank-vs-blank fails as vacuous,
 *   (d) scale — ratio of measured horizontal glyph advance in device px to the runtime
 *       atlas advance derived from the font chain via deriveCharSize / computeCellMetrics.
 *
 * Pure ES module with zero external image dependencies (PNG decode/encode via node:zlib).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { inflateSync, deflateSync } from 'node:zlib';
import { deriveCharSize, computeCellMetrics } from '../../packages/glyph3d-core/src/core/cellMetrics.js';
import { bootHeadlessFontChain } from '../headlessFontChain.mjs';

/**
 * @typedef {{
 *   width: number,
 *   height: number,
 *   data: Uint8Array,
 *   crop?: { x: number, y: number, w: number, h: number }
 * }} RgbaImage
 *
 * @typedef {{
 *   width: number,
 *   height: number,
 *   bg: [number, number, number],
 *   ink: Float32Array,
 *   inkPixels: number,
 *   inkCoverage: number,
 *   maxContrast: number,
 *   p95Ink: number,
 *   vacuous: boolean
 * }} InkMap
 *
 * @typedef {{
 *   yStart: number,
 *   yEnd: number,
 *   yCenter: number,
 *   height: number,
 *   meanInk: number,
 *   peakInk: number
 * }} InkRowBand
 *
 * @typedef {{
 *   pitchPx: number | null,
 *   medianDiffPx: number | null,
 *   meanDiffPx: number | null,
 *   stdDiffPx: number | null,
 *   autocorrPitchPx: number | null,
 *   autocorrStrength: number,
 *   integerSnapErrorPx: number | null,
 *   nearestIntegerPx: number | null,
 *   rowCount: number,
 *   medianBandHeightPx: number | null,
 *   rows: InkRowBand[],
 *   vacuous: boolean
 * }} RowPitchResult
 *
 * @typedef {{
 *   rampWidthMedianPx: number | null,
 *   rampWidthMeanPx: number | null,
 *   rawRamp10_90MedianPx: number | null,
 *   verticalStemRampPx: number | null,
 *   horizontalStemRampPx: number | null,
 *   twoPxRampShare: number | null,
 *   sharpStepShare: number | null,
 *   midGrayInkShare: number,
 *   edgeCount: number,
 *   verticalEdgeCount: number,
 *   horizontalEdgeCount: number,
 *   vacuous: boolean
 * }} EdgeCrispnessResult
 *
 * @typedef {{
 *   width: number,
 *   height: number,
 *   totalPixels: number,
 *   changedPixels: number,
 *   changedRatio: number,
 *   changedAboveTol: number,
 *   changedAboveTolRatio: number,
 *   tolerance: number,
 *   maxDiff: number,
 *   meanAbsDiff: number,
 *   diffBounds: { x: number, y: number, w: number, h: number } | null,
 *   inkCoverageA: number,
 *   inkCoverageB: number,
 *   vacuous: boolean,
 *   still: boolean
 * }} StillnessResult
 *
 * @typedef {{
 *   measuredAdvancePx: number | null,
 *   autocorrAdvancePx: number | null,
 *   autocorrStrength: number,
 *   blobMedianAdvancePx: number | null,
 *   expectedAdvancePx: number | null,
 *   scaleRatio: number | null,
 *   scaleErrorPct: number | null,
 *   measuredAdvanceToPitch: number | null,
 *   atlasAdvanceToPitch: number | null,
 *   aspectScaleRatio: number | null,
 *   rowsMeasured: number,
 *   glyphCount: number,
 *   vacuous: boolean
 * }} GlyphScaleResult
 *
 * @typedef {{
 *   fontSize: number,
 *   worldScale: number,
 *   upem: number,
 *   mAdvanceUnits: number,
 *   charSize: { width: number, height: number },
 *   cellMetrics: ReturnType<typeof computeCellMetrics>,
 *   cellAdvanceToPitch: number,
 *   shaperAdvanceToPitch: number,
 *   advanceAtRowPitch: (rowPitchPx: number, mode?: 'cell' | 'shaper') => number
 * }} AtlasReferenceMetrics
 */

const PNG_SIG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

/**
 * Paeth predictor per RFC 2083 section 6.6.
 * @param {number} a - left byte
 * @param {number} b - above byte
 * @param {number} c - upper-left byte
 * @returns {number}
 */
function paeth(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
}

/**
 * Decode an 8-bit non-interlaced PNG buffer into top-down RGBA8 pixels.
 * @param {Uint8Array | Buffer} buf
 * @returns {RgbaImage}
 */
export function decodePng(buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    if (bytes.length < 33) throw new Error('decodePng: buffer too short');
    for (let i = 0; i < 8; i++) {
        if (bytes[i] !== PNG_SIG[i]) throw new Error('decodePng: invalid PNG signature');
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
    /** @type {Uint8Array[]} */
    const idatChunks = [];
    let idatTotal = 0;
    let offset = 8;

    while (offset + 8 <= bytes.length) {
        const len = view.getUint32(offset, false);
        const type = String.fromCharCode(
            bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]
        );
        const dataStart = offset + 8;
        const dataEnd = dataStart + len;
        if (dataEnd + 4 > bytes.length) throw new Error(`decodePng: truncated chunk ${type}`);

        if (type === 'IHDR') {
            width = view.getUint32(dataStart, false);
            height = view.getUint32(dataStart + 4, false);
            bitDepth = bytes[dataStart + 8];
            colorType = bytes[dataStart + 9];
            const compression = bytes[dataStart + 10];
            const filter = bytes[dataStart + 11];
            interlace = bytes[dataStart + 12];
            if (bitDepth !== 8) throw new Error(`decodePng: unsupported bitDepth=${bitDepth} (expected 8)`);
            if (compression !== 0 || filter !== 0 || interlace !== 0) {
                throw new Error(`decodePng: unsupported compression/filter/interlace (${compression}/${filter}/${interlace})`);
            }
        } else if (type === 'IDAT') {
            const slice = bytes.subarray(dataStart, dataEnd);
            idatChunks.push(slice);
            idatTotal += slice.length;
        } else if (type === 'IEND') {
            break;
        }
        offset = dataEnd + 4;
    }

    if (width <= 0 || height <= 0) throw new Error('decodePng: missing or invalid IHDR');
    const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 0 ? 1 : 0;
    if (!channels) throw new Error(`decodePng: unsupported colorType=${colorType}`);

    const compressed = new Uint8Array(idatTotal);
    let pos = 0;
    for (const c of idatChunks) {
        compressed.set(c, pos);
        pos += c.length;
    }
    const raw = new Uint8Array(inflateSync(compressed));
    const stride = width * channels;
    const expectedLen = height * (1 + stride);
    if (raw.length < expectedLen) {
        throw new Error(`decodePng: inflated size ${raw.length} < expected ${expectedLen}`);
    }

    const recon = new Uint8Array(height * stride);
    for (let y = 0; y < height; y++) {
        const filterType = raw[y * (1 + stride)];
        const srcRow = y * (1 + stride) + 1;
        const dstRow = y * stride;
        const prevRow = (y - 1) * stride;

        for (let i = 0; i < stride; i++) {
            const x = raw[srcRow + i];
            const a = i >= channels ? recon[dstRow + i - channels] : 0;
            const b = y > 0 ? recon[prevRow + i] : 0;
            const c = (y > 0 && i >= channels) ? recon[prevRow + i - channels] : 0;
            let v = x;
            if (filterType === 1) v = (x + a) & 0xff;
            else if (filterType === 2) v = (x + b) & 0xff;
            else if (filterType === 3) v = (x + ((a + b) >> 1)) & 0xff;
            else if (filterType === 4) v = (x + paeth(a, b, c)) & 0xff;
            else if (filterType !== 0) throw new Error(`decodePng: unknown scanline filter ${filterType} at row ${y}`);
            recon[dstRow + i] = v;
        }
    }

    const rgba = new Uint8Array(width * height * 4);
    if (channels === 4) {
        rgba.set(recon);
    } else if (channels === 3) {
        for (let i = 0, j = 0; i < recon.length; i += 3, j += 4) {
            rgba[j] = recon[i];
            rgba[j + 1] = recon[i + 1];
            rgba[j + 2] = recon[i + 2];
            rgba[j + 3] = 255;
        }
    } else if (channels === 2) {
        for (let i = 0, j = 0; i < recon.length; i += 2, j += 4) {
            rgba[j] = rgba[j + 1] = rgba[j + 2] = recon[i];
            rgba[j + 3] = recon[i + 1];
        }
    } else {
        for (let i = 0, j = 0; i < recon.length; i += 1, j += 4) {
            rgba[j] = rgba[j + 1] = rgba[j + 2] = recon[i];
            rgba[j + 3] = 255;
        }
    }
    return { width, height, data: rgba };
}

/** CRC32 table for PNG chunk encoding. */
const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c >>> 0;
    }
    return t;
})();

/**
 * @param {Uint8Array} typeAndData
 * @returns {number}
 */
function crc32(typeAndData) {
    let c = 0xffffffff;
    for (let i = 0; i < typeAndData.length; i++) {
        c = CRC_TABLE[(c ^ typeAndData[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
}

/**
 * @param {string} type
 * @param {Uint8Array} data
 * @returns {Uint8Array}
 */
function makeChunk(type, data) {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length, false);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)), false);
    return out;
}

/**
 * Encode an RGBA8 image into a standard PNG buffer.
 * @param {RgbaImage} img
 * @returns {Uint8Array}
 */
export function encodePng(img) {
    const { width, height, data } = img;
    if (width <= 0 || height <= 0 || data.length !== width * height * 4) {
        throw new Error(`encodePng: invalid image dimensions ${width}x${height} (data=${data.length})`);
    }
    const ihdr = new Uint8Array(13);
    const iv = new DataView(ihdr.buffer);
    iv.setUint32(0, width, false);
    iv.setUint32(4, height, false);
    ihdr[8] = 8;  // bit depth 8
    ihdr[9] = 6;  // color type 6 = RGBA
    ihdr[10] = 0; // compression
    ihdr[11] = 0; // filter
    ihdr[12] = 0; // interlace

    const stride = width * 4;
    const raw = new Uint8Array(height * (1 + stride));
    for (let y = 0; y < height; y++) {
        raw[y * (1 + stride)] = 0; // filter 0 (None)
        raw.set(data.subarray(y * stride, (y + 1) * stride), y * (1 + stride) + 1);
    }
    const idatData = new Uint8Array(deflateSync(raw));
    const cIhdr = makeChunk('IHDR', ihdr);
    const cIdat = makeChunk('IDAT', idatData);
    const cIend = makeChunk('IEND', new Uint8Array(0));

    const out = new Uint8Array(PNG_SIG.length + cIhdr.length + cIdat.length + cIend.length);
    let o = 0;
    out.set(PNG_SIG, o); o += PNG_SIG.length;
    out.set(cIhdr, o); o += cIhdr.length;
    out.set(cIdat, o); o += cIdat.length;
    out.set(cIend, o);
    return out;
}

/**
 * Read a PNG file from disk.
 * @param {string} path
 * @returns {RgbaImage}
 */
export function readPng(path) {
    return decodePng(readFileSync(path));
}

/**
 * Write an RGBA8 image as a PNG file to disk.
 * @param {string} path
 * @param {RgbaImage} img
 */
export function writePng(path, img) {
    writeFileSync(path, encodePng(img));
}

/**
 * Crop a rectangular sub-region from an RGBA8 image. Fails loud if out of bounds.
 * @param {RgbaImage} img
 * @param {{ x: number, y: number, w: number, h: number }} rect
 * @returns {RgbaImage}
 */
export function cropImage(img, rect) {
    const x = Math.trunc(rect.x);
    const y = Math.trunc(rect.y);
    const w = Math.trunc(rect.w);
    const h = Math.trunc(rect.h);
    if (w <= 0 || h <= 0 || x < 0 || y < 0 || x + w > img.width || y + h > img.height) {
        throw new Error(`cropImage: invalid crop (${x},${y},${w},${h}) on ${img.width}x${img.height} image`);
    }
    const out = new Uint8Array(w * h * 4);
    for (let row = 0; row < h; row++) {
        const srcOff = ((y + row) * img.width + x) * 4;
        out.set(img.data.subarray(srcOff, srcOff + w * 4), row * w * 4);
    }
    return { width: w, height: h, data: out, crop: { x, y, w, h } };
}

/**
 * Parse a "x,y,w,h" crop flag string.
 * @param {string} spec
 * @returns {{ x: number, y: number, w: number, h: number }}
 */
export function parseCropSpec(spec) {
    const parts = String(spec).split(',').map((s) => Number(s.trim()));
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
        throw new Error(`Invalid crop spec "${spec}" — expected "x,y,w,h"`);
    }
    return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
}

/**
 * Quantile of a sorted numeric array.
 * @param {ArrayLike<number>} sorted
 * @param {number} q - in [0, 1]
 * @returns {number}
 */
function quantileSorted(sorted, q) {
    if (!sorted.length) return 0;
    const pos = Math.max(0, Math.min(sorted.length - 1, q * (sorted.length - 1)));
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return lo === hi ? sorted[lo] : sorted[lo] * (hi - pos) + sorted[hi] * (pos - lo);
}

/**
 * Estimate background color and per-pixel normalized ink contrast in [0, 1].
 * Background is inferred from the dominant luminance histogram mode (since background plate
 * or sky occupies the majority of pixels in any text pane).
 *
 * @param {RgbaImage} img
 * @param {{
 *   inkThreshold?: number,
 *   minInkPixels?: number,
 *   minContrast?: number
 * }} [opts]
 * @returns {InkMap}
 */
export function computeInkMap(img, opts = {}) {
    const { width, height, data } = img;
    const inkThreshold = opts.inkThreshold ?? 0.08;
    const minInkPixels = opts.minInkPixels ?? 12;
    const minContrast = opts.minContrast ?? 0.08;
    const n = width * height;

    // 64-bin luminance histogram to locate the dominant background tone
    const bins = new Int32Array(64);
    const sumR = new Float64Array(64);
    const sumG = new Float64Array(64);
    const sumB = new Float64Array(64);

    for (let i = 0; i < n; i++) {
        const o = i * 4;
        const r = data[o], g = data[o + 1], b = data[o + 2];
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        const bin = Math.min(63, Math.max(0, lum >> 2));
        bins[bin]++;
        sumR[bin] += r;
        sumG[bin] += g;
        sumB[bin] += b;
    }

    let bestBin = 0;
    for (let b = 1; b < 64; b++) {
        if (bins[b] > bins[bestBin]) bestBin = b;
    }
    const cnt = Math.max(1, bins[bestBin]);
    const bgR = sumR[bestBin] / cnt;
    const bgG = sumG[bestBin] / cnt;
    const bgB = sumB[bestBin] / cnt;

    const ink = new Float32Array(n);
    let maxContrast = 0;
    let inkPixels = 0;
    /** @type {number[]} */
    const activeVals = [];

    for (let i = 0; i < n; i++) {
        const o = i * 4;
        const dr = Math.abs(data[o] - bgR);
        const dg = Math.abs(data[o + 1] - bgG);
        const db = Math.abs(data[o + 2] - bgB);
        const c = Math.max(dr, dg, db) / 255;
        ink[i] = c;
        if (c > maxContrast) maxContrast = c;
        if (c >= inkThreshold) {
            inkPixels++;
            activeVals.push(c);
        }
    }

    activeVals.sort((a, b) => a - b);
    const p95Ink = activeVals.length ? quantileSorted(activeVals, 0.95) : 0;
    const inkCoverage = n > 0 ? inkPixels / n : 0;
    const vacuous = inkPixels < minInkPixels || maxContrast < minContrast;

    return {
        width,
        height,
        bg: [Math.round(bgR), Math.round(bgG), Math.round(bgB)],
        ink,
        inkPixels,
        inkCoverage: +inkCoverage.toFixed(6),
        maxContrast: +maxContrast.toFixed(4),
        p95Ink: +p95Ink.toFixed(4),
        vacuous,
    };
}

/**
 * Parabolic 3-point peak refinement around discrete index k in array y.
 * @param {ArrayLike<number>} y
 * @param {number} k
 * @returns {number}
 */
function parabolicPeak(y, k) {
    if (k <= 0 || k >= y.length - 1) return k;
    const y0 = y[k - 1], y1 = y[k], y2 = y[k + 1];
    const denom = y0 - 2 * y1 + y2;
    if (Math.abs(denom) < 1e-12) return k;
    const delta = 0.5 * (y0 - y2) / denom;
    return k + Math.max(-0.5, Math.min(0.5, delta));
}

/**
 * Normalized autocorrelation of a 1D signal for lags in [minLag, maxLag], finding the
 * fundamental period peak (first strong local maximum, avoiding 2x/3x harmonic lock).
 *
 * @param {Float64Array | Float32Array} signal
 * @param {number} minLag
 * @param {number} maxLag
 * @returns {{ lagPx: number | null, strength: number, corr: Float64Array }}
 */
function fundamentalAutocorr(signal, minLag, maxLag) {
    const n = signal.length;
    const hi = Math.min(maxLag, Math.floor(n / 2));
    const corr = new Float64Array(hi + 1);
    if (hi < minLag || n < minLag * 2) return { lagPx: null, strength: 0, corr };

    let mean = 0;
    for (let i = 0; i < n; i++) mean += signal[i];
    mean /= n;

    const centered = new Float64Array(n);
    let energy0 = 0;
    for (let i = 0; i < n; i++) {
        const v = signal[i] - mean;
        centered[i] = v;
        energy0 += v * v;
    }
    if (energy0 < 1e-12) return { lagPx: null, strength: 0, corr };

    corr[0] = 1;
    for (let lag = 1; lag <= hi; lag++) {
        let s = 0, eA = 0, eB = 0;
        const len = n - lag;
        for (let i = 0; i < len; i++) {
            const a = centered[i];
            const b = centered[i + lag];
            s += a * b;
            eA += a * a;
            eB += b * b;
        }
        const denom = Math.sqrt(eA * eB);
        corr[lag] = denom > 1e-12 ? s / denom : 0;
    }

    // Find the first valley after lag 0 so the zero-lag decay lobe is never mistaken for a peak
    let startLag = minLag;
    let passedZeroLobe = false;
    for (let lag = 1; lag <= hi; lag++) {
        if (corr[lag] > corr[lag - 1]) {
            passedZeroLobe = true;
            if (lag > startLag) startLag = lag;
            break;
        }
    }
    if (!passedZeroLobe) return { lagPx: null, strength: 0, corr };

    // Collect true local peaks in [startLag, hi]
    /** @type {{ lag: number, val: number }[]} */
    const peaks = [];
    for (let lag = startLag; lag <= hi; lag++) {
        const prev = corr[lag - 1];
        const next = lag < hi ? corr[lag + 1] : corr[lag] - 1e-6;
        const prom = corr[lag] - 0.5 * (prev + next);
        if (corr[lag] >= prev && corr[lag] >= next && (corr[lag] > 0.025 || prom > 0.025)) {
            peaks.push({ lag, val: corr[lag] });
        }
    }
    if (!peaks.length) return { lagPx: null, strength: 0, corr };

    const maxPeakVal = Math.max(...peaks.map((p) => p.val));
    // First candidate is the earliest strong local peak (>= 50% of maxPeakVal)
    let chosen = peaks.find((p) => p.val >= 0.50 * maxPeakVal) || peaks[0];
    let refined = parabolicPeak(corr, chosen.lag);

    // Sub-harmonic check: when blank lines repeat periodically (e.g. 3-line blocks in a terminal
    // where blank lines separate dense headers), the k-th harmonic (k = 2, 3, 4) can have a
    // higher correlation than the 1x fundamental. If refined/k (>= startLag) itself sits at a
    // genuine positive local peak in `peaks`, lock onto the fundamental period refined/k.
    for (const k of [4, 3, 2]) {
        const subTarget = refined / k;
        if (subTarget < startLag) continue;
        const subPeak = peaks.find((p) => Math.abs(p.lag - subTarget) <= 1.15 && p.val >= Math.max(0.03, 0.15 * maxPeakVal));
        if (subPeak) {
            refined = refined / k;
            chosen = subPeak;
            break;
        }
    }

    return { lagPx: +refined.toFixed(4), strength: +chosen.val.toFixed(4), corr };
}

/**
 * (a) Measure text row pitch in device pixels from horizontal projection profiles of ink rows.
 *
 * Combines two estimators:
 *   1. Segmented ink row bands -> ink-weighted row centers -> single-step filtering +
 *      ordinary least-squares slope of row center vs integer row index.
 *   2. Autocorrelation of the horizontal row projection profile with parabolic peak refinement.
 *
 * @param {RgbaImage} img
 * @param {{
 *   inkMap?: InkMap,
 *   minPitchPx?: number,
 *   maxPitchPx?: number,
 *   inkThreshold?: number
 * }} [opts]
 * @returns {RowPitchResult}
 */
export function measureRowPitch(img, opts = {}) {
    const inkMap = opts.inkMap || computeInkMap(img, opts);
    const { width, height, ink } = inkMap;
    const minPitchPx = opts.minPitchPx ?? 5;
    const maxPitchPx = opts.maxPitchPx ?? 48;
    const inkThreshold = opts.inkThreshold ?? 0.08;

    if (inkMap.vacuous) {
        return {
            pitchPx: null,
            medianDiffPx: null,
            meanDiffPx: null,
            stdDiffPx: null,
            autocorrPitchPx: null,
            autocorrStrength: 0,
            integerSnapErrorPx: null,
            nearestIntegerPx: null,
            rowCount: 0,
            medianBandHeightPx: null,
            rows: [],
            vacuous: true,
        };
    }

    // Horizontal projection profile: mean active ink per row, peak ink, and active pixel count
    const rowProfile = new Float64Array(height);
    const rowPeak = new Float64Array(height);
    const rowActiveCount = new Int32Array(height);
    for (let y = 0; y < height; y++) {
        let sum = 0;
        let pk = 0;
        let cnt = 0;
        const rowOff = y * width;
        for (let x = 0; x < width; x++) {
            const v = ink[rowOff + x];
            if (v >= inkThreshold) {
                sum += v;
                cnt++;
            }
            if (v > pk) pk = v;
        }
        rowProfile[y] = sum / width;
        rowPeak[y] = pk;
        rowActiveCount[y] = cnt;
    }

    const sortedRow = Float64Array.from(rowProfile).sort();
    const p20Row = quantileSorted(sortedRow, 0.20);
    // Avoid thresholding against p95Row * 0.12 on wide terminals (e.g. 239 cols), where dense
    // lines or 1-px full-width rules inflate p95Row and cause short lines (2-10 chars) to lose
    // their vertical-stem scanlines and shatter into multiple 1-px crossbar fragments.
    // Instead, require at least minRowPixels active ink pixels above the inter-row gap floor
    // (skipping 2-px vertical box borders in empty gaps while preserving short text lines).
    const minRowPixels = Math.max(3, Math.min(6, Math.floor(width * 0.004)));
    const bandThresh = Math.max((minRowPixels * inkThreshold) / Math.max(width, 1), p20Row * 1.35);
    const isScanlineActive = (y) =>
        rowActiveCount[y] >= minRowPixels &&
        rowProfile[y] >= bandThresh &&
        rowPeak[y] >= inkThreshold * 1.25;

    // Estimate typical single-row glyph band height from contiguous active runs so that
    // autocorrelation never mistakes intra-glyph crossbar spacing (< glyph height) for row pitch.
    /** @type {number[]} */
    const prelimHeights = [];
    for (let y = 0; y < height; ) {
        while (y < height && !isScanlineActive(y)) y++;
        if (y >= height) break;
        const s0 = y;
        while (y < height && isScanlineActive(y)) y++;
        const h = y - s0;
        if (h >= 4 && h <= maxPitchPx) prelimHeights.push(h);
    }
    prelimHeights.sort((a, b) => a - b);
    const typicalGlyphHeight = prelimHeights.length >= 2
        ? quantileSorted(prelimHeights, 0.25)
        : 0;
    const effectiveMinPitchPx = Math.max(minPitchPx, Math.round(typicalGlyphHeight * 1.05));

    // Normalize each active scanline by its local (±4 px) vertical row peak before autocorrelation
    // so short lines (2-8 chars) and full-width lines (200+ chars) both have unit row amplitude
    // instead of short lines falling below the global mean and correlating negatively.
    const autocorrProfile = new Float64Array(height);
    for (let y = 0; y < height; y++) {
        if (!isScanlineActive(y)) continue;
        let localMax = 0;
        const y0 = Math.max(0, y - 4);
        const y1 = Math.min(height - 1, y + 4);
        for (let yy = y0; yy <= y1; yy++) {
            if (rowProfile[yy] > localMax) localMax = rowProfile[yy];
        }
        autocorrProfile[y] = localMax > 0 ? rowProfile[y] / localMax : 0;
    }

    const ac = fundamentalAutocorr(autocorrProfile, effectiveMinPitchPx, maxPitchPx);

    // If perspective tilt or a box border merged multiple rows into a giant band
    // (height > 1.60x the expected/autocorr pitch), split that band at internal valleys.
    const splitRefPitch = Math.max(effectiveMinPitchPx, ac.lagPx ?? 13);
    /** @type {InkRowBand[]} */
    const rawBands = [];
    const buildBand = (s0, s1) => {
        const h = s1 - s0 + 1;
        let wSum = 0, ySum = 0, pk = 0;
        for (let yy = s0; yy <= s1; yy++) {
            const w = rowProfile[yy];
            wSum += w;
            ySum += yy * w;
            if (rowPeak[yy] > pk) pk = rowPeak[yy];
        }
        return {
            yStart: s0,
            yEnd: s1,
            yCenter: +(ySum / Math.max(wSum, 1e-12)).toFixed(4),
            height: h,
            meanInk: +(wSum / h).toFixed(4),
            peakInk: +pk.toFixed(4),
        };
    };

    for (let y = 0; y <= height; ) {
        while (y < height && !isScanlineActive(y)) y++;
        if (y >= height) break;
        const bStart = y;
        while (y < height && isScanlineActive(y)) y++;
        const bEnd = y - 1;
        const bHeight = bEnd - bStart + 1;

        const pushSubBand = (s0, s1) => {
            const h = s1 - s0 + 1;
            if (h < 1 || h > maxPitchPx * 1.5) return;
            const band = buildBand(s0, s1);
            if (band.meanInk > 0) rawBands.push(band);
        };

        if (bHeight <= splitRefPitch * 1.60) {
            pushSubBand(bStart, bEnd);
        } else {
            // Find local minima inside [bStart..bEnd] spaced at least splitRefPitch*0.65 apart
            const minStep = Math.max(3, Math.round(splitRefPitch * 0.65));
            let segStart = bStart;
            let lastPeakVal = rowProfile[bStart];
            for (let yy = bStart + 1; yy < bEnd; yy++) {
                if (rowProfile[yy] > lastPeakVal) lastPeakVal = rowProfile[yy];
                const isLocalMin = rowProfile[yy] <= rowProfile[yy - 1] && rowProfile[yy] <= rowProfile[yy + 1];
                if (isLocalMin && yy - segStart >= minStep && rowProfile[yy] <= lastPeakVal * 0.85) {
                    pushSubBand(segStart, yy - 1);
                    segStart = yy;
                    lastPeakVal = rowProfile[yy];
                }
            }
            pushSubBand(segStart, bEnd);
        }
    }

    // Merge intra-row fragments (descender loops, underscores, or short-line vertical stems)
    // that lie within a single glyph cell (gap <= 2 px and combined outer span <= 0.92 * splitRefPitch).
    const maxIntraGap = Math.max(2, Math.floor(splitRefPitch * 0.20));
    let mergedAny = true;
    while (mergedAny) {
        mergedAny = false;
        for (let i = rawBands.length - 1; i > 0; i--) {
            const prev = rawBands[i - 1];
            const cur = rawBands[i];
            const gap = cur.yStart - prev.yEnd - 1;
            const span = cur.yEnd - prev.yStart + 1;
            if (gap <= maxIntraGap && (cur.height <= 3 || prev.height <= 3) && span <= splitRefPitch * 0.92) {
                rawBands[i - 1] = buildBand(prev.yStart, cur.yEnd);
                rawBands.splice(i, 1);
                mergedAny = true;
            }
        }
    }

    // When real multi-scanline glyph rows are present (max height >= 6 px), exclude 1-2 px
    // horizontal rules / box borders (or bare hyphen/underscore lines) whose vertical center
    // sits at the rule/crossbar rather than the full glyph cell center. Also exclude unsplit
    // multi-row solid blocks taller than 1.40x pitch.
    const maxBandHeight = rawBands.reduce((m, b) => Math.max(m, b.height), 0);
    const pitchBands = maxBandHeight >= 6
        ? rawBands.filter((b) => b.height >= 3 && b.height <= splitRefPitch * 1.40)
        : rawBands;

    if (pitchBands.length < 2) {
        const pitch = ac.lagPx;
        const nearest = pitch !== null ? Math.round(pitch) : null;
        return {
            pitchPx: pitch,
            medianDiffPx: null,
            meanDiffPx: null,
            stdDiffPx: null,
            autocorrPitchPx: ac.lagPx,
            autocorrStrength: ac.strength,
            integerSnapErrorPx: pitch !== null && nearest !== null ? +Math.abs(pitch - nearest).toFixed(4) : null,
            nearestIntegerPx: nearest,
            rowCount: pitchBands.length,
            medianBandHeightPx: pitchBands.length ? pitchBands[0].height : null,
            rows: pitchBands,
            vacuous: pitch === null || pitchBands.length < 2,
        };
    }

    const heights = pitchBands.map((b) => b.height).sort((a, b) => a - b);
    const medianHeight = quantileSorted(heights, 0.5);
    const minValidDiff = Math.max(minPitchPx * 0.75, medianHeight * 0.95);

    const rawDiffs = [];
    for (let i = 0; i < pitchBands.length - 1; i++) {
        const d = pitchBands[i + 1].yCenter - pitchBands[i].yCenter;
        if (d >= minValidDiff && d <= maxPitchPx * 4.5) rawDiffs.push(d);
    }
    rawDiffs.sort((a, b) => a - b);

    // Locate the first (1x single-row) step cluster in rawDiffs and take its unbiased median
    // (avoiding the 35th-percentile low bias on dense grids and 2x/3x jump on blank-line grids).
    let baseEst = ac.lagPx ?? 13;
    if (rawDiffs.length > 0) {
        const dLo = quantileSorted(rawDiffs, rawDiffs.length >= 6 ? 0.10 : 0.0);
        const firstCluster = rawDiffs.filter((d) => d >= dLo * 0.85 && d <= dLo * 1.25);
        baseEst = firstCluster.length ? quantileSorted(firstCluster, 0.50) : quantileSorted(rawDiffs, 0.50);
        // If every consecutive row pair in the sample was separated by blank lines (2x/3x) while
        // autocorrelation locked onto the 1x fundamental, de-multiply baseEst to the fundamental.
        if (ac.lagPx !== null && ac.lagPx >= minPitchPx) {
            const mult = Math.round(baseEst / ac.lagPx);
            if (mult >= 2 && mult <= 4 && Math.abs(baseEst - mult * ac.lagPx) <= 0.12 * baseEst) {
                baseEst = baseEst / mult;
            }
        }
    }

    // Filter to single-row steps around baseEst
    const singleDiffs = rawDiffs.filter((d) => d >= baseEst * 0.72 && d <= baseEst * 1.32);
    const stepDiffs = singleDiffs.length ? singleDiffs : rawDiffs;
    stepDiffs.sort((a, b) => a - b);

    const medianDiff = stepDiffs.length ? quantileSorted(stepDiffs, 0.5) : null;
    const meanDiff = stepDiffs.length
        ? stepDiffs.reduce((a, b) => a + b, 0) / stepDiffs.length
        : null;
    const stdDiff = stepDiffs.length >= 2 && meanDiff !== null
        ? Math.sqrt(stepDiffs.reduce((s, d) => s + (d - meanDiff) ** 2, 0) / stepDiffs.length)
        : 0;

    // Fit line center vs cumulative integer row index across lattice chains (allowing up to 5
    // consecutive blank lines, k = 1..6) so blank lines do not break telescope cancellation.
    const refStep = medianDiff ?? ac.lagPx ?? baseEst;
    let sumW = 0, sumSlope = 0;
    let chainIndices = [0];
    let chainCenters = [pitchBands[0].yCenter];

    const flushChain = () => {
        if (chainCenters.length < 2) return;
        const m = chainCenters.length;
        let mx = 0, my = 0;
        for (let i = 0; i < m; i++) { mx += chainIndices[i]; my += chainCenters[i]; }
        mx /= m; my /= m;
        let num = 0, den = 0;
        for (let i = 0; i < m; i++) {
            const dx = chainIndices[i] - mx;
            num += dx * (chainCenters[i] - my);
            den += dx * dx;
        }
        if (den > 0) {
            const slope = num / den;
            sumSlope += slope * den;
            sumW += den;
        }
    };

    for (let i = 1; i < pitchBands.length; i++) {
        const dy = pitchBands[i].yCenter - pitchBands[i - 1].yCenter;
        const k = Math.round(dy / refStep);
        const tol = k <= 2 ? 0.30 * refStep : Math.min(0.25 * refStep, 2.2);
        if (k >= 1 && k <= 6 && Math.abs(dy - k * refStep) <= tol) {
            chainIndices.push(chainIndices[chainIndices.length - 1] + k);
            chainCenters.push(pitchBands[i].yCenter);
        } else {
            flushChain();
            chainIndices = [0];
            chainCenters = [pitchBands[i].yCenter];
        }
    }
    flushChain();

    const regressedPitch = sumW > 0 ? sumSlope / sumW : (meanDiff ?? ac.lagPx);
    const pitchPx = regressedPitch !== null ? +regressedPitch.toFixed(4) : null;
    const nearestInt = pitchPx !== null ? Math.round(pitchPx) : null;

    return {
        pitchPx,
        medianDiffPx: medianDiff !== null ? +medianDiff.toFixed(4) : null,
        meanDiffPx: meanDiff !== null ? +meanDiff.toFixed(4) : null,
        stdDiffPx: stdDiff !== null ? +stdDiff.toFixed(4) : null,
        autocorrPitchPx: ac.lagPx,
        autocorrStrength: ac.strength,
        integerSnapErrorPx: pitchPx !== null && nearestInt !== null ? +Math.abs(pitchPx - nearestInt).toFixed(4) : null,
        nearestIntegerPx: nearestInt,
        rowCount: pitchBands.length,
        medianBandHeightPx: heights.length ? +medianHeight.toFixed(2) : null,
        rows: pitchBands,
        vacuous: pitchPx === null || pitchBands.length < 2,
    };
}

/**
 * Scan 1D lines to measure monotonic ink edge transition widths.
 *
 * For each significant monotonic ramp [i0..i1] with amplitude >= minEdgeAmp:
 *   - raw10_90: continuous 10%->90% span in pixels (0.80 for ideal 1-px step, 1.60 for 2-px ramp)
 *   - gradWidth: gradient participation width (sum g_k)^2 / sum(g_k^2) (1.0 for 1-px step, 2.0 for 2-px uniform ramp)
 *   - peakRefWidth: reference peak divided by max single-pixel step (catches 1-px stems shifted by 0.5px
 *     into [0, 0.5, 0.5, 0] where peak drops to half of p95Ink)
 *   - effectiveWidth: max(raw10_90 / 0.80, gradWidth, peakRefWidth)
 *
 * @param {Float32Array} ink
 * @param {number} width
 * @param {number} height
 * @param {boolean} horizontalScan - true = scan along X (measures vertical stems); false = scan along Y (measures horizontal stems)
 * @param {number} minEdgeAmp
 * @param {number} refPeakInk
 * @returns {{ widths: number[], raw10_90: number[] }}
 */
function scanLineTransitions(ink, width, height, horizontalScan, minEdgeAmp, refPeakInk) {
    /** @type {number[]} */
    const widths = [];
    /** @type {number[]} */
    const raw10_90 = [];
    const outerLen = horizontalScan ? height : width;
    const innerLen = horizontalScan ? width : height;
    const line = new Float32Array(innerLen);
    const eps = 0.015;

    for (let o = 0; o < outerLen; o++) {
        let lineMax = 0;
        for (let i = 0; i < innerLen; i++) {
            const v = horizontalScan ? ink[o * width + i] : ink[i * width + o];
            line[i] = v;
            if (v > lineMax) lineMax = v;
        }
        if (lineMax < minEdgeAmp) continue;
        const localRef = Math.max(lineMax, refPeakInk * 0.85);

        let i0 = 0;
        while (i0 < innerLen - 1) {
            const d0 = line[i0 + 1] - line[i0];
            if (Math.abs(d0) <= eps) {
                i0++;
                continue;
            }
            const sign = d0 > 0 ? 1 : -1;
            let i1 = i0 + 1;
            while (i1 < innerLen - 1) {
                const d = line[i1 + 1] - line[i1];
                if (d * sign > eps) {
                    i1++;
                } else {
                    break;
                }
            }

            const vStart = line[i0];
            const vEnd = line[i1];
            const amp = Math.abs(vEnd - vStart);
            if (amp >= minEdgeAmp) {
                const lo = Math.min(vStart, vEnd);
                const t10 = lo + 0.10 * amp;
                const t90 = lo + 0.90 * amp;

                // Continuous piecewise-linear positions for 10% and 90%
                let x10 = i0, x90 = i1;
                for (let k = i0; k < i1; k++) {
                    const a = line[k], b = line[k + 1];
                    const minAB = Math.min(a, b), maxAB = Math.max(a, b);
                    const span = Math.max(1e-9, maxAB - minAB);
                    if (t10 >= minAB && t10 <= maxAB) {
                        const frac = sign > 0 ? (t10 - a) / (b - a) : (a - t10) / (a - b);
                        x10 = k + Math.max(0, Math.min(1, frac));
                    }
                    if (t90 >= minAB && t90 <= maxAB) {
                        const frac = sign > 0 ? (t90 - a) / (b - a) : (a - t90) / (a - b);
                        x90 = k + Math.max(0, Math.min(1, frac));
                    }
                }
                const span10_90 = Math.abs(x90 - x10);
                const normStep10_90 = span10_90 / 0.80;

                // Step gradient participation width & max single-pixel step
                let sumG = 0, sumG2 = 0, maxStep = 0;
                for (let k = i0; k < i1; k++) {
                    const g = Math.abs(line[k + 1] - line[k]);
                    sumG += g;
                    sumG2 += g * g;
                    if (g > maxStep) maxStep = g;
                }
                const gradParticipation = sumG2 > 1e-12 ? (sumG * sumG) / sumG2 : 1;

                // If a 1-px stem [0, 1, 0] was half-pixel shifted to [0, 0.5, 0.5, 0],
                // its peak or valley is a 2-pixel plateau at half of localRef (unlike a >=3-px crossbar).
                const topIdx = sign > 0 ? i1 : i0;
                const botIdx = sign > 0 ? i0 : i1;
                const topDir = sign > 0 ? 1 : -1;
                const botDir = sign > 0 ? -1 : 1;
                const nbTop1 = Math.max(0, Math.min(innerLen - 1, topIdx + topDir));
                const nbTop2 = Math.max(0, Math.min(innerLen - 1, topIdx + 2 * topDir));
                const nbBot1 = Math.max(0, Math.min(innerLen - 1, botIdx + botDir));
                const nbBot2 = Math.max(0, Math.min(innerLen - 1, botIdx + 2 * botDir));
                const is2PxPeak =
                    Math.abs(line[topIdx] - line[nbTop1]) <= 0.08 * localRef &&
                    Math.abs(line[topIdx] - line[nbTop2]) > 0.12 * localRef &&
                    line[topIdx] < 0.75 * localRef;
                const is2PxValley =
                    line[botIdx] > 0.12 * localRef &&
                    Math.abs(line[botIdx] - line[nbBot1]) <= 0.08 * localRef &&
                    Math.abs(line[botIdx] - line[nbBot2]) > 0.12 * localRef;
                const peakRefWidth = (is2PxPeak || is2PxValley) && maxStep > 1e-9
                    ? Math.min(3.0, localRef / maxStep)
                    : 1.0;

                const effWidth = Math.max(gradParticipation, peakRefWidth);
                raw10_90.push(span10_90);
                widths.push(effWidth);
            }
            i0 = i1;
        }
    }
    return { widths, raw10_90 };
}

/**
 * (b) Measure edge crispness — the width of ink transitions on vertical and horizontal stems.
 *
 * Crisp integer-aligned stems transition in 1.0 px (single step between background and stem).
 * Half-pixel offsets or perspective filtering blur transitions into >= 2-px ramps.
 *
 * @param {RgbaImage} img
 * @param {{
 *   inkMap?: InkMap,
 *   minEdgeAmplitude?: number
 * }} [opts]
 * @returns {EdgeCrispnessResult}
 */
export function measureEdgeCrispness(img, opts = {}) {
    const inkMap = opts.inkMap || computeInkMap(img, opts);
    if (inkMap.vacuous) {
        return {
            rampWidthMedianPx: null,
            rampWidthMeanPx: null,
            rawRamp10_90MedianPx: null,
            verticalStemRampPx: null,
            horizontalStemRampPx: null,
            twoPxRampShare: null,
            sharpStepShare: null,
            midGrayInkShare: 0,
            edgeCount: 0,
            verticalEdgeCount: 0,
            horizontalEdgeCount: 0,
            vacuous: true,
        };
    }

    const { width, height, ink, p95Ink, maxContrast } = inkMap;
    const refPeak = Math.max(p95Ink, maxContrast * 0.85);
    const minEdgeAmp = opts.minEdgeAmplitude ?? Math.max(0.06, refPeak * 0.30);

    const horiz = scanLineTransitions(ink, width, height, true, minEdgeAmp, refPeak);
    const vert = scanLineTransitions(ink, width, height, false, minEdgeAmp, refPeak);

    const allWidths = [...horiz.widths, ...vert.widths].sort((a, b) => a - b);
    const allRaw = [...horiz.raw10_90, ...vert.raw10_90].sort((a, b) => a - b);
    const vSorted = [...horiz.widths].sort((a, b) => a - b);
    const hSorted = [...vert.widths].sort((a, b) => a - b);

    // Mid-gray ink share: fraction of active ink pixels sitting between 20% and 75% of refPeak
    let activeCount = 0;
    let midGrayCount = 0;
    const loGray = 0.20 * refPeak;
    const hiGray = 0.75 * refPeak;
    for (let i = 0; i < ink.length; i++) {
        const v = ink[i];
        if (v >= 0.12 * refPeak) {
            activeCount++;
            if (v >= loGray && v <= hiGray) midGrayCount++;
        }
    }
    const midGrayInkShare = activeCount > 0 ? +(midGrayCount / activeCount).toFixed(4) : 0;

    if (allWidths.length < 4) {
        return {
            rampWidthMedianPx: null,
            rampWidthMeanPx: null,
            rawRamp10_90MedianPx: null,
            verticalStemRampPx: null,
            horizontalStemRampPx: null,
            twoPxRampShare: null,
            sharpStepShare: null,
            midGrayInkShare,
            edgeCount: allWidths.length,
            verticalEdgeCount: vSorted.length,
            horizontalEdgeCount: hSorted.length,
            vacuous: true,
        };
    }

    const medianW = quantileSorted(allWidths, 0.5);
    const meanW = allWidths.reduce((a, b) => a + b, 0) / allWidths.length;
    const rawMed = quantileSorted(allRaw, 0.5);
    const vMed = vSorted.length ? quantileSorted(vSorted, 0.5) : null;
    const hMed = hSorted.length ? quantileSorted(hSorted, 0.5) : null;

    const twoPxCount = allWidths.filter((w) => w >= 1.75).length;
    const sharpCount = allWidths.filter((w) => w <= 1.15).length;

    return {
        rampWidthMedianPx: +medianW.toFixed(4),
        rampWidthMeanPx: +meanW.toFixed(4),
        rawRamp10_90MedianPx: +rawMed.toFixed(4),
        verticalStemRampPx: vMed !== null ? +vMed.toFixed(4) : null,
        horizontalStemRampPx: hMed !== null ? +hMed.toFixed(4) : null,
        twoPxRampShare: +(twoPxCount / allWidths.length).toFixed(4),
        sharpStepShare: +(sharpCount / allWidths.length).toFixed(4),
        midGrayInkShare,
        edgeCount: allWidths.length,
        verticalEdgeCount: vSorted.length,
        horizontalEdgeCount: hSorted.length,
        vacuous: false,
    };
}

/**
 * (c) Measure stillness — exact frame-to-frame difference between two captures N ms apart.
 *
 * Enforces a non-empty ink guard on both frames: a blank-vs-blank pair has 0 changed pixels
 * but is flagged `vacuous: true` and `still: false` so vacuous captures never pass.
 *
 * @param {RgbaImage} imgA
 * @param {RgbaImage} imgB
 * @param {{
 *   tolerance?: number,
 *   inkMapA?: InkMap,
 *   inkMapB?: InkMap
 * }} [opts]
 * @returns {StillnessResult}
 */
export function measureStillness(imgA, imgB, opts = {}) {
    if (imgA.width !== imgB.width || imgA.height !== imgB.height) {
        throw new Error(
            `measureStillness: dimension mismatch (${imgA.width}x${imgA.height} vs ${imgB.width}x${imgB.height})`
        );
    }
    const { width, height } = imgA;
    const tolerance = opts.tolerance ?? 2;
    const inkA = opts.inkMapA || computeInkMap(imgA, opts);
    const inkB = opts.inkMapB || computeInkMap(imgB, opts);
    const vacuous = inkA.vacuous || inkB.vacuous;

    const totalPixels = width * height;
    const a = imgA.data;
    const b = imgB.data;

    let changedPixels = 0;
    let changedAboveTol = 0;
    let maxDiff = 0;
    let absSum = 0;
    let minX = width, minY = height, maxX = -1, maxY = -1;

    for (let y = 0; y < height; y++) {
        const rowOff = y * width;
        for (let x = 0; x < width; x++) {
            const o = (rowOff + x) * 4;
            const dr = Math.abs(a[o] - b[o]);
            const dg = Math.abs(a[o + 1] - b[o + 1]);
            const db = Math.abs(a[o + 2] - b[o + 2]);
            const da = Math.abs(a[o + 3] - b[o + 3]);
            const d = Math.max(dr, dg, db, da);
            absSum += dr + dg + db;
            if (d > 0) {
                changedPixels++;
                if (d > maxDiff) maxDiff = d;
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
                if (d > tolerance) changedAboveTol++;
            }
        }
    }

    const diffBounds = changedPixels > 0
        ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
        : null;

    return {
        width,
        height,
        totalPixels,
        changedPixels,
        changedRatio: +(changedPixels / Math.max(1, totalPixels)).toFixed(6),
        changedAboveTol,
        changedAboveTolRatio: +(changedAboveTol / Math.max(1, totalPixels)).toFixed(6),
        tolerance,
        maxDiff,
        meanAbsDiff: +(absSum / Math.max(1, totalPixels * 3)).toFixed(5),
        diffBounds,
        inkCoverageA: inkA.inkCoverage,
        inkCoverageB: inkB.inkCoverage,
        vacuous,
        still: !vacuous && changedPixels === 0,
    };
}

/** @type {Promise<AtlasReferenceMetrics> | null} */
let _cachedAtlasPromise = null;

/**
 * Boot the runtime HarfBuzz font chain and derive the authoritative atlas cell and shaper
 * advance metrics via deriveCharSize / computeCellMetrics (Rule 3: never hardcode font metrics).
 *
 * @param {{ fontSize?: number, worldScale?: number }} [opts]
 * @returns {Promise<AtlasReferenceMetrics>}
 */
export async function loadAtlasReferenceMetrics(opts = {}) {
    const fontSize = opts.fontSize ?? 48;
    const worldScale = opts.worldScale ?? 0.025;
    if (!_cachedAtlasPromise) {
        _cachedAtlasPromise = (async () => {
            const { chain } = await bootHeadlessFontChain();
            const upem = chain.upem || 2048;
            const shapedM = chain.shape('M');
            const mAdvanceUnits = (shapedM && shapedM[0]) ? shapedM[0].ax : upem * 0.6;
            const charSize = deriveCharSize(chain, 48);
            const cellMetrics = computeCellMetrics(charSize, 0.025);
            const cellAdvanceToPitch = cellMetrics.charWidth / cellMetrics.lineSpacing;
            const shaperAdvanceToPitch = (mAdvanceUnits / upem) / 1.15;
            return {
                fontSize: 48,
                worldScale: 0.025,
                upem,
                mAdvanceUnits,
                charSize,
                cellMetrics,
                cellAdvanceToPitch,
                shaperAdvanceToPitch,
                advanceAtRowPitch(rowPitchPx, mode = 'cell') {
                    return rowPitchPx * (mode === 'shaper' ? shaperAdvanceToPitch : cellAdvanceToPitch);
                },
            };
        })();
    }
    const base = await _cachedAtlasPromise;
    if (fontSize === 48 && worldScale === 0.025) return base;
    const { chain } = await bootHeadlessFontChain();
    const charSize = deriveCharSize(chain, fontSize);
    const cellMetrics = computeCellMetrics(charSize, worldScale);
    const cellAdvanceToPitch = cellMetrics.charWidth / cellMetrics.lineSpacing;
    const shaperAdvanceToPitch = (base.mAdvanceUnits / base.upem) / 1.15;
    return {
        fontSize,
        worldScale,
        upem: base.upem,
        mAdvanceUnits: base.mAdvanceUnits,
        charSize,
        cellMetrics,
        cellAdvanceToPitch,
        shaperAdvanceToPitch,
        advanceAtRowPitch(rowPitchPx, mode = 'cell') {
            return rowPitchPx * (mode === 'shaper' ? shaperAdvanceToPitch : cellAdvanceToPitch);
        },
    };
}

/**
 * (d) Measure horizontal glyph advance in device px and its scale ratio against the atlas advance.
 *
 * Within each detected ink row band:
 *   1. Accumulates the normalized autocorrelation of the horizontal ink profile across rows
 *      to find the periodic column stride `autocorrAdvancePx`.
 *   2. Segments contiguous glyph ink blobs in each row, computes their centroids, and fits a
 *      least-squares column-stride slope across each row's glyphs.
 *   3. Compares `measuredAdvancePx` against `expectedAdvancePx` (explicitly passed, or derived
 *      from `atlasMetrics.advanceAtRowPitch(targetRowPitchPx)`).
 *
 * @param {RgbaImage} img
 * @param {{
 *   inkMap?: InkMap,
 *   rowPitch?: RowPitchResult,
 *   atlasMetrics?: AtlasReferenceMetrics,
 *   expectedAdvancePx?: number,
 *   targetRowPitchPx?: number,
 *   advanceMode?: 'cell' | 'shaper',
 *   minAdvancePx?: number,
 *   maxAdvancePx?: number
 * }} [opts]
 * @returns {GlyphScaleResult}
 */
export function measureGlyphScale(img, opts = {}) {
    const inkMap = opts.inkMap || computeInkMap(img, opts);
    const rowPitch = opts.rowPitch || measureRowPitch(img, { ...opts, inkMap });
    const minAdv = opts.minAdvancePx ?? (
        rowPitch.pitchPx ? Math.max(3, Math.min(12, Math.round(rowPitch.pitchPx * 0.40))) : 3
    );
    const maxAdv = opts.maxAdvancePx ?? 32;

    if (inkMap.vacuous) {
        return {
            measuredAdvancePx: null,
            autocorrAdvancePx: null,
            autocorrStrength: 0,
            blobMedianAdvancePx: null,
            expectedAdvancePx: opts.expectedAdvancePx ?? null,
            scaleRatio: null,
            scaleErrorPct: null,
            measuredAdvanceToPitch: null,
            atlasAdvanceToPitch: opts.atlasMetrics?.cellAdvanceToPitch ?? null,
            aspectScaleRatio: null,
            rowsMeasured: 0,
            glyphCount: 0,
            vacuous: true,
        };
    }

    const { width, height, ink } = inkMap;
    /** @type {InkRowBand[]} */
    const bands = rowPitch.rows.length
        ? rowPitch.rows
        : [{ yStart: 0, yEnd: height - 1, yCenter: (height - 1) / 2, height, meanInk: inkMap.inkCoverage, peakInk: inkMap.maxContrast }];

    const hiLag = Math.min(maxAdv, Math.floor(width / 2));
    const aggCorr = new Float64Array(hiLag + 1);
    let validCorrRows = 0;

    /** @type {number[][]} */
    const rowGlyphCenters = [];
    let totalGlyphs = 0;

    for (const band of bands) {
        const prof = new Float64Array(width);
        const colMax = new Float64Array(width);
        let maxP = 0;
        let maxCol = 0;
        for (let x = 0; x < width; x++) {
            let s = 0;
            let cm = 0;
            for (let y = band.yStart; y <= band.yEnd; y++) {
                const v = ink[y * width + x];
                s += v;
                if (v > cm) cm = v;
            }
            const m = s / band.height;
            prof[x] = m;
            colMax[x] = cm;
            if (m > maxP) maxP = m;
            if (cm > maxCol) maxCol = cm;
        }
        if (maxP < 0.02 || maxCol < 0.08) continue;

        // Find active X span of this line so empty margins don't dilute autocorrelation
        const activeThresh = Math.max(0.02, maxP * 0.14);
        const segThresh = Math.max(0.06, maxCol * 0.25);
        let xFirst = -1, xLast = -1;
        for (let x = 0; x < width; x++) {
            if (colMax[x] >= segThresh) {
                if (xFirst < 0) xFirst = x;
                xLast = x;
            }
        }
        if (xFirst >= 0 && xLast - xFirst >= minAdv * 3) {
            const slice = prof.subarray(xFirst, xLast + 1);
            const ac = fundamentalAutocorr(slice, minAdv, Math.min(hiLag, Math.floor(slice.length / 2)));
            if (ac.corr.length > minAdv) {
                for (let lag = 1; lag < ac.corr.length; lag++) {
                    aggCorr[lag] += ac.corr[lag];
                }
                validCorrRows++;
            }
        }

        // Segment individual glyph blobs along the row using colMax so horizontal crossbars stay connected
        /** @type {number[]} */
        const centers = [];
        let inGlyph = false;
        let gStart = 0;
        for (let x = 0; x <= width; x++) {
            const on = x < width && colMax[x] >= segThresh && prof[x] >= activeThresh * 0.5;
            if (on && !inGlyph) {
                inGlyph = true;
                gStart = x;
            } else if (!on && inGlyph) {
                inGlyph = false;
                const gEnd = x - 1;
                const gW = gEnd - gStart + 1;
                if (gW >= 1 && gW <= maxAdv * 1.4) {
                    let wSum = 0, xSum = 0;
                    for (let xx = gStart; xx <= gEnd; xx++) {
                        wSum += prof[xx];
                        xSum += xx * prof[xx];
                    }
                    if (wSum > 0) centers.push(xSum / wSum);
                }
            }
        }
        if (centers.length >= 2) {
            rowGlyphCenters.push(centers);
            totalGlyphs += centers.length;
        }
    }

    // Extract aggregate autocorrelation peak across all rows
    let autocorrAdvancePx = null;
    let autocorrStrength = 0;
    if (validCorrRows > 0) {
        aggCorr[0] = 1;
        for (let lag = 1; lag <= hiLag; lag++) aggCorr[lag] /= validCorrRows;
        let startLag = minAdv;
        let passedValley = false;
        for (let lag = 1; lag <= hiLag; lag++) {
            if (aggCorr[lag] > aggCorr[lag - 1]) {
                passedValley = true;
                if (lag > startLag) startLag = lag;
                break;
            }
        }
        if (passedValley) {
            /** @type {{ lag: number, val: number }[]} */
            const peaks = [];
            for (let lag = startLag; lag <= hiLag; lag++) {
                const prev = aggCorr[lag - 1];
                const next = lag < hiLag ? aggCorr[lag + 1] : aggCorr[lag] - 1e-6;
                if (aggCorr[lag] >= prev && aggCorr[lag] >= next && aggCorr[lag] > 0.04) {
                    peaks.push({ lag, val: aggCorr[lag] });
                }
            }
            if (peaks.length) {
                const maxVal = Math.max(...peaks.map((p) => p.val));
                const chosen = peaks.find((p) => p.val >= 0.50 * maxVal) || peaks[0];
                autocorrAdvancePx = +parabolicPeak(aggCorr, chosen.lag).toFixed(4);
                autocorrStrength = +chosen.val.toFixed(4);
            }
        }
    }

    // Collect inter-blob diffs and fit per-row OLS slope against integer column indices
    /** @type {number[]} */
    const rawBlobDiffs = [];
    for (const centers of rowGlyphCenters) {
        for (let i = 0; i < centers.length - 1; i++) {
            const dx = centers[i + 1] - centers[i];
            if (dx >= minAdv * 0.7 && dx <= maxAdv * 2.2) rawBlobDiffs.push(dx);
        }
    }
    rawBlobDiffs.sort((a, b) => a - b);

    const seedAdv = autocorrAdvancePx ?? (rawBlobDiffs.length ? quantileSorted(rawBlobDiffs, 0.4) : null);
    const singleBlobDiffs = seedAdv !== null
        ? rawBlobDiffs.filter((d) => d >= seedAdv * 0.70 && d <= seedAdv * 1.35)
        : rawBlobDiffs;
    const blobMedianAdvancePx = singleBlobDiffs.length
        ? +quantileSorted(singleBlobDiffs, 0.5).toFixed(4)
        : null;

    const refAdv = blobMedianAdvancePx ?? seedAdv;
    let sumSlope = 0, sumW = 0;
    if (refAdv !== null && refAdv > 0) {
        for (const centers of rowGlyphCenters) {
            let cols = [0];
            let xs = [centers[0]];
            const flush = () => {
                if (xs.length < 3) return;
                const m = xs.length;
                let mc = 0, mx = 0;
                for (let i = 0; i < m; i++) { mc += cols[i]; mx += xs[i]; }
                mc /= m; mx /= m;
                let num = 0, den = 0;
                for (let i = 0; i < m; i++) {
                    const dc = cols[i] - mc;
                    num += dc * (xs[i] - mx);
                    den += dc * dc;
                }
                if (den > 0) {
                    sumSlope += (num / den) * den;
                    sumW += den;
                }
            };
            for (let i = 1; i < centers.length; i++) {
                const dx = centers[i] - centers[i - 1];
                const k = Math.round(dx / refAdv);
                if (k >= 1 && k <= 3 && Math.abs(dx - k * refAdv) <= 0.28 * refAdv) {
                    cols.push(cols[cols.length - 1] + k);
                    xs.push(centers[i]);
                } else {
                    flush();
                    cols = [0];
                    xs = [centers[i]];
                }
            }
            flush();
        }
    }

    const regressedAdv = sumW > 0 ? sumSlope / sumW : (blobMedianAdvancePx ?? autocorrAdvancePx);
    const measuredAdvancePx = regressedAdv !== null ? +regressedAdv.toFixed(4) : null;

    // Resolve expected atlas advance
    const atlas = opts.atlasMetrics || null;
    const mode = opts.advanceMode ?? 'cell';
    const targetPitch = opts.targetRowPitchPx ?? rowPitch.pitchPx ?? 13;
    const expectedAdvancePx = opts.expectedAdvancePx !== undefined
        ? opts.expectedAdvancePx
        : (atlas && targetPitch ? +atlas.advanceAtRowPitch(targetPitch, mode).toFixed(4) : null);

    const scaleRatio = (measuredAdvancePx !== null && expectedAdvancePx !== null && expectedAdvancePx > 0)
        ? +(measuredAdvancePx / expectedAdvancePx).toFixed(4)
        : null;
    const scaleErrorPct = scaleRatio !== null ? +((scaleRatio - 1) * 100).toFixed(2) : null;

    const measuredAdvanceToPitch = (measuredAdvancePx !== null && rowPitch.pitchPx)
        ? +(measuredAdvancePx / rowPitch.pitchPx).toFixed(4)
        : null;
    const atlasAdvanceToPitch = atlas
        ? +(mode === 'cell' ? atlas.cellAdvanceToPitch : atlas.shaperAdvanceToPitch).toFixed(4)
        : null;
    const aspectScaleRatio = (measuredAdvanceToPitch !== null && atlasAdvanceToPitch !== null && atlasAdvanceToPitch > 0)
        ? +(measuredAdvanceToPitch / atlasAdvanceToPitch).toFixed(4)
        : null;

    return {
        measuredAdvancePx,
        autocorrAdvancePx,
        autocorrStrength,
        blobMedianAdvancePx,
        expectedAdvancePx,
        scaleRatio,
        scaleErrorPct,
        measuredAdvanceToPitch,
        atlasAdvanceToPitch,
        aspectScaleRatio,
        rowsMeasured: rowGlyphCenters.length,
        glyphCount: totalGlyphs,
        vacuous: measuredAdvancePx === null,
    };
}

/**
 * Automatically locate candidate text regions inside a full-canvas screenshot by scanning
 * 64x64 tiles for ink density + multi-row structure and merging adjacent active tiles.
 *
 * @param {RgbaImage} img
 * @param {{ tileSize?: number }} [opts]
 * @returns {{ x: number, y: number, w: number, h: number, rowCount: number, pitchPx: number | null, inkPixels: number }[]}
 */
export function findTextRegions(img, opts = {}) {
    const tileSize = opts.tileSize ?? 64;
    const cols = Math.ceil(img.width / tileSize);
    const rows = Math.ceil(img.height / tileSize);
    const active = new Uint8Array(cols * rows);

    for (let ty = 0; ty < rows; ty++) {
        for (let tx = 0; tx < cols; tx++) {
            const x0 = tx * tileSize, y0 = ty * tileSize;
            const w = Math.min(img.width - x0, tileSize);
            const h = Math.min(img.height - y0, tileSize);
            if (w < 16 || h < 16) continue;
            const tile = cropImage(img, { x: x0, y: y0, w, h });
            const tileInk = computeInkMap(tile, { minInkPixels: 6, minContrast: 0.14 });
            if (!tileInk.vacuous && tileInk.inkCoverage >= 0.012 && tileInk.inkCoverage <= 0.65) {
                active[ty * cols + tx] = 1;
            }
        }
    }

    // Connected components of active tiles
    const visited = new Uint8Array(cols * rows);
    /** @type {{ x: number, y: number, w: number, h: number, rowCount: number, pitchPx: number | null, inkPixels: number }[]} */
    const regions = [];

    for (let i = 0; i < active.length; i++) {
        if (!active[i] || visited[i]) continue;
        const queue = [i];
        visited[i] = 1;
        let minTx = cols, maxTx = 0, minTy = rows, maxTy = 0;
        while (queue.length) {
            const cur = /** @type {number} */ (queue.pop());
            const cx = cur % cols, cy = Math.floor(cur / cols);
            if (cx < minTx) minTx = cx;
            if (cx > maxTx) maxTx = cx;
            if (cy < minTy) minTy = cy;
            if (cy > maxTy) maxTy = cy;
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const nx = cx + dx, ny = cy + dy;
                    if (nx >= 0 && nx < cols && ny >= 0 && ny < rows) {
                        const ni = ny * cols + nx;
                        if (active[ni] && !visited[ni]) {
                            visited[ni] = 1;
                            queue.push(ni);
                        }
                    }
                }
            }
        }
        const x = minTx * tileSize;
        const y = minTy * tileSize;
        const w = Math.min(img.width - x, (maxTx - minTx + 1) * tileSize);
        const h = Math.min(img.height - y, (maxTy - minTy + 1) * tileSize);
        if (w >= 48 && h >= 24) {
            const sub = cropImage(img, { x, y, w, h });
            const subInk = computeInkMap(sub, opts);
            const rp = measureRowPitch(sub, { inkMap: subInk });
            if (!subInk.vacuous && rp.rowCount >= 2) {
                regions.push({
                    x, y, w, h,
                    rowCount: rp.rowCount,
                    pitchPx: rp.pitchPx,
                    inkPixels: subInk.inkPixels,
                });
            }
        }
    }

    regions.sort((a, b) => (b.rowCount * Math.sqrt(b.inkPixels)) - (a.rowCount * Math.sqrt(a.inkPixels)));
    return regions;
}

/**
 * Evaluate pixel-exactness pass/fail gates for orthographic plane verification.
 *
 * @param {{
 *   rowPitch: RowPitchResult,
 *   crispness: EdgeCrispnessResult,
 *   scale: GlyphScaleResult,
 *   stillness?: StillnessResult | null
 * }} report
 * @param {{
 *   expectedRowPitchPx?: number | null,
 *   pitchTolPx?: number,
 *   integerSnapTolPx?: number,
 *   maxRampWidthPx?: number,
 *   maxTwoPxRampShare?: number,
 *   scaleTolPct?: number,
 *   maxChangedPixels?: number
 * }} [thresholds]
 * @returns {{ passed: boolean, failures: string[] }}
 */
export function evaluatePixelGates(report, thresholds = {}) {
    const expectedPitch = thresholds.expectedRowPitchPx ?? null;
    const pitchTolPx = thresholds.pitchTolPx ?? 0.15;
    const integerSnapTolPx = thresholds.integerSnapTolPx ?? 0.12;
    const maxRampWidthPx = thresholds.maxRampWidthPx ?? 1.25;
    const maxTwoPxRampShare = thresholds.maxTwoPxRampShare ?? 0.20;
    const scaleTolPct = thresholds.scaleTolPct ?? 1.0;
    const maxChangedPixels = thresholds.maxChangedPixels ?? 0;

    /** @type {string[]} */
    const failures = [];
    const { rowPitch, crispness, scale, stillness } = report;

    if (rowPitch.vacuous) {
        failures.push('rowPitch: vacuous (fewer than 2 text rows detected)');
    } else {
        if (expectedPitch !== null && rowPitch.pitchPx !== null) {
            const diff = Math.abs(rowPitch.pitchPx - expectedPitch);
            if (diff > pitchTolPx) {
                failures.push(
                    `rowPitch: measured ${rowPitch.pitchPx.toFixed(2)} px != expected ${expectedPitch} px (|Δ|=${diff.toFixed(2)} px > ${pitchTolPx} px)`
                );
            }
        }
        if (rowPitch.integerSnapErrorPx !== null && rowPitch.integerSnapErrorPx > integerSnapTolPx) {
            failures.push(
                `rowPitch: non-integer row pitch ${rowPitch.pitchPx?.toFixed(2)} px (snap error ${rowPitch.integerSnapErrorPx.toFixed(2)} px > ${integerSnapTolPx} px)`
            );
        }
    }

    if (crispness.vacuous) {
        failures.push('crispness: vacuous (insufficient stem transitions)');
    } else {
        if (crispness.rampWidthMedianPx !== null && crispness.rampWidthMedianPx > maxRampWidthPx) {
            failures.push(
                `crispness: median transition width ${crispness.rampWidthMedianPx.toFixed(2)} px > ${maxRampWidthPx} px (blurred stems)`
            );
        }
        if (crispness.twoPxRampShare !== null && crispness.twoPxRampShare > maxTwoPxRampShare) {
            failures.push(
                `crispness: ${(crispness.twoPxRampShare * 100).toFixed(1)}% of stem edges are >=2-px ramps (max ${(maxTwoPxRampShare * 100).toFixed(1)}%)`
            );
        }
    }

    if (scale.vacuous) {
        failures.push('scale: vacuous (could not measure glyph advance)');
    } else if (scale.scaleErrorPct !== null && Math.abs(scale.scaleErrorPct) > scaleTolPct) {
        failures.push(
            `scale: glyph advance ratio ${scale.scaleRatio?.toFixed(4)}x (${scale.scaleErrorPct > 0 ? '+' : ''}${scale.scaleErrorPct.toFixed(2)}% vs atlas advance ${scale.expectedAdvancePx?.toFixed(3)} px, tol ±${scaleTolPct}%)`
        );
    }

    if (stillness) {
        if (stillness.vacuous) {
            failures.push('stillness: vacuous (blank or text-free capture)');
        } else if (stillness.changedPixels > maxChangedPixels) {
            failures.push(
                `stillness: ${stillness.changedPixels} pixels changed between captures (maxDiff=${stillness.maxDiff}/255, allowed=${maxChangedPixels})`
            );
        }
    }

    return { passed: failures.length === 0, failures };
}

// ── Synthetic fixture generator for teeth verification ────────────────────────

/**
 * 5x9 stem bitmap glyphs composed of crisp horizontal and vertical stems.
 * Each glyph is 9 rows of 5-bit strings ('#' = ink, '.' = background).
 * @type {Record<string, string[]>}
 */
const STEM_GLYPHS = {
    M: [
        '#...#',
        '##.##',
        '##.##',
        '#.#.#',
        '#.#.#',
        '#...#',
        '#...#',
        '#...#',
        '#...#',
    ],
    H: [
        '#...#',
        '#...#',
        '#...#',
        '#####',
        '#####',
        '#...#',
        '#...#',
        '#...#',
        '#...#',
    ],
    E: [
        '#####',
        '#####',
        '#....',
        '####.',
        '####.',
        '#....',
        '#....',
        '#####',
        '#####',
    ],
    F: [
        '#####',
        '#####',
        '#....',
        '####.',
        '####.',
        '#....',
        '#....',
        '#....',
        '#....',
    ],
    T: [
        '#####',
        '#####',
        '..#..',
        '..#..',
        '..#..',
        '..#..',
        '..#..',
        '..#..',
        '..#..',
    ],
    L: [
        '#....',
        '#....',
        '#....',
        '#....',
        '#....',
        '#....',
        '#....',
        '#####',
        '#####',
    ],
    I: [
        '#####',
        '#####',
        '..#..',
        '..#..',
        '..#..',
        '..#..',
        '..#..',
        '#####',
        '#####',
    ],
    N: [
        '#...#',
        '##..#',
        '##..#',
        '#.#.#',
        '#.#.#',
        '#..##',
        '#..##',
        '#...#',
        '#...#',
    ],
    U: [
        '#...#',
        '#...#',
        '#...#',
        '#...#',
        '#...#',
        '#...#',
        '#...#',
        '#####',
        '#####',
    ],
    O: [
        '#####',
        '#####',
        '#...#',
        '#...#',
        '#...#',
        '#...#',
        '#...#',
        '#####',
        '#####',
    ],
};

const DEFAULT_FIXTURE_LINES = [
    'THEMINIHTTMLIHEFTOUNTHEMINIHTTML',
    'MHTEFILNOUHTEMINLOUFMHTEFILNOUHT',
    'FILNOUTHEMINUOTHEFLIFILNOUTHEMIN',
    'NOUTHEMINLHTEFIMNOUTNOUTHEMINLHT',
    'EMINLHTEFOUHTEMINLOHEMINLHTEFOUH',
    'HTEFILNOUTHEMINLOUHTHTEFILNOUTHE',
    'LNOUTHEMINFHTELINOULLNOUTHEMINFH',
    'UTHEMINLOUFHTEMINLOUUTHEMINLOUFH',
    'MINLHTEFOUHTEMINLHTEMINLHTEFOUHT',
    'EFILNOUTHEMINLOUHTEMEFILNOUTHEMI',
    'THEMINIHTTMLIHEFTOUNTHEMINIHTTML',
    'MHTEFILNOUHTEMINLOUFMHTEFILNOUHT',
];

/**
 * Render a synthetic text fixture with exact continuous box-filter area coverage over each
 * device pixel [px, px+1] x [py, py+1], then round-trip through PNG encode/decode.
 *
 * - At scale=1.0, offsetX=0, offsetY=0, integer rowPitchPx=13 and integer advancePx=7:
 *   every stem edge lands on an integer pixel boundary -> 1-px crisp transitions, exact
 *   13.00 px row pitch, exact 7.00 px glyph advance.
 * - At offsetX=0.5, offsetY=0.5: every stem edge straddles half a pixel -> 2-px blurred ramps.
 * - At scale=1.03: row pitch becomes 13.39 px and glyph advance becomes 1.03x.
 *
 * @param {{
 *   width?: number,
 *   height?: number,
 *   lines?: string[],
 *   rowPitchPx?: number,
 *   advancePx?: number,
 *   scale?: number,
 *   offsetX?: number,
 *   offsetY?: number,
 *   marginX?: number,
 *   marginY?: number,
 *   bg?: [number, number, number],
 *   fg?: [number, number, number]
 * }} [opts]
 * @returns {RgbaImage}
 */
export function renderSyntheticTextPng(opts = {}) {
    const width = opts.width ?? 320;
    const height = opts.height ?? 200;
    const lines = opts.lines ?? DEFAULT_FIXTURE_LINES;
    const baseRowPitch = opts.rowPitchPx ?? 13;
    const baseAdvance = opts.advancePx ?? 7;
    const scale = opts.scale ?? 1.0;
    const offsetX = opts.offsetX ?? 0.0;
    const offsetY = opts.offsetY ?? 0.0;
    const marginX = opts.marginX ?? 16;
    const marginY = opts.marginY ?? 16;
    const bg = opts.bg ?? [15, 20, 27];
    const fg = opts.fg ?? [220, 230, 240];

    const rowPitch = baseRowPitch * scale;
    const advance = baseAdvance * scale;
    const subPx = scale; // 1 glyph bitmap unit = 1*scale device px

    // Collect continuous world-space ink rectangles [x0, y0, x1, y1]
    /** @type {[number, number, number, number][]} */
    const rects = [];
    for (let r = 0; r < lines.length; r++) {
        const line = lines[r];
        const rowY0 = marginY + offsetY + r * rowPitch;
        for (let c = 0; c < line.length; c++) {
            const ch = line[c];
            const glyph = STEM_GLYPHS[ch];
            if (!glyph) continue;
            const colX0 = marginX + offsetX + c * advance;
            for (let gy = 0; gy < glyph.length; gy++) {
                const gRow = glyph[gy];
                let runStart = -1;
                for (let gx = 0; gx <= gRow.length; gx++) {
                    const on = gx < gRow.length && gRow[gx] === '#';
                    if (on && runStart < 0) runStart = gx;
                    else if (!on && runStart >= 0) {
                        rects.push([
                            colX0 + runStart * subPx,
                            rowY0 + gy * subPx,
                            colX0 + gx * subPx,
                            rowY0 + (gy + 1) * subPx,
                        ]);
                        runStart = -1;
                    }
                }
            }
        }
    }

    // Rasterize via exact pixel area coverage (8x8 subpixel supersampling per covered pixel)
    const cov = new Float32Array(width * height);
    const SUB = 8;
    const invSub2 = 1 / (SUB * SUB);

    for (const [rx0, ry0, rx1, ry1] of rects) {
        const ix0 = Math.max(0, Math.floor(rx0));
        const iy0 = Math.max(0, Math.floor(ry0));
        const ix1 = Math.min(width - 1, Math.ceil(rx1) - 1);
        const iy1 = Math.min(height - 1, Math.ceil(ry1) - 1);

        for (let py = iy0; py <= iy1; py++) {
            for (let px = ix0; px <= ix1; px++) {
                // Fast path when rectangle completely covers pixel [px, px+1] x [py, py+1]
                if (rx0 <= px && rx1 >= px + 1 && ry0 <= py && ry1 >= py + 1) {
                    cov[py * width + px] = 1.0;
                    continue;
                }
                let hits = 0;
                for (let sy = 0; sy < SUB; sy++) {
                    const ySample = py + (sy + 0.5) / SUB;
                    if (ySample < ry0 || ySample >= ry1) continue;
                    for (let sx = 0; sx < SUB; sx++) {
                        const xSample = px + (sx + 0.5) / SUB;
                        if (xSample >= rx0 && xSample < rx1) hits++;
                    }
                }
                const idx = py * width + px;
                cov[idx] = Math.min(1.0, cov[idx] + hits * invSub2);
            }
        }
    }

    const data = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        const a = cov[i];
        const o = i * 4;
        data[o] = Math.round(bg[0] + (fg[0] - bg[0]) * a);
        data[o + 1] = Math.round(bg[1] + (fg[1] - bg[1]) * a);
        data[o + 2] = Math.round(bg[2] + (fg[2] - bg[2]) * a);
        data[o + 3] = 255;
    }

    // Round-trip through real PNG encode + decode so every fixture tests the PNG decoder too
    return decodePng(encodePng({ width, height, data }));
}
