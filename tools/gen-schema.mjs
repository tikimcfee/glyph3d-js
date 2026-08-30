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
    // s.buffers carries a $comment; iterate only entries that are actual buffers.
    const slotBufs = Object.fromEntries(Object.entries(s.buffers).filter(([, v]) => v && v.lanes));
    const allBufs = { ...slotBufs, partialCounts: s.scanPartial.counts,
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
    for (const [bufName, buf] of Object.entries(slotBufs)) {
        for (const lane of buf.lanes) {
            if (buf.carrier === 'f32' && lane.kind !== 'measure' && !lane.misplaced) {
                errs.push(`${bufName}.${lane.name}: kind '${lane.kind}' is exact but sits in an f32 buffer with no 'misplaced' justification`);
            }
            if (buf.carrier === 'u32' && lane.kind === 'measure') {
                errs.push(`${bufName}.${lane.name}: a measure in a u32 buffer`);
            }
        }
    }

    // THE INVARIANT THIS FILE EXISTS FOR: no exact value may ride a float carrier.
    // A lane in the f32 buffer that is an identity/count/bitfield is the bug that
    // cost this codebase three separate walls. `misplaced` is the one documented
    // exception, and it must SAY so — silence is a failure.
    for (const [bufName, buf] of Object.entries(slotBufs)) {
        if (buf.carrier !== 'f32') continue;
        for (const lane of buf.lanes) {
            if (lane.bitfield && !lane.misplaced) errs.push(`${bufName}.${lane.name}: a bitfield in an f32 buffer with no 'misplaced' justification`);
        }
    }
    for (const id of s.identities) {
        if (id.carrier !== 'u32') errs.push(`identity ${id.name}: carrier is '${id.carrier}', identities must be u32`);
    }
    // THE TRUNCATION INVARIANT. The record format is defined as a prefix of each
    // buffer, which is what makes emitting one a shortening rather than a gather.
    // That only holds if every render-read lane sorts BEFORE every lane that is not
    // read. If someone adds a render-read lane at the tail, this throws rather than
    // silently turning the record into a repack.
    for (const [bufName, buf] of Object.entries(slotBufs)) {
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
    // THE PARTITION MUST BE BINARY AND TOTAL. The contract declares four kinds
    // because four is the truth, but every consumer that classifies lanes does so
    // in TWO buckets — measure vs exact — and at least one of them (the render
    // side's slot-type gate) depends on those buckets being disjoint AND
    // exhaustive to catch an unclassified lane. A third kind with no bucket is a
    // classification that can drift from its own checker, which is the failure
    // this file exists to prevent. So: assert the partition here, at the one place
    // that knows every kind, rather than leaving each consumer to assume it.
    const KIND_IS_EXACT = { count: true, identity: true, bitfield: true, measure: false };
    for (const [bufName, buf] of Object.entries(allBufs)) {
        for (const lane of buf.lanes) {
            if (!(lane.kind in KIND_IS_EXACT)) {
                errs.push(`${bufName}.${lane.name}: kind '${lane.kind}' has no side in the `
                    + `measure/exact partition — a consumer classifying in two buckets `
                    + `would have nowhere to put it`);
            }
        }
    }
    // THE RECORD IS A WIRE FORMAT, so its byte count must be DERIVED from field
    // widths, never asserted alongside them. 6 measures + 2 counts = 32 bytes only
    // while every carrier is 4 bytes wide; if one ever became f16 the constant and
    // the field list could disagree in silence.
    const CARRIER_BYTES = { f32: 4, u32: 4 };
    for (const [bufName, buf] of Object.entries(slotBufs)) {
        if (CARRIER_BYTES[buf.carrier] !== 4) {
            errs.push(`${bufName}: carrier '${buf.carrier}' is not a known 4-byte carrier — `
                + `RECORD_BYTES is derived assuming 4 bytes per field and would be wrong`);
        }
    }
    // THE SEMANTIC SET AND THIS LAYER'S TABLE MUST ACCOUNT FOR EACH OTHER, in both
    // directions. Layout freedom is not content freedom: a parameter one layer has
    // and another cannot express is behaviour the conformance corpus can never see,
    // because it only compares outputs on inputs BOTH layers accept.
    const semantic = new Set(s.itemParams.params.map(p => p.name));
    const realized = new Set();
    for (const lane of s.itemTable.measures.lanes) {
        const kinds = ['realizes', 'realization_only', 'orphan'].filter(k => k in lane);
        if (kinds.length !== 1) {
            errs.push(`itemTable.${lane.name}: must declare exactly one of realizes / `
                + `realization_only / orphan — has ${kinds.length}. A lane whose relationship `
                + `to the semantic set is unstated is how a field ends up in one layer and `
                + `not the other with nothing to notice.`);
            continue;
        }
        if (lane.realizes) {
            if (!semantic.has(lane.realizes)) {
                errs.push(`itemTable.${lane.name}: realizes '${lane.realizes}', which is not `
                    + `a semantic parameter`);
            }
            if (realized.has(lane.realizes)) {
                errs.push(`itemTable: '${lane.realizes}' realized by more than one lane`);
            }
            realized.add(lane.realizes);
        }
    }
    for (const name of semantic) {
        if (!realized.has(name)) {
            errs.push(`itemParams.${name}: no lane of this layer's item table realizes it — `
                + `a layout parameter this backend cannot express`);
        }
    }
    // A DECLARATION MAY NOT OUTLIVE ITS JUSTIFICATION. Every rule above catches a
    // lane that violates without a declaration; these catch the mirror — a
    // DECLARATION that no longer describes anything true. Both directions matter,
    // and only the first is obvious.
    //
    // Fix GLYPH_ID's carrier, forget to remove its `misplaced` entry, and the
    // exemption silently covers whatever lands in that slot next. A deviation list
    // that outlives its deviation is a permanent hole with a comment on it, and the
    // file people trust most becomes the one carrying the stalest claims. A settled
    // debt must FAIL until it is removed.
    for (const [bufName, buf] of Object.entries(slotBufs)) {
        for (const lane of buf.lanes) {
            if (!lane.misplaced) continue;
            const deviating = buf.carrier === 'f32' && lane.kind !== 'measure';
            if (!deviating) {
                errs.push(`${bufName}.${lane.name}: declares 'misplaced' but is not `
                    + `deviating — kind '${lane.kind}' on a '${buf.carrier}' carrier is `
                    + `correct. A settled debt must be REMOVED, not left as an exemption `
                    + `covering whatever lands in this slot next.`);
            }
        }
    }
    for (const lane of s.itemTable.measures.lanes) {
        if ((lane.realization_only || lane.orphan) && semantic.has(lane.name)) {
            errs.push(`itemTable.${lane.name}: declared ${lane.orphan ? 'orphan' : 'realization_only'} `
                + `but IS in the semantic set — the declaration has outlived its reason`);
        }
    }
    if (errs.length) throw new Error('schema invalid:\n  ' + errs.join('\n  '));
    return s;
}
validate(schema);

const sp = schema.scanPartial;
const it = schema.itemTable;
const ib = schema.itemBounds;
const head = (cmt) => [
    `${cmt} GENERATED by tools/gen-schema.mjs from schema/glyph-identity.json.`,
    `${cmt} DO NOT EDIT — edit the schema and regenerate.`,
    `${cmt}`,
];
// The engine's file describes the ENGINE'S CONTAINER, so it says so. The contract
// file must NOT carry this text: "four phase arrays" is a fact about this backend,
// not about the pipeline, and putting it atop a shared file is the whole error
// being corrected here — a description of one layer presented as everyone's
// contract.
const banner = (cmt) => [
    ...head(cmt),
    `${cmt} THIS LAYER'S REALIZATION. Six arrays, split twice — who WRITES a lane`,
    `${cmt} decides where it lives; who READS it decides whether it lives at all:`,
    `${cmt}   static (sm f32 + fl u32)      decode's output; a pure function of the byte`,
    `${cmt}   positional (lm f32 + lc u32)  the fold's output; render-read`,
    `${cmt}   witness (wm f32 + wc u32)     fold interior no render path reads; the`,
    `${cmt}                                 serial form writes it only when witnessed`,
    `${cmt} Float carriers hold measures, u32 carriers hold counts — no bitcasts, and`,
    `${cmt} a count cannot land in a float array by accident.`,
    `${cmt}`,
    `${cmt} Strides and lane indices below are THIS BACKEND'S and are not prescribed`,
    `${cmt} to anyone. What is shared lives in glyphContract.js: the record format and`,
    `${cmt} the kind of each field. Another layer may realize the same kinds in a`,
    `${cmt} different container and stay conformant; what it owes is the assertion`,
    `${cmt} that its own mapping respects them, which validate() performs for this one.`,
].join('\n');
const contractBanner = (cmt) => [
    ...head(cmt),
    `${cmt} THE SHARED TIER, and nothing else. Names and kinds — no strides, no lane`,
    `${cmt} indices, nothing about how any layer stores anything. The renderer runs one`,
    `${cmt} buffer; the native backend runs four phase arrays; the live item table is`,
    `${cmt} stride 15 against the backend's 15. All are conformant: container is a`,
    `${cmt} per-layer realization and KIND is the declared fact.`,
    `${cmt}`,
    `${cmt} What every layer owes: assert that its own mapping respects KIND below, and`,
    `${cmt} produce RECORD_* exactly. Nothing more.`,
].join('\n');

// ── Mojo ────────────────────────────────────────────────────────────────────
const stM = schema.buffers.staticMeasures, stC = schema.buffers.staticCounts;
const poM = schema.buffers.posMeasures, poC = schema.buffers.posCounts;
const wM = schema.buffers.witnessMeasures, wC = schema.buffers.witnessCounts;
const rbv = (buf) => buf.lanes.filter(l => l.read_by_vertex).sort((a, b) => a.index - b.index).map(l => l.name);
// THE FIXTURE FORMAT — frozen on disk (format v2), NOT derived from the container.
// Fixtures carry the ORACLE'S VALUES in this order; the engine's working buffers
// may be re-laid at will and the fixtures do not move. When the container was one
// measures-8 + counts-4 pair these were the same shape by coincidence; the phase
// split ended the coincidence, not the format.
const FIXTURE_MEASURES = ['X', 'Y', 'Z', 'ADVANCE', 'HEIGHT', 'GLYPH_ID', 'BASE_X', 'LINE_ADV'];
const FIXTURE_COUNTS = ['ROW', 'COL', 'FLAGS', 'ORD'];
// DERIVED, never hand-written: the record is the render-read prefix of each buffer.
// ── THE WIRE, PINNED AS A LITERAL ───────────────────────────────────────────
// The record's field order is a WIRE FORMAT: the renderer consumes these bytes in
// this order, and nothing about the engine's internal storage may move them. But
// every RECORD_* below is DERIVED from the schema's lane declarations — so a
// schema restructure (the static/positional split, say) would silently regenerate
// the contract with different bytes and nothing would fail. The one artifact that
// must not change would be regenerated by the change. This literal is the anchor:
// derivation still happens, and then must MATCH the pin, or the build fails.
//
// Changing the wire format is still possible — edit this literal, knowingly, in a
// commit that says so — but it can no longer happen as a side effect.
const WIRE_MEASURES = ['X', 'Y', 'Z', 'ADVANCE', 'HEIGHT', 'GLYPH_ID'];
const WIRE_COUNTS = ['ROW', 'COL'];
const WIRE_BYTES = 32;
{
    // The record is a CONCATENATION OF PREFIX RUNS: posMeasures' render-read
    // prefix, then staticMeasures', then posCounts'. The wire order partitions
    // exactly at the phase boundary, which is what keeps compact() memcpy-shaped
    // (three runs instead of two, still no lane map).
    const gotM = [...rbv(poM), ...rbv(stM)];
    const gotC = [...rbv(poC), ...rbv(stC)];
    const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
    if (!same(gotM, WIRE_MEASURES) || !same(gotC, WIRE_COUNTS)) {
        throw new Error('THE RECORD WIRE FORMAT MOVED.\n'
            + `  pinned:  [${WIRE_MEASURES}] + [${WIRE_COUNTS}]\n`
            + `  derived: [${gotM}] + [${gotC}]\n`
            + '  The schema restructure changed which lanes are render-read or their '
            + 'order. If the wire format change is INTENDED, update WIRE_* in this '
            + 'file in the same commit and say so; otherwise the restructure broke '
            + 'the record and this error is doing its job.');
    }
    if ((gotM.length + gotC.length) * 4 !== WIRE_BYTES) {
        throw new Error(`record is ${(gotM.length + gotC.length) * 4} B, wire pin says ${WIRE_BYTES}`);
    }
}
const recM = WIRE_MEASURES.length;
const recC = WIRE_COUNTS.length;
const mojo = [
    banner('#'), '',
    '# ── The SLOT BUFFERS: six arrays, split twice ─────────────────────────────',
    "# static  = decode's output (pure function of the byte); positional = the",
    "# fold's render-read output; witness = fold interior no render path reads.",
    '# Decode NEVER touches positional or witness — that is the write-axis split.',
    '# LM/LC = layout measures/counts; SM = static measures; WM/WC = witness;',
    '# FLAGS is its own stride-1 array (flags[id], no lane constant needed).',
    `comptime SM_STRIDE = ${stM.stride}`,
    ...stM.lanes.map(l => `comptime SM_${l.name} = ${l.index}`),
    `comptime FLAGS_STRIDE = ${stC.stride}`, '',
    `comptime LM_STRIDE = ${poM.stride}`,
    ...poM.lanes.map(l => `comptime LM_${l.name} = ${l.index}`), '',
    `comptime LC_STRIDE = ${poC.stride}`,
    ...poC.lanes.map(l => `comptime LC_${l.name} = ${l.index}`), '',
    '# Witness arrays (read-axis split): stride-1, indexed by byte. The scan form',
    '# allocates them; the serial form only under its witness instantiation.',
    `comptime WM_STRIDE = ${wM.stride}`,
    `comptime WC_STRIDE = ${wC.stride}`, '',
    '# The RECORD format (the wire): unchanged by either split. A record is emitted',
    '# as three runs — posMeasures[0..3), staticMeasures[0..3), posCounts WHOLE —',
    '# a concatenation of truncations, still no lane map.',
    `comptime RECORD_MEASURE_STRIDE = ${recM}`,
    `comptime RECORD_COUNT_STRIDE = ${recC}`,
    `comptime RECORD_BYTES = ${recM * 4 + recC * 4}`, '',
    '# ── THE FIXTURE FORMAT — frozen on disk (format v2), independent of the',
    "#    container. Fixtures carry the oracle's VALUES in this order; the engine's",
    '#    buffers may be re-laid at will and the fixtures do not move.',
    `comptime FIXTURE_MEASURE_STRIDE = ${FIXTURE_MEASURES.length}`,
    ...FIXTURE_MEASURES.map((n, i) => `comptime FIX_M_${n} = ${i}`), '',
    `comptime FIXTURE_COUNT_STRIDE = ${FIXTURE_COUNTS.length}`,
    ...FIXTURE_COUNTS.map((n, i) => `comptime FIX_C_${n} = ${i}`), '',
    '# The scan partial (ScanElem) in a GPU buffer — same kind rule.',
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
    'def fixture_measure_lane_name(lane: Int) -> String:',
    '    \'\'\'FIXTURE lane name for diagnostics (fixture order, not container order).\'\'\'',
    ...FIXTURE_MEASURES.map((n, i) => `    if lane == ${i}:\n        return "${n}"`),
    '    return "M_?"', '',
    '',
    'def fixture_count_lane_name(lane: Int) -> String:',
    ...FIXTURE_COUNTS.map((n, i) => `    if lane == ${i}:\n        return "${n}"`),
    '    return "C_?"', '',
].join('\n');
writeFileSync(join(root, 'engine/glyph_schema.mojo'), mojo);

// ── JS: THE CONTRACT TIER, and only that ────────────────────────────────────
//
// This file used to emit MEASURE_STRIDE / COUNT_STRIDE / ITEM_STRIDE / PARTIAL_*
// and every lane index — the ENGINE'S CONTAINER, written into the renderer's
// package as though it were a shared contract. It never was. The render side runs
// one buffer at SLOT_STRIDE 12; the engine runs measures-8 + counts-4; the live JS
// item table is stride 15 against this file's 16.
//
// Nothing ever imported it, which is precisely how that 15-vs-16 mismatch survived:
// an unread contract cannot be violated, so the drift had nowhere to show up.
//
// validate() above already had the rule right — "another layer may realize the same
// kinds in a different container and stay conformant; what it owes is this same
// assertion over its own mapping." The rules were correct and the EMIT contradicted
// them. We wrote the principle down and generated its violation from the same script.
//
// THREE TIERS, and only the first two are anyone else's business:
//
//   PINNED BIT-FOR-BIT   the RECORD. It is the wire from a layout backend to a
//                        renderer, truncation invariant included.
//   SHARED SEMANTICS     lane KINDS, the exact/vertex-read sets, and the SET of
//                        item parameters. Properties of the pipeline, not of a buffer.
//   NOT PRESCRIBED       strides and lane indices. Internal working containers.
//                        They stay in engine/glyph_schema.mojo, which is the
//                        engine's realization and says so.
//
// The item-parameter SET is in the contract because layout freedom is not content
// freedom: two layers may store the same parameters differently, but a parameter one
// layer has and the other cannot express is behaviour the conformance corpus can
// never see — it only compares outputs on inputs both accept. PAGE_LINE_HEIGHT was
// exactly that, and was harmless only because it turned out to be dead.
const fieldKinds = {};
// PAD is container filler, not a field of the pipeline — it has no kind to share.
// The witness buffers are in this loop ON PURPOSE: LINE_ADV and ORD are fields
// of the pipeline (the fixtures carry them, the scan partial computes them) —
// the read-axis split moved their CONTAINER, not their existence. The proof the
// tiers are real: the commit that moved them regenerated this file byte-identical.
for (const buf of [poM, wM, poC, wC, stM, stC]) for (const l of buf.lanes) {
    if (l.name !== 'PAD') fieldKinds[l.name] = l.kind;
}
for (const l of it.measures.lanes) fieldKinds[l.name] ??= l.kind;
for (const l of ib.lanes) fieldKinds[l.name] ??= l.kind;
const quoted = (a) => `[${a.map(x => `'${x}'`).join(', ')}]`;

const js = [
    contractBanner('//'), '',
    '// ── PINNED BIT-FOR-BIT: the record is the wire ─────────────────────────────',
    '/** Per-glyph record: the bytes that cross from a layout backend to a renderer.',
    ' *  Order is part of the format. Emitting one is a TRUNCATION of whatever the',
    ' *  producer keeps internally, never a repack — validate() enforces that every',
    ' *  render-read field sorts before every unread one. */',
    `/** Every record field is one 4-byte carrier (f32 or u32); validate() refuses`,
    ` *  a schema where that stops being true, so RECORD_BYTES is DERIVED here and`,
    ` *  cannot silently disagree with the field lists below. */`,
    `export const RECORD_FIELD_BYTES = 4;`,
    `export const RECORD_BYTES = ${(recM + recC)} * RECORD_FIELD_BYTES;`,
    `export const RECORD_MEASURES = Object.freeze(${quoted(WIRE_MEASURES)});`,
    `export const RECORD_COUNTS = Object.freeze(${quoted(WIRE_COUNTS)});`,
    '',
    '// ── KNOWN DEVIATIONS: declared, justified, and still violations ────────────',
    '/** Fields whose kind is EXACT but which ride a float carrier TODAY, with the',
    ' *  reason. A layer asserting KIND needs this to tell a real violation from the',
    ' *  documented one — without it the contract states a rule that NO layer',
    ' *  currently satisfies, and the first assertion written against it fails for a',
    ' *  reason its author cannot act on. Deviations are debts, not exemptions. */',
    `export const KNOWN_DEVIATIONS = Object.freeze({`,
    ...[...stM.lanes, ...stC.lanes, ...poM.lanes, ...poC.lanes].filter(l => l.misplaced).map(l => `    ${l.name}: ${JSON.stringify(l.misplaced)},`),
    `});`,
    '',
    '// ── SHARED SEMANTICS: kinds, not containers ────────────────────────────────',
    '/** KIND per field. Every layer must ASSERT its own mapping respects these —',
    ' *  that assertion is what a layer owes; its lane numbering is its own affair. */',
    `export const KIND = Object.freeze({`,
    ...Object.entries(fieldKinds).map(([k, v]) => `    ${k}: '${v}',`),
    `});`,
    '',
    '/** EXACT fields: counts, identities and bitfields. Must never ride a float',
    ' *  carrier — and a float ordered key IS a float carrier wearing a u32 costume. */',
    `export const EXACT_FIELDS = Object.freeze(${quoted(Object.keys(fieldKinds).filter(k => fieldKinds[k] !== 'measure'))});`,
    `export const MEASURE_FIELDS = Object.freeze(${quoted(Object.keys(fieldKinds).filter(k => fieldKinds[k] === 'measure'))});`,
    '/** MEASURE_FIELDS and EXACT_FIELDS are DISJOINT and EXHAUSTIVE over KIND —',
    ' *  asserted by the generator, so a consumer that classifies lanes in two',
    ' *  buckets can rely on totality. KIND keeps the finer distinction (identity vs',
    ' *  count vs bitfield) for anyone who needs it; nobody has to handle a third',
    ' *  bucket to stay correct. */',
    '',
    '/** Fields the vertex path reads. */',
    `export const VERTEX_READ = Object.freeze(${quoted([...rbv(poM), ...rbv(stM), ...rbv(poC), ...rbv(stC)])});`,
    '',
    '/** The SET of per-item layout parameters both layers must be able to express.',
    ' *  Names and kinds only — where they sit in anyone\'s item table is not shared. */',
    `export const ITEM_PARAMS = Object.freeze(${quoted(schema.itemParams.params.map(p => p.name))});`,
    '',
    '/** Per-item bounds fields, and which of them are exact (never an ordered key). */',
    `export const BOUNDS_FIELDS = Object.freeze(${quoted(ib.lanes.map(l => l.name))});`,
    `export const BOUNDS_EXACT_FIELDS = Object.freeze(${quoted(ib.lanes.filter(l => l.kind !== 'measure').map(l => l.name))});`,
    '',
].join('\n');
writeFileSync(join(root, 'packages/glyph3d-core/src/compute/glyphContract.js'), js);

// ── The ENGINE'S container, in JS, for the ENGINE'S tooling ─────────────────
// engine/fixtures/gen.mjs needs the FIXTURE strides to lay out the fixture
// buffers. It used to import them from the renderer's package — a description of
// this backend's container, living in another layer's tree, imported across the
// boundary the wrong way round. That single import is also why "nothing consumes
// glyphSchema.js" was wrong: both of us grepped packages/ and app/ and neither
// looked in engine/, which is where the one consumer was.
const engineJs = [
    banner('//'), '',
    '// ── THE FIXTURE FORMAT (frozen, v2) — what gen.mjs writes to disk ─────────',
    `export const FIXTURE_MEASURE_STRIDE = ${FIXTURE_MEASURES.length};`,
    ...FIXTURE_MEASURES.map((n, i) => `export const FIX_M_${n} = ${i};`), '',
    `export const FIXTURE_COUNT_STRIDE = ${FIXTURE_COUNTS.length};`,
    ...FIXTURE_COUNTS.map((n, i) => `export const FIX_C_${n} = ${i};`), '',
    '// ── This backend\'s WORKING container (the phase split) ────────────────────',
    `export const SM_STRIDE = ${stM.stride};`,
    ...stM.lanes.map(l => `export const SM_${l.name} = ${l.index};`), '',
    `export const LM_STRIDE = ${poM.stride};`,
    ...poM.lanes.map(l => `export const LM_${l.name} = ${l.index};`), '',
    `export const LC_STRIDE = ${poC.stride};`,
    ...poC.lanes.map(l => `export const LC_${l.name} = ${l.index};`), '',
    `export const RECORD_MEASURE_STRIDE = ${recM};`,
    `export const RECORD_COUNT_STRIDE = ${recC};`, '',
    `export const ITEM_STRIDE = ${it.measures.stride};`,
    ...it.measures.lanes.map(l => `export const I_${l.name} = ${l.index};`), '',
    `export const BOUNDS_STRIDE = ${ib.stride};`,
    ...ib.lanes.map(l => `export const B_${l.name} = ${l.index};`), '',
].join('\n');
writeFileSync(join(root, 'engine/glyph_schema.mjs'), engineJs);

console.log(`schema ok — static ${stM.stride}f32+${stC.stride}u32, positional ${poM.stride}f32+${poC.stride}u32;`
    + ` record = ${recM}+${recC} lanes, ${recM * 4 + recC * 4} B/glyph; fixture format ${FIXTURE_MEASURES.length}+${FIXTURE_COUNTS.length} (frozen)`);
console.log('  wrote engine/glyph_schema.mojo');
console.log('  wrote packages/glyph3d-core/src/compute/glyphContract.js (contract tier only)');
console.log('  wrote engine/glyph_schema.mjs (this backend + fixture format, for engine tooling)');
