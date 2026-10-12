/**
 * GridEditor — pure string editing operations and caret mesh helpers for 3D text grids.
 */

import * as THREE from 'three';

export const CARET_COLOR = Object.freeze({ r: 1.0, g: 0.85, b: 0.2 });
export const CARET_RENDER_ORDER = 5;

/**
 * Codepoint index → UTF-16 offset within `str`.
 * Protects against splitting surrogate-pair emoji or unicode graphemes.
 * @param {string} str
 * @param {number} cp
 * @returns {number}
 */
export function cpToU16(str, cp) {
    let u = 0;
    for (let n = 0; n < cp && u < str.length; n++) {
        u += str.codePointAt(u) > 0xFFFF ? 2 : 1;
    }
    return u;
}

/**
 * Count of codepoints in `str` (not UTF-16 code units).
 * @param {string} str
 * @returns {number}
 */
export function cpLen(str) {
    let n = 0;
    for (let u = 0; u < str.length; n++) {
        u += str.codePointAt(u) > 0xFFFF ? 2 : 1;
    }
    return n;
}

/**
 * Clamp cursor {line, col} to valid line and codepoint boundaries.
 * @param {string[]} lines
 * @param {number} line
 * @param {number} col
 * @returns {{line: number, col: number}}
 */
export function clampCursor(lines, line, col) {
    const ln = Math.max(0, Math.min(line, lines.length - 1));
    const cl = Math.max(0, Math.min(col, cpLen(lines[ln] ?? '')));
    return { line: ln, col: cl };
}

/**
 * Insert a string at the cursor. Splits on `\n` to span multiple lines.
 * Mutates `lines` in place and returns the new cursor position.
 * @param {string[]} lines
 * @param {{line: number, col: number}} cursor
 * @param {string} str
 * @returns {{line: number, col: number}}
 */
export function insertText(lines, cursor, str) {
    if (!cursor || !str) return cursor;
    const parts = String(str).split('\n');
    const { line, col } = cursor;
    const cur = lines[line] ?? '';
    const u = cpToU16(cur, col);
    const before = cur.slice(0, u);
    const after = cur.slice(u);

    if (parts.length === 1) {
        lines[line] = before + parts[0] + after;
        cursor.col = col + cpLen(parts[0]);
    } else {
        const tail = parts[parts.length - 1];
        const newLines = [
            before + parts[0],
            ...parts.slice(1, -1),
            tail + after,
        ];
        lines.splice(line, 1, ...newLines);
        cursor.line = line + parts.length - 1;
        cursor.col = cpLen(tail);
    }
    return cursor;
}

/**
 * Backspace: delete char before cursor; if at col 0, join with previous line.
 * Mutates `lines` in place and returns the new cursor position.
 * @param {string[]} lines
 * @param {{line: number, col: number}} cursor
 * @returns {{line: number, col: number}}
 */
export function deleteBackward(lines, cursor) {
    if (!cursor) return cursor;
    const { line, col } = cursor;
    if (col > 0) {
        const cur = lines[line] ?? '';
        lines[line] = cur.slice(0, cpToU16(cur, col - 1)) + cur.slice(cpToU16(cur, col));
        cursor.col = col - 1;
    } else if (line > 0) {
        const prev = lines[line - 1] ?? '';
        const cur = lines[line] ?? '';
        cursor.line = line - 1;
        cursor.col = cpLen(prev);
        lines[line - 1] = prev + cur;
        lines.splice(line, 1);
    }
    return cursor;
}

/**
 * Delete: delete char at cursor; if at end of line, join next line in.
 * Mutates `lines` in place and returns the new cursor position.
 * @param {string[]} lines
 * @param {{line: number, col: number}} cursor
 * @returns {{line: number, col: number}}
 */
export function deleteForward(lines, cursor) {
    if (!cursor) return cursor;
    const { line, col } = cursor;
    const cur = lines[line] ?? '';
    if (col < cpLen(cur)) {
        lines[line] = cur.slice(0, cpToU16(cur, col)) + cur.slice(cpToU16(cur, col + 1));
    } else if (line < lines.length - 1) {
        lines[line] = cur + (lines[line + 1] ?? '');
        lines.splice(line + 1, 1);
    }
    return cursor;
}

/**
 * Enter: split current line at cursor; cursor moves to start of new line.
 * Mutates `lines` in place and returns the new cursor position.
 * @param {string[]} lines
 * @param {{line: number, col: number}} cursor
 * @returns {{line: number, col: number}}
 */
export function splitLine(lines, cursor) {
    if (!cursor) return cursor;
    const { line, col } = cursor;
    const cur = lines[line] ?? '';
    const u = cpToU16(cur, col);
    lines.splice(line, 1, cur.slice(0, u), cur.slice(u));
    cursor.line = line + 1;
    cursor.col = 0;
    return cursor;
}

/**
 * Move cursor by relative offsets, wrapping lines naturally.
 * @param {string[]} lines
 * @param {{line: number, col: number}} cursor
 * @param {number} dx
 * @param {number} dy
 * @returns {{line: number, col: number}}
 */
export function moveCursor(lines, cursor, dx, dy) {
    if (!cursor) return cursor;
    let { line, col } = cursor;
    const lineCount = lines.length;

    if (dy) {
        line = Math.max(0, Math.min(line + dy, lineCount - 1));
        col = Math.min(col, cpLen(lines[line] ?? ''));
    }

    while (dx > 0) {
        const len = cpLen(lines[line] ?? '');
        if (col < len) { col++; dx--; continue; }
        if (line < lineCount - 1) { line++; col = 0; dx--; continue; }
        break;
    }
    while (dx < 0) {
        if (col > 0) { col--; dx++; continue; }
        if (line > 0) { line--; col = cpLen(lines[line] ?? ''); dx++; continue; }
        break;
    }

    return clampCursor(lines, line, col);
}

/**
 * Create a caret plane mesh for 3D cursor rendering.
 * @param {Object} [options]
 * @returns {THREE.Mesh}
 */
export function createCaretMesh(options = {}) {
    const c = options.color || CARET_COLOR;
    const geo = new THREE.PlaneGeometry(1, 1);
    const mat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(c.r, c.g, c.b),
        transparent: true,
        opacity: options.opacity ?? 0.85,
        side: THREE.DoubleSide,
        forceSinglePass: true,   // a flat quad — see glyphMaterial
        depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = options.renderOrder ?? CARET_RENDER_ORDER;
    mesh.frustumCulled = false;
    return mesh;
}

/**
 * Position and scale the caret mesh to match a world/grid-local cursor position.
 * @param {THREE.Mesh|null} caretMesh
 * @param {{x: number, y: number, z?: number}|null} pos
 * @param {{charWidth: number, lineSpacing: number}|null} metrics
 * @returns {boolean} whether caret was positioned and made visible
 */
export function positionCaretMesh(caretMesh, pos, metrics) {
    if (!caretMesh || !pos || !metrics) {
        if (caretMesh) caretMesh.visible = false;
        return false;
    }
    const barWidth = Math.max(metrics.charWidth * 0.1, 0.5);
    const barHeight = metrics.lineSpacing;

    caretMesh.scale.set(barWidth, barHeight, 1);
    caretMesh.position.set(pos.x + barWidth / 2, pos.y, (pos.z ?? 0) + 0.05);
    caretMesh.visible = true;
    return true;
}
