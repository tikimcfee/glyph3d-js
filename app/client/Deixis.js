/**
 * Deixis — "this" and "that" on the bus (docs/planes/DESIGN.md §3.8, the LITE part).
 *
 * A REF names what someone pointed at, in the words a prompt needs:
 *
 *   { kind: 'code' | 'terminal', entity, durable, quote, origin: {who, ts}, text }
 *     code      durable {path, line, col}            text  `app/x.js:42 «rec.meta?.patch»`
 *     terminal  durable {terminal, line, col}        text  `gx-relay line 1204 «$ go test ./...»`
 *
 * `line` is 1-based for code (what an editor and parseFileRef say) and the terminal's RUNNING
 * number for a terminal (TerminalGrid.lineOfSlot: it keeps its number as it scrolls into the
 * depth history, where a screen row would not). `entity` is the registry id the ref lives on;
 * `path` is that file shown relative to the served root.
 *
 * The person points: `deixis.here` resolves the glyph under the cursor (the hover pick's glyph slot) or
 * the focused caret into a Ref, and `point.mark` puts `this = <text>` into the CommandBar
 * (`onDraft`), so the next line they send carries it. Agents point back: `point.show` from an
 * IDENTIFIED caller (`glyph3d-cli --as`) fills the line in the caller's hue — the existing
 * highlight fill on a code line, a row mark on a terminal — and moves nothing of the person's: no
 * camera, focus, keyboard or projection. One live point per agent. Every point.* is a `[deixis]`
 * record in the relay log store.
 *
 * A point FOLLOWS its words (the FULL part): when its file's text changes (CodeGrid's text
 * listener — an agent's edit landing, the person typing) it finds its line again — the same line
 * text, else its quote near, else anywhere; gone, it is an orphan, listed but unfilled — and a
 * `suggest` point with proposed text (`--with`) is RESOLVED when an edit puts that text where it
 * pointed. While the person types, agents' points are HELD and drawn once they stop for
 * `point.breakpointIdleMs` (keyboardRouter tells noteKey of every key).
 *
 * ONE resolver turns any spelling back into a Ref (resolveRef): a Ref's JSON, its one-line text,
 * or any `file:line[:col]` a log or a stack trace prints (parseFileRef → the registry → the tour
 * resolver's suffix/basename match).
 */

import TourResolver from '@glyph3d/core/services/tour/TourResolver.js';
import { parseFileRef } from '@glyph3d/core/parsing/parseFileRef.js';
import { canonicalPath } from '../commands/handlers/pathResolve.js';
import { getSetting } from './settings.js';

/** @typedef {{path:string, line:number, col:number}} CodeSpot */
/** @typedef {{terminal:string, line:number, col:number}} TerminalSpot */
/**
 * @typedef {Object} Ref
 * @property {'code'|'terminal'} kind
 * @property {string} entity      registry id
 * @property {CodeSpot|TerminalSpot} durable
 * @property {string} quote       the text pointed at (a token on a code line, a terminal's line)
 * @property {{who:string|null, ts:number}} origin   who pointed (null = the person at the display)
 * @property {string} text        the one-line form
 */

const TERMINAL_TEXT = /^(\S+)\s+line\s+(\d+)(?::(\d+))?(?:\s+«([\s\S]*)»)?\s*$/;
const QUOTED = /«([\s\S]*)»\s*$/;

// ============ Building refs ============

/** A file's registry id shown relative to the served root (absolute when outside it). */
export function shortPath(ctx, id) {
    const root = ctx?.fileProvider?.rootInfo?.root;
    return root && id.startsWith(root + '/') ? id.slice(root.length + 1) : id;
}

/** The token at a column: the run of non-blank characters containing it (else the line, trimmed). */
export function tokenAt(lineText, col0) {
    const cps = [...(lineText ?? '')];
    if (!cps.length) return '';
    const c = Math.min(Math.max(col0, 0), cps.length - 1);
    if (/\s/.test(cps[c])) return cps.join('').trim();
    let a = c, b = c + 1;
    while (a > 0 && !/\s/.test(cps[a - 1])) a--;
    while (b < cps.length && !/\s/.test(cps[b])) b++;
    return cps.slice(a, b).join('');
}

/** The one-line form of a ref. @param {Omit<Ref,'text'>} r @returns {string} */
export function refText(r) {
    const q = r.quote ? ` «${r.quote}»` : '';
    if (r.kind === 'code') {
        const d = /** @type {CodeSpot} */ (r.durable);
        return `${d.path}:${d.line}${q}`;
    }
    const d = /** @type {TerminalSpot} */ (r.durable);
    return `${d.terminal} line ${d.line}${q}`;
}

function makeRef(kind, entity, durable, quote, who) {
    const r = { kind, entity, durable, quote, origin: { who: who ?? null, ts: Date.now() } };
    return /** @type {Ref} */ ({ ...r, text: refText(r) });
}

/**
 * A code ref: line/col 0-based in, 1-based in the ref. The quote is the token at the column.
 * @param {Object} ctx @param {string} id  registry id @param {Object} grid  a CodeGrid
 * @param {number} line0 @param {number} col0 @param {string|null} [who]
 * @returns {Ref|{error:string}}
 */
export function codeRef(ctx, id, grid, line0, col0, who = null) {
    const text = grid?.lines?.[line0];
    if (text == null) return { error: `'${id}' has no line ${line0 + 1}` };
    return makeRef('code', id, { path: shortPath(ctx, id), line: line0 + 1, col: col0 + 1 }, tokenAt(text, col0), who);
}

/**
 * A terminal ref by running line number. The quote is the line's text.
 * @param {string} id @param {Object} grid  a TerminalGrid @param {number} line @param {number} col0
 * @param {string|null} [who]
 * @returns {Ref|{error:string}}
 */
export function terminalRef(id, grid, line, col0, who = null) {
    const text = grid?.lineText?.(line);
    if (text == null) return { error: `'${id}' no longer draws line ${line} (scrolled past its depth history)` };
    return makeRef('terminal', id, { terminal: id, line, col: col0 + 1 }, text.trim(), who);
}

/**
 * The ref for a glyph slot on a registered surface — what a glyph pick names.
 * @param {Object} ctx @param {{id:string, grid:Object}} entry @param {number} slot  the grid-local
 *   slot (CanvasInteraction.resolveGlyphHitFor) @param {string|null} [who]
 * @returns {Ref|{error:string}}
 */
export function refAtSlot(ctx, entry, slot, who = null) {
    const g = entry?.grid;
    if (typeof g?.lineOfSlot === 'function') {
        const at = g.lineOfSlot(slot);
        return at ? terminalRef(entry.id, g, at.line, at.col, who) : { error: `slot ${slot} is past what '${entry.id}' draws` };
    }
    if (typeof g?.getCharForSlot === 'function') {
        const at = g.getCharForSlot(slot);
        return at ? codeRef(ctx, entry.id, g, at.line, at.col, who) : { error: `slot ${slot} is not a character of '${entry.id}'` };
    }
    return { error: `'${entry?.id}' is not text (no glyph lines to point at)` };
}

/**
 * The ref for a surface's own focus point: a code grid's caret, a terminal's cursor line.
 * @param {Object} ctx @param {{id:string, grid:Object}} entry @param {string|null} [who]
 * @returns {Ref|{error:string}}
 */
export function refAtCaret(ctx, entry, who = null) {
    const g = entry?.grid;
    if (typeof g?.lineOfSlot === 'function') {
        const c = g._cursor;
        return terminalRef(entry.id, g, g.linesScrolled + (c?.y ?? 0), c?.x ?? 0, who);
    }
    const caret = g?.getCursor?.();
    if (!caret) return { error: `'${entry?.id}' has no caret (not editing) — point with the cursor instead` };
    return codeRef(ctx, entry.id, g, caret.line, caret.col, who);
}

// ============ The ONE resolver ============

/**
 * Any spelling of a reference → a Ref: a Ref's JSON, its one-line text (`path:line «quote»`,
 * `<terminal> line N «quote»`), or any `file:line[:col]` text. The quote, when given, is kept as
 * said (it is what the pointer saw); otherwise it is read off the surface now.
 * @param {Object} ctx  reads ctx.registry, ctx.fileProvider
 * @param {string|Object} input
 * @param {string|null} [who]
 * @returns {Ref|{error:string}}
 */
export function resolveRef(ctx, input, who = null) {
    if (input && typeof input === 'object') return fromJson(ctx, input, who);
    const s = String(input ?? '').trim();
    if (!s) return { error: 'nothing to resolve' };
    if (s.startsWith('{')) {
        let j;
        try { j = JSON.parse(s); } catch (e) { return { error: `not a ref: bad JSON (${e.message})` }; }
        return fromJson(ctx, j, who);
    }
    const said = QUOTED.exec(s)?.[1];
    const t = TERMINAL_TEXT.exec(s);
    if (t && ctx.registry?.get?.(t[1])) {
        const e = ctx.registry.get(t[1]);
        const r = terminalRef(t[1], e.grid, Number(t[2]), t[3] ? Number(t[3]) - 1 : 0, who);
        return 'error' in r || said == null ? r : withQuote(r, said);
    }
    const parsed = parseFileRef(s.replace(QUOTED, '')).refs[0];
    if (!parsed) return { error: `no reference in '${s}' (want path:line, '<terminal> line N', or a ref's JSON)` };
    const r = codeAt(ctx, parsed.ref.filePath, parsed.ref.line, parsed.ref.col, who);
    return 'error' in r || said == null ? r : withQuote(r, said);
}

/** A Ref-shaped object → a Ref resolved on the live surface (its text recomputed). */
function fromJson(ctx, j, who) {
    const d = j?.durable;
    if (j?.kind === 'code' && d?.path && Number.isInteger(d.line)) {
        const r = codeAt(ctx, d.path, d.line, d.col ?? 1, j.origin?.who ?? who);
        return 'error' in r || j.quote == null ? r : withQuote(r, String(j.quote));
    }
    if (j?.kind === 'terminal' && d?.terminal && Number.isInteger(d.line)) {
        const e = ctx.registry?.get?.(d.terminal);
        if (!e) return { error: `no terminal '${d.terminal}'` };
        const r = terminalRef(d.terminal, e.grid, d.line, (d.col ?? 1) - 1, j.origin?.who ?? who);
        return 'error' in r || j.quote == null ? r : withQuote(r, String(j.quote));
    }
    return { error: `not a ref: want {kind: 'code'|'terminal', durable: {path|terminal, line}} (got ${JSON.stringify(j)?.slice(0, 120)})` };
}

/** A path (any spelling) + 1-based line/col → a code ref on the open grid that shows it. */
function codeAt(ctx, path, line1, col1, who) {
    const reg = ctx.registry;
    if (!reg) return { error: 'no registry' };
    const key = canonicalPath(ctx, path);
    let id = reg.get(key) ? key : null;
    if (!id) id = new TourResolver(reg).resolve({ filePath: path, line: line1, col: col1, endLine: null, endCol: null }).registryId;
    if (!id) return { error: `'${path}' is not open (no grid shows it)` };
    const grid = reg.get(id)?.grid;
    if (!Number.isInteger(line1) || line1 < 1) return { error: `'${path}': a line number is required` };
    return codeRef(ctx, id, grid, line1 - 1, Math.max(0, (col1 ?? 1) - 1), who);
}

function withQuote(r, quote) {
    const out = { ...r, quote };
    return { ...out, text: refText(out) };
}

// ============ Hues ============

/**
 * The caller's hue: its agent book's lane colour when it has one (a gomuxai agent's lane id is
 * its name), else a stable hue from its name.
 * @param {Object} ctx @param {string} who
 * @returns {{r:number, g:number, b:number}}
 */
export function callerHue(ctx, who) {
    const a = ctx?.agentBooks?.agents?.().find((x) => x.id === who || x.name === who);
    if (a?.color) {
        const n = parseInt(String(a.color).slice(1), 16);
        if (Number.isFinite(n)) return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
    }
    let h = 2166136261;
    for (const ch of String(who)) h = Math.imul(h ^ ch.codePointAt(0), 16777619);
    const hue = ((h >>> 0) % 360) / 360;
    return hsl(hue, 0.65, 0.55);
}

function hsl(h, s, l) {
    const f = (n) => {
        const k = (n + h * 12) % 12;
        return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    };
    return { r: f(0), g: f(8), b: f(4) };
}

// ============ Points ============

/**
 * @typedef {Object} Point
 * @property {string} id        the caller's name (one live point per agent)
 * @property {string} who
 * @property {'look'|'suggest'} kind
 * @property {string|null} say
 * @property {Ref} ref
 * @property {{r:number,g:number,b:number}} hue
 * @property {number} ts
 * @property {number} seq       shown order (newest highest — ts ties within a millisecond)
 * @property {'shown'|'held'|'orphan'|'resolved'} status  held: waiting for the person to stop typing;
 *   orphan: its words are gone from the file; resolved: an edit made what it suggested
 * @property {string|null} anchor  a code point's line text as last seen (what re-anchoring looks for)
 * @property {string|null} replace a suggest point's proposed text (`--with`): seen in the file → resolved
 * @property {string|null} moved   how the last edit moved it ('kept'|'line'|'near'|'far'), null before
 */

/** How a point's line is found again after its file changes, nearest first. @private */
function relocate(lines, line0, anchor, quote, window) {
    if (anchor != null && lines[line0] === anchor) return { line0, how: 'kept' };
    const nearest = (pred, limit) => {
        for (let d = 0; d <= limit; d++) {
            if (line0 - d >= 0 && pred(lines[line0 - d])) return line0 - d;
            if (d && line0 + d < lines.length && pred(lines[line0 + d])) return line0 + d;
        }
        return -1;
    };
    const span = Math.max(lines.length, line0 + 1);
    let i = anchor != null ? nearest((s) => s === anchor, span) : -1;
    if (i >= 0) return { line0: i, how: 'line' };
    if (quote) {
        i = nearest((s) => s != null && s.includes(quote), window);
        if (i >= 0) return { line0: i, how: 'near' };
        i = nearest((s) => s != null && s.includes(quote), span);
        if (i >= 0) return { line0: i, how: 'far' };
    }
    return null;
}

/** The live points (one per agent) and the CommandBar draft channel. */
export default class Deixis {
    /** @param {Object} ctx the shared context (registry, agentBooks) */
    constructor(ctx) {
        this.ctx = ctx;
        /** @type {Map<string, Point>} */
        this.points = new Map();
        /** @type {Set<(text:string) => void>} */
        this._draft = new Set();
        this._seq = 0;
        /** @type {Map<string, () => void>} code entity → its text listener's unlisten */
        this._watch = new Map();
        /** when the person last pressed a key (performance.now()), -Infinity before any */
        this._lastKey = -Infinity;
        this._flushTimer = null;
    }

    /** The idle the person's typing must leave before a point draws (ms). */
    get idleMs() { return Math.max(0, Number(getSetting('point.breakpointIdleMs')) || 0); }

    /**
     * The person pressed a key (keyboardRouter tells us, every keydown). Points arriving while they
     * type are HELD and drawn once they stop for idleMs — agents never flicker lines under a typist.
     * @param {number} [now] performance.now()
     */
    noteKey(now = performance.now()) {
        this._lastKey = now;
        if ([...this.points.values()].some((p) => p.status === 'held')) this._scheduleFlush();
    }

    /** @private */
    _scheduleFlush() {
        clearTimeout(this._flushTimer);
        const wait = Math.max(0, this._lastKey + this.idleMs - performance.now());
        this._flushTimer = setTimeout(() => this.flush(), wait);
    }

    /** Draw the held points if the person has stopped typing (else wait again). @returns {number} drawn */
    flush(now = performance.now()) {
        this._flushTimer = null;
        if (now - this._lastKey < this.idleMs) { this._scheduleFlush(); return 0; }
        let n = 0;
        for (const p of this.points.values()) {
            if (p.status !== 'held') continue;
            p.status = 'shown';
            this._draw(p.ref, p.hue, p.fill, p.who);
            n++;
        }
        if (n) console.info(`[deixis] ${n} held point(s) drawn — the person stopped typing`);
        return n;
    }

    /**
     * Show `who`'s point (replacing its last): fill the line in its hue. Draws only — moves no
     * camera, focus, keyboard or projection.
     * @param {string} who @param {Ref} ref
     * @param {{kind?: 'look'|'suggest', say?: string|null, fill: number}} opts  fill: the opacity
     * @returns {Point}
     */
    show(who, ref, { kind = 'look', say = null, fill, replace = null, now = performance.now() }) {
        if (!who) throw new Error('Deixis.show: an anonymous caller has no point');
        if (!(fill > 0 && fill <= 1)) throw new Error(`Deixis.show: fill opacity must be in (0, 1] (got ${fill})`);
        if (replace != null && kind !== 'suggest') throw new Error('Deixis.show: --with is a suggest point\'s proposed text');
        this.clear(who);
        const hue = callerHue(this.ctx, who);
        const grid = this.ctx.registry?.get?.(ref.entity)?.grid;
        const anchor = ref.kind === 'code' ? (grid?.lines?.[ref.durable.line - 1] ?? null) : null;
        const typing = now - this._lastKey < this.idleMs;
        const p = { id: who, who, kind, say, ref, hue, ts: Date.now(), seq: ++this._seq, fill,
                    status: typing ? 'held' : 'shown', anchor, replace: replace != null ? String(replace) : null, moved: null };
        this.points.set(who, p);
        if (typing) this._scheduleFlush();
        else this._draw(ref, hue, fill, who);
        if (ref.kind === 'code') this._watchText(ref.entity, grid);
        return p;
    }

    /** One text listener per code surface a point is on. @private */
    _watchText(entity, grid) {
        if (this._watch.has(entity) || typeof grid?.addTextListener !== 'function') return;
        this._watch.set(entity, grid.addTextListener((g) => this.reanchor(entity, g)));
    }

    /** @private */
    _unwatchIfIdle(entity) {
        if ([...this.points.values()].some((p) => p.ref.entity === entity)) return;
        this._watch.get(entity)?.();
        this._watch.delete(entity);
    }

    /**
     * A code surface's text changed: every live point on it finds its line again — the same line
     * text where it was, else that line text nearest, else its quote within point.reanchorWindow
     * lines, else its quote anywhere; found nowhere, it is an ORPHAN (its fill goes; it stays
     * listed). A suggest point whose proposed text (`--with`) now stands where it pointed is
     * RESOLVED by the edit. @param {string} entity @param {Object} grid @returns {Point[]} the moved
     */
    reanchor(entity, grid) {
        const lines = grid?.lines;
        if (!Array.isArray(lines)) return [];
        const window = Math.max(0, Number(getSetting('point.reanchorWindow')) || 0);
        const out = [];
        for (const p of this.points.values()) {
            if (p.ref.entity !== entity || p.ref.kind !== 'code' || p.status === 'orphan' || p.status === 'resolved') continue;
            const old0 = p.ref.durable.line - 1;
            const drawn = p.status === 'shown';
            if (drawn) this._draw(p.ref, null, 0, p.who);   // unfill where it was (the line may have moved)
            const want = p.replace?.trim();
            const at = relocate(lines, old0, p.anchor, p.ref.quote, window);
            // Resolved only when the pointed line itself changed (its text is no longer found as it
            // was) and the proposed text now stands there or nearest it — an unrelated edit that
            // merely shifts the line never resolves it.
            const lineChanged = !at || (at.how !== 'kept' && at.how !== 'line');
            const landed = want && lineChanged
                ? (at && lines[at.line0]?.includes(want) ? at.line0 : relocate(lines, old0, null, want, window)?.line0 ?? null)
                : null;
            if (landed != null) {
                p.status = 'resolved';
                p.moved = at?.how ?? null;
                p.ref = this._moved(p.ref, landed);
                console.info(`[deixis] ${p.who}'s suggestion at ${p.ref.text} was made by an edit — resolved`);
                out.push(p);
                continue;
            }
            if (!at) {
                p.status = 'orphan';
                p.moved = null;
                console.info(`[deixis] ${p.who}'s point ${p.ref.text}: its words are gone from the file — orphaned`);
                out.push(p);
                continue;
            }
            p.moved = at.how;
            p.anchor = lines[at.line0];
            if (at.line0 !== old0) { p.ref = this._moved(p.ref, at.line0); out.push(p); }
            if (drawn) this._draw(p.ref, p.hue, p.fill, p.who);
        }
        return out;
    }

    /** A code ref moved to another line (0-based); its column and quote as said. @private */
    _moved(ref, line0) {
        const out = { ...ref, durable: { ...ref.durable, line: line0 + 1 } };
        return { ...out, text: refText(out) };
    }

    /** Clear `who`'s point (its fill goes). @param {string} who @returns {boolean} whether it had one */
    clear(who) {
        const p = this.points.get(who);
        if (!p) return false;
        if (p.status === 'shown') this._draw(p.ref, null, 0, who);
        this.points.delete(who);
        this._unwatchIfIdle(p.ref.entity);
        return true;
    }

    /** @returns {Point[]} newest first */
    list() { return [...this.points.values()].sort((a, b) => b.seq - a.seq); }

    /** Listen for `point.mark` drafts (the CommandBar inserts them). @param {(text:string)=>void} fn @returns {() => void} */
    onDraft(fn) { this._draft.add(fn); return () => this._draft.delete(fn); }

    /** Offer a draft line to the CommandBar. @param {string} text @returns {number} listeners told */
    draft(text) { for (const fn of this._draft) fn(text); return this._draft.size; }

    /** Fill (hue) or unfill (null) a ref's line. @private */
    _draw(ref, hue, fill, who) {
        const e = this.ctx.registry?.get?.(ref.entity);
        const g = e?.grid;
        if (!g) return;
        if (ref.kind === 'terminal') {
            g.setRowMark?.(`point:${who}`, hue ? { line: ref.durable.line, color: hue, opacity: fill } : null);
            return;
        }
        const line0 = ref.durable.line - 1;
        g.clearLineHighlight?.(line0);
        if (hue) g.highlightRange?.(line0, 0, line0, Math.max(1, g.getLineSlotCount?.(line0) ?? 1), hue, fill);
    }
}
