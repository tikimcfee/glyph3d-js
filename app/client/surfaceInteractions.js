/**
 * Surface interaction records — the ONE place that knows, per framed-surface type, how a
 * generic input gesture maps to a command-bus verb. The canvas input layer and the camera's
 * wheel drain consult this table instead of scattering `type === 'terminal'` branches across
 * CommandProvider / CanvasInteraction / VCC.
 *
 * TWO wheel gestures, one grammar each:
 *   plain wheel  (wheelScroll) — MOVEMENT: terminal scrollback, a framed grid's conveyor;
 *     everything else falls through to the camera dolly.
 *   shift+wheel  (wheelPage)   — PAGING: turns the BOOK under the cursor — an agent book
 *     (cover or card) or a library volume (cover or any page) — wheel-down dives deeper
 *     into the deck (older for a recency deck, the next page for a volume).
 * The "framed vs not" verdict is a property of the surface, not a special case the gates
 * should re-derive — so it lives here.
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
    // content. An unframed whole-file grid returns null, leaving the plain wheel to the camera.
    wheelScroll(entry, dy) {
      const g = entry.grid;
      if (!(g?.getFrameRows?.() > 0)) return null;
      let rows = Math.round(dy / 30);
      if (rows === 0) rows = dy > 0 ? 1 : -1;
      return ['grid.scroll', entry.id, String(rows)];
    },
    // Any page of a book IS the book: SHIFT+wheel over a grid riding a library VOLUME
    // turns the directory — one notch, one file, down dives deeper into the deck —
    // the same paging grammar as an agent book's cards. Plain wheel stays movement.
    wheelPage(entry, dy) {
      for (let n = entry.grid; n; n = n.parent) {
        if (n.userData?.isVolume && n.userData.path !== undefined) {
          return ['book.scroll', n.userData.path, String(dy > 0 ? 1 : -1)];
        }
      }
      return null;
    },
    moveVerb: 'grid.move',
  },
  card: {
    // Any page of a book IS the book: SHIFT+wheel turns it from wherever you're
    // reading — no aiming at the cover's margins. A plain wheel stays the camera's
    // (movement and paging are separate gestures). The card's meta names its lane.
    wheelPage(entry, dy) {
      const id = entry.meta?.agentId;
      return id ? ['book.scroll', id, String(dy > 0 ? -1 : 1)] : null;
    },
  },
  volume: {
    // A library volume's COVER is the directory's book: SHIFT+wheel anywhere on it
    // turns the pages — one notch, one file, down dives deeper into the deck — the
    // same paging grammar as an agent book's cover. Plain wheel stays the camera's.
    wheelPage(entry, dy) {
      const p = entry.meta?.path;
      return p !== undefined ? ['book.scroll', p, String(dy > 0 ? 1 : -1)] : null;
    },
  },
  agent: {
    // An agent book. SHIFT+wheel over the cover TURNS THE PAGES — down = older
    // (deeper into the run), up = newer; landing on the newest resumes live-follow.
    // One notch = one sheet: a page turn is a discrete act, not a glide.
    wheelPage(entry, dy) {
      return ['book.scroll', entry.id, String(dy > 0 ? -1 : 1)];
    },
    // Drag the cover to reposition the whole deck. Ephemeral observation state, so the
    // move verb pins it in-place (no workspace persistence).
    moveVerb: 'book.move',
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
  const rec = entry ? RECORDS[entry.role || entry.type] : null;
  return rec?.wheelScroll ? rec.wheelScroll(entry, dy) : null;
}

/**
 * The command (array form) for a PAGING wheel (shift+scroll) over a surface, or null if the
 * surface under the cursor doesn't page. Distinct from wheelScrollCommand — movement scroll
 * and page-turn scroll are separate gestures (the modifier is the split).
 * @param {Object|null} entry - a registry entry ({ id, type, grid, meta }) or null
 * @param {number} dy - wheel delta (shift+wheel arrives as deltaX on most platforms;
 *   the camera controller normalizes before it reaches here)
 * @returns {string[]|null}
 */
export function wheelPageCommand(entry, dy) {
  const rec = entry ? RECORDS[entry.role || entry.type] : null;
  return rec?.wheelPage ? rec.wheelPage(entry, dy) : null;
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
