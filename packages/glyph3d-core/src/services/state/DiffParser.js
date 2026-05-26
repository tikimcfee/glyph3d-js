/**
 * DiffParser - Parse unified diff patches into aligned side-by-side line arrays
 *
 * Takes a unified diff patch string (as returned by GitHub's PR files endpoint)
 * and produces two equal-length line arrays for left (base) and right (head) grids,
 * with spacer lines inserted to keep additions/removals aligned across panes.
 *
 * Line types:
 *   'context'  - unchanged line (appears in both panes)
 *   'add'      - added line (right pane only, spacer on left)
 *   'remove'   - removed line (left pane only, spacer on right)
 *   'hunk'     - hunk header (@@ ... @@)
 *   'spacer'   - blank alignment spacer (paired with add/remove on other side)
 */

/** @typedef {{ type: string, text: string, lineNo: number|null }} DiffLine */

/**
 * Parse a unified diff patch into aligned left/right line arrays
 * @param {string} patch - Unified diff patch string from GitHub API
 * @returns {{ left: DiffLine[], right: DiffLine[] }}
 */
export function parsePatchAligned(patch) {
    if (!patch || patch.length === 0) {
        return { left: [], right: [] };
    }

    const rawLines = patch.split('\n');
    const left = [];
    const right = [];

    let oldLineNo = 0;
    let newLineNo = 0;

    // Accumulate consecutive remove/add blocks to pair them as modifications
    let removeBuffer = [];
    let addBuffer = [];

    function flushBuffers() {
        const maxLen = Math.max(removeBuffer.length, addBuffer.length);

        for (let i = 0; i < maxLen; i++) {
            if (i < removeBuffer.length) {
                left.push(removeBuffer[i]);
            } else {
                left.push({ type: 'spacer', text: '', lineNo: null });
            }

            if (i < addBuffer.length) {
                right.push(addBuffer[i]);
            } else {
                right.push({ type: 'spacer', text: '', lineNo: null });
            }
        }

        removeBuffer = [];
        addBuffer = [];
    }

    for (let i = 0; i < rawLines.length; i++) {
        const line = rawLines[i];

        // Hunk header: @@ -oldStart,oldCount +newStart,newCount @@ optional context
        if (line.startsWith('@@')) {
            flushBuffers();

            const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
            if (match) {
                oldLineNo = parseInt(match[1], 10);
                newLineNo = parseInt(match[2], 10);
            }

            left.push({ type: 'hunk', text: line, lineNo: null });
            right.push({ type: 'hunk', text: line, lineNo: null });
            continue;
        }

        // Removal
        if (line.startsWith('-')) {
            removeBuffer.push({ type: 'remove', text: line.slice(1), lineNo: oldLineNo++ });
            continue;
        }

        // Addition
        if (line.startsWith('+')) {
            addBuffer.push({ type: 'add', text: line.slice(1), lineNo: newLineNo++ });
            continue;
        }

        // Context line (starts with space) or anything else
        // First flush any accumulated remove/add buffers
        flushBuffers();

        if (line.startsWith(' ') || line.length === 0) {
            const text = line.startsWith(' ') ? line.slice(1) : line;
            left.push({ type: 'context', text, lineNo: oldLineNo++ });
            right.push({ type: 'context', text, lineNo: newLineNo++ });
        }
        // Skip lines like "\ No newline at end of file"
    }

    // Flush any trailing remove/add block
    flushBuffers();

    return { left, right };
}

/**
 * Apply a parsed aligned diff to full file contents.
 * Produces two equal-length arrays representing the complete files,
 * with changed lines colored and spacers inserted for alignment.
 *
 * @param {string} baseContent - Full content of the base (old) file
 * @param {string} headContent - Full content of the head (new) file
 * @param {string} patch - Unified diff patch string
 * @returns {{ left: DiffLine[], right: DiffLine[] }}
 */
export function buildAlignedDiff(baseContent, headContent, patch) {
    if (!patch || patch.length === 0) {
        // No diff — just show both files as context
        const baseLines = (baseContent || '').split('\n');
        const headLines = (headContent || '').split('\n');
        const maxLen = Math.max(baseLines.length, headLines.length);
        const left = [];
        const right = [];

        for (let i = 0; i < maxLen; i++) {
            left.push({
                type: 'context',
                text: i < baseLines.length ? baseLines[i] : '',
                lineNo: i < baseLines.length ? i + 1 : null
            });
            right.push({
                type: 'context',
                text: i < headLines.length ? headLines[i] : '',
                lineNo: i < headLines.length ? i + 1 : null
            });
        }

        return { left, right };
    }

    // Parse the patch to get hunk info
    const hunks = parseHunks(patch);
    const baseLines = (baseContent || '').split('\n');
    const headLines = (headContent || '').split('\n');

    const left = [];
    const right = [];

    let baseIdx = 0;  // current position in base file (0-indexed)
    let headIdx = 0;  // current position in head file (0-indexed)

    for (const hunk of hunks) {
        // Emit context lines before this hunk
        const hunkBaseStart = hunk.oldStart - 1; // convert 1-indexed to 0-indexed
        const hunkHeadStart = hunk.newStart - 1;

        while (baseIdx < hunkBaseStart && headIdx < hunkHeadStart) {
            left.push({ type: 'context', text: baseLines[baseIdx] || '', lineNo: baseIdx + 1 });
            right.push({ type: 'context', text: headLines[headIdx] || '', lineNo: headIdx + 1 });
            baseIdx++;
            headIdx++;
        }

        // Process hunk lines — accumulate removes/adds for alignment
        let removeBuffer = [];
        let addBuffer = [];

        function flushHunkBuffers() {
            const maxLen = Math.max(removeBuffer.length, addBuffer.length);
            for (let i = 0; i < maxLen; i++) {
                if (i < removeBuffer.length) {
                    left.push(removeBuffer[i]);
                } else {
                    left.push({ type: 'spacer', text: '', lineNo: null });
                }
                if (i < addBuffer.length) {
                    right.push(addBuffer[i]);
                } else {
                    right.push({ type: 'spacer', text: '', lineNo: null });
                }
            }
            removeBuffer = [];
            addBuffer = [];
        }

        for (const entry of hunk.lines) {
            if (entry.op === '-') {
                removeBuffer.push({ type: 'remove', text: entry.text, lineNo: baseIdx + 1 });
                baseIdx++;
            } else if (entry.op === '+') {
                addBuffer.push({ type: 'add', text: entry.text, lineNo: headIdx + 1 });
                headIdx++;
            } else {
                // Context line — flush any pending removes/adds first
                flushHunkBuffers();
                left.push({ type: 'context', text: entry.text, lineNo: baseIdx + 1 });
                right.push({ type: 'context', text: entry.text, lineNo: headIdx + 1 });
                baseIdx++;
                headIdx++;
            }
        }

        flushHunkBuffers();
    }

    // Emit remaining context after last hunk
    while (baseIdx < baseLines.length || headIdx < headLines.length) {
        const bText = baseIdx < baseLines.length ? baseLines[baseIdx] : null;
        const hText = headIdx < headLines.length ? headLines[headIdx] : null;

        if (bText !== null && hText !== null) {
            left.push({ type: 'context', text: bText, lineNo: baseIdx + 1 });
            right.push({ type: 'context', text: hText, lineNo: headIdx + 1 });
            baseIdx++;
            headIdx++;
        } else if (bText !== null) {
            left.push({ type: 'context', text: bText, lineNo: baseIdx + 1 });
            right.push({ type: 'spacer', text: '', lineNo: null });
            baseIdx++;
        } else {
            left.push({ type: 'spacer', text: '', lineNo: null });
            right.push({ type: 'context', text: hText, lineNo: headIdx + 1 });
            headIdx++;
        }
    }

    return { left, right };
}

/**
 * Parse a unified diff patch into structured hunks
 * @param {string} patch - Unified diff patch string
 * @returns {Array<{oldStart: number, oldCount: number, newStart: number, newCount: number, lines: Array}>}
 */
function parseHunks(patch) {
    const rawLines = patch.split('\n');
    const hunks = [];
    let currentHunk = null;

    for (const line of rawLines) {
        if (line.startsWith('@@')) {
            const match = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
            if (match) {
                currentHunk = {
                    oldStart: parseInt(match[1], 10),
                    oldCount: match[2] !== undefined ? parseInt(match[2], 10) : 1,
                    newStart: parseInt(match[3], 10),
                    newCount: match[4] !== undefined ? parseInt(match[4], 10) : 1,
                    lines: []
                };
                hunks.push(currentHunk);
            }
            continue;
        }

        if (!currentHunk) continue;

        if (line.startsWith('-')) {
            currentHunk.lines.push({ op: '-', text: line.slice(1) });
        } else if (line.startsWith('+')) {
            currentHunk.lines.push({ op: '+', text: line.slice(1) });
        } else if (line.startsWith(' ')) {
            currentHunk.lines.push({ op: ' ', text: line.slice(1) });
        } else if (line.startsWith('\\')) {
            // "\ No newline at end of file" — skip
        } else if (line.length === 0 && currentHunk.lines.length > 0) {
            // Empty context line within a hunk
            currentHunk.lines.push({ op: ' ', text: '' });
        }
    }

    return hunks;
}

/**
 * Get color for a diff line type
 * @param {string} type - Line type: 'context', 'add', 'remove', 'hunk', 'spacer'
 * @returns {{ r: number, g: number, b: number }}
 */
export function getDiffColor(type) {
    switch (type) {
        case 'add':     return { r: 0.2, g: 0.9, b: 0.3 };
        case 'remove':  return { r: 0.9, g: 0.25, b: 0.25 };
        case 'hunk':    return { r: 0.4, g: 0.6, b: 1.0 };
        case 'context': return { r: 0.65, g: 0.65, b: 0.65 };
        case 'spacer':  return { r: 0.2, g: 0.2, b: 0.2 };
        default:        return { r: 0.65, g: 0.65, b: 0.65 };
    }
}
