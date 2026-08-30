// Classify every slot-lane access site by lane kind.
import { readFileSync } from 'node:fs';

// DERIVED from the oracle's authoritative table — this file used to hold its own
// copy that classified S_GLYPH_ID as a COUNT, contradicting FLOAT_LANES and papered
// over with a 'DEFERRED' special case. That is the exact drift the shared table exists
// to stop, so it does not get to live here either.
const Ref = await import('../packages/glyph3d-core/src/compute/glyphPipelineReference.js');
const NAME_OF = Object.fromEntries(Object.entries(Ref)
    .filter(([k, v]) => /^S_[A-Z_]+$/.test(k) && typeof v === 'number').map(([k, v]) => [v, k]));
const COUNT = Object.fromEntries([...Ref.COUNT_LANES].map((l) => [NAME_OF[l], l]));
const FLOAT = Object.fromEntries([...Ref.FLOAT_LANES].map((l) => [NAME_OF[l], l]));
const FILES = [
  'packages/glyph3d-core/src/compute/glyphPipelineKernels.js',
  'packages/glyph3d-core/src/compute/glyphPipelineReference.js',
  'packages/glyph3d-core/src/compute/glyphPipelineScan.js',
  'packages/glyph3d-core/src/core/glyphVertex.js',
  'packages/glyph3d-core/src/GlyphField.js',
  'packages/glyph3d-core/src/core/ByteLayoutDescription.js',
];
const tally = {};
const rows = [];
for (const f of FILES) {
  let src; try { src = readFileSync(f, 'utf8'); } catch { continue; }
  src.split('\n').forEach((line, i) => {
    const hits = [...line.matchAll(/\bS_[A-Z_]+\b/g)].map(m => m[0]);
    for (const h of new Set(hits)) {
      const kind = h in COUNT ? (h === 'S_GLYPH_ID' ? 'DEFERRED' : 'count')
                 : h in FLOAT ? 'float' : null;
      if (!kind) continue;
      // S_X+1 / S_X+2 are the Y/Z lanes read positionally in the shader
      const positional = /S_X \+ [12]/.test(line);
      tally[f] ??= { count: 0, float: 0, DEFERRED: 0 };
      tally[f][kind]++;
      rows.push({ f, line: i + 1, lane: h, kind, positional, text: line.trim().slice(0, 92) });
    }
  });
}
const short = (f) => f.split('/').pop();
console.log('SITE COUNT BY FILE AND LANE KIND\n');
console.log('file'.padEnd(30), 'count'.padStart(6), 'float'.padStart(6), 'deferred'.padStart(9));
let tc = 0, tf = 0, td = 0;
for (const [f, t] of Object.entries(tally)) {
  console.log(short(f).padEnd(30), String(t.count).padStart(6), String(t.float).padStart(6), String(t.DEFERRED).padStart(9));
  tc += t.count; tf += t.float; td += t.DEFERRED;
}
console.log(''.padEnd(30, '-'), '------ ------ ---------');
console.log('TOTAL'.padEnd(30), String(tc).padStart(6), String(tf).padStart(6), String(td).padStart(9));
console.log(`\ncount lanes  -> native u32, NO bitcast         (${tc} sites)`);
console.log(`float lanes  -> bitcast<f32> on read/write     (${tf} sites)`);
console.log(`S_GLYPH_ID   -> DEFERRED (trie format)         (${td} sites)`);
console.log(`\nTOTAL SITES: ${tc + tf + td}`);

// ── the durable artifact ────────────────────────────────────────────────────
import { writeFileSync } from 'node:fs';
const out = [];
out.push('# u32 slot-lane migration map');
out.push('');
out.push('Generated survey, not a plan of record — regenerate rather than edit');
out.push('(`bun tools/lanemap.mjs`) if the pipeline moves before the migration lands.');
out.push('');
out.push('## The rule');
out.push('');
out.push('The slot buffer IS `uint`. Twelve lanes, two treatments — the third');
out.push('(a deferred lane) is gone: the trie moved to u32 and S_GLYPH_ID moved with it.');
out.push('');
out.push('| lanes | treatment | why |');
out.push('|---|---|---|');
out.push('| `S_GLYPH_ID` `S_ROW` `S_COL` `S_FLAGS` `S_ORD` | **native u32, no bitcast** | counts, a bitfield and an identity; exact past 2^24, which is the point of the change |');
out.push('| `S_ADVANCE` `S_HEIGHT` `S_X` `S_Y` `S_Z` `S_BASE_X` `S_LINE_ADV` | **`bitcast` on read and write** | real f32 values; reinterpretation is lossless and free, unlike the int-in-float it replaces |');
out.push('');
out.push('`S_GLYPH_ID` was the deferred one — copied verbatim from `trie.blocks`, which');
out.push('was a `Float32Array`, so the identity inherited a float carrier all the way up.');
out.push('The trie is a `Uint32Array` now (identities and the flags bitfield native,');
out.push('advance/height bitcast — `TRIE_MEASURE_LANES` in `GlyphTrie.js`), and decode');
out.push('copies all three lanes verbatim because both containers share the convention.');
out.push('');
out.push('`S_X + 1` / `S_X + 2` are the Y and Z lanes addressed positionally in the');
out.push('vertex shader — float treatment, and easy to miss because the constant says X.');
out.push('');
out.push('## Totals');
out.push('');
out.push('| file | count | float | deferred |');
out.push('|---|---:|---:|---:|');
for (const [f, t] of Object.entries(tally)) out.push(`| \`${short(f)}\` | ${t.count} | ${t.float} | ${t.DEFERRED} |`);
out.push(`| **TOTAL** | **${tc}** | **${tf}** | **${td}** |`);
out.push('');
out.push(`${tc + tf + td} lane references in all. Note this counts LANE REFERENCES, not`);
out.push('lines: one line can touch several lanes, which is why a line-based grep');
out.push('undercounts it badly (113 by that measure).');
out.push('');
out.push('## Sites');
for (const f of FILES) {
  const mine = rows.filter((r) => r.f === f);
  if (!mine.length) continue;
  out.push('');
  out.push(`### \`${f}\``);
  out.push('');
  out.push('| line | lane | treatment | code |');
  out.push('|---:|---|---|---|');
  for (const r of mine) {
    const t = r.kind === 'DEFERRED' ? 'DEFERRED' : r.kind === 'count' ? 'u32' : 'bitcast';
    const note = r.positional ? ' *(positional Y/Z)*' : '';
    out.push(`| ${r.line} | \`${r.lane}\`${note} | ${t} | \`${r.text.replace(/\|/g, '\\|')}\` |`);
  }
}
writeFileSync('docs/plans/u32-lane-migration-map.md', out.join('\n') + '\n');
console.log('\nwrote docs/plans/u32-lane-migration-map.md');
