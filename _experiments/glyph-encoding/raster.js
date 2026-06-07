/**
 * Headless curve rasterizer. Takes the SAME outlines the GPU consumes
 * (FontChain.glyphOutline(slot)) and fills them with a nonzero-winding scanline,
 * supersampled for AA. This is the "output curve image" ground truth: render the
 * text two ways (reference shaping vs map→expand) and the pixels must match.
 *
 * Not the exact Slug analytic-coverage shader — it's a deterministic proxy. The
 * point is discrimination: identical glyph streams → identical pixels, so any
 * map bug (dropped glyph, wrong slot, wrong order) shows up as red in the diff.
 */

const SS = 3; // supersample factor per axis

/** Flatten an outline (M/L/Q/C/Z, font units, y-up) into polyline contours. */
function flatten(outline) {
  const contours = [];
  let cur = null, sx = 0, sy = 0, cx = 0, cy = 0;
  for (const seg of outline) {
    const v = seg.values;
    switch (seg.type) {
      case 'M':
        if (cur) contours.push(cur);
        cur = []; cx = sx = v[0]; cy = sy = v[1]; cur.push([cx, cy]); break;
      case 'L':
        cx = v[0]; cy = v[1]; cur.push([cx, cy]); break;
      case 'Q': {
        for (let i = 1; i <= 8; i++) {
          const t = i / 8, m = 1 - t;
          cur.push([m * m * cx + 2 * m * t * v[0] + t * t * v[2],
                    m * m * cy + 2 * m * t * v[1] + t * t * v[3]]);
        }
        cx = v[2]; cy = v[3]; break;
      }
      case 'C': {
        for (let i = 1; i <= 12; i++) {
          const t = i / 12, m = 1 - t;
          cur.push([m*m*m*cx + 3*m*m*t*v[0] + 3*m*t*t*v[2] + t*t*t*v[4],
                    m*m*m*cy + 3*m*m*t*v[1] + 3*m*t*t*v[3] + t*t*t*v[5]]);
        }
        cx = v[4]; cy = v[5]; break;
      }
      case 'Z':
        if (cur) cur.push([sx, sy]); break;
    }
  }
  if (cur) contours.push(cur);
  return contours;
}

/** Shared layout geometry so the grayscale and highlight renders line up exactly. */
export function layoutGeom(chain, slotLines, opts = {}) {
  const emPx = opts.emPx ?? 12;
  const maxLines = opts.maxLines ?? 30;
  const maxCols = opts.maxCols ?? 72;
  const scale = emPx / chain.upem;
  const ext = chain.fontExtents();
  const ascPx = ext.ascender * scale;
  const lineH = (ext.ascender - ext.descender) * scale * 1.15;
  const cellPx = chain.shape('M')[0].ax * scale;
  const nLines = Math.min(slotLines.length, maxLines);
  let cols = 1;
  for (let i = 0; i < nLines; i++) cols = Math.max(cols, Math.min(slotLines[i].length, maxCols));
  const W = Math.ceil(cols * cellPx) + 2;
  const H = Math.ceil(nLines * lineH) + 2;
  return { emPx, maxLines, maxCols, scale, ascPx, lineH, cellPx, nLines, W, H };
}

/**
 * Render slot-lines to a grayscale image (white bg, black glyphs).
 * @param {import('../../packages/glyph3d-core/src/shaping/FontChain.js').default} chain
 * @param {number[][]} slotLines - per source line, the slot per codepoint
 * @param {{emPx?:number, maxLines?:number, maxCols?:number}} [opts]
 */
export function renderToImage(chain, slotLines, opts = {}) {
  const { scale, ascPx, lineH, cellPx, nLines, maxCols, W, H } = layoutGeom(chain, slotLines, opts);
  const SW = W * SS, SH = H * SS;

  // Collect edges in supersampled pixel space (skip horizontal edges).
  const edges = [];
  for (let li = 0; li < nLines; li++) {
    const slots = slotLines[li];
    const baseY = li * lineH + ascPx;
    for (let ci = 0; ci < slots.length && ci < maxCols; ci++) {
      const slot = slots[ci];
      if (!slot) continue; // blank slot 0 → empty cell
      const outline = chain.glyphOutline(slot);
      if (!outline.length) continue;
      const ox = ci * cellPx;
      for (const c of flatten(outline)) {
        for (let k = 0; k + 1 < c.length; k++) {
          const x0 = (ox + c[k][0] * scale) * SS;
          const y0 = (baseY - c[k][1] * scale) * SS;
          const x1 = (ox + c[k + 1][0] * scale) * SS;
          const y1 = (baseY - c[k + 1][1] * scale) * SS;
          if (y0 !== y1) edges.push([x0, y0, x1, y1]);
        }
      }
    }
  }

  const ss = new Uint8Array(SW * SH);
  const xs = [];
  for (let y = 0; y < SH; y++) {
    const yc = y + 0.5;
    xs.length = 0;
    for (const e of edges) {
      const y0 = e[1], y1 = e[3];
      const lo = y0 < y1 ? y0 : y1, hi = y0 < y1 ? y1 : y0;
      if (yc >= lo && yc < hi) {
        const t = (yc - y0) / (y1 - y0);
        xs.push([e[0] + t * (e[2] - e[0]), y1 > y0 ? 1 : -1]);
      }
    }
    xs.sort((a, b) => a[0] - b[0]);
    let w = 0;
    for (let i = 0; i < xs.length - 1; i++) {
      w += xs[i][1];
      if (w !== 0) {
        const xa = Math.max(0, Math.ceil(xs[i][0] - 0.5));
        const xb = Math.min(SW - 1, Math.floor(xs[i + 1][0] - 0.5));
        for (let x = xa; x <= xb; x++) ss[y * SW + x] = 1;
      }
    }
  }

  // Downsample to grayscale (invert coverage → dark text on white).
  const out = new Uint8Array(W * H);
  const norm = SS * SS;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let s = 0;
      for (let dy = 0; dy < SS; dy++)
        for (let dx = 0; dx < SS; dx++)
          s += ss[(y * SS + dy) * SW + (x * SS + dx)];
      out[y * W + x] = Math.round(255 * (1 - s / norm));
    }
  }
  return { width: W, height: H, channels: 1, data: out };
}

/**
 * Render with a highlight set (flat slot indices) tinting the picked cells —
 * the visual proof that a range query lands on the right glyphs. Black text over
 * white, with highlighted cells tinted yellow. Composites over the proven
 * grayscale path so geometry matches exactly.
 * @param {Set<number>} highlight - flat slot indices to tint
 */
export function renderHighlighted(chain, slotLines, highlight, opts = {}) {
  const g = layoutGeom(chain, slotLines, opts);
  const gray = renderToImage(chain, slotLines, opts);
  const { W, H } = g;
  const out = new Uint8Array(W * H * 3);

  // per-line slot base, so (line,col) → flat slot index matches IndexView
  const base = new Array(slotLines.length);
  let acc = 0;
  for (let i = 0; i < slotLines.length; i++) { base[i] = acc; acc += slotLines[i].length; }

  for (let y = 0; y < H; y++) {
    const line = Math.floor(y / g.lineH);
    for (let x = 0; x < W; x++) {
      const col = Math.floor(x / g.cellPx);
      let br = 255, bg = 255, bb = 255;
      if (line >= 0 && line < g.nLines && col >= 0 && col < slotLines[line].length &&
          highlight.has(base[line] + col)) { br = 255; bg = 238; bb = 130; }
      const k = gray.data[y * W + x] / 255; // 1=white(bg), 0=ink(black)
      const o = (y * W + x) * 3;
      out[o] = Math.round(br * k); out[o + 1] = Math.round(bg * k); out[o + 2] = Math.round(bb * k);
    }
  }
  return { width: W, height: H, channels: 3, data: out };
}

/** Pixel-diff two grayscale images → RGB image (red where they differ) + count. */
export function diffImages(a, b) {
  const W = Math.max(a.width, b.width);
  const H = Math.max(a.height, b.height);
  const out = new Uint8Array(W * H * 3);
  let diff = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const va = x < a.width && y < a.height ? a.data[y * a.width + x] : 255;
      const vb = x < b.width && y < b.height ? b.data[y * b.width + x] : 255;
      const o = (y * W + x) * 3;
      if (va !== vb) { out[o] = 255; out[o + 1] = 0; out[o + 2] = 0; diff++; }
      else { out[o] = va; out[o + 1] = va; out[o + 2] = va; }
    }
  }
  return { image: { width: W, height: H, channels: 3, data: out }, diff };
}
