// key-notice.test.mjs — a verb run from a KEY says what went wrong on the display
// (keyboardRouter keyVerb → env.notify → ctx.status.notice → the StatusBar's fading notice line).
//
//   bun tools/key-notice.test.mjs
//
// The live bug: Ctrl+Space then Tab ran carrel.back, which answered 'ERR: no carrel to go back to
// (enter two plane desks first)' — and nothing showed: a key has no command bar to print its answer.
// Locks, through the real installKeyboardRouter (an injected document):
//   - the prefixed key's ERR reaches notify once, as 'err' (the reported case: prefix + Tab)
//   - so does every other key path: a bare nav key, Esc's plane leave, Esc popping the context chain
//     (the gesture env's verbs), the held-chord fan and its release
//   - a promise that answers ERR, or rejects, and an exec that throws (the key still claimed, the
//     throw said in the console with its verb) reach it too
//   - a verb's `data.notice` reaches it as 'notice'; an OK answer reaches nothing
//   - a verb run any other way (env.exec straight — the command bar, the CLI) shows nothing
// The channel (ctx.status): a notice lives its ms and is gone; a newer one replaces it (the older's
// timer never clears it); the activity line and the notice never clear each other; bad input is loud.
// The StatusBar renders the notice over the hint, red for an ERR (server render).
// Teeth: a keyVerb that only runs the verb fails every notify check; a StatusBar without the notice
// line fails the render checks. KEYBOARD_ROUTER=<path> / STATUS_BAR=<path> run them against others.

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createStatusChannel } from '../app/client/statusChannel.js';

const { installKeyboardRouter } = await import(process.env.KEYBOARD_ROUTER || '../app/client/keyboardRouter.js');
const { default: StatusBar, fadeMs } = await import(process.env.STATUS_BAR || '../app/StatusBar.jsx');

let fails = 0, checks = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.error(`FAIL ${m}`); } };
const J = (v) => JSON.stringify(v);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const flush = () => sleep(0);
process.on('unhandledRejection', (e) => ok(false, `a rejected key verb went unhandled (${e?.message ?? e})`));

const CODES = { ' ': 'Space', Tab: 'Tab', Escape: 'Escape', h: 'KeyH', f: 'KeyF' };
const CTRL = { ctrl: true };
const BACK_ERR = 'ERR: no carrel to go back to (enter two plane desks first)';

/** The router with a scripted exec: `answers` maps a verb line to its answer (a value or a function). */
function harness({ answers = {}, desk = true, nodes = [] } = {}) {
    const listeners = new Map();
    const doc = { activeElement: null, addEventListener: (t, fn) => listeners.set(t, fn), removeEventListener: (t) => listeners.delete(t) };
    const notes = [], ran = [];
    const answer = (cmd) => {
        const line = Array.isArray(cmd) ? cmd.join(' ') : cmd;
        ran.push(line);
        const a = answers[line] ?? { text: 'OK' };
        return typeof a === 'function' ? a() : a;
    };
    const exec = answer;
    const env = {
        document: doc,
        am: { get: () => null, isCaptured: () => false, on: () => () => {} },
        exec,
        notify: (text, kind) => notes.push([kind, text]),
        gestureEnv: { exec: answer, attention: { get: () => null, clear: () => {} }, context: { nodes: () => nodes } },
        planeEntered: () => desk, planeReading: () => (desk ? { desk: {} } : null), planePrefixMs: 1500,
    };
    installKeyboardRouter(env);
    const ev = (key, mods = {}, repeat = false) => ({ key, code: CODES[key] ?? key, repeat, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift, altKey: !!mods.alt, metaKey: !!mods.meta,
        claimed: false, preventDefault() { this.claimed = true; }, stopImmediatePropagation() {} });
    const down = (key, mods, repeat) => { const e = ev(key, mods, repeat); listeners.get('keydown')(e); return e.claimed; };
    const up = (key, mods) => { const e = ev(key, mods); listeners.get('keyup')?.(e); return e.claimed; };
    const prefix = (key) => { down(' ', CTRL); up(' ', CTRL); up('Control'); return down(key); };
    return { env, exec, down, up, prefix, notes, ran };
}

// the reported case: prefix + Tab → carrel.back → its ERR is shown
{
    const h = harness({ answers: { 'carrel.back': { text: BACK_ERR, data: null } } });
    ok(h.prefix('Tab'), 'prefix + Tab is claimed');
    ok(h.ran.join('|') === 'carrel.back', `…and runs carrel.back (${h.ran.join('|')})`);
    ok(J(h.notes) === J([['err', BACK_ERR]]), `its ERR reaches notify once, as err (${J(h.notes)})`);
}
// an OK answer shows nothing; a notice shows as a notice
{
    const h = harness({ answers: { 'carrel.back': { text: "OK: entered 'b'", data: { notice: 'NOT pixel-exact: the canvas box is not observed yet' } } } });
    h.prefix('Tab');
    ok(J(h.notes) === J([['notice', 'NOT pixel-exact: the canvas box is not observed yet']]), `a verb's data.notice reaches notify as a notice (${J(h.notes)})`);
    const q = harness();
    q.prefix('Tab'); q.prefix('h'); q.down('h');
    ok(q.ran.length === 3 && q.notes.length === 0, `OK answers show nothing (${q.ran.length} ran, ${J(q.notes)})`);
}
// every other key path
{
    const h = harness({ answers: { 'pane.focus left': { text: 'ERR: no pin to the left' } } });
    ok(h.down('h') && J(h.notes) === J([['err', 'ERR: no pin to the left']]), `a bare nav key's ERR (${J(h.notes)})`);
    const e = harness({ answers: { 'carrel.leave': { text: "ERR: 'b' isn't entered as a plane" } } });
    ok(e.down('Escape') && e.notes[0]?.[1] === "ERR: 'b' isn't entered as a plane", `Esc's plane leave: its ERR (${J(e.notes)})`);
    const g = harness({ desk: false, nodes: [{ kind: 'edit', id: 'g' }], answers: { 'edit.stop': { text: 'ERR: nothing is being edited' } } });
    ok(g.down('Escape') && g.ran.includes('edit.stop') && g.notes[0]?.[1] === 'ERR: nothing is being edited', `Esc popping the context chain (the gesture env's verb): its ERR (${J(g.notes)})`);
    const f = harness({ answers: { 'plane.fan on': { text: 'ERR: not in a plane view' }, 'plane.fan off': { text: 'ERR: not in a plane view' } } });
    f.down(' ', CTRL); f.down(' ', CTRL, true); f.up(' ', CTRL);
    ok(f.ran.join('|') === 'plane.fan on|plane.fan off' && f.notes.length === 2, `the held chord's fan and its release: both ERRs (${J(f.notes)})`);
}
// async answers, rejections, throws
{
    const h = harness({ answers: { 'carrel.back': () => Promise.resolve({ text: BACK_ERR }) } });
    h.prefix('Tab');
    ok(h.notes.length === 0, 'a pending answer shows nothing yet');
    await flush();
    ok(J(h.notes) === J([['err', BACK_ERR]]), `an awaited ERR reaches notify (${J(h.notes)})`);

    const errs = [], cerr = console.error;
    console.error = (...a) => errs.push(a.map(String).join(' '));
    const r = harness({ answers: { 'carrel.back': () => Promise.reject(new Error('relay gone')) } });
    r.prefix('Tab');
    await flush();
    const t = harness({ answers: { 'carrel.back': () => { throw new Error('boom'); } } });
    let claimed;
    try { claimed = t.prefix('Tab'); } catch (e) { claimed = false; ok(false, `a throwing verb escapes the key handler (${e.message})`); }
    console.error = cerr;
    ok(J(r.notes) === J([['err', 'ERR: carrel.back: relay gone']]), `a rejection reaches notify (${J(r.notes)})`);
    ok(claimed && J(t.notes) === J([['err', 'ERR: carrel.back: boom']]), `a throw reaches notify, the key still claimed (${J(t.notes)})`);
    ok(errs.length === 2 && errs.every((e) => e.includes("'carrel.back' failed")), `…and both are said in the console with the verb (${J(errs)})`);
}
// a verb run any other way shows nothing
{
    const h = harness({ answers: { 'carrel.back': { text: BACK_ERR } } });
    const res = h.env.exec('carrel.back');
    ok(res.text === BACK_ERR && h.notes.length === 0, 'env.exec straight (the command bar, the CLI): nothing shown');
    ok(h.env.exec === h.exec, 'installing the router leaves env.exec as given');
}
// no notify: the key verb still runs
{
    const h = harness({ answers: { 'carrel.back': { text: BACK_ERR } } });
    delete h.env.notify;
    ok(h.prefix('Tab') && h.ran.join() === 'carrel.back', 'without notify the verb still runs');
}

// the channel's notice
{
    const st = createStatusChannel();
    const seen = [];
    st.subscribeNotice((n) => seen.push(n ? n.text : null));
    st.set('Opening a.js…');
    const n1 = st.notice(BACK_ERR, { kind: 'err', ms: 40 });
    ok(st.getNotice() === n1 && n1.kind === 'err' && st.get() === 'Opening a.js…', 'a notice shows beside the activity');
    st.clear();
    ok(st.getNotice() === n1, 'clearing the activity leaves the notice');
    await sleep(25);
    const n2 = st.notice('second', { ms: 40 });
    await sleep(25);
    ok(st.getNotice() === n2, "a newer notice replaces the older, and the older's timer doesn't clear it");
    await sleep(30);
    ok(st.getNotice() === null, 'a notice is gone after its ms');
    ok(J(seen) === J([BACK_ERR, 'second', null]), `subscribers hear each change (${J(seen)})`);
    const bad = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };
    ok(/ms must be/.test(bad(() => st.notice('x', { ms: 0 }))), 'a notice of 0 ms fails loud');
    ok(/text must be/.test(bad(() => st.notice('', { ms: 10 }))), 'an empty notice fails loud');
    ok(/kind must be/.test(bad(() => st.notice('x', { kind: 'warn', ms: 10 }))), 'an unknown kind fails loud');
}

// the StatusBar shows it, over the hint
{
    const st = createStatusChannel();
    const client = { ctx: { status: st } };
    const idle = renderToStaticMarkup(React.createElement(StatusBar, { client, hint: 'drag pan' }));
    ok(idle.includes('drag pan') && !idle.includes('data-notice'), 'no notice: the hint');
    st.notice(BACK_ERR, { kind: 'err', ms: 4000 });
    const html = renderToStaticMarkup(React.createElement(StatusBar, { client, hint: 'drag pan' }));
    ok(html.includes('data-notice="err"') && html.includes('no carrel to go back to'), `an ERR notice is the line (${html.slice(0, 160)})`);
    ok(!html.includes('drag pan'), 'over the hint');
    ok(/color:#f0a0a0/.test(html.replace(/\s/g, '')), 'red for an ERR');
    st.notice('two\nlines', { ms: 4000 });
    const two = renderToStaticMarkup(React.createElement(StatusBar, { client, hint: 'drag pan' }));
    ok(two.includes('two · lines') && two.includes('data-notice="notice"'), 'a notice of several lines reads as one, joined by ·');
    ok(fadeMs(4000) === 600 && fadeMs(300) === 100, `the fade: the last third, at most 600 ms (${fadeMs(4000)}, ${fadeMs(300)})`);
}

console.log(`${fails ? 'FAIL' : 'ok'} — key-notice: ${checks - fails}/${checks}`);
process.exit(fails ? 1 : 0);
