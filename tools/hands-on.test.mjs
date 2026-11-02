// hands-on.test.mjs — the hand surfaces cost nothing while no hand device is attached
// (app/client/handsOn.js; HandCloud.renderPip; the Hand panel's calib.status poll).
//
//   bun tools/hands-on.test.mjs
//
// Locks, on a real SourceStream:
//   - the hand cloud view is born hidden (hand.cloudView.visible defaults false)
//   - pollWhileHands: with no hand device it ticks once and rests; a hand attaching ticks and polls;
//     a non-hand device doesn't; the last hand leaving ticks once and stops; stop() unsubscribes
//   - renderPip, the cloud view SHOWN: draws nothing with no hand device (no empty box), draws with one
// Teeth: an unconditional poll (setInterval regardless) ticks every period with no device, and an
// ungated pass (view.render straight) draws the empty box — both fail here.

import './headless-canvas.mjs';
import SourceStream from '../packages/glyph3d-core/src/services/orchestration/SourceStream.js';
import { handsOn, pollWhileHands } from '../app/client/handsOn.js';
import HandCloud from '../app/client/HandCloud.js';
import { HAND_CLOUD_SETTINGS } from '../app/client/handCloudSettings.js';

let fails = 0, checks = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.error(`FAIL ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = (fn) => { const log = console.log; console.log = () => {}; try { return fn(); } finally { console.log = log; } };

const newStream = () => new SourceStream({ bridge: { onSourceEvent: () => () => {} } });

// the cloud view is born hidden
{
    const vis = HAND_CLOUD_SETTINGS.find((s) => s.key === 'hand.cloudView.visible');
    ok(vis && vis.default === false, `hand.cloudView.visible defaults off (${vis?.default})`);
}

// pollWhileHands
{
    const MS = 10, WAIT = 80;
    const stream = newStream();
    let n = 0;
    const stop = pollWhileHands(stream, () => { n++; }, MS);
    await sleep(WAIT);
    ok(n === 1 && !handsOn(stream), `no hand device: one read, then rest (${n} ticks in ${WAIT} ms)`);

    const atCam = n;
    quiet(() => stream.attachLocal('src-cam-0', 'camera'));
    await sleep(WAIT);
    ok(n - atCam === 1 && !handsOn(stream), `a non-hand device: one read, no poll (${n - atCam} ticks)`);

    const atHand = n;
    quiet(() => stream.attachLocal('src-hand-0', 'hand'));
    ok(n === atHand + 1 && handsOn(stream), `a hand attaching: one read at once, and handsOn sees it (${n - atHand})`);
    await sleep(WAIT);
    ok(n - atHand >= 4, `a hand device: it polls (${n - atHand} ticks in ${WAIT} ms at ${MS} ms)`);

    const atLeave = n;
    quiet(() => stream.detachLocal('src-hand-0'));
    await sleep(WAIT);
    ok(n - atLeave === 1 && !handsOn(stream), `the last hand leaving: one read, then rest (${n - atLeave} ticks)`);

    stop();
    const atStop = n;
    quiet(() => stream.attachLocal('src-hand-1', 'hand'));
    await sleep(WAIT);
    ok(n === atStop, `stopped: a hand attaching runs nothing (${n - atStop} ticks)`);

    // Subscribing with a hand already attached: one read now, then the poll.
    let m = 0;
    const stop2 = pollWhileHands(stream, () => { m++; }, MS);
    ok(m === 1, `a hand already attached: one read at start (${m})`);
    await sleep(WAIT);
    ok(m >= 4, `…then it polls (${m})`);
    stop2();
    let threw = null;
    try { pollWhileHands(stream, () => {}, 0); } catch (e) { threw = e.message; }
    ok(!!threw, `a period of 0 fails loud (${threw})`);
}

// renderPip: shown, it draws only while a hand device is attached
{
    const stream = newStream();
    const hc = new HandCloud({ stream, presence: {} });
    hc.view.setVisible(true);
    let draws = 0;
    const renderer = {
        autoClear: true,
        getSize: (v) => v.set(1600, 900),
        getViewport: (v) => v, getScissor: (v) => v, getScissorTest: () => false,
        getClearColor: (c) => c, getClearAlpha: () => 1,
        setViewport() {}, setScissor() {}, setScissorTest() {}, setClearColor() {},
        clear() { draws++; }, render() { draws++; },
    };
    hc.renderPip(renderer);
    ok(draws === 0, `shown, no hand device: the pass draws nothing (${draws} draw calls)`);
    quiet(() => stream.attachLocal('src-hand-0', 'hand'));
    hc.renderPip(renderer);
    ok(draws > 0, `shown, a hand device: it draws (${draws} draw calls)`);
    hc.view.setVisible(false);
    const at = draws;
    hc.renderPip(renderer);
    ok(draws === at, 'hidden: nothing, hand or not');
    hc.dispose?.();
}

console.log(`${fails ? 'FAIL' : 'ok'} — hands-on: ${checks - fails}/${checks}`);
process.exit(fails ? 1 : 0);
