/**
 * terminalDepthHistory — pure, GPU-free helpers for terminal scrollback-into-depth.
 *
 * tmux owns true scrollback and repaints only the visible pane (no "line scrolled
 * off" event), so TerminalGrid recovers history by diffing consecutive frames. That
 * heuristic — vertical-scroll detection — is exactly the kind of index logic that
 * goes subtly wrong (off-by-one shift, blank-region false positives, capture order),
 * so it lives here as testable functions instead of inline in the renderer.
 *
 * A "row snapshot" is `{ cp: Float32Array, r,g,b: Float32Array }` (codepoints +
 * colors) as produced by TerminalGrid._snapshotLive. Only `cp` matters to detection.
 */

/**
 * Detect a vertical scroll between the previous live screen and the incoming one:
 * the smallest k≥1 for which every overlapping row matches after shifting up by k
 * (current row y === previous row y+k), with at least one non-blank cell in the
 * overlap. Returns 0 when nothing scrolled — a static frame, a full repaint, or a
 * clear (no consistent shift exists). Compares codepoints only, so color churn or a
 * cursor blink never registers as a scroll.
 *
 * @param {Array<{cp:Float32Array}>|null} prevRows  last frame's per-row snapshot
 * @param {{cells:Array<Array<{codepoint:number}>>}} screen  incoming ScreenBuffer
 * @param {number} rows
 * @param {number} cols
 * @returns {number} lines scrolled off the top (0 = none)
 */
export function detectVerticalScroll(prevRows, screen, rows, cols) {
    if (!prevRows) return 0;

    // Trim trailing rows that are blank in BOTH frames. After a line-scroll the cursor
    // sits on an empty home line below the output, so the newest content lands at row
    // rows-2 and row rows-1 stays blank. Comparing the full screen then fails — a
    // 1-line scroll needs cur[rows-2] == prev[rows-1], but that's new-content vs blank.
    // The cursor home line isn't content, so it must not gate the match.
    const curBlank = (y) => {
        const r = screen.cells[y];
        if (!r) return true;
        for (let x = 0; x < cols; x++) { const c = r[x]; if (c && (c.codepoint ?? 32) !== 32) return false; }
        return true;
    };
    const prevBlank = (y) => {
        const cp = prevRows[y] && prevRows[y].cp;
        if (!cp) return true;
        for (let x = 0; x < cols; x++) { if (cp[x] !== 32) return false; }
        return true;
    };
    let effRows = rows;
    while (effRows > 0 && curBlank(effRows - 1) && prevBlank(effRows - 1)) effRows--;
    if (effRows < 2) return 0;

    for (let k = 1; k < effRows; k++) {
        let ok = true;
        let sawContent = false;
        for (let y = 0; y + k < effRows; y++) {
            const cur = screen.cells[y];
            const pv = prevRows[y + k].cp;
            for (let x = 0; x < cols; x++) {
                const c = cur ? (cur[x]?.codepoint ?? 32) : 32;
                if (c !== pv[x]) { ok = false; break; }
                if (c !== 32) sawContent = true;
            }
            if (!ok) break;
        }
        if (ok && sawContent) return k;
    }
    return 0;
}

/**
 * The k rows that just scrolled off the top, NEWEST-FIRST. prevRows[k-1] sat
 * directly above the new top, so it is the newest history; prevRows[0] is the
 * oldest. Returned so `history.unshift(...captureScrolledRows(prev, k))` keeps the
 * ring's index 0 = newest.
 * @param {Array} prevRows
 * @param {number} k
 * @returns {Array}
 */
export function captureScrolledRows(prevRows, k) {
    return prevRows.slice(0, k).reverse();
}

/**
 * Re-fit captured history rows to a new column width after a resize: clip if the
 * panel narrowed, blank-pad (space + default fg 0.8) if it widened. Terminals don't
 * re-wrap scrollback on resize — they clip — and tmux holds the durable copy
 * (terminal.depth.seed restores the lost columns). Returns a NEW ring; a row already
 * at `cols` is reused as-is (snapshots are immutable). Every row staying exactly
 * `cols` wide is a hard invariant — _paintHistory reads row.cp[0..cols), so a short
 * row would yield undefined → NaN in the GPU buffer.
 * @param {Array<{cp:Float32Array,r:Float32Array,g:Float32Array,b:Float32Array}>} history  newest-first ring
 * @param {number} cols  the new column width
 * @returns {Array} a ring of the same length, every row exactly `cols` wide
 */
export function reflowHistoryRows(history, cols) {
    return history.map((row) => {
        if (row.cp.length === cols) return row;
        const cp = new Float32Array(cols).fill(32);
        const r  = new Float32Array(cols).fill(0.8);
        const g  = new Float32Array(cols).fill(0.8);
        const b  = new Float32Array(cols).fill(0.8);
        const n = Math.min(row.cp.length, cols);
        cp.set(row.cp.subarray(0, n));
        r.set(row.r.subarray(0, n));
        g.set(row.g.subarray(0, n));
        b.set(row.b.subarray(0, n));
        return { cp, r, g, b };
    });
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

/**
 * Pre-compute world-space XYZ positions for live terminal cells and depth-history slots.
 * Live cells are placed row-major starting at origin (x increases rightward, y decreases downward).
 * Depth-history slots are page-quantized, stepping back in −Z and optionally rising in +Y.
 *
 * @param {Float32Array} positions
 * @param {number} cols
 * @param {number} rows
 * @param {number} depthMax
 * @param {{charWidth:number,charHeight:number,letterSpacing:number,lineSpacing:number}} metrics
 * @param {number} depthYStep
 * @param {number} depthZStep
 */
export function computeTerminalPositions(positions, cols, rows, depthMax, metrics, depthYStep, depthZStep) {
    const strideX = metrics.charWidth + metrics.letterSpacing;
    const strideY = metrics.lineSpacing;

    for (let row = 0; row < rows; row++) {
        const y = -row * strideY;
        for (let col = 0; col < cols; col++) {
            const idx = (row * cols + col) * 3;
            positions[idx]     = col * strideX;
            positions[idx + 1] = y;
            positions[idx + 2] = 0;
        }
    }

    const base0 = cols * rows;
    const R = rows;
    const pageRise  = depthYStep;
    const pageDepth = depthZStep;
    for (let h = 0; h < depthMax; h++) {
        const p = Math.floor(h / R);
        const i = h % R;
        const rowFromTop = (R - 1) - i;
        const y = (p + 1) * pageRise - rowFromTop * strideY;
        const z = -(p + 1) * pageDepth;
        for (let col = 0; col < cols; col++) {
            const idx = (base0 + h * cols + col) * 3;
            positions[idx]     = col * strideX;
            positions[idx + 1] = y;
            positions[idx + 2] = z;
        }
    }
}

/**
 * Fill sizes array with uniform charWidth x charHeight.
 *
 * @param {Float32Array} sizes
 * @param {number} totalCount
 * @param {number} charWidth
 * @param {number} charHeight
 */
export function computeTerminalSizes(sizes, totalCount, charWidth, charHeight) {
    for (let i = 0; i < totalCount; i++) {
        sizes[i * 2]     = charWidth;
        sizes[i * 2 + 1] = charHeight;
    }
}

/**
 * Calculate the bounding extent for terminal glyphs in local space.
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
    const pages = depthMax > 0 ? Math.ceil(depthMax / rows) : 0;
    return {
        min: {
            x: 0,
            y: -(rows - 1) * strideY,
            z: -pages * depthZStep,
        },
        max: {
            x: (cols - 1) * strideX + metrics.charWidth,
            y: pages * depthYStep + metrics.charHeight,
            z: 0,
        },
    };
}

/**
 * Snapshot the live screen region of canonical typed arrays into an array of immutable row objects.
 *
 * @param {Float32Array} codepoints
 * @param {Float32Array} cellR
 * @param {Float32Array} cellG
 * @param {Float32Array} cellB
 * @param {number} cols
 * @param {number} rows
 * @returns {Array<{cp:Float32Array, r:Float32Array, g:Float32Array, b:Float32Array}>}
 */
export function snapshotLiveRegion(codepoints, cellR, cellG, cellB, cols, rows) {
    const snap = new Array(rows);
    for (let y = 0; y < rows; y++) {
        const base = y * cols;
        const rcp = new Float32Array(cols);
        const rr = new Float32Array(cols);
        const rg = new Float32Array(cols);
        const rb = new Float32Array(cols);
        for (let x = 0; x < cols; x++) {
            rcp[x] = codepoints[base + x];
            rr[x]  = cellR[base + x];
            rg[x]  = cellG[base + x];
            rb[x]  = cellB[base + x];
        }
        snap[y] = { cp: rcp, r: rr, g: rg, b: rb };
    }
    return snap;
}

/**
 * Write the depth-history ring into the history region of canonical typed arrays.
 *
 * @param {Object} options
 * @param {Float32Array} options.codepoints
 * @param {Float32Array} options.cellR
 * @param {Float32Array} options.cellG
 * @param {Float32Array} options.cellB
 * @param {Array<{cp:Float32Array, r:Float32Array, g:Float32Array, b:Float32Array}>} options.history
 * @param {number} options.cols
 * @param {number} options.rows
 * @param {number} options.depthMax
 * @param {number} options.depthFadeMin
 * @param {boolean} options.depthEnabled
 * @param {boolean} options.altActive
 */
export function paintHistoryRegion({
    codepoints, cellR, cellG, cellB,
    history, cols, rows, depthMax, depthFadeMin, depthEnabled, altActive
}) {
    if (depthMax === 0) return;
    const base0 = cols * rows;
    const n = history ? history.length : 0;
    const hide = !depthEnabled || altActive;
    const pageCount = Math.max(1, Math.ceil(depthMax / rows));

    for (let h = 0; h < depthMax; h++) {
        const base = base0 + h * cols;
        if (hide || h >= n) {
            for (let x = 0; x < cols; x++) {
                const i = base + x;
                codepoints[i] = 32; cellR[i] = 0; cellG[i] = 0; cellB[i] = 0;
            }
            continue;
        }
        const row = history[h];
        const fade = depthFade(Math.floor(h / rows), pageCount, depthFadeMin);
        for (let x = 0; x < cols; x++) {
            const i = base + x;
            codepoints[i] = row.cp[x];
            cellR[i] = row.r[x] * fade;
            cellG[i] = row.g[x] * fade;
            cellB[i] = row.b[x] * fade;
        }
    }
}

/**
 * Synchronize canonical typed arrays directly into InstancedSlotBuffer and highlight buffer.
 * Glyph ids and colors go through the slot buffer's lane setters (float-valued lanes).
 *
 * @param {Object} options
 * @param {number} options.count
 * @param {number} options.liveCount
 * @param {import('../core/InstancedSlotBuffer.js').InstancedSlotBuffer} options.slotBuffer
 * @param {Uint8ClampedArray|null} options.highlightBuffer
 * @param {Float32Array} options.codepoints
 * @param {Float32Array} options.cellR
 * @param {Float32Array} options.cellG
 * @param {Float32Array} options.cellB
 * @param {Float32Array} options.cellBgR
 * @param {Float32Array} options.cellBgG
 * @param {Float32Array} options.cellBgB
 * @param {Float32Array} options.cellBgA
 * @param {(cp:number)=>number} options.glyphIdLookup
 * @param {(a:number)=>number} options.encodeHighlightAlpha
 * @returns {boolean} true if buffers were synced, false if buffer capacity too small
 */
export function syncTerminalBuffers({
    count, liveCount, slotBuffer, highlightBuffer,
    codepoints, cellR, cellG, cellB,
    cellBgR, cellBgG, cellBgB, cellBgA,
    glyphIdLookup, encodeHighlightAlpha
}) {
    if (!slotBuffer || slotBuffer.capacity < count) return false;
    const hl  = highlightBuffer;

    for (let i = 0; i < count; i++) {
        slotBuffer.setGlyphId(i, glyphIdLookup ? glyphIdLookup(codepoints[i]) : codepoints[i]);

        const cr = (cellR[i] * 255 + 0.5) | 0;
        const cg = (cellG[i] * 255 + 0.5) | 0;
        const cb = (cellB[i] * 255 + 0.5) | 0;
        slotBuffer.setColor(i, (cr & 0xff) | ((cg & 0xff) << 8) | ((cb & 0xff) << 16));

        if (hl) {
            const h = i * 4;
            if (i < liveCount && cellBgA && cellBgA[i] > 0) {
                hl[h]     = (cellBgR[i] * 255 + 0.5) | 0;
                hl[h + 1] = (cellBgG[i] * 255 + 0.5) | 0;
                hl[h + 2] = (cellBgB[i] * 255 + 0.5) | 0;
                hl[h + 3] = encodeHighlightAlpha ? encodeHighlightAlpha(cellBgA[i]) : 255;
            } else {
                hl[h] = 0; hl[h + 1] = 0; hl[h + 2] = 0; hl[h + 3] = 0;
            }
        }
    }
    return true;
}

