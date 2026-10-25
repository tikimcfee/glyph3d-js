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
 *     into the deck (older for a recency deck, the next page for a volume). Paging is
 *     NOTCHED: the paging gate (CommandProvider.tryPageHovered) runs the wheel's travel
 *     through a detent (wheelDetent.js) and hands a record whole notches — the record
 *     turns exactly that many sheets, never one per frame that carried any delta.
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
 * @property {(entry: Object, notches: number) => (string[]|null)} [wheelPage] - command to turn
 *   the book this surface belongs to by `notches` whole wheel notches (signed: + = wheel-down),
 *   or null if it doesn't page.
 * @property {string} [moveVerb] - the verb that repositions this surface (drag-to-move);
 *   absent = the surface doesn't drag.
 * @property {(entry: Object) => boolean} [pinnedInPlace] - true when THIS instance is laid out
 *   by something else (a page riding a book) and so doesn't drag even though its kind does.
 */

/** The library volume a grid rides as a page, or null — any page of a book IS the book. */
function volumeOf(grid) {
  for (let n = grid; n; n = n.parent) if (n.userData?.isVolume && n.userData.path !== undefined) return n;
  return null;
}

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
    wheelPage(entry, notches) {
      const vol = volumeOf(entry.grid);
      return vol ? ['book.scroll', vol.userData.path, String(notches)] : null;
    },
    moveVerb: 'grid.move',
    // A page of a library volume is laid out by its book — dragging it out tore it from
    // the deck and stretched the directory's bounds to wherever it landed.
    pinnedInPlace: (entry) => !!volumeOf(entry.grid),
  },
  card: {
    // Any page of a book IS the book: SHIFT+wheel turns it from wherever you're
    // reading — no aiming at the cover's margins. A plain wheel stays the camera's
    // (movement and paging are separate gestures). The card's meta names its lane.
    wheelPage(entry, notches) {
      const id = entry.meta?.agentId;
      return id ? ['book.scroll', id, String(-notches)] : null;
    },
  },
  volume: {
    // A library volume's COVER is the directory's book: SHIFT+wheel anywhere on it
    // turns the pages — one notch, one file, down dives deeper into the deck — the
    // same paging grammar as an agent book's cover. Plain wheel stays the camera's.
    wheelPage(entry, notches) {
      const p = entry.meta?.path;
      return p !== undefined ? ['book.scroll', p, String(notches)] : null;
    },
  },
  agent: {
    // An agent book. SHIFT+wheel over the cover TURNS THE PAGES — down = older
    // (deeper into the run), up = newer; landing on the newest resumes live-follow.
    // One notch = one sheet: a page turn is a discrete act, not a glide.
    wheelPage(entry, notches) {
      return ['book.scroll', entry.id, String(-notches)];
    },
    // Drag the cover to reposition the whole deck. Ephemeral observation state, so the
    // move verb pins it in-place (no workspace persistence).
    moveVerb: 'book.move',
  },
  delta: {
    // A delta set's cover — same recency grammar as an agent book: down = earlier
    // files, up = fresher; landing on the newest resumes follow-the-change.
    // The book address is the DELTA form (a watch set's id is also an agent id —
    // the bare id would page the agent's run book instead).
    wheelPage(entry, notches) {
      const id = entry.meta?.deltaId;
      return id ? ['book.scroll', `delta:${id}`, String(-notches)] : null;
    },
    moveVerb: 'book.move',
  },
  search: {
    // The search book's cover — drag it to stand the results somewhere else (paging rides
    // its cards' records).
    moveVerb: 'book.move',
  },
  'delta-page': {
    // Any page of a delta book IS the book — SHIFT+wheel over a base/head grid turns
    // the file sheets from wherever you're reading.
    wheelPage(entry, notches) {
      const id = entry.meta?.deltaId;
      return id ? ['book.scroll', `delta:${id}`, String(-notches)] : null;
    },
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
 * @param {number} notches - whole wheel notches, signed (+ = wheel-down) — the paging
 *   gate's detent output, never a raw delta
 * @returns {string[]|null}
 */
export function wheelPageCommand(entry, notches) {
  const rec = entry ? RECORDS[entry.role || entry.type] : null;
  return rec?.wheelPage ? rec.wheelPage(entry, notches) : null;
}

/**
 * The move verb (drag-to-reposition) for a surface. A kind (registry role || type) with a record
 * but no moveVerb (an agent book's cards, a library volume) doesn't drag, nor does an instance its
 * record pins in place (a library volume's page): null. A kind with no record (a frame) moves as
 * a grid.
 * @param {Object} entry - a registry entry ({ id, type, role, grid })
 * @returns {string|null}
 */
export function moveVerbFor(entry) {
  const rec = RECORDS[entry.role || entry.type];
  if (!rec) return 'grid.move';
  if (rec.pinnedInPlace?.(entry)) return null;
  return rec.moveVerb ?? null;
}
