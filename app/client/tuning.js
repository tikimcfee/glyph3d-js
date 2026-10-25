/**
 * tuning — per-INSTANCE values for desks (carrels) and shelf books (agent / delta): which
 * knobs one desk or one book can be given, labelled by what you'll see change, and the
 * one home those values live in.
 *
 * THE MODEL. Settings (▸ Carrel, ▸ gomuxai, ▸ Agent / Delta Books) are the DEFAULTS an
 * instance is born with. A value set on one instance (carrel.set / book.set / book.form)
 * is that instance's own and wins: a Settings change never pushes onto a live instance's
 * own value, and no owner (the gomuxai hub, the agents desk, a book shelf's re-apply)
 * re-stamps one. `default` hands a knob back — a desk to what it was born as
 * (Carrel.born), a book to its shelf's current default.
 *
 * THE HOME. An instance's own values are a durable component of the workspace model —
 * `view.tune` (the Tuning component) on the surface record keyed by the instance's
 * registry id: `carrel:<name>`, `agent:book:<id>`, `delta:book:<id>`. Durable because an
 * operator gesture set it and nothing recomputes it. The session snapshot saves every
 * record (`tunings`) and restore puts them back into the model FIRST — before any desk is
 * built — so a saved desk stands back up wearing them, a DERIVED desk (the gomuxai hub's,
 * rebuilt from the tree every boot and never saved) wears them the moment it's built
 * (buildCarrel), and whatever registers later (a hub book, a desk that raced the restore)
 * is projected on registration (SessionStore's projector → projectTune). Keyed by name,
 * not by the live object: a hub team desk that comes and goes with its agent's helpers
 * keeps its values between appearances; carrel.dissolve forgets a desk's.
 *
 * Commands own the writes (carrel.set, book.set, book.form); the HUD reads these tables
 * and fires those verbs — it owns no behavior.
 */
/** @import { AppContext } from './CommandProvider.jsx' */
/** @import Carrel from '@glyph3d/core/services/interaction/Carrel.js' */

import { pageableBookOf } from './bookFocus.js';

/**
 * @typedef {Object} Knob
 * @property {string} key            the instance's own param name (the verb's key)
 * @property {string} label          what you'll see change — the HUD row and the verb help
 * @property {string} short          a few words, for the compact desk strip (CarrelsPanel)
 * @property {'number'|'enum'} type
 * @property {string[]} [options]    enum values
 * @property {Object<string,string>} [names] enum value → its HUD button text
 * @property {number} [min] @property {number} [max] @property {number} [step]
 * @property {boolean} [hud]         false: verb-only (not a HUD row)
 * @property {boolean} [page]        a book knob that's an agent book's page text (AgentBooks.tuneText), not its deck
 * @property {(o: Object) => boolean} [shows] the row matters for this instance's current shape
 */

const ring = (d) => d.mode === 'ring';
const naturalRing = (d) => d.mode === 'ring' && d.seat === 'natural';
const uniformRing = (d) => d.mode === 'ring' && d.seat !== 'natural';

/** @type {Knob[]} one desk's knobs — Carrel's own params, in HUD order. */
export const DESK_KNOBS = [
  { key: 'mode', type: 'enum', options: ['ring', 'grid'], names: { ring: 'ring ◠', grid: 'wall ▦' },
    short: 'shape', label: 'Shape — a ring around you, or a flat wall' },
  { key: 'seat', type: 'enum', options: ['natural', 'uniform'], names: { natural: 'own size', uniform: 'same size' },
    short: 'seats', label: 'Members — each at its own size, or fitted into same-size seats', shows: ring },
  { key: 'facing', type: 'enum', options: ['in', 'out'], names: { in: 'center', out: 'outward' },
    short: 'facing', label: 'Members face — the center, or outward' },
  { key: 'radius', type: 'number', min: 20, max: 20000, step: 10,
    short: 'radius', label: 'How far the ring (or wall) stands from the desk’s center — a ring of own-size members widens past it to fit' },
  { key: 'ringMaxRows', type: 'number', min: 1, max: 20, step: 1,
    short: 'rows', label: 'Rows the ring stacks before it widens around you', shows: naturalRing },
  { key: 'maxArcDeg', type: 'number', min: 60, max: 360, step: 5,
    short: 'arc°', label: 'How far around you the ring wraps (°) — the rest is the doorway', shows: ring },
  { key: 'gapFrac', type: 'number', min: 0, max: 5, step: 0.05,
    short: 'spacing', label: 'Space between members (× seat height)' },
  { key: 'boxH', type: 'number', min: 20, max: 600, step: 5,
    short: 'seat size', label: 'Seat height — what each member is fitted into', shows: uniformRing },
  { key: 'boxAspect', type: 'number', min: 0.5, max: 3, step: 0.05, hud: false,
    short: 'seat w:h', label: 'Seat shape (width ÷ height)', shows: uniformRing },
  { key: 'growCap', type: 'number', min: 1, max: 4, step: 0.05, hud: false,
    short: 'grow cap', label: 'Most a small member grows to fill its seat (×)', shows: uniformRing },
  { key: 'glowStrength', type: 'number', min: 0, max: 2, step: 0.05,
    short: 'glow', label: 'Floor shadow brightness (0 hides it)' },
  { key: 'tableFrac', type: 'number', min: 1, max: 2, step: 0.05, hud: false,
    short: 'shadow reach', label: 'How far the floor shadow reaches past the members (× radius)' },
  { key: 'shadowSoft', type: 'number', min: 0, max: 1, step: 0.05, hud: false,
    short: 'shadow soft', label: 'Floor shadow edge softness' },
  { key: 'animDur', type: 'number', min: 0, max: 2, step: 0.01, hud: false,
    short: 'slide s', label: 'Seconds a member takes to slide into its seat' },
  { key: 'yawRate', type: 'number', min: 0.5, max: 60, step: 0.5, hud: false,
    short: 'turn rate', label: 'How quickly members turn to face their way' },
];

const agentBook = (b) => b.kind === 'agent';

/** @type {Knob[]} one shelf book's knobs — its deck (Book.DECK_TUNABLE), and an agent
 *  book's page text (`page`: AgentBooks.PAGE_TEXT_TUNABLE — each page's text size and how
 *  its lines break; past the page, text scales down to fit). Its form is book.form (also
 *  its own); an agent book's kept turns are book.limit. */
export const BOOK_KNOBS = [
  { key: 'versoTextSize', type: 'number', min: 0.5, max: 400, step: 0.5, page: true, shows: agentBook,
    short: 'left text', label: 'Left page text size — the headline’s row height (the rest of the call and its numbers keep their share); too big for the page, it scales down to fit' },
  { key: 'versoBreak', type: 'enum', options: ['wrap', 'natural'], names: { wrap: 'wrap to page', natural: 'own lines' }, page: true, shows: agentBook,
    short: 'left lines', label: 'Left page lines — wrap to the page, or keep the text’s own lines (a long line shrinks to fit, left to right)' },
  { key: 'rectoTextSize', type: 'number', min: 0.5, max: 400, step: 0.5, page: true, shows: agentBook,
    short: 'right text', label: 'Right page text size — prose’s row height (files and command output keep their share); too big for the page, it scales down to fit' },
  { key: 'rectoBreak', type: 'enum', options: ['wrap', 'natural'], names: { wrap: 'wrap to page', natural: 'own lines' }, page: true, shows: agentBook,
    short: 'right lines', label: 'Right page lines — wrap to the page, or keep the text’s own lines (a long line shrinks to fit, left to right)' },
  { key: 'zPitch', type: 'number', min: 1, max: 4000, step: 5,
    short: 'spacing', label: 'How far apart the pages ahead stand' },
  { key: 'turned', type: 'number', min: 0.01, max: 1, step: 0.01,
    short: 'pressed', label: 'How tightly the pages you’ve read press together at the back (× spacing)' },
  { key: 'slide', type: 'number', min: 0, max: 20, step: 0.25,
    short: 'slide', label: 'How far the pages slide on a turn (pages; 0 = they cut)' },
  { key: 'lerp', type: 'number', min: 0, max: 60, step: 0.5,
    short: 'glide', label: 'How fast pages glide into place' },
];

const DESK_BY_KEY = new Map(DESK_KNOBS.map((k) => [k.key, k]));
const BOOK_BY_KEY = new Map(BOOK_KNOBS.map((k) => [k.key, k]));

/** Coerce a raw (typed / stored) value for a knob — null when it isn't one. */
function coerce(knob, raw) {
  if (knob.type === 'enum') return knob.options.includes(String(raw)) ? String(raw) : null;
  const n = typeof raw === 'number' ? raw : parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

// ── the record ────────────────────────────────────────────────────────────────

/**
 * An instance's own values (a copy; {} when it has none).
 * @param {AppContext} ctx @param {string} id registry id
 */
export function tuneOf(ctx, id) {
  return { ...(ctx.workspace?.getSurface?.(id)?.view?.tune || {}) };
}

/** Write one key of an instance's record (null drops it; an empty record is dropped whole). */
function writeTune(ctx, id, key, value) {
  const ws = ctx.workspace;
  if (!ws?.setSurfaceView) return;
  const next = tuneOf(ctx, id);
  if (value == null) delete next[key]; else next[key] = value;
  if (!ws.getSurface(id) && !Object.keys(next).length) return;
  ws.setSurfaceView(id, undefined, { tune: Object.keys(next).length ? next : null });
}

/**
 * Forget an instance's own values (the desk was dissolved).
 * @param {AppContext} ctx @param {string} id
 */
export function forgetTune(ctx, id) {
  if (ctx.workspace?.getSurface?.(id)?.view?.tune) ctx.workspace.setSurfaceView(id, undefined, { tune: null });
}

/**
 * Every instance with values of its own — what the session snapshot saves.
 * @param {AppContext} ctx @returns {Array<{id:string, tune:Object}>}
 */
export function listTunings(ctx) {
  return (ctx.workspace?.listSurfaces?.() || [])
    .filter((s) => s.view?.tune && Object.keys(s.view.tune).length)
    .map((s) => ({ id: s.id, tune: { ...s.view.tune } }));
}

// ── desks ─────────────────────────────────────────────────────────────────────

/** Set one knob on a desk, live. @returns {boolean} whether the desk changed */
function setDeskKnob(desk, key, v) {
  if (key === 'mode') return desk.mode !== v && desk.setMode(v);
  if (key === 'seat') return desk.setSeat(v);
  if (key === 'facing') return desk.facing !== v && desk.setFacing(v);
  return desk[key] !== v && desk.setParam(key, v);
}

/** Lay a record over a desk — keys it doesn't know are skipped. @returns {boolean} changed */
export function applyDeskTune(desk, tune) {
  let changed = false;
  for (const [key, raw] of Object.entries(tune || {})) {
    const knob = DESK_BY_KEY.get(key);
    const v = knob ? coerce(knob, raw) : null;
    if (v != null && setDeskKnob(desk, key, v)) changed = true;
  }
  return changed;
}

/**
 * Give one desk its own value for a knob — live, and into its record. `'default'` hands
 * the knob back to what the desk was born as.
 * @param {AppContext} ctx @param {Carrel} desk @param {string} key @param {string|number} raw
 * @returns {{ok:true, key:string, value:any, own:boolean}|{ok:false, error:string}}
 */
export function tuneDesk(ctx, desk, key, raw) {
  const knob = DESK_BY_KEY.get(key);
  if (!knob) return { ok: false, error: `no desk knob '${key}' (knobs: ${DESK_KNOBS.map((k) => k.key).join('|')})` };
  if (raw === 'default') {
    setDeskKnob(desk, key, desk.born[key]);
    writeTune(ctx, desk.name, key, null);
    return { ok: true, key, value: desk[key], own: false };
  }
  const v = coerce(knob, raw);
  if (v == null) return { ok: false, error: knob.type === 'enum' ? `${key} is one of ${knob.options.join('|')}` : `${key} wants a number` };
  setDeskKnob(desk, key, v);
  writeTune(ctx, desk.name, key, v);
  return { ok: true, key, value: desk[key], own: true };
}

/**
 * A desk's knobs as a reading: the live value, what it was born as, and which are its own.
 * @param {AppContext} ctx @param {Carrel} desk
 */
export function readDesk(ctx, desk) {
  const own = tuneOf(ctx, desk.name);
  const values = {};
  for (const k of DESK_KNOBS) values[k.key] = desk[k.key];
  return { name: desk.carrelName, values, born: { ...desk.born }, own };
}

/**
 * The desk an object sits at — the nearest desk up its scene graph (a seated book, a card
 * on a seated book's page, a team desk inside the hub), found by lookup in ctx.carrels.
 * @param {AppContext} ctx @param {Object|null|undefined} obj @returns {Carrel|null}
 */
export function deskOf(ctx, obj) {
  const map = ctx.carrels;
  if (!(map instanceof Map)) return null;
  for (let n = obj; n; n = n.parent) {
    if (n.carrelName != null && map.get(n.carrelName) === n && !n._dissolving) return n;
  }
  return null;
}

/**
 * The desk behind an attention slot's entity: the desk itself, or the one it's seated at.
 * @param {AppContext} ctx @param {'primary'|'hover'} slot @returns {Carrel|null}
 */
export function deskInSlot(ctx, slot) {
  const id = ctx.attentionManager?.get?.(slot)?.id;
  if (!id) return null;
  return deskOf(ctx, ctx.registry?.get?.(id)?.grid);
}

// ── books ─────────────────────────────────────────────────────────────────────

/**
 * The record id of a shelf book hit (bookFocus's BookHit): its registry group id. A library
 * volume has none — it's rebuilt every layout pass; its form lives on its directory.
 * @param {{kind:string, books?:Object, agentId?:string, deltas?:Object, setId?:string}} hit
 * @returns {string|null}
 */
export function bookTuneId(hit) {
  if (hit?.kind === 'agent') return hit.books.lanes.get(hit.agentId)?.groupId ?? null;
  if (hit?.kind === 'delta') return hit.deltas.sets.get(hit.setId)?.groupId ?? null;
  return null;
}

/** Lay a record over a shelf book (a BookHit) — keys it doesn't know are skipped, as is a
 *  page-text key on a book that isn't an agent's. @returns {boolean} changed */
export function applyBookTune(hit, tune) {
  const book = hit.book;
  let changed = false;
  for (const [key, raw] of Object.entries(tune || {})) {
    if (key === 'form') {
      const f = raw === 'splay' ? 'splay' : 'deck';
      if (book.form !== f) { book.setForm(f); changed = true; }
      continue;
    }
    const knob = BOOK_BY_KEY.get(key);
    const v = knob ? coerce(knob, raw) : null;
    if (v == null) continue;
    if (knob.page) {
      if (hit.kind !== 'agent') continue;
      const text = hit.books.textOf(hit.agentId);
      if (text && text.own[key] !== v && hit.books.tuneText(hit.agentId, key, v)) changed = true;
      continue;
    }
    if ((book.deck[key] !== v || !(key in book.deckOwn)) && book.tuneDeck(key, v)) changed = true;
  }
  return changed;
}

/** A book knob's live value on a shelf book (undefined: a page knob on a delta book). */
function bookValue(hit, knob) {
  if (!knob.page) return hit.book.deck[knob.key];
  return hit.kind === 'agent' ? hit.books.textOf(hit.agentId)?.values[knob.key] : undefined;
}

/**
 * Give one shelf book its own value for a knob — BOOK_KNOBS, or `form` (deck|splay) — live
 * and into its record. `'default'` hands it back to its shelf's default.
 * @param {AppContext} ctx @param {Object} hit a shelf BookHit @param {string} key @param {string|number} raw
 * @returns {{ok:true, key:string, value:any, own:boolean}|{ok:false, error:string}}
 */
export function tuneBook(ctx, hit, key, raw) {
  const id = bookTuneId(hit);
  if (!id) return { ok: false, error: 'a library volume takes its deck from Settings ▸ Layout (its form is book.form)' };
  const book = hit.book;
  if (key === 'form') {
    const f = raw === 'default' ? 'deck' : String(raw);
    if (f !== 'deck' && f !== 'splay') return { ok: false, error: 'form is deck|splay' };
    book.setForm(f);
    writeTune(ctx, id, 'form', raw === 'default' ? null : f);
    return { ok: true, key, value: f, own: raw !== 'default' };
  }
  const knob = BOOK_BY_KEY.get(key);
  if (!knob) return { ok: false, error: `no book knob '${key}' (knobs: ${BOOK_KNOBS.map((k) => k.key).join('|')})` };
  if (knob.page && hit.kind !== 'agent') return { ok: false, error: `${key} is an agent book's page text — a delta book's pages fit their files` };
  const set = (v) => (knob.page ? hit.books.tuneText(hit.agentId, key, v) : book.tuneDeck(key, v));
  if (raw === 'default') {
    set(null);
    writeTune(ctx, id, key, null);
    return { ok: true, key, value: bookValue(hit, knob), own: false };
  }
  const v = coerce(knob, raw);
  if (v == null || (knob.page && knob.type === 'number' && !(v > 0))) {
    return { ok: false, error: knob.type === 'enum' ? `${key} is one of ${knob.options.join('|')}` : `${key} wants a${knob.page ? ' positive' : ''} number` };
  }
  set(v);
  writeTune(ctx, id, key, v);
  return { ok: true, key, value: bookValue(hit, knob), own: true };
}

/**
 * A shelf book's knobs as a reading: its kind, live values (the knobs its kind has),
 * form, and which are its own.
 * @param {AppContext} ctx @param {Object} hit
 */
export function readBook(ctx, hit) {
  const id = bookTuneId(hit);
  const values = {};
  for (const k of BOOK_KNOBS) if (!k.shows || k.shows(hit)) values[k.key] = bookValue(hit, k);
  return { id, kind: hit.kind, form: hit.book.form, values, own: id ? tuneOf(ctx, id) : {} };
}

// ── projection ────────────────────────────────────────────────────────────────

/**
 * Lay an instance's record over its live object, if it's live — a desk, or a shelf book.
 * Idempotent (an already-true value is left alone), so it can run on every registry change.
 * @param {AppContext} ctx @param {string} id @param {Object} tune
 * @returns {boolean} changed
 */
export function projectTune(ctx, id, tune) {
  const obj = ctx.registry?.get?.(id)?.grid;
  if (!obj || !tune) return false;
  const desk = deskOf(ctx, obj);
  if (desk === obj) {
    const changed = applyDeskTune(desk, tune);
    if (changed && desk.worldManaged) ctx.world?.relayout();
    return changed;
  }
  const hit = pageableBookOf(ctx, obj);
  return hit && hit.book === obj && bookTuneId(hit) === id ? applyBookTune(hit, tune) : false;
}
