#!/usr/bin/env bun
/**
 * gen-schema.mjs — generate the lane constants from schema/glyph-identity.json.
 *
 * The schema is the source of truth; every layer generates from it. This is the
 * script that makes "say it once" true rather than aspirational: hand-editing a
 * generated file is pointless because the next run overwrites it.
 *
 * Validation runs FIRST and throws. A schema that violates the invariants is a
 * build failure, not a review miss — which is the whole reason the schema exists.
 *
 * Run: bun tools/gen-schema.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const schema = JSON.parse(readFileSync(join(root, 'schema/glyph-identity.json'), 'utf8'));

// ── validate ────────────────────────────────────────────────────────────────
function validate(s) {
    const errs = [];
    const allBufs = { ...s.buffers, partialCounts: s.scanPartial.counts,
        partialMeasures: s.scanPartial.measures, itemTable: s.itemTable.measures };
    for (const [bufName, buf] of Object.entries(allBufs)) {
        const seen = new Set();
        for (const lane of buf.lanes) {
            if (typeof lane.index !== 'number') errs.push(`${bufName}.${lane.name}: no index`);
            if (seen.has(lane.index)) errs.push(`${bufName}: duplicate index ${lane.index}`);
            seen.add(lane.index);
            if (lane.index >= buf.stride) errs.push(`${bufName}.${lane.name}: index ${lane.index} >= stride ${buf.stride}`);
        }
        if (buf.lanes.length !== buf.stride) errs.push(`${bufName}: ${buf.lanes.length} lanes but stride ${buf.stride}`);
        for (let i = 0; i < buf.stride; i++) if (!seen.has(i)) errs.push(`${bufName}: index ${i} unassigned`);
    }
    // EVERY lane declares a kind. A lane without one is a build failure, not a
    // review miss — that omission is how totalRows stayed a float for a year.
    const KINDS = new Set(['count', 'identity', 'bitfield', 'measure']);
    for (const [bufName, buf] of Object.entries(allBufs)) {
        for (const lane of buf.lanes) {
            if (!KINDS.has(lane.kind)) errs.push(`${bufName}.${lane.name}: kind '${lane.kind}' is not one of ${[...KINDS]}`);
        }
    }
    for (const lane of s.itemBounds.lanes) {
        if (!KINDS.has(lane.kind)) errs.push(`itemBounds.${lane.name}: missing or invalid kind`);
    }
    // THE ENGINE'S CONTAINER IS DERIVED FROM KIND, AND ASSERTED AGAINST IT. Another
    // layer may realize the same kinds in a different container and stay conformant;
    // what it owes is this same assertion over its own mapping.
    for (const lane of s.buffers.measures.lanes) {
        if (lane.kind !== 'measure' && !lane.misplaced) {
            errs.push(`measures.${lane.name}: kind '${lane.kind}' is exact but sits in the f32 buffer with no 'misplaced' justification`);
        }
    }
    for (const lane of s.buffers.counts.lanes) {
        if (lane.kind === 'measure') errs.push(`counts.${lane.name}: a measure in the u32 buffer`);
    }

    // THE INVARIANT THIS FILE EXISTS FOR: no exact value may ride a float carrier.
    // A lane in the f32 buffer that is an identity/count/bitfield is the bug that
    // cost this codebase three separate walls. `misplaced` is the one documented
    // exception, and it must SAY so — silence is a failure.
    const measures = s.buffers.measures;
    for (const lane of measures.lanes) {
        if (lane.bitfield && !lane.misplaced) errs.push(`measures.${lane.name}: a bitfield in the f32 buffer with no 'misplaced' justification`);
    }
    for (const id of s.identities) {
        if (id.carrier !== 'u32') errs.push(`identity ${id.name}: carrier is '${id.carrier}', identities must be u32`);
    }
    // THE TRUNCATION INVARIANT. The record format is defined as a prefix of each
    // buffer, which is what makes emitting one a shortening rather than a gather.
    // That only holds if every render-read lane sorts BEFORE every lane that is not
    // read. If someone adds a render-read lane at the tail, this throws rather than
    // silently turning the record into a repack.
    for (const [bufName, buf] of Object.entries(s.buffers)) {
        const sorted = [...buf.lanes].sort((a, b) => a.index - b.index);
        let seenUnread = null;
        for (const lane of sorted) {
            if (!lane.read_by_vertex) { seenUnread ??= lane.name; }
            else if (seenUnread) {
                errs.push(`${bufName}.${lane.name} is read by the vertex path but sits after `
                    + `${seenUnread}, which is not — the record format would stop being a truncation`);
            }
        }
    }
    if (errs.length) throw new Error('schema invalid:\n  ' + errs.join('\n  '));
    return s;
}
validate(schema);

const sp = schema.scanPartial;
const it = schema.itemTable;
const ib = schema.itemBounds;
const banner = (cmt) => [
    `${cmt} GENERATED by tools/gen-schema.mjs from schema/glyph-identity.json.`,
    `${cmt} DO NOT EDIT — edit the schema and regenerate.`,
    `${cmt}`,
    `${cmt} Two buffers, and where a value lives IS what kind it is:`,
    `${cmt}   measures (f32) — where things are in space; rounding is load-bearing.`,
    `${cmt}   counts   (u32) — what the data is; exact to 2^32, never rounded.`,
    `${cmt} There are no bitcasts. A count cannot land in the float buffer by accident.`,
].join('\n');

// ── Mojo ────────────────────────────────────────────────────────────────────
const m = schema.buffers.measures, c = schema.buffers.counts;
// DERIVED, never hand-written: the record is the render-read prefix of each buffer.
const recM = m.lanes.filter(l => l.read_by_vertex).length;
const recC = c.lanes.filter(l => l.read_by_vertex).length;
const mojo = [
    banner('#'), '',
    `comptime MEASURE_STRIDE = ${m.stride}`,
    ...m.lanes.map(l => `comptime M_${l.name} = ${l.index}`), '',
    `comptime COUNT_STRIDE = ${c.stride}`,
    ...c.lanes.map(l => `comptime C_${l.name} = ${l.index}`), '',
    '# The RECORD format: the render-read prefix of each buffer. Emitting a record',
    '# is a truncation, not a repack — which is why the scratch pool can be reused',
    '# and the resident cost stops scaling with the corpus.',
    `comptime RECORD_MEASURE_STRIDE = ${recM}`,
    `comptime RECORD_COUNT_STRIDE = ${recC}`,
    `comptime RECORD_BYTES = ${recM * 4 + recC * 4}`, '',
    '# The scan partial (ScanElem) in a GPU buffer — same two-buffer rule.',
    `comptime PARTIAL_COUNT_STRIDE = ${sp.counts.stride}`,
    ...sp.counts.lanes.map(l => `comptime P_${l.name} = ${l.index}`), '',
    `comptime PARTIAL_MEASURE_STRIDE = ${sp.measures.stride}`,
    ...sp.measures.lanes.map(l => `comptime PM_${l.name} = ${l.index}`), '',
    '# Per-item layout params on device — f32, because Metal has no f64.',
    `comptime ITEM_STRIDE = ${it.measures.stride}`,
    ...it.measures.lanes.map(l => `comptime I_${l.name} = ${l.index}`), '',
    '# Per-item bounds + fold scalars. Lane kinds matter on device: Metal has no f64,',
    '# so counts go to native u32 atomics and measures to f32 ordered keys.',
    `comptime BOUNDS_STRIDE = ${ib.stride}`,
    ...ib.lanes.map(l => `comptime B_${l.name} = ${l.index}`),
    `comptime BOUNDS_COUNT_LANES = ${JSON.stringify(ib.lanes.filter(l => l.kind !== 'measure').map(l => l.index))}`.replace('[','(').replace(']',')'), '',
    '',
    'def measure_lane_name(lane: Int) -> String:',
    '    """Lane name for diagnostics — runtime lookup (comptime lists cannot materialize)."""',
    ...m.lanes.map(l => `    if lane == ${l.index}:\n        return "M_${l.name}"`),
    '    return "M_?"', '',
    '',
    'def count_lane_name(lane: Int) -> String:',
    ...c.lanes.map(l => `    if lane == ${l.index}:\n        return "C_${l.name}"`),
    '    return "C_?"', '',
].join('\n');
writeFileSync(join(root, 'engine/glyph_schema.mojo'), mojo);

// ── JS ──────────────────────────────────────────────────────────────────────
const js = [
    banner('//'), '',
    `export const MEASURE_STRIDE = ${m.stride};`,
    ...m.lanes.map(l => `export const M_${l.name} = ${l.index};`), '',
    `export const COUNT_STRIDE = ${c.stride};`,
    ...c.lanes.map(l => `export const C_${l.name} = ${l.index};`), '',
    `/** The RECORD format: the render-read prefix of each buffer (a truncation). */`,
    `export const RECORD_MEASURE_STRIDE = ${recM};`,
    `export const RECORD_COUNT_STRIDE = ${recC};`,
    `export const RECORD_BYTES = ${recM * 4 + recC * 4};`, '',
    `export const PARTIAL_COUNT_STRIDE = ${sp.counts.stride};`,
    ...sp.counts.lanes.map(l => `export const P_${l.name} = ${l.index};`), '',
    `export const PARTIAL_MEASURE_STRIDE = ${sp.measures.stride};`,
    ...sp.measures.lanes.map(l => `export const PM_${l.name} = ${l.index};`), '',
    `export const ITEM_STRIDE = ${it.measures.stride};`,
    ...it.measures.lanes.map(l => `export const I_${l.name} = ${l.index};`), '',
    `export const BOUNDS_STRIDE = ${ib.stride};`,
    ...ib.lanes.map(l => `export const B_${l.name} = ${l.index};`),
    `/** Bounds lanes that are EXACT — must never pass through floatToOrderedKey. */`,
    `export const BOUNDS_EXACT_LANES = Object.freeze([${ib.lanes.filter(l => l.kind !== 'measure').map(l => `B_${l.name}`).join(', ')}]);`, '',
    `/** Lanes the vertex path reads, in each buffer. */`,
    `export const MEASURE_VERTEX_LANES = Object.freeze([${m.lanes.filter(l => l.read_by_vertex).map(l => `M_${l.name}`).join(', ')}]);`,
    `export const COUNT_VERTEX_LANES = Object.freeze([${c.lanes.filter(l => l.read_by_vertex).map(l => `C_${l.name}`).join(', ')}]);`,
    `/** Fold scratch — needed while computing, never read by the render path. */`,
    `export const MEASURE_SCRATCH_LANES = Object.freeze([${m.lanes.filter(l => l.scratch).map(l => `M_${l.name}`).join(', ')}]);`,
    `export const COUNT_SCRATCH_LANES = Object.freeze([${c.lanes.filter(l => l.scratch).map(l => `C_${l.name}`).join(', ')}]);`,
    '',
].join('\n');
writeFileSync(join(root, 'packages/glyph3d-core/src/compute/glyphSchema.js'), js);

console.log(`schema ok — measures ${m.stride} lanes, counts ${c.stride} lanes;`
    + ` record = ${recM}+${recC} lanes, ${recM * 4 + recC * 4} B/glyph (vs ${(m.stride + c.stride) * 4} B/source byte)`);
console.log('  wrote engine/glyph_schema.mojo');
console.log('  wrote packages/glyph3d-core/src/compute/glyphSchema.js');
