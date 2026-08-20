# u32 slot-lane migration map

Generated survey, not a plan of record — regenerate rather than edit
(`bun tools/lanemap.mjs`) if the pipeline moves before the migration lands.

## The rule

The slot buffer becomes `uint`. Twelve lanes, three treatments:

| lanes | treatment | why |
|---|---|---|
| `S_ROW` `S_COL` `S_FLAGS` `S_ORD` | **native u32, no bitcast** | genuine counts; exact past 2^24, which is the point of the change |
| `S_ADVANCE` `S_HEIGHT` `S_X` `S_Y` `S_Z` `S_BASE_X` `S_LINE_ADV` | **`bitcast` on read and write** | real f32 values; reinterpretation is lossless and free, unlike the int-in-float it replaces |
| `S_GLYPH_ID` | **DEFERRED** | copied straight from `trie.blocks` (a Float32Array); moving it is a trie/atlas format change, scoped separately |

`S_X + 1` / `S_X + 2` are the Y and Z lanes addressed positionally in the
vertex shader — float treatment, and easy to miss because the constant says X.

## Totals

| file | count | float | deferred |
|---|---:|---:|---:|
| `glyphPipelineKernels.js` | 26 | 27 | 4 |
| `glyphPipelineReference.js` | 28 | 47 | 4 |
| `glyphPipelineScan.js` | 12 | 4 | 0 |
| `glyphVertex.js` | 4 | 8 | 2 |
| `GlyphField.js` | 2 | 0 | 0 |
| `ByteLayoutDescription.js` | 1 | 11 | 0 |
| **TOTAL** | **73** | **97** | **10** |

180 lane references in all. Note this counts LANE REFERENCES, not
lines: one line can touch several lanes, which is why a line-based grep
undercounts it badly (113 by that measure).

## Sites

### `packages/glyph3d-core/src/compute/glyphPipelineKernels.js`

| line | lane | treatment | code |
|---:|---|---|---|
| 77 | `S_GLYPH_ID` | DEFERRED | `SLOT_STRIDE, S_GLYPH_ID, S_ADVANCE, S_HEIGHT,` |
| 77 | `S_ADVANCE` | bitcast | `SLOT_STRIDE, S_GLYPH_ID, S_ADVANCE, S_HEIGHT,` |
| 77 | `S_HEIGHT` | bitcast | `SLOT_STRIDE, S_GLYPH_ID, S_ADVANCE, S_HEIGHT,` |
| 78 | `S_X` | bitcast | `S_X, S_Y, S_Z, S_ROW, S_COL, S_FLAGS, S_BASE_X, S_LINE_ADV, S_ORD, F_NEWLINE,` |
| 78 | `S_Y` | bitcast | `S_X, S_Y, S_Z, S_ROW, S_COL, S_FLAGS, S_BASE_X, S_LINE_ADV, S_ORD, F_NEWLINE,` |
| 78 | `S_Z` | bitcast | `S_X, S_Y, S_Z, S_ROW, S_COL, S_FLAGS, S_BASE_X, S_LINE_ADV, S_ORD, F_NEWLINE,` |
| 78 | `S_ROW` | u32 | `S_X, S_Y, S_Z, S_ROW, S_COL, S_FLAGS, S_BASE_X, S_LINE_ADV, S_ORD, F_NEWLINE,` |
| 78 | `S_COL` | u32 | `S_X, S_Y, S_Z, S_ROW, S_COL, S_FLAGS, S_BASE_X, S_LINE_ADV, S_ORD, F_NEWLINE,` |
| 78 | `S_FLAGS` | u32 | `S_X, S_Y, S_Z, S_ROW, S_COL, S_FLAGS, S_BASE_X, S_LINE_ADV, S_ORD, F_NEWLINE,` |
| 78 | `S_BASE_X` | bitcast | `S_X, S_Y, S_Z, S_ROW, S_COL, S_FLAGS, S_BASE_X, S_LINE_ADV, S_ORD, F_NEWLINE,` |
| 78 | `S_LINE_ADV` | bitcast | `S_X, S_Y, S_Z, S_ROW, S_COL, S_FLAGS, S_BASE_X, S_LINE_ADV, S_ORD, F_NEWLINE,` |
| 78 | `S_ORD` | u32 | `S_X, S_Y, S_Z, S_ROW, S_COL, S_FLAGS, S_BASE_X, S_LINE_ADV, S_ORD, F_NEWLINE,` |
| 199 | `S_ORD` | u32 | `// S_ORD (and every count lane) must stay exact in an f32 slot lane.` |
| 344 | `S_FLAGS` | u32 | `slots.element(o0.add(uint(S_FLAGS))).assign(float(0));` |
| 350 | `S_ADVANCE` | bitcast | `slots.element(o0.add(uint(S_ADVANCE))).assign(float(0));` |
| 351 | `S_HEIGHT` | bitcast | `slots.element(o0.add(uint(S_HEIGHT))).assign(float(0));` |
| 387 | `S_GLYPH_ID` | DEFERRED | `slots.element(o.add(uint(S_GLYPH_ID))).assign(glyphId);` |
| 388 | `S_ADVANCE` | bitcast | `slots.element(o.add(uint(S_ADVANCE))).assign(advance);` |
| 389 | `S_HEIGHT` | bitcast | `slots.element(o.add(uint(S_HEIGHT))).assign(height);` |
| 395 | `S_FLAGS` | u32 | `slots.element(o.add(uint(S_FLAGS)))` |
| 572 | `S_FLAGS` | u32 | `const flags = int(S.element(o.add(uint(S_FLAGS)))).toVar('lfFlags');` |
| 598 | `S_ADVANCE` | bitcast | `acc.tailAdv.addAssign(S.element(o.add(uint(S_ADVANCE))));` |
| 729 | `S_FLAGS` | u32 | `const flags = int(S.element(o.add(uint(S_FLAGS)))).toVar('aFlags');` |
| 751 | `S_ROW` | u32 | `S.element(o.add(uint(S_ROW))).assign(row.toFloat());` |
| 752 | `S_COL` | u32 | `S.element(o.add(uint(S_COL))).assign(col.toFloat());` |
| 753 | `S_LINE_ADV` | bitcast | `S.element(o.add(uint(S_LINE_ADV))).assign(acc.tailAdv);` |
| 754 | `S_ORD` | u32 | `S.element(o.add(uint(S_ORD))).assign(acc.glyphs.toFloat());` |
| 755 | `S_FLAGS` | u32 | `S.element(o.add(uint(S_FLAGS))).assign(float(flags.bitOr(int(F_RENDERED))));` |
| 758 | `S_FLAGS` | u32 | `S.element(o.add(uint(S_FLAGS))).assign(float(0));` |
| 775 | `S_LINE_ADV` | bitcast | `* Foldless: x is the line prefix (S_LINE_ADV), exact at any line length — the case` |
| 793 | `S_FLAGS` | u32 | `If(int(lane(id, S_FLAGS)).bitAnd(int(F_LEADER)).equal(int(0)), () => { Return(); });` |
| 806 | `S_COL` | u32 | `const col = int(lane(id, S_COL)).toVar('col');` |
| 807 | `S_ORD` | u32 | `const ord = int(lane(id, S_ORD)).toVar('ord');` |
| 808 | `S_ROW` | u32 | `const row = lane(id, S_ROW).toVar('row');` |
| 818 | `S_ADVANCE` | bitcast | `x.addAssign(lane(q, S_ADVANCE));` |
| 822 | `S_LINE_ADV` | bitcast | `x.assign(lane(id, S_LINE_ADV));` |
| 828 | `S_BASE_X` | bitcast | `S.element(o.add(uint(S_BASE_X))).assign(x.add(originX));` |
| 829 | `S_X` | bitcast | `S.element(o.add(uint(S_X))).assign(x.add(originX));` |
| 830 | `S_Y` | bitcast | `S.element(o.add(uint(S_Y))).assign(row.negate().mul(lineHeight).add(originY));` |
| 831 | `S_Z` | bitcast | `S.element(o.add(uint(S_Z))).assign(originZ.sub(wrapRow.toFloat().mul(zWrapStep)));` |
| 885 | `S_FLAGS` | u32 | `If(int(lane(id, S_FLAGS)).bitAnd(int(F_LEADER)).equal(int(0)), () => { Return(); });` |
| 907 | `S_ROW` | u32 | `const row = int(lane(id, S_ROW)).toVar('row');` |
| 908 | `S_COL` | u32 | `const col = int(lane(id, S_COL)).toVar('col');` |
| 916 | `S_BASE_X` | bitcast | `const x = lane(id, S_BASE_X).toVar('x');` |
| 939 | `S_X` | bitcast | `S.element(o.add(uint(S_X))).assign(xf);` |
| 940 | `S_Y` | bitcast | `S.element(o.add(uint(S_Y))).assign(yf);` |
| 941 | `S_Z` | bitcast | `S.element(o.add(uint(S_Z))).assign(zf);` |
| 945 | `S_ADVANCE` | bitcast | `const w = lane(id, S_ADVANCE).toVar('w');` |
| 946 | `S_HEIGHT` | bitcast | `const h = lane(id, S_HEIGHT).toVar('h');` |
| 1123 | `S_ROW` | u32 | `* Reads apply's S_ROW/S_COL + decode's S_GLYPH_ID (previous dispatches — the race` |
| 1123 | `S_COL` | u32 | `* Reads apply's S_ROW/S_COL + decode's S_GLYPH_ID (previous dispatches — the race` |
| 1123 | `S_GLYPH_ID` | DEFERRED | `* Reads apply's S_ROW/S_COL + decode's S_GLYPH_ID (previous dispatches — the race` |
| 1140 | `S_FLAGS` | u32 | `const flags = int(S.element(o.add(uint(S_FLAGS))));` |
| 1149 | `S_GLYPH_ID` | DEFERRED | `const gid = uint(S.element(o.add(uint(S_GLYPH_ID)))).toVar('fGid');` |
| 1156 | `S_COL` | u32 | `const tx = int(S.element(o.add(uint(S_COL))).div(cpt)).clamp(int(0), int(FAR_SLAB - 1));` |
| 1157 | `S_ROW` | u32 | `const ty = int(S.element(o.add(uint(S_ROW))).div(rpt)).clamp(int(0), int(FAR_SLAB - 1));` |
| 1440 | `S_BASE_X` | bitcast | `*  reconstructive (S_BASE_X + integer lanes): safe to call repeatedly with any` |

### `packages/glyph3d-core/src/compute/glyphPipelineReference.js`

| line | lane | treatment | code |
|---:|---|---|---|
| 71 | `S_ROW` | u32 | `* The fold pass (scan on the GPU, serial here) writes ONLY the exact lanes — S_ROW,` |
| 72 | `S_COL` | u32 | `* S_COL, S_LINE_ADV, S_ORD. resolveX turns them into the fold-relative S_BASE_X (plus` |
| 72 | `S_LINE_ADV` | bitcast | `* S_COL, S_LINE_ADV, S_ORD. resolveX turns them into the fold-relative S_BASE_X (plus` |
| 72 | `S_ORD` | u32 | `* S_COL, S_LINE_ADV, S_ORD. resolveX turns them into the fold-relative S_BASE_X (plus` |
| 72 | `S_BASE_X` | bitcast | `* S_COL, S_LINE_ADV, S_ORD. resolveX turns them into the fold-relative S_BASE_X (plus` |
| 73 | `S_X` | bitcast | `* the unpaginated S_X/S_Y/S_Z), and paginate remaps from S_BASE_X + integers. Each` |
| 73 | `S_Y` | bitcast | `* the unpaginated S_X/S_Y/S_Z), and paginate remaps from S_BASE_X + integers. Each` |
| 73 | `S_Z` | bitcast | `* the unpaginated S_X/S_Y/S_Z), and paginate remaps from S_BASE_X + integers. Each` |
| 73 | `S_BASE_X` | bitcast | `* the unpaginated S_X/S_Y/S_Z), and paginate remaps from S_BASE_X + integers. Each` |
| 78 | `S_GLYPH_ID` | DEFERRED | `export const S_GLYPH_ID = 0;` |
| 79 | `S_ADVANCE` | bitcast | `export const S_ADVANCE = 1;` |
| 80 | `S_HEIGHT` | bitcast | `export const S_HEIGHT = 2;` |
| 81 | `S_X` | bitcast | `export const S_X = 3;` |
| 82 | `S_Y` | bitcast | `export const S_Y = 4;` |
| 83 | `S_Z` | bitcast | `export const S_Z = 5;` |
| 84 | `S_ROW` | u32 | `export const S_ROW = 6;      // exact: the glyph's visual row (wrap segments included)` |
| 85 | `S_COL` | u32 | `export const S_COL = 7;      // exact: glyphs since the last newline` |
| 86 | `S_FLAGS` | u32 | `export const S_FLAGS = 8;` |
| 87 | `S_BASE_X` | bitcast | `export const S_BASE_X = 9;   // resolveX's fold-relative x (+ item origin), written once —` |
| 90 | `S_LINE_ADV` | bitcast | `export const S_LINE_ADV = 10; // exact fold: f32 advance sum since line start (exclusive).` |
| 92 | `S_ORD` | u32 | `export const S_ORD = 11;      // exact fold: item-relative leader ordinal (newlines` |
| 97 | `S_FLAGS` | u32 | `// "is this a newline?" — is a decode-time fact and rides S_FLAGS as F_NEWLINE.` |
| 178 | `S_ADVANCE` | bitcast | `slots[o + S_ADVANCE] = 0;` |
| 179 | `S_HEIGHT` | bitcast | `slots[o + S_HEIGHT] = 0;` |
| 192 | `S_GLYPH_ID` | DEFERRED | `slots[o + S_GLYPH_ID] = g.glyphId;` |
| 193 | `S_ADVANCE` | bitcast | `slots[o + S_ADVANCE] = g.advance;` |
| 194 | `S_HEIGHT` | bitcast | `slots[o + S_HEIGHT] = g.height;` |
| 195 | `S_FLAGS` | u32 | `slots[o + S_FLAGS] = F_LEADER` |
| 259 | `S_FLAGS` | u32 | `const flags = slots[o + S_FLAGS];` |
| 264 | `S_ROW` | u32 | `slots[o + S_ROW] = row;` |
| 265 | `S_COL` | u32 | `slots[o + S_COL] = col;` |
| 266 | `S_LINE_ADV` | bitcast | `slots[o + S_LINE_ADV] = lineAdv;` |
| 267 | `S_ORD` | u32 | `slots[o + S_ORD] = ord;` |
| 268 | `S_BASE_X` | bitcast | `slots[o + S_BASE_X] = x + ox;` |
| 269 | `S_X` | bitcast | `slots[o + S_X] = x + ox;` |
| 270 | `S_Y` | bitcast | `slots[o + S_Y] = -row * (params.lineHeight ?? slots[o + S_HEIGHT]) + oy;` |
| 270 | `S_HEIGHT` | bitcast | `slots[o + S_Y] = -row * (params.lineHeight ?? slots[o + S_HEIGHT]) + oy;` |
| 271 | `S_Z` | bitcast | `slots[o + S_Z] = -wrapRow * zStep + oz;` |
| 272 | `S_FLAGS` | u32 | `slots[o + S_FLAGS] = flags \| F_RENDERED;` |
| 292 | `S_ADVANCE` | bitcast | `lineAdv += slots[o + S_ADVANCE];` |
| 294 | `S_ADVANCE` | bitcast | `: Math.fround(segAdv + slots[o + S_ADVANCE]);` |
| 308 | `S_LINE_ADV` | bitcast | `* prefixes. Foldless, x IS the line prefix (S_LINE_ADV).` |
| 314 | `S_BASE_X` | bitcast | `* Cross-thread reads: previous passes' lanes + the ordinal map. Writes: S_BASE_X,` |
| 315 | `S_X` | bitcast | `* S_X/S_Y/S_Z, the scalar reduce. Read set and write set are disjoint lanes —` |
| 315 | `S_Y` | bitcast | `* S_X/S_Y/S_Z, the scalar reduce. Read set and write set are disjoint lanes —` |
| 315 | `S_Z` | bitcast | `* S_X/S_Y/S_Z, the scalar reduce. Read set and write set are disjoint lanes —` |
| 325 | `S_FLAGS` | u32 | `if ((slots[o + S_FLAGS] & F_LEADER) === 0) return;` |
| 328 | `S_COL` | u32 | `const col = slots[o + S_COL];` |
| 329 | `S_ORD` | u32 | `const ord = slots[o + S_ORD];` |
| 339 | `S_ADVANCE` | bitcast | `x = Math.fround(x + slots[q * SLOT_STRIDE + S_ADVANCE]);` |
| 342 | `S_LINE_ADV` | bitcast | `x = slots[o + S_LINE_ADV];` |
| 345 | `S_ROW` | u32 | `const row = slots[o + S_ROW];` |
| 347 | `S_BASE_X` | bitcast | `slots[o + S_BASE_X] = x + (p.origin?.x \|\| 0);` |
| 348 | `S_X` | bitcast | `slots[o + S_X] = x + (p.origin?.x \|\| 0);` |
| 349 | `S_Y` | bitcast | `slots[o + S_Y] = -row * (p.lineHeight ?? slots[o + S_HEIGHT]) + (p.origin?.y \|\| 0);` |
| 349 | `S_HEIGHT` | bitcast | `slots[o + S_Y] = -row * (p.lineHeight ?? slots[o + S_HEIGHT]) + (p.origin?.y \|\| 0);` |
| 350 | `S_Z` | bitcast | `slots[o + S_Z] = -wrapRow * (p.zStep \|\| 0) + (p.origin?.z \|\| 0);` |
| 394 | `S_BASE_X` | bitcast | `* The remap is RECONSTRUCTIVE, never accumulative: x reads the untouched S_BASE_X, and` |
| 407 | `S_FLAGS` | u32 | `if ((slots[o + S_FLAGS] & F_LEADER) === 0) return;` |
| 414 | `S_ROW` | u32 | `const row = slots[o + S_ROW], col = slots[o + S_COL];` |
| 414 | `S_COL` | u32 | `const row = slots[o + S_ROW], col = slots[o + S_COL];` |
| 434 | `S_X` | bitcast | `slots[o + S_X] = slots[o + S_BASE_X] + (yPage % wide) * (p.pageStrideX \|\| 0);` |
| 434 | `S_BASE_X` | bitcast | `slots[o + S_X] = slots[o + S_BASE_X] + (yPage % wide) * (p.pageStrideX \|\| 0);` |
| 435 | `S_Y` | bitcast | `slots[o + S_Y] = oy - (screenRow - yPage * rows) * p.lineHeight - band * (p.bandStrideY \|\| 0` |
| 436 | `S_Z` | bitcast | `slots[o + S_Z] = oz - seg * (p.zStep \|\| 0) + band * (p.depthPerBand \|\| 0) + xPage * (p.depth` |
| 449 | `S_FLAGS` | u32 | `if ((slots[o + S_FLAGS] & F_LEADER) === 0) return;` |
| 450 | `S_X` | bitcast | `const x = slots[o + S_X], y = slots[o + S_Y], z = slots[o + S_Z];` |
| 450 | `S_Y` | bitcast | `const x = slots[o + S_X], y = slots[o + S_Y], z = slots[o + S_Z];` |
| 450 | `S_Z` | bitcast | `const x = slots[o + S_X], y = slots[o + S_Y], z = slots[o + S_Z];` |
| 451 | `S_ADVANCE` | bitcast | `const w = slots[o + S_ADVANCE], h = slots[o + S_HEIGHT];` |
| 451 | `S_HEIGHT` | bitcast | `const w = slots[o + S_ADVANCE], h = slots[o + S_HEIGHT];` |
| 532 | `S_FLAGS` | u32 | `if ((slots[id * SLOT_STRIDE + S_FLAGS] & F_LEADER) !== 0) leaders++;` |
| 596 | `S_ROW` | u32 | `// K10b farNormalize) that read ONLY previous-dispatch lanes (apply's S_ROW/S_COL,` |
| 596 | `S_COL` | u32 | `// K10b farNormalize) that read ONLY previous-dispatch lanes (apply's S_ROW/S_COL,` |
| 597 | `S_GLYPH_ID` | DEFERRED | `// decode's S_GLYPH_ID) plus CPU-written lanes (instanceColor via a storage view, the` |
| 635 | `S_FLAGS` | u32 | `const flags = slots[o + S_FLAGS] \| 0;` |
| 644 | `S_ROW` | u32 | `const row = slots[o + S_ROW], col = slots[o + S_COL];` |
| 644 | `S_COL` | u32 | `const row = slots[o + S_ROW], col = slots[o + S_COL];` |
| 648 | `S_GLYPH_ID` | DEFERRED | `const d = densityAt(slots[o + S_GLYPH_ID] \| 0) \|\| 0;` |

### `packages/glyph3d-core/src/compute/glyphPipelineScan.js`

| line | lane | treatment | code |
|---:|---|---|---|
| 58 | `S_ADVANCE` | bitcast | `SLOT_STRIDE, S_ADVANCE, S_ROW, S_COL, S_FLAGS, S_LINE_ADV, S_ORD,` |
| 58 | `S_ROW` | u32 | `SLOT_STRIDE, S_ADVANCE, S_ROW, S_COL, S_FLAGS, S_LINE_ADV, S_ORD,` |
| 58 | `S_COL` | u32 | `SLOT_STRIDE, S_ADVANCE, S_ROW, S_COL, S_FLAGS, S_LINE_ADV, S_ORD,` |
| 58 | `S_FLAGS` | u32 | `SLOT_STRIDE, S_ADVANCE, S_ROW, S_COL, S_FLAGS, S_LINE_ADV, S_ORD,` |
| 58 | `S_LINE_ADV` | bitcast | `SLOT_STRIDE, S_ADVANCE, S_ROW, S_COL, S_FLAGS, S_LINE_ADV, S_ORD,` |
| 58 | `S_ORD` | u32 | `SLOT_STRIDE, S_ADVANCE, S_ROW, S_COL, S_FLAGS, S_LINE_ADV, S_ORD,` |
| 100 | `S_FLAGS` | u32 | `(slots[o + S_FLAGS] & F_NEWLINE) !== 0,` |
| 101 | `S_ADVANCE` | bitcast | `slots[o + S_ADVANCE],` |
| 102 | `S_FLAGS` | u32 | `(slots[o + S_FLAGS] & F_LEADER) !== 0,` |
| 243 | `S_FLAGS` | u32 | `const flags = slots[o + S_FLAGS];` |
| 246 | `S_ROW` | u32 | `slots[o + S_ROW] = v.row;` |
| 247 | `S_COL` | u32 | `slots[o + S_COL] = v.col;` |
| 248 | `S_LINE_ADV` | bitcast | `slots[o + S_LINE_ADV] = v.lineAdv;` |
| 249 | `S_ORD` | u32 | `slots[o + S_ORD] = v.ord;` |
| 250 | `S_FLAGS` | u32 | `slots[o + S_FLAGS] = flags \| F_RENDERED;` |
| 298 | `S_FLAGS` | u32 | `if ((slots[id * SLOT_STRIDE + S_FLAGS] & F_LEADER) !== 0) leaders++;` |

### `packages/glyph3d-core/src/core/glyphVertex.js`

| line | lane | treatment | code |
|---:|---|---|---|
| 32 | `S_GLYPH_ID` | DEFERRED | `import { SLOT_STRIDE, S_GLYPH_ID, S_ADVANCE, S_HEIGHT, S_X, S_ROW, S_COL } from '../compute/` |
| 32 | `S_ADVANCE` | bitcast | `import { SLOT_STRIDE, S_GLYPH_ID, S_ADVANCE, S_HEIGHT, S_X, S_ROW, S_COL } from '../compute/` |
| 32 | `S_HEIGHT` | bitcast | `import { SLOT_STRIDE, S_GLYPH_ID, S_ADVANCE, S_HEIGHT, S_X, S_ROW, S_COL } from '../compute/` |
| 32 | `S_X` | bitcast | `import { SLOT_STRIDE, S_GLYPH_ID, S_ADVANCE, S_HEIGHT, S_X, S_ROW, S_COL } from '../compute/` |
| 32 | `S_ROW` | u32 | `import { SLOT_STRIDE, S_GLYPH_ID, S_ADVANCE, S_HEIGHT, S_X, S_ROW, S_COL } from '../compute/` |
| 32 | `S_COL` | u32 | `import { SLOT_STRIDE, S_GLYPH_ID, S_ADVANCE, S_HEIGHT, S_X, S_ROW, S_COL } from '../compute/` |
| 200 | `S_ADVANCE` | bitcast | `// zeroed size lanes — decode re-zeroes S_ADVANCE/S_HEIGHT every run (a rewritten` |
| 200 | `S_HEIGHT` | bitcast | `// zeroed size lanes — decode re-zeroes S_ADVANCE/S_HEIGHT every run (a rewritten` |
| 206 | `S_X` *(positional Y/Z)* | bitcast | `iPos     = vec4(byteSlots.element(base.add(int(S_X))), byteSlots.element(base.add(int(S_X + ` |
| 207 | `S_ADVANCE` | bitcast | `iSize    = vec2(byteSlots.element(base.add(int(S_ADVANCE))), byteSlots.element(base.add(int(` |
| 207 | `S_HEIGHT` | bitcast | `iSize    = vec2(byteSlots.element(base.add(int(S_ADVANCE))), byteSlots.element(base.add(int(` |
| 208 | `S_GLYPH_ID` | DEFERRED | `iGlyphId = byteSlots.element(base.add(int(S_GLYPH_ID)));` |
| 212 | `S_ROW` | u32 | `iRowCol  = vec2(byteSlots.element(base.add(int(S_ROW))), byteSlots.element(base.add(int(S_CO` |
| 212 | `S_COL` | u32 | `iRowCol  = vec2(byteSlots.element(base.add(int(S_ROW))), byteSlots.element(base.add(int(S_CO` |

### `packages/glyph3d-core/src/GlyphField.js`

| line | lane | treatment | code |
|---:|---|---|---|
| 206 | `S_ROW` | u32 | `// Far-texture: the glyph's grid position (the transform's S_ROW/S_COL read;` |
| 206 | `S_COL` | u32 | `// Far-texture: the glyph's grid position (the transform's S_ROW/S_COL read;` |

### `packages/glyph3d-core/src/core/ByteLayoutDescription.js`

| line | lane | treatment | code |
|---:|---|---|---|
| 1 | `S_X` | bitcast | `import { SLOT_STRIDE, S_X, S_Y, S_Z, S_ADVANCE, S_FLAGS, F_LEADER } from '../compute/glyphPi` |
| 1 | `S_Y` | bitcast | `import { SLOT_STRIDE, S_X, S_Y, S_Z, S_ADVANCE, S_FLAGS, F_LEADER } from '../compute/glyphPi` |
| 1 | `S_Z` | bitcast | `import { SLOT_STRIDE, S_X, S_Y, S_Z, S_ADVANCE, S_FLAGS, F_LEADER } from '../compute/glyphPi` |
| 1 | `S_ADVANCE` | bitcast | `import { SLOT_STRIDE, S_X, S_Y, S_Z, S_ADVANCE, S_FLAGS, F_LEADER } from '../compute/glyphPi` |
| 1 | `S_FLAGS` | u32 | `import { SLOT_STRIDE, S_X, S_Y, S_Z, S_ADVANCE, S_FLAGS, F_LEADER } from '../compute/glyphPi` |
| 137 | `S_X` | bitcast | `x: this.slots[last + S_X] + this.slots[last + S_ADVANCE],` |
| 137 | `S_ADVANCE` | bitcast | `x: this.slots[last + S_X] + this.slots[last + S_ADVANCE],` |
| 138 | `S_Y` | bitcast | `y: this.slots[last + S_Y], z: this.slots[last + S_Z],` |
| 138 | `S_Z` | bitcast | `y: this.slots[last + S_Y], z: this.slots[last + S_Z],` |
| 144 | `S_X` | bitcast | `return { x: this.slots[o + S_X], y: this.slots[o + S_Y], z: this.slots[o + S_Z] };` |
| 144 | `S_Y` | bitcast | `return { x: this.slots[o + S_X], y: this.slots[o + S_Y], z: this.slots[o + S_Z] };` |
| 144 | `S_Z` | bitcast | `return { x: this.slots[o + S_X], y: this.slots[o + S_Y], z: this.slots[o + S_Z] };` |
