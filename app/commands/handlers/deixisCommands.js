/**
 * Deixis commands — "this" and "that" on the bus (docs/planes/DESIGN.md §3.8, lite; the model is
 * app/client/Deixis.js).
 *
 *   ref.resolve <text|json>          any spelling of a reference → a Ref (path:line «quote»,
 *                                    `<terminal> line N «quote»`, a Ref's JSON, a log's file:line)
 *   deixis.here [hover|primary|key|at <x> <y>]
 *                                    what is being pointed at: the glyph under the cursor (hover,
 *                                    the default — the GPU pick's glyph slot), a CSS-px point on
 *                                    the canvas (at), or a focused surface's caret / cursor line
 *   point.mark [here|<ref>]          put `this = <ref>` into the CommandBar (the plane prefix's p)
 *   point.show <ref> [--kind look|suggest] [--say <line>]
 *                                    an IDENTIFIED caller's point (glyph3d-cli --as): its line fills
 *                                    in the caller's hue. Moves NOTHING of the person's — no camera,
 *                                    focus, keyboard or projection. One live point per agent.
 *   point.list                       the live points
 *   point.go [id]                    the person's verb: focus and fly to a point (newest by default)
 *   point.clear [id|all]             an agent clears its own point; the person clears any or all
 *
 * Every point.* writes a `[deixis]` record (scope 'deixis') to the relay log store.
 */

import { emitLogRecord } from '@glyph3d/core/services/orchestration/consoleForwarder.js';
import { getSetting } from '../../client/settings.js';
import { entryForGrid, resolveGlyphHitFor } from '../../client/CanvasInteraction.jsx';
import { resolveRef, refAtSlot, refAtCaret } from '../../client/Deixis.js';

/** One `[deixis]` record in the relay log store. */
function record(verb, ctx, fields) {
    emitLogRecord('info', 'deixis', `[deixis] ${verb}${ctx.caller ? ` by ${ctx.caller}` : ''}${fields.text ? ` ${fields.text}` : ''}`,
        { verb, caller: ctx.caller ?? null, sender: ctx.sender ?? null, cid: ctx.cid, ...fields });
}

const fail = (text) => ({ text: `ERR: ${text}`, data: null });

/**
 * The ref under a CSS-px point on the canvas (top-left origin): the GPU pick's surface and glyph.
 * @returns {Promise<import('../../client/Deixis.js').Ref|{error:string}>}
 */
async function refAtPoint(ctx, x, y) {
    const ps = ctx.pickingSystem;
    if (!ps) return { error: 'no picking system' };
    const hits = await ps.pick(['grid', 'glyph'], ctx.camera, ctx.scene, x, y);
    const tok = hits.grid?.token;
    const owner = tok && typeof tok.ownerOf === 'function' ? tok.ownerOf(hits.grid.slotIndex) : tok;
    const entry = owner ? entryForGrid(ctx.registry, owner) : null;
    if (!entry) return { error: `nothing pickable at (${x}, ${y})` };
    const slot = resolveGlyphHitFor(entry.grid, hits.glyph);
    if (slot == null) return { error: `(${x}, ${y}) is over '${entry.id}' but not on a character` };
    return refAtSlot(ctx, entry, slot, ctx.caller ?? null);
}

/** The cursor's CSS-px point on the canvas, or null when it isn't over it. */
function cursorPoint(ctx) {
    const c = ctx.cameraController?.input?.cursor;
    const rect = ctx.renderer?.domElement?.getBoundingClientRect?.();
    if (!c?.inCanvas || !rect) return null;
    return { x: c.x - rect.left, y: c.y - rect.top };
}

/**
 * deixis.here's argument → a Ref.
 * @param {Object} ctx @param {string[]} args
 */
async function here(ctx, args) {
    const how = String(args[0] ?? 'hover').toLowerCase();
    if (how === 'at') {
        const x = Number(args[1]), y = Number(args[2]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return { error: 'usage: deixis.here at <x> <y>   (CSS px from the canvas top-left)' };
        return refAtPoint(ctx, x, y);
    }
    if (how === 'hover') {
        const p = cursorPoint(ctx);
        if (!p) return { error: 'the cursor is not over the canvas' };
        return refAtPoint(ctx, p.x, p.y);
    }
    if (how === 'primary' || how === 'key') {
        const key = ctx.attentionManager?.get?.(how) ?? null;
        if (!key) return { error: `nothing holds the ${how} slot` };
        const entry = ctx.registry?.get?.(key);
        if (!entry) return { error: `the ${how} slot names '${key}', which is not registered` };
        return refAtCaret(ctx, { id: key, grid: entry.grid }, ctx.caller ?? null);
    }
    return { error: `deixis.here: want hover | primary | key | at <x> <y> (got '${args[0]}')` };
}

/** point.show's args: the ref text, then --kind / --say. */
function parseShow(args) {
    const ref = [];
    let kind = 'look', say = null;
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--kind') { kind = String(args[++i] ?? ''); continue; }
        if (args[i] === '--say') { say = args[++i] ?? null; continue; }
        ref.push(args[i]);
    }
    return { refText: ref.join(' '), kind, say };
}

/** @param {import('../../client/CommandProvider.jsx').AppRouter} router */
export default function registerDeixisCommands(router) {
    router.register('ref.resolve', (args, ctx) => {
        if (!args.length) return fail('usage: ref.resolve <text|json>');
        const r = resolveRef(ctx, args.join(' '), ctx.caller ?? null);
        if ('error' in r) return fail(r.error);
        return { text: `OK: ${r.text}`, data: r };
    }, { description: 'Resolve any spelling of a reference (path:line «quote», <terminal> line N, a Ref JSON, a log line) to a Ref', usage: '<text|json>', returns: 'Ref { kind, entity, durable, quote, origin, text }' });

    router.register('deixis.here', async (args, ctx) => {
        const r = await here(ctx, args);
        if ('error' in r) return fail(r.error);
        return { text: `OK: ${r.text}`, data: r };
    }, { description: 'What is pointed at: the glyph under the cursor (hover), a canvas point (at x y), or a focused caret (primary|key)', usage: '[hover|primary|key|at <x> <y>]', returns: 'Ref' });

    router.register('point.mark', async (args, ctx) => {
        const r = !args.length || args[0] === 'here' ? await here(ctx, args.slice(1).length ? args.slice(1) : ['hover']) : resolveRef(ctx, args.join(' '), ctx.caller ?? null);
        if ('error' in r) return fail(r.error);
        const line = `this = ${r.text}`;
        const told = ctx.deixis?.draft(line) ?? 0;
        record('point.mark', ctx, { text: r.text, ref: r });
        return { text: `OK: ${line}${told ? '' : ' (no CommandBar to receive it)'}`, data: { ref: r, line, told } };
    }, { description: "Put `this = <ref>` into the CommandBar — what you're pointing at (hover by default), for the next line you send", usage: '[here [hover|primary|key|at x y]|<ref>]', returns: '{ ref, line, told }' });

    router.register('point.show', (args, ctx) => {
        const who = ctx.caller;
        if (!who) return fail('point.show needs an identified caller: glyph3d-cli --as <name> (or $AGENT_NAME) — an anonymous point has no owner or hue');
        if (!ctx.deixis) return fail('no deixis on this display');
        const { refText, kind, say } = parseShow(args);
        if (kind !== 'look' && kind !== 'suggest') return fail(`--kind is look or suggest (got '${kind}')`);
        if (!refText) return fail('usage: point.show <ref> [--kind look|suggest] [--say <line>]');
        const r = resolveRef(ctx, refText, who);
        if ('error' in r) return fail(r.error);
        const fill = Number(getSetting(kind === 'suggest' ? 'point.suggestFill' : 'point.lookFill'));
        const p = ctx.deixis.show(who, r, { kind, say, fill });
        record('point.show', ctx, { text: r.text, kind, say, ref: r });
        return { text: `OK: ${who} points at ${r.text}${say ? ` — ${say}` : ''}`, data: p };
    }, { description: "Point at a line from an identified caller: it fills in the caller's hue (no camera, focus or keyboard change); one point per agent", usage: '<ref> [--kind look|suggest] [--say <line>]', returns: 'Point { id, who, kind, say, ref, hue, ts }' });

    router.register('point.list', (_args, ctx) => {
        const pts = ctx.deixis?.list() ?? [];
        if (!pts.length) return { text: 'OK: no points', data: [] };
        return { text: `OK: ${pts.length} point(s)\n${pts.map((p) => `  ${p.id} [${p.kind}] ${p.ref.text}${p.say ? ` — ${p.say}` : ''}`).join('\n')}`, data: pts };
    }, { description: 'The live points (one per agent), newest first', returns: 'Point[]' });

    router.register('point.go', async (args, ctx) => {
        if (ctx.caller) return fail(`point.go is the person's verb — it moves attention and the camera; '${ctx.caller}' points (point.show) instead`);
        const pts = ctx.deixis?.list() ?? [];
        const p = args[0] ? ctx.deixis?.points.get(String(args[0])) : pts[0];
        if (!p) return fail(args[0] ? `no point '${args[0]}' (point.list)` : 'no points');
        await ctx.execute(['attention.set', 'primary', p.ref.entity]);
        await ctx.execute(['camera.focus', p.ref.entity]);
        record('point.go', ctx, { text: p.ref.text, id: p.id });
        return { text: `OK: to ${p.id}'s point ${p.ref.text}`, data: p };
    }, { description: "Go to a point (the newest by default): focus its surface and fly the camera there — the person's verb", usage: '[id]', returns: 'Point' });

    router.register('point.clear', (args, ctx) => {
        const d = ctx.deixis;
        if (!d) return fail('no deixis on this display');
        const who = ctx.caller;
        const arg = args[0] ? String(args[0]) : null;
        if (who) {
            if (arg && arg !== who) return fail(`${who} can clear only its own point (not '${arg}')`);
            const had = d.clear(who);
            record('point.clear', ctx, { id: who, had });
            return { text: had ? `OK: cleared ${who}'s point` : `OK: ${who} had no point`, data: { cleared: had ? [who] : [] } };
        }
        const ids = !arg || arg === 'all' ? [...d.points.keys()] : [arg];
        if (arg && arg !== 'all' && !d.points.has(arg)) return fail(`no point '${arg}' (point.list)`);
        for (const id of ids) d.clear(id);
        record('point.clear', ctx, { ids });
        return { text: `OK: cleared ${ids.length} point(s)`, data: { cleared: ids } };
    }, { description: "Clear points: an agent its own; the person any one, or all", usage: '[id|all]', returns: '{ cleared }' });
}
