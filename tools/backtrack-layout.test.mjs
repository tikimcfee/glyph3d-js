// backtrack-layout.test.mjs — the look-back layout kernel, proved ORDER-INDEPENDENT
// without a GPU.
//   bun tools/backtrack-layout.test.mjs [--slots 4000] [--orders 40]
//
// The kernel (ported from the MetalKit utf32GlyphMap_FastLayout) has every thread walk
// BACKWARD through the output buffer accumulating advances until it finds a predecessor
// that has already written its absolute position — then it inherits and stops. If it
// finds none, it walks to the start and computes the whole prefix itself.
//
// That is a deliberate data race: thread N reads slots other threads are concurrently
// writing, and which predecessors happen to be `rendered` when N runs is pure scheduling
// luck. The kernel is only correct if EVERY completion order yields the same buffer.
// It never spins — a miss costs redundant work, never a stall — so there is no
// forward-progress requirement, but there IS a convergence requirement, and that is what
// this asserts.
//
// Orders exercised: forward (best case, every predecessor ready), REVERSE (worst case,
// nothing is ever ready so every thread walks to zero), and random interleavings.
// The oracle is the sequential forward fold.

const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def;
};
const N_SLOTS = arg('--slots', 4000);
const N_ORDERS = arg('--orders', 40);
const WINDOW = arg('--window', 128);   // the kernel's `backtrackCount > 128` inherit gate

const NEWLINE = 10;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log(`  ✗ ${m}`); } };

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build a byte-indexed slot buffer, exactly as the Metal pipeline leaves it after the
 * decode pass: one slot per BYTE, with continuation bytes left as non-leaders (hash 0).
 * That is why the walk skips zeros instead of needing a compaction pass.
 */
function makeSlots(r, n) {
  const slots = [];
  while (slots.length < n) {
    const roll = r();
    if (roll < 0.06) {
      slots.push({ cp: NEWLINE, sizeX: 0.6, sizeY: 1.4, leader: true });
    } else if (roll < 0.10) {
      // 4-byte emoji: a leader plus three continuation slots the walk must skip
      slots.push({ cp: 0x1F600, sizeX: 2.4, sizeY: 1.4, leader: true });
      for (let k = 0; k < 3; k++) slots.push({ cp: 0, sizeX: 0, sizeY: 0, leader: false });
    } else if (roll < 0.13) {
      // 2-byte latin-1: leader + one continuation
      slots.push({ cp: 0xE9, sizeX: 1.2, sizeY: 1.4, leader: true });
      slots.push({ cp: 0, sizeX: 0, sizeY: 0, leader: false });
    } else {
      slots.push({ cp: 65 + Math.floor(r() * 26), sizeX: 1.2, sizeY: 1.4, leader: true });
    }
  }
  return slots.slice(0, n);
}

/** THE ORACLE: the sequential forward fold over leaders. */
function sequentialFold(slots) {
  const out = new Float64Array(slots.length * 2);
  let x = 0, y = 0;
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    if (!s.leader) continue;
    out[i * 2] = x; out[i * 2 + 1] = y;
    if (s.cp === NEWLINE) { y -= s.sizeY; x = 0; }
    else x += s.sizeX;
  }
  return out;
}

/** indexOfCharacterBefore — skip non-leader slots; return id when none exists. */
function indexBefore(slots, id) {
  let j = id - 1;
  while (j >= 0) {
    if (slots[j].leader) return j;
    j--;
  }
  return id;
}

/**
 * ONE THREAD of utf32GlyphMap_FastLayout, faithful to the Metal body: accumulate while
 * walking back, and once past the window, inherit the first `rendered` predecessor's
 * ABSOLUTE position and stop.
 */
function runThread(slots, st, id) {
  const s = slots[id];
  if (!s.leader) return;

  let x = 0, y = 0, foundLineStart = false, steps = 0;
  let prev = indexBefore(slots, id);

  while (prev !== id) {
    const pRendered = st.rendered[prev];
    if (pRendered && steps > WINDOW) {
      // Inherit: the predecessor's absolute position closes our prefix.
      // NOTE: the Metal original resets x to 0 here when the predecessor is a newline.
      // That is only right when the newline is IMMEDIATELY before you; in this branch it
      // is >= WINDOW steps back and `x` already holds the summed advances of everything
      // between, which the reset discards. A newline severs the chain — it does not zero
      // what has already been accumulated past it. (Order-dependent: it only fires when
      // the inherit point lands on a newline with a long unbroken run behind it, which is
      // why forward and reverse order both miss it.)
      if (slots[prev].cp === NEWLINE) {
        y -= slots[prev].sizeY;
        foundLineStart = true;
      }
      y += st.y[prev];
      if (!foundLineStart) { x += st.x[prev] + slots[prev].sizeX; }
      foundLineStart = st.foundLineStart[prev] || foundLineStart;
      break;
    }
    if (slots[prev].cp === NEWLINE) { y -= slots[prev].sizeY; foundLineStart = true; }
    if (!foundLineStart) x += slots[prev].sizeX;

    steps++;
    const cur = prev;
    prev = indexBefore(slots, prev);
    if (prev === cur) break;   // hit the start of the buffer
  }

  st.x[id] = x; st.y[id] = y;
  st.foundLineStart[id] = foundLineStart;
  st.rendered[id] = 1;         // published AFTER the position — the release the walk relies on
  st.steps += steps;
}

function dispatch(slots, order) {
  const n = slots.length;
  const st = {
    x: new Float64Array(n), y: new Float64Array(n),
    foundLineStart: new Uint8Array(n), rendered: new Uint8Array(n), steps: 0,
  };
  for (const id of order) runThread(slots, st, id);
  return st;
}

const ids = (n) => Array.from({ length: n }, (_, i) => i);
const shuffled = (r, n) => {
  const a = ids(n);
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};

const r = rng(12345);
const slots = makeSlots(r, N_SLOTS);
const leaders = slots.filter((s) => s.leader).length;
const newlines = slots.filter((s) => s.cp === NEWLINE).length;
const oracle = sequentialFold(slots);
const EPS = 1e-9;

function compare(st, label) {
  let bad = 0, worst = 0, worstAt = -1;
  for (let i = 0; i < slots.length; i++) {
    if (!slots[i].leader) continue;
    const dx = Math.abs(st.x[i] - oracle[i * 2]);
    const dy = Math.abs(st.y[i] - oracle[i * 2 + 1]);
    const d = Math.max(dx, dy);
    if (d > worst) { worst = d; worstAt = i; }
    if (d > EPS) bad++;
  }
  ok(bad === 0, `${label}: ${bad}/${leaders} slots diverge from the sequential fold (worst ${worst.toExponential(2)} at ${worstAt})`);
  return { bad, worst, steps: st.steps };
}

console.log(`corpus: ${slots.length} byte-slots, ${leaders} leaders, ${newlines} newlines, window ${WINDOW}\n`);

// Forward: every predecessor is ready — the fast path.
const fwd = compare(dispatch(slots, ids(slots.length)), 'forward order');

// Reverse: NOTHING is ever rendered when a thread runs, so every thread walks to zero.
// This is both the correctness worst case and the O(n^2) cost worst case.
const rev = compare(dispatch(slots, ids(slots.length).reverse()), 'reverse order (nothing ever ready)');

// Random interleavings — the orders a real GPU actually produces.
let worstRandom = 0;
for (let k = 0; k < N_ORDERS; k++) {
  const st = dispatch(slots, shuffled(rng(1000 + k), slots.length));
  const res = compare(st, `random order #${k}`);
  worstRandom = Math.max(worstRandom, res.worst);
}

// A pathological single-line file: no newline ever severs the x chain, so the walk cannot
// terminate early on a line break. This is the case that decides whether the window is a
// real bound or just a hopeful one.
{
  const r2 = rng(777);
  const oneLine = Array.from({ length: 20000 }, () => ({ cp: 65, sizeX: 1.2, sizeY: 1.4, leader: true }));
  const oracle2 = sequentialFold(oneLine);
  const st = dispatch(oneLine, ids(oneLine.length));
  let bad = 0;
  for (let i = 0; i < oneLine.length; i++) if (Math.abs(st.x[i] - oracle2[i * 2]) > 1e-6) bad++;
  ok(bad === 0, `20k single-line: ${bad} diverge`);
  console.log(`\n  single-line (20k, no breaks): ${(st.steps / oneLine.length).toFixed(1)} avg steps/thread, ${st.steps.toLocaleString()} total`);
}

console.log(`\nwalk cost (forward)  : ${(fwd.steps / leaders).toFixed(1)} avg steps/thread, ${fwd.steps.toLocaleString()} total`);
console.log(`walk cost (reverse)  : ${(rev.steps / leaders).toFixed(1)} avg steps/thread, ${rev.steps.toLocaleString()} total`);
console.log(`\n${fail === 0 ? '✓' : '✗'} backtrack-layout: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
