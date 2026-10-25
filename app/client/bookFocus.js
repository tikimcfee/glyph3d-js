/**
 * bookFocus — which BOOK is the user looking at? The bare book verbs (book.page /
 * book.scroll / book.form with no id), the book keys, and the HUD's book row all ask
 * this one question, so it has one answer.
 *
 * An attention slot names an entity; the book is found by LOOKUP, never id surgery:
 * start from the slot's registry object (a card, a cover, a page's grid) — or, when
 * that object is docked away from its home, the durable file book the content tree
 * keeps for its id — and walk UP the scene graph to the nearest book an owner claims:
 *   - a library VOLUME (userData.isVolume)            → { kind: 'volume', book }
 *   - an agent lane's book (AgentBooks.resolveLane)    → { kind: 'agent', books, agentId, book }
 *   - a delta set's book (DeltaBooks.resolveSet)       → { kind: 'delta', deltas, setId, book }
 * A plain one-sheet file book is not a pageable book of its own — the walk passes it
 * and keeps climbing (a file riding a volume pages the volume).
 */
/** @import { AppContext } from './CommandProvider.jsx' */

/**
 * @typedef {{ kind: 'volume', book: Object }
 *         | { kind: 'agent', books: Object, agentId: string, book: Object }
 *         | { kind: 'delta', deltas: Object, setId: string, book: Object }} BookHit
 */

/**
 * The pageable book an object rides (itself included), or null.
 * @param {AppContext} ctx @param {Object|null|undefined} obj @returns {BookHit|null}
 */
export function pageableBookOf(ctx, obj) {
  for (let n = obj; n; n = n.parent) {
    const ud = n.userData;
    if (!ud?.isBook) continue;
    if (ud.isVolume) return { kind: 'volume', book: n };
    const lane = ctx.agentBooks?.resolveLane?.(n);
    if (lane) return { kind: 'agent', books: ctx.agentBooks, agentId: lane[0], book: n };
    const set = ctx.deltaBooks?.resolveSet?.(n);
    if (set) return { kind: 'delta', deltas: ctx.deltaBooks, setId: set[0], book: n };
  }
  return null;
}

/**
 * The book behind one attention slot's entity, or null.
 * @param {AppContext} ctx @param {'primary'|'hover'} slot @returns {BookHit|null}
 */
export function bookInSlot(ctx, slot) {
  const id = ctx.attentionManager?.get?.(slot)?.id;
  if (!id) return null;
  return pageableBookOf(ctx, ctx.registry?.get?.(id)?.grid)
      ?? pageableBookOf(ctx, ctx.contentTree?.bookAt?.(id));
}

/**
 * The book in FOCUS: the focused entity's (attention primary — what you clicked), else
 * the hovered one's (what you're pointing at), else null.
 * @param {AppContext} ctx @returns {BookHit|null}
 */
export function bookInFocus(ctx) {
  return bookInSlot(ctx, 'primary') ?? bookInSlot(ctx, 'hover');
}
