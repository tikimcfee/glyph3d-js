/**
 * Surface interaction records — the ONE place that knows, per framed-surface type, how a
 * generic input gesture maps to a command-bus verb. The canvas input layer and the camera's
 * wheel drain consult this table instead of scattering `type === 'terminal'` branches across
 * CommandProvider / CanvasInteraction / VCC.
 *
 * The split this encodes: terminals are ALWAYS a fixed screen (the wheel scrolls their
 * tmux-owned scrollback); code grids are a fixed screen ONLY when framed (a windowed/conveyor
 * view), and a whole-file grid leaves the wheel to the camera. That "framed vs not" verdict is
 * a property of the surface, not a special case the gate should re-derive — so it lives here.
 *
 * A capability that returns null (or a type with no record) means "this surface does not consume
 * the gesture" → the gesture falls through to the camera (the wheel dollies). Camera-framing
 * strategy stays out of this table: it genuinely needs the live CodeGrid object (head-anchored
 * computeGridFocus vs. center focusOnObject), so it remains the camera controller's call.
 */

/**
 * @typedef {Object} SurfaceRecord
 * @property {(entry: Object, dy: number) => (string[]|null)} [wheelScroll] - command (array form,
 *   id may contain spaces) to scroll the surface by a wheel delta, or null if it doesn't scroll.
 * @property {string} moveVerb - the verb that repositions this surface (drag-to-move).
 */

/** @type {Record<string, SurfaceRecord>} */
const RECORDS = {
  terminal: {
    // Fixed screen → the wheel always drives tmux scrollback. wheel up (dy<0) → +lines = back
    // into history; the adapter runs copy-mode and the repaint streams back. ~30px ≈ one line,
    // min one line in the wheel direction.
    wheelScroll(entry, dy) {
      let lines = -Math.round(dy / 30);
      if (lines === 0) lines = dy > 0 ? -1 : 1;
      return ['terminal.scroll', entry.id, String(lines)];
    },
    moveVerb: 'terminal.move',
  },
  grid: {
    // Scrolls only when FRAMED (frameRows>0) — the conveyor. wheel down (dy>0) → +rows = later
    // content. An unframed whole-file grid returns null, leaving the wheel to the camera.
    wheelScroll(entry, dy) {
      const g = entry.grid;
      if (!(g?.getFrameRows?.() > 0)) return null;
      let rows = Math.round(dy / 30);
      if (rows === 0) rows = dy > 0 ? 1 : -1;
      return ['grid.scroll', entry.id, String(rows)];
    },
    moveVerb: 'grid.move',
  },
};

/**
 * The command (array form) to scroll a hovered surface by a wheel delta, or null if the surface
 * under the cursor doesn't consume the wheel (→ the camera dollies).
 * @param {Object|null} entry - a registry entry ({ id, type, grid }) or null
 * @param {number} dy - wheel delta
 * @returns {string[]|null}
 */
export function wheelScrollCommand(entry, dy) {
  const rec = entry ? RECORDS[entry.type] : null;
  return rec?.wheelScroll ? rec.wheelScroll(entry, dy) : null;
}

/**
 * The move verb (drag-to-reposition) for a surface type. Defaults to grid.move for any type
 * without a dedicated record.
 * @param {string} type
 * @returns {string}
 */
export function moveVerbFor(type) {
  return RECORDS[type]?.moveVerb || 'grid.move';
}
