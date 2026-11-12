/**
 * terminalDepthHistory — pure, GPU-free helpers for terminal scrollback-into-depth.
 *
 * tmux owns true scrollback and repaints only the visible pane (no "line scrolled
 * off" event), so TerminalGrid recovers history by diffing consecutive frames. That
 * heuristic — vertical-scroll detection — is exactly the kind of index logic that
 * goes subtly wrong (off-by-one shift, blank-region false positives, capture order),
 * so it lives here as testable functions instead of inline in the renderer.
 *
 * The rows a terminal draws — its history lines, oldest first, then its live rows, top to
 * bottom — are one SEQUENCE in time order, and a scroll of k shifts the whole sequence by k: the
 * oldest k history lines drop, the top k live rows become the newest history, k new rows arrive
 * at the bottom. TerminalGrid keeps the sequence as a RING of physical rows and moves the ring's
 * head instead of the data, so a row's cells are written once — when its content changes — and
 * every scroll after that only re-poses it. Sequence index s: s < depthMax is history line
 * h = depthMax − 1 − s (0 = newest); s ≥ depthMax is live row y = s − depthMax.
 */

/** @private Whether `cols` codepoints from `base` are all spaces. */
function rowBlank(cp, base, cols) {
    for (let x = 0; x < cols; x++) if (cp[base + x] !== 32) return false;
    return true;
}

/**
 * Detect a vertical scroll between the live screen the terminal holds and the incoming one:
 * the smallest k≥1 for which every overlapping row matches after shifting up by k
 * (incoming row y === held row y+k), with at least one non-blank cell in the overlap.
 * Returns 0 when nothing scrolled — a static frame, a full repaint, or a clear (no
 * consistent shift exists). Compares codepoints only, so color churn or a cursor blink
 * never registers as a scroll.
 *
 * @param {Uint32Array} heldCp       the codepoints the terminal holds (its physical rows)
 * @param {Int32Array} heldRowBase   where held live row y starts in heldCp (y = 0..rows-1)
 * @param {Uint32Array} curCp        the incoming screen's codepoints, row-major (row y at y·cols)
 * @param {number} rows
 * @param {number} cols
 * @returns {number} lines scrolled off the top (0 = none)
 */
export function detectVerticalScroll(heldCp, heldRowBase, curCp, rows, cols) {
    // Trim trailing rows that are blank in BOTH frames. After a line-scroll the cursor
    // sits on an empty home line below the output, so the newest content lands at row
    // rows-2 and row rows-1 stays blank. Comparing the full screen then fails — a
    // 1-line scroll needs cur[rows-2] == prev[rows-1], but that's new-content vs blank.
    // The cursor home line isn't content, so it must not gate the match.
    let effRows = rows;
    while (effRows > 0 && rowBlank(curCp, (effRows - 1) * cols, cols) && rowBlank(heldCp, heldRowBase[effRows - 1], cols)) effRows--;
    if (effRows < 2) return 0;

    for (let k = 1; k < effRows; k++) {
        let ok = true;
        let sawContent = false;
        for (let y = 0; y + k < effRows; y++) {
            const cb = y * cols;
            const hb = heldRowBase[y + k];
            for (let x = 0; x < cols; x++) {
                const c = curCp[cb + x];
                if (c !== heldCp[hb + x]) { ok = false; break; }
                if (c !== 32) sawContent = true;
            }
            if (!ok) break;
        }
        if (ok && sawContent) return k;
    }
    return 0;
}

/**
 * Brightness multiplier for depth slot h (0 = newest, in the forefront). Fades
 * linearly from 1 at the front to fadeMin at the deepest slot — atmospheric
 * perspective so older history recedes visually as well as in Z.
 * @param {number} h          slot index
 * @param {number} depthMax   number of depth slots
 * @param {number} fadeMin    deepest slot's brightness (0..1)
 * @returns {number}
 */
export function depthFade(h, depthMax, fadeMin) {
    return depthMax > 1 ? 1 - (h / (depthMax - 1)) * (1 - fadeMin) : 1;
}

/** Floats per sequence index in a row layout: y, z, fade. */
export const ROW_LAYOUT_STRIDE = 3;

/**
 * Where each row of the sequence sits and how bright it draws, in the terminal's local frame:
 * `out[s·3 + 0..2]` = y, z, fade for sequence index s (0 … rows + depthMax − 1). Live rows run
 * down from y = 0 at z = 0, unfaded. History is page-quantized: lines group into screenfuls
 * (`rows` each), each page a flat block at the live screen's Y that steps back depthZStep and
 * rises depthYStep per page, the newest page just behind the live screen, faded per page toward
 * fadeMin (a page reads as one block — its lines never smear across depth).
 *
 * @param {Float32Array} out  (rows + depthMax) × ROW_LAYOUT_STRIDE
 * @param {number} rows
 * @param {number} depthMax
 * @param {{lineSpacing:number}} metrics
 * @param {number} depthYStep  world rise per page
 * @param {number} depthZStep  world recession per page
 * @param {number} fadeMin     the oldest page's brightness
 */
export function layoutTerminalRows(out, rows, depthMax, metrics, depthYStep, depthZStep, fadeMin) {
    const strideY = metrics.lineSpacing;
    const pageCount = Math.max(1, Math.ceil(depthMax / rows));
    for (let s = 0; s < depthMax + rows; s++) {
        const o = s * ROW_LAYOUT_STRIDE;
        if (s >= depthMax) {
            out[o] = -(s - depthMax) * strideY;
            out[o + 1] = 0;
            out[o + 2] = 1;
            continue;
        }
        const h = depthMax - 1 - s;
        const p = Math.floor(h / rows);
        const rowFromTop = (rows - 1) - (h % rows);
        out[o] = (p + 1) * depthYStep - rowFromTop * strideY;
        out[o + 1] = -(p + 1) * depthZStep;
        out[o + 2] = depthFade(p, pageCount, fadeMin);
    }
}

/**
 * Calculate the bounding extent for terminal glyphs in local space — the hull of every
 * cell's ink, mirroring layoutTerminalRows. A glyph's anchor is its pen origin x and its row's
 * center y, so a cell spans [x, x + charWidth] × [y ± charHeight/2]: live rows' centers run
 * 0 … −(rows−1)·lineSpacing, history pages rise to pages·depthYStep and recede to
 * −pages·depthZStep. three culls by this box (InstancedField.setLayoutExtent).
 *
 * @param {number} cols
 * @param {number} rows
 * @param {number} depthMax
 * @param {{charWidth:number,charHeight:number,letterSpacing:number,lineSpacing:number}} metrics
 * @param {number} depthYStep
 * @param {number} depthZStep
 * @returns {{min:{x:number,y:number,z:number}, max:{x:number,y:number,z:number}}}
 */
export function computeTerminalGlyphExtent(cols, rows, depthMax, metrics, depthYStep, depthZStep) {
    const strideX = metrics.charWidth + metrics.letterSpacing;
    const strideY = metrics.lineSpacing;
    const half = metrics.charHeight / 2;
    const pages = depthMax > 0 ? Math.ceil(depthMax / rows) : 0;
    // History's lowest center is page 0's bottom row: depthYStep − (rows−1)·strideY.
    const lowest = -(rows - 1) * strideY + (pages > 0 ? Math.min(0, depthYStep) : 0);
    return {
        min: {
            x: 0,
            y: lowest - half,
            z: -pages * depthZStep,
        },
        max: {
            x: (cols - 1) * strideX + metrics.charWidth,
            y: Math.max(0, pages * depthYStep) + half,
            z: 0,
        },
    };
}
