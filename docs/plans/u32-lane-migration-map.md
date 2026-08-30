# u32 slot-lane migration map

Generated survey, not a plan of record — regenerate rather than edit
(`bun tools/lanemap.mjs`) if the pipeline moves before the migration lands.

## The rule

The slot buffer IS `uint`. Twelve lanes, two treatments — the third
(a deferred lane) is gone: the trie moved to u32 and S_GLYPH_ID moved with it.

| lanes | treatment | why |
|---|---|---|
| `S_GLYPH_ID` `S_ROW` `S_COL` `S_FLAGS` `S_ORD` | **native u32, no bitcast** | counts, a bitfield and an identity; exact past 2^24, which is the point of the change |
| `S_ADVANCE` `S_HEIGHT` `S_X` `S_Y` `S_Z` `S_BASE_X` `S_LINE_ADV` | **`bitcast` on read and write** | real f32 values; reinterpretation is lossless and free, unlike the int-in-float it replaces |

`S_GLYPH_ID` was the deferred one — copied verbatim from `trie.blocks`, which
was a `Float32Array`, so the identity inherited a float carrier all the way up.
The trie is a `Uint32Array` now (identities and the flags bitfield native,
advance/height bitcast — `TRIE_MEASURE_LANES` in `GlyphTrie.js`), and decode
copies all three lanes verbatim because both containers share the convention.

`S_X + 1` / `S_X + 2` are the Y and Z lanes addressed positionally in the
vertex shader — float treatment, and easy to miss because the constant says X.

## Totals

| file | count | float | deferred |
|---|---:|---:|---:|
| `glyphPipelineKernels.js` | 27 | 27 | 4 |
| `glyphPipelineReference.js` | 36 | 61 | 6 |
| `glyphPipelineScan.js` | 12 | 4 | 0 |
| `glyphVertex.js` | 4 | 12 | 2 |
| `GlyphField.js` | 2 | 0 | 0 |
| `ByteLayoutDescription.js` | 1 | 11 | 0 |
| **TOTAL** | **82** | **115** | **12** |

209 lane references in all. Note this counts LANE REFERENCES, not
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
| 439 | `S_FLAGS` | u32 | `slots.element(o0.add(uint(S_FLAGS))).assign(uint(0));` |
| 445 | `S_ADVANCE` | bitcast | `slots.element(o0.add(uint(S_ADVANCE))).assign(uint(0));   // bits of 0.0f` |
| 446 | `S_HEIGHT` | bitcast | `slots.element(o0.add(uint(S_HEIGHT))).assign(uint(0));    // bits of 0.0f` |
| 487 | `S_GLYPH_ID` | DEFERRED | `slots.element(o.add(uint(S_GLYPH_ID))).assign(glyphId);` |
| 488 | `S_ADVANCE` | bitcast | `slots.element(o.add(uint(S_ADVANCE))).assign(advance);` |
| 489 | `S_HEIGHT` | bitcast | `slots.element(o.add(uint(S_HEIGHT))).assign(height);` |
| 499 | `S_FLAGS` | u32 | `slots.element(o.add(uint(S_FLAGS)))` |
| 676 | `S_FLAGS` | u32 | `const flags = int(S.element(o.add(uint(S_FLAGS)))).toVar('lfFlags');` |
| 702 | `S_ADVANCE` | bitcast | `acc.tailAdv.addAssign(bitcast(S.element(o.add(uint(S_ADVANCE))), 'float'));` |
| 833 | `S_FLAGS` | u32 | `const flags = int(S.element(o.add(uint(S_FLAGS)))).toVar('aFlags');` |
| 855 | `S_ROW` | u32 | `S.element(o.add(uint(S_ROW))).assign(row.toUint());` |
| 856 | `S_COL` | u32 | `S.element(o.add(uint(S_COL))).assign(col.toUint());` |
| 857 | `S_LINE_ADV` | bitcast | `S.element(o.add(uint(S_LINE_ADV))).assign(bitcast(acc.tailAdv, 'uint'));` |
| 858 | `S_ORD` | u32 | `S.element(o.add(uint(S_ORD))).assign(acc.glyphs.toUint());` |
| 859 | `S_FLAGS` | u32 | `S.element(o.add(uint(S_FLAGS))).assign(uint(flags.bitOr(int(F_RENDERED))));` |
| 862 | `S_FLAGS` | u32 | `S.element(o.add(uint(S_FLAGS))).assign(uint(0));` |
| 879 | `S_LINE_ADV` | bitcast | `* Foldless: x is the line prefix (S_LINE_ADV), exact at any line length — the case` |
| 897 | `S_FLAGS` | u32 | `If(int(lane(id, S_FLAGS)).bitAnd(int(F_LEADER)).equal(int(0)), () => { Return(); });` |
| 910 | `S_COL` | u32 | `const col = int(lane(id, S_COL)).toVar('col');` |
| 911 | `S_ORD` | u32 | `const ord = int(lane(id, S_ORD)).toVar('ord');` |
| 912 | `S_ROW` | u32 | `// S_ROW is a native u32 COUNT lane. Hold it BOTH ways on purpose: the float` |
| 916 | `S_ROW` | u32 | `const rowU = lane(id, S_ROW).toVar('rowU');` |
| 927 | `S_ADVANCE` | bitcast | `x.addAssign(bitcast(lane(q, S_ADVANCE), 'float'));` |
| 931 | `S_LINE_ADV` | bitcast | `x.assign(bitcast(lane(id, S_LINE_ADV), 'float'));` |
| 937 | `S_BASE_X` | bitcast | `S.element(o.add(uint(S_BASE_X))).assign(bitcast(x.add(originX), 'uint'));` |
| 938 | `S_X` | bitcast | `S.element(o.add(uint(S_X))).assign(bitcast(x.add(originX), 'uint'));` |
| 939 | `S_Y` | bitcast | `S.element(o.add(uint(S_Y))).assign(bitcast(row.negate().mul(lineHeight).add(originY), 'uint'` |
| 940 | `S_Z` | bitcast | `S.element(o.add(uint(S_Z))).assign(bitcast(originZ.sub(wrapRow.toFloat().mul(zWrapStep)), 'u` |
| 954 | `S_ROW` | u32 | `// Reachable, not theoretical: S_ROW is the VISUAL row (wrap segments` |
| 1008 | `S_FLAGS` | u32 | `If(int(lane(id, S_FLAGS)).bitAnd(int(F_LEADER)).equal(int(0)), () => { Return(); });` |
| 1030 | `S_ROW` | u32 | `const row = int(lane(id, S_ROW)).toVar('row');` |
| 1031 | `S_COL` | u32 | `const col = int(lane(id, S_COL)).toVar('col');` |
| 1039 | `S_BASE_X` | bitcast | `const x = bitcast(lane(id, S_BASE_X), 'float').toVar('x');` |
| 1062 | `S_X` | bitcast | `S.element(o.add(uint(S_X))).assign(bitcast(xf, 'uint'));` |
| 1063 | `S_Y` | bitcast | `S.element(o.add(uint(S_Y))).assign(bitcast(yf, 'uint'));` |
| 1064 | `S_Z` | bitcast | `S.element(o.add(uint(S_Z))).assign(bitcast(zf, 'uint'));` |
| 1068 | `S_ADVANCE` | bitcast | `const w = bitcast(lane(id, S_ADVANCE), 'float').toVar('w');` |
| 1069 | `S_HEIGHT` | bitcast | `const h = bitcast(lane(id, S_HEIGHT), 'float').toVar('h');` |
| 1249 | `S_ROW` | u32 | `* Reads apply's S_ROW/S_COL + decode's S_GLYPH_ID (previous dispatches — the race` |
| 1249 | `S_COL` | u32 | `* Reads apply's S_ROW/S_COL + decode's S_GLYPH_ID (previous dispatches — the race` |
| 1249 | `S_GLYPH_ID` | DEFERRED | `* Reads apply's S_ROW/S_COL + decode's S_GLYPH_ID (previous dispatches — the race` |
| 1266 | `S_FLAGS` | u32 | `const flags = int(S.element(o.add(uint(S_FLAGS))));` |
| 1278 | `S_GLYPH_ID` | DEFERRED | `const gid = S.element(o.add(uint(S_GLYPH_ID))).toVar('fGid');` |
| 1285 | `S_COL` | u32 | `const tx = int(S.element(o.add(uint(S_COL))).toFloat().div(cpt)).clamp(int(0), int(FAR_SLAB ` |
| 1286 | `S_ROW` | u32 | `const ty = int(S.element(o.add(uint(S_ROW))).toFloat().div(rpt)).clamp(int(0), int(FAR_SLAB ` |
| 1588 | `S_BASE_X` | bitcast | `*  reconstructive (S_BASE_X + integer lanes): safe to call repeatedly with any` |

### `packages/glyph3d-core/src/compute/glyphPipelineReference.js`

| line | lane | treatment | code |
|---:|---|---|---|
| 72 | `S_ROW` | u32 | `// COUNTS (S_ROW/S_COL/S_FLAGS/S_ORD) are stored natively and are now exact for` |
| 72 | `S_COL` | u32 | `// COUNTS (S_ROW/S_COL/S_FLAGS/S_ORD) are stored natively and are now exact for` |
| 72 | `S_FLAGS` | u32 | `// COUNTS (S_ROW/S_COL/S_FLAGS/S_ORD) are stored natively and are now exact for` |
| 72 | `S_ORD` | u32 | `// COUNTS (S_ROW/S_COL/S_FLAGS/S_ORD) are stored natively and are now exact for` |
| 77 | `S_ADVANCE` | bitcast | `// FLOATS (S_ADVANCE/S_HEIGHT/S_X/S_Y/S_Z/S_BASE_X/S_LINE_ADV) are bitcast. This` |
| 77 | `S_HEIGHT` | bitcast | `// FLOATS (S_ADVANCE/S_HEIGHT/S_X/S_Y/S_Z/S_BASE_X/S_LINE_ADV) are bitcast. This` |
| 77 | `S_X` | bitcast | `// FLOATS (S_ADVANCE/S_HEIGHT/S_X/S_Y/S_Z/S_BASE_X/S_LINE_ADV) are bitcast. This` |
| 77 | `S_Y` | bitcast | `// FLOATS (S_ADVANCE/S_HEIGHT/S_X/S_Y/S_Z/S_BASE_X/S_LINE_ADV) are bitcast. This` |
| 77 | `S_Z` | bitcast | `// FLOATS (S_ADVANCE/S_HEIGHT/S_X/S_Y/S_Z/S_BASE_X/S_LINE_ADV) are bitcast. This` |
| 77 | `S_BASE_X` | bitcast | `// FLOATS (S_ADVANCE/S_HEIGHT/S_X/S_Y/S_Z/S_BASE_X/S_LINE_ADV) are bitcast. This` |
| 77 | `S_LINE_ADV` | bitcast | `// FLOATS (S_ADVANCE/S_HEIGHT/S_X/S_Y/S_Z/S_BASE_X/S_LINE_ADV) are bitcast. This` |
| 98 | `S_ROW` | u32 | `* The fold pass (scan on the GPU, serial here) writes ONLY the exact lanes — S_ROW,` |
| 99 | `S_COL` | u32 | `* S_COL, S_LINE_ADV, S_ORD. resolveX turns them into the fold-relative S_BASE_X (plus` |
| 99 | `S_LINE_ADV` | bitcast | `* S_COL, S_LINE_ADV, S_ORD. resolveX turns them into the fold-relative S_BASE_X (plus` |
| 99 | `S_ORD` | u32 | `* S_COL, S_LINE_ADV, S_ORD. resolveX turns them into the fold-relative S_BASE_X (plus` |
| 99 | `S_BASE_X` | bitcast | `* S_COL, S_LINE_ADV, S_ORD. resolveX turns them into the fold-relative S_BASE_X (plus` |
| 100 | `S_X` | bitcast | `* the unpaginated S_X/S_Y/S_Z), and paginate remaps from S_BASE_X + integers. Each` |
| 100 | `S_Y` | bitcast | `* the unpaginated S_X/S_Y/S_Z), and paginate remaps from S_BASE_X + integers. Each` |
| 100 | `S_Z` | bitcast | `* the unpaginated S_X/S_Y/S_Z), and paginate remaps from S_BASE_X + integers. Each` |
| 100 | `S_BASE_X` | bitcast | `* the unpaginated S_X/S_Y/S_Z), and paginate remaps from S_BASE_X + integers. Each` |
| 105 | `S_GLYPH_ID` | DEFERRED | `export const S_GLYPH_ID = 0;` |
| 106 | `S_ADVANCE` | bitcast | `export const S_ADVANCE = 1;` |
| 107 | `S_HEIGHT` | bitcast | `export const S_HEIGHT = 2;` |
| 108 | `S_X` | bitcast | `export const S_X = 3;` |
| 109 | `S_Y` | bitcast | `export const S_Y = 4;` |
| 110 | `S_Z` | bitcast | `export const S_Z = 5;` |
| 111 | `S_ROW` | u32 | `export const S_ROW = 6;      // exact: the glyph's visual row (wrap segments included)` |
| 112 | `S_COL` | u32 | `export const S_COL = 7;      // exact: glyphs since the last newline` |
| 113 | `S_FLAGS` | u32 | `export const S_FLAGS = 8;` |
| 114 | `S_BASE_X` | bitcast | `export const S_BASE_X = 9;   // resolveX's fold-relative x (+ item origin), written once —` |
| 117 | `S_LINE_ADV` | bitcast | `export const S_LINE_ADV = 10; // exact fold: f32 advance sum since line start (exclusive).` |
| 119 | `S_ORD` | u32 | `export const S_ORD = 11;      // exact fold: item-relative leader ordinal (newlines` |
| 124 | `S_FLAGS` | u32 | `// "is this a newline?" — is a decode-time fact and rides S_FLAGS as F_NEWLINE.` |
| 143 | `S_GLYPH_ID` | DEFERRED | `* S_GLYPH_ID is a FLOAT lane on purpose: it is copied straight from the trie's f32` |
| 147 | `S_ADVANCE` | bitcast | `S_ADVANCE, S_HEIGHT, S_X, S_Y, S_Z, S_BASE_X, S_LINE_ADV,` |
| 147 | `S_HEIGHT` | bitcast | `S_ADVANCE, S_HEIGHT, S_X, S_Y, S_Z, S_BASE_X, S_LINE_ADV,` |
| 147 | `S_X` | bitcast | `S_ADVANCE, S_HEIGHT, S_X, S_Y, S_Z, S_BASE_X, S_LINE_ADV,` |
| 147 | `S_Y` | bitcast | `S_ADVANCE, S_HEIGHT, S_X, S_Y, S_Z, S_BASE_X, S_LINE_ADV,` |
| 147 | `S_Z` | bitcast | `S_ADVANCE, S_HEIGHT, S_X, S_Y, S_Z, S_BASE_X, S_LINE_ADV,` |
| 147 | `S_BASE_X` | bitcast | `S_ADVANCE, S_HEIGHT, S_X, S_Y, S_Z, S_BASE_X, S_LINE_ADV,` |
| 147 | `S_LINE_ADV` | bitcast | `S_ADVANCE, S_HEIGHT, S_X, S_Y, S_Z, S_BASE_X, S_LINE_ADV,` |
| 150 | `S_GLYPH_ID` | DEFERRED | `export const COUNT_LANES = Object.freeze(new Set([S_GLYPH_ID, S_ROW, S_COL, S_FLAGS, S_ORD])` |
| 150 | `S_ROW` | u32 | `export const COUNT_LANES = Object.freeze(new Set([S_GLYPH_ID, S_ROW, S_COL, S_FLAGS, S_ORD])` |
| 150 | `S_COL` | u32 | `export const COUNT_LANES = Object.freeze(new Set([S_GLYPH_ID, S_ROW, S_COL, S_FLAGS, S_ORD])` |
| 150 | `S_FLAGS` | u32 | `export const COUNT_LANES = Object.freeze(new Set([S_GLYPH_ID, S_ROW, S_COL, S_FLAGS, S_ORD])` |
| 150 | `S_ORD` | u32 | `export const COUNT_LANES = Object.freeze(new Set([S_GLYPH_ID, S_ROW, S_COL, S_FLAGS, S_ORD])` |
| 159 | `S_HEIGHT` | bitcast | `* S_HEIGHT, which staggered baselines within a row (a taller CJK glyph at -row * 1.61` |
| 273 | `S_ADVANCE` | bitcast | `slots[o + S_ADVANCE] = fbits(0);` |
| 274 | `S_HEIGHT` | bitcast | `slots[o + S_HEIGHT] = fbits(0);` |
| 290 | `S_GLYPH_ID` | DEFERRED | `slots[o + S_GLYPH_ID] = g.glyphId;` |
| 291 | `S_ADVANCE` | bitcast | `slots[o + S_ADVANCE] = fbits(g.advance);` |
| 292 | `S_HEIGHT` | bitcast | `slots[o + S_HEIGHT] = fbits(g.height);` |
| 293 | `S_FLAGS` | u32 | `slots[o + S_FLAGS] = F_LEADER` |
| 357 | `S_FLAGS` | u32 | `const flags = slots[o + S_FLAGS];` |
| 362 | `S_ROW` | u32 | `slots[o + S_ROW] = row;` |
| 363 | `S_COL` | u32 | `slots[o + S_COL] = col;` |
| 364 | `S_LINE_ADV` | bitcast | `slots[o + S_LINE_ADV] = fbits(lineAdv);` |
| 365 | `S_ORD` | u32 | `slots[o + S_ORD] = ord;` |
| 366 | `S_BASE_X` | bitcast | `slots[o + S_BASE_X] = fbits(x + ox);` |
| 367 | `S_X` | bitcast | `slots[o + S_X] = fbits(x + ox);` |
| 368 | `S_HEIGHT` | bitcast | `// lineHeight is the ITEM's, never the glyph's. The `?? slots[S_HEIGHT]` fallback` |
| 378 | `S_Y` | bitcast | `slots[o + S_Y] = fbits(-row * params.lineHeight + oy);` |
| 379 | `S_Z` | bitcast | `slots[o + S_Z] = fbits(-wrapRow * zStep + oz);` |
| 380 | `S_FLAGS` | u32 | `slots[o + S_FLAGS] = flags \| F_RENDERED;` |
| 400 | `S_ADVANCE` | bitcast | `lineAdv += fval(slots[o + S_ADVANCE]);` |
| 402 | `S_ADVANCE` | bitcast | `: Math.fround(segAdv + fval(slots[o + S_ADVANCE]));` |
| 416 | `S_LINE_ADV` | bitcast | `* prefixes. Foldless, x IS the line prefix (S_LINE_ADV).` |
| 422 | `S_BASE_X` | bitcast | `* Cross-thread reads: previous passes' lanes + the ordinal map. Writes: S_BASE_X,` |
| 423 | `S_X` | bitcast | `* S_X/S_Y/S_Z, the scalar reduce. Read set and write set are disjoint lanes —` |
| 423 | `S_Y` | bitcast | `* S_X/S_Y/S_Z, the scalar reduce. Read set and write set are disjoint lanes —` |
| 423 | `S_Z` | bitcast | `* S_X/S_Y/S_Z, the scalar reduce. Read set and write set are disjoint lanes —` |
| 433 | `S_FLAGS` | u32 | `if ((slots[o + S_FLAGS] & F_LEADER) === 0) return;` |
| 436 | `S_COL` | u32 | `const col = slots[o + S_COL];` |
| 437 | `S_ORD` | u32 | `const ord = slots[o + S_ORD];` |
| 447 | `S_ADVANCE` | bitcast | `x = Math.fround(x + fval(slots[q * SLOT_STRIDE + S_ADVANCE]));` |
| 450 | `S_LINE_ADV` | bitcast | `x = fval(slots[o + S_LINE_ADV]);` |
| 453 | `S_ROW` | u32 | `const row = slots[o + S_ROW];` |
| 455 | `S_BASE_X` | bitcast | `slots[o + S_BASE_X] = fbits(x + (p.origin?.x \|\| 0));` |
| 456 | `S_X` | bitcast | `slots[o + S_X] = fbits(x + (p.origin?.x \|\| 0));` |
| 458 | `S_Y` | bitcast | `slots[o + S_Y] = fbits(-row * p.lineHeight + (p.origin?.y \|\| 0));` |
| 459 | `S_Z` | bitcast | `slots[o + S_Z] = fbits(-wrapRow * (p.zStep \|\| 0) + (p.origin?.z \|\| 0));` |
| 503 | `S_BASE_X` | bitcast | `* The remap is RECONSTRUCTIVE, never accumulative: x reads the untouched S_BASE_X, and` |
| 516 | `S_FLAGS` | u32 | `if ((slots[o + S_FLAGS] & F_LEADER) === 0) return;` |
| 523 | `S_ROW` | u32 | `const row = slots[o + S_ROW], col = slots[o + S_COL];` |
| 523 | `S_COL` | u32 | `const row = slots[o + S_ROW], col = slots[o + S_COL];` |
| 543 | `S_X` | bitcast | `slots[o + S_X] = fbits(fval(slots[o + S_BASE_X]) + (yPage % wide) * (p.pageStrideX \|\| 0));` |
| 543 | `S_BASE_X` | bitcast | `slots[o + S_X] = fbits(fval(slots[o + S_BASE_X]) + (yPage % wide) * (p.pageStrideX \|\| 0));` |
| 544 | `S_Y` | bitcast | `slots[o + S_Y] = fbits(oy - (screenRow - yPage * rows) * p.lineHeight - band * (p.bandStride` |
| 545 | `S_Z` | bitcast | `slots[o + S_Z] = fbits(oz - seg * (p.zStep \|\| 0) + band * (p.depthPerBand \|\| 0) + xPage * (p` |
| 558 | `S_FLAGS` | u32 | `if ((slots[o + S_FLAGS] & F_LEADER) === 0) return;` |
| 559 | `S_X` | bitcast | `const x = fval(slots[o + S_X]), y = fval(slots[o + S_Y]), z = fval(slots[o + S_Z]);` |
| 559 | `S_Y` | bitcast | `const x = fval(slots[o + S_X]), y = fval(slots[o + S_Y]), z = fval(slots[o + S_Z]);` |
| 559 | `S_Z` | bitcast | `const x = fval(slots[o + S_X]), y = fval(slots[o + S_Y]), z = fval(slots[o + S_Z]);` |
| 560 | `S_ADVANCE` | bitcast | `const w = fval(slots[o + S_ADVANCE]), h = fval(slots[o + S_HEIGHT]);` |
| 560 | `S_HEIGHT` | bitcast | `const w = fval(slots[o + S_ADVANCE]), h = fval(slots[o + S_HEIGHT]);` |
| 660 | `S_FLAGS` | u32 | `if ((slots[id * SLOT_STRIDE + S_FLAGS] & F_LEADER) !== 0) leaders++;` |
| 724 | `S_ROW` | u32 | `// K10b farNormalize) that read ONLY previous-dispatch lanes (apply's S_ROW/S_COL,` |
| 724 | `S_COL` | u32 | `// K10b farNormalize) that read ONLY previous-dispatch lanes (apply's S_ROW/S_COL,` |
| 725 | `S_GLYPH_ID` | DEFERRED | `// decode's S_GLYPH_ID) plus CPU-written lanes (instanceColor via a storage view, the` |
| 763 | `S_FLAGS` | u32 | `const flags = slots[o + S_FLAGS] \| 0;` |
| 772 | `S_ROW` | u32 | `const row = slots[o + S_ROW], col = slots[o + S_COL];` |
| 772 | `S_COL` | u32 | `const row = slots[o + S_ROW], col = slots[o + S_COL];` |
| 778 | `S_GLYPH_ID` | DEFERRED | `const d = densityAt(slots[o + S_GLYPH_ID]) \|\| 0;` |

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
| 101 | `S_ADVANCE` | bitcast | `fval(slots[o + S_ADVANCE]),` |
| 102 | `S_FLAGS` | u32 | `(slots[o + S_FLAGS] & F_LEADER) !== 0,` |
| 243 | `S_FLAGS` | u32 | `const flags = slots[o + S_FLAGS];` |
| 246 | `S_ROW` | u32 | `slots[o + S_ROW] = v.row;` |
| 247 | `S_COL` | u32 | `slots[o + S_COL] = v.col;` |
| 248 | `S_LINE_ADV` | bitcast | `slots[o + S_LINE_ADV] = fbits(v.lineAdv);` |
| 249 | `S_ORD` | u32 | `slots[o + S_ORD] = v.ord;` |
| 250 | `S_FLAGS` | u32 | `slots[o + S_FLAGS] = flags \| F_RENDERED;` |
| 299 | `S_FLAGS` | u32 | `if ((slots[id * SLOT_STRIDE + S_FLAGS] & F_LEADER) !== 0) leaders++;` |

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
| 213 | `S_X` *(positional Y/Z)* | bitcast | `// bitcast. S_X + 1 / S_X + 2 are the Y and Z lanes addressed POSITIONALLY —` |
| 214 | `S_X` | bitcast | `// they are float lanes despite the constant reading S_X, and a search for` |
| 215 | `S_Y` | bitcast | `// S_Y / S_Z will not find them.` |
| 215 | `S_Z` | bitcast | `// S_Y / S_Z will not find them.` |
| 217 | `S_X` *(positional Y/Z)* | bitcast | `iPos     = vec4(fl(S_X), fl(S_X + 1), fl(S_X + 2), float(0));` |
| 218 | `S_ADVANCE` | bitcast | `iSize    = vec2(fl(S_ADVANCE), fl(S_HEIGHT));` |
| 218 | `S_HEIGHT` | bitcast | `iSize    = vec2(fl(S_ADVANCE), fl(S_HEIGHT));` |
| 222 | `S_GLYPH_ID` | DEFERRED | `iGlyphId = byteSlots.element(base.add(int(S_GLYPH_ID))).toFloat();` |
| 227 | `S_ROW` | u32 | `iRowCol  = vec2(byteSlots.element(base.add(int(S_ROW))).toFloat(), byteSlots.element(base.ad` |
| 227 | `S_COL` | u32 | `iRowCol  = vec2(byteSlots.element(base.add(int(S_ROW))).toFloat(), byteSlots.element(base.ad` |

### `packages/glyph3d-core/src/GlyphField.js`

| line | lane | treatment | code |
|---:|---|---|---|
| 206 | `S_ROW` | u32 | `// Far-texture: the glyph's grid position (the transform's S_ROW/S_COL read;` |
| 206 | `S_COL` | u32 | `// Far-texture: the glyph's grid position (the transform's S_ROW/S_COL read;` |

### `packages/glyph3d-core/src/core/ByteLayoutDescription.js`

| line | lane | treatment | code |
|---:|---|---|---|
| 1 | `S_X` | bitcast | `import { SLOT_STRIDE, S_X, S_Y, S_Z, S_ADVANCE, S_FLAGS, F_LEADER, fval} from '../compute/gl` |
| 1 | `S_Y` | bitcast | `import { SLOT_STRIDE, S_X, S_Y, S_Z, S_ADVANCE, S_FLAGS, F_LEADER, fval} from '../compute/gl` |
| 1 | `S_Z` | bitcast | `import { SLOT_STRIDE, S_X, S_Y, S_Z, S_ADVANCE, S_FLAGS, F_LEADER, fval} from '../compute/gl` |
| 1 | `S_ADVANCE` | bitcast | `import { SLOT_STRIDE, S_X, S_Y, S_Z, S_ADVANCE, S_FLAGS, F_LEADER, fval} from '../compute/gl` |
| 1 | `S_FLAGS` | u32 | `import { SLOT_STRIDE, S_X, S_Y, S_Z, S_ADVANCE, S_FLAGS, F_LEADER, fval} from '../compute/gl` |
| 137 | `S_X` | bitcast | `x: fval(this.slots[last + S_X]) + fval(this.slots[last + S_ADVANCE]),` |
| 137 | `S_ADVANCE` | bitcast | `x: fval(this.slots[last + S_X]) + fval(this.slots[last + S_ADVANCE]),` |
| 138 | `S_Y` | bitcast | `y: fval(this.slots[last + S_Y]), z: fval(this.slots[last + S_Z]),` |
| 138 | `S_Z` | bitcast | `y: fval(this.slots[last + S_Y]), z: fval(this.slots[last + S_Z]),` |
| 144 | `S_X` | bitcast | `return { x: fval(this.slots[o + S_X]), y: fval(this.slots[o + S_Y]), z: fval(this.slots[o + ` |
| 144 | `S_Y` | bitcast | `return { x: fval(this.slots[o + S_X]), y: fval(this.slots[o + S_Y]), z: fval(this.slots[o + ` |
| 144 | `S_Z` | bitcast | `return { x: fval(this.slots[o + S_X]), y: fval(this.slots[o + S_Y]), z: fval(this.slots[o + ` |
