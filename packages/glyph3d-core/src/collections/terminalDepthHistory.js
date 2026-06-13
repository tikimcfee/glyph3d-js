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
