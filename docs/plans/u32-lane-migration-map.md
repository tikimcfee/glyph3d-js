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
| `glyphPipelineKernels.js` | 25 | 31 | 0 |
| `glyphPipelineReference.js` | 36 | 67 | 0 |
| `glyphPipelineScan.js` | 12 | 4 | 0 |
| `glyphVertex.js` | 4 | 14 | 0 |
| `GlyphField.js` | 2 | 0 | 0 |
| `ByteLayoutDescription.js` | 1 | 11 | 0 |
| **TOTAL** | **80** | **127** | **0** |

207 lane references in all. Note this counts LANE REFERENCES, not
lines: one line can touch several lanes, which is why a line-based grep
undercounts it badly (113 by that measure).

## Sites

### `packages/glyph3d-core/src/compute/glyphPipelineKernels.js`

| line | lane | treatment | code |
|---:|---|---|---|
| 77 | `S_GLYPH_ID` | bitcast | `SLOT_STRIDE, S_GLYPH_ID, S_ADVANCE, S_HEIGHT,` |
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
| 359 | `S_FLAGS` | u32 | `slots.element(o0.add(uint(S_FLAGS))).assign(uint(0));` |
| 365 | `S_ADVANCE` | bitcast | `slots.element(o0.add(uint(S_ADVANCE))).assign(uint(0));   // bits of 0.0f` |
| 366 | `S_HEIGHT` | bitcast | `slots.element(o0.add(uint(S_HEIGHT))).assign(uint(0));    // bits of 0.0f` |
| 402 | `S_GLYPH_ID` | bitcast | `slots.element(o.add(uint(S_GLYPH_ID))).assign(bitcast(glyphId, 'uint'));   // DEFERRED: stil` |
| 403 | `S_ADVANCE` | bitcast | `slots.element(o.add(uint(S_ADVANCE))).assign(bitcast(advance, 'uint'));` |
| 404 | `S_HEIGHT` | bitcast | `slots.element(o.add(uint(S_HEIGHT))).assign(bitcast(height, 'uint'));` |
| 410 | `S_FLAGS` | u32 | `slots.element(o.add(uint(S_FLAGS)))` |
| 587 | `S_FLAGS` | u32 | `const flags = int(S.element(o.add(uint(S_FLAGS)))).toVar('lfFlags');` |
| 613 | `S_ADVANCE` | bitcast | `acc.tailAdv.addAssign(bitcast(S.element(o.add(uint(S_ADVANCE))), 'float'));` |
| 744 | `S_FLAGS` | u32 | `const flags = int(S.element(o.add(uint(S_FLAGS)))).toVar('aFlags');` |
| 766 | `S_ROW` | u32 | `S.element(o.add(uint(S_ROW))).assign(row.toUint());` |
| 767 | `S_COL` | u32 | `S.element(o.add(uint(S_COL))).assign(col.toUint());` |
| 768 | `S_LINE_ADV` | bitcast | `S.element(o.add(uint(S_LINE_ADV))).assign(bitcast(acc.tailAdv, 'uint'));` |
| 769 | `S_ORD` | u32 | `S.element(o.add(uint(S_ORD))).assign(acc.glyphs.toUint());` |
| 770 | `S_FLAGS` | u32 | `S.element(o.add(uint(S_FLAGS))).assign(uint(flags.bitOr(int(F_RENDERED))));` |
| 773 | `S_FLAGS` | u32 | `S.element(o.add(uint(S_FLAGS))).assign(uint(0));` |
| 790 | `S_LINE_ADV` | bitcast | `* Foldless: x is the line prefix (S_LINE_ADV), exact at any line length — the case` |
| 808 | `S_FLAGS` | u32 | `If(int(lane(id, S_FLAGS)).bitAnd(int(F_LEADER)).equal(int(0)), () => { Return(); });` |
| 821 | `S_COL` | u32 | `const col = int(lane(id, S_COL)).toVar('col');` |
| 822 | `S_ORD` | u32 | `const ord = int(lane(id, S_ORD)).toVar('ord');` |
| 823 | `S_ROW` | u32 | `const row = lane(id, S_ROW).toFloat().toVar('row');` |
| 833 | `S_ADVANCE` | bitcast | `x.addAssign(bitcast(lane(q, S_ADVANCE), 'float'));` |
| 837 | `S_LINE_ADV` | bitcast | `x.assign(bitcast(lane(id, S_LINE_ADV), 'float'));` |
| 843 | `S_BASE_X` | bitcast | `S.element(o.add(uint(S_BASE_X))).assign(bitcast(x.add(originX), 'uint'));` |
| 844 | `S_X` | bitcast | `S.element(o.add(uint(S_X))).assign(bitcast(x.add(originX), 'uint'));` |
| 845 | `S_Y` | bitcast | `S.element(o.add(uint(S_Y))).assign(bitcast(row.negate().mul(lineHeight).add(originY), 'uint'` |
| 846 | `S_Z` | bitcast | `S.element(o.add(uint(S_Z))).assign(bitcast(originZ.sub(wrapRow.toFloat().mul(zWrapStep)), 'u` |
| 900 | `S_FLAGS` | u32 | `If(int(lane(id, S_FLAGS)).bitAnd(int(F_LEADER)).equal(int(0)), () => { Return(); });` |
| 922 | `S_ROW` | u32 | `const row = int(lane(id, S_ROW)).toVar('row');` |
| 923 | `S_COL` | u32 | `const col = int(lane(id, S_COL)).toVar('col');` |
| 931 | `S_BASE_X` | bitcast | `const x = bitcast(lane(id, S_BASE_X), 'float').toVar('x');` |
| 954 | `S_X` | bitcast | `S.element(o.add(uint(S_X))).assign(bitcast(xf, 'uint'));` |
| 955 | `S_Y` | bitcast | `S.element(o.add(uint(S_Y))).assign(bitcast(yf, 'uint'));` |
| 956 | `S_Z` | bitcast | `S.element(o.add(uint(S_Z))).assign(bitcast(zf, 'uint'));` |
| 960 | `S_ADVANCE` | bitcast | `const w = bitcast(lane(id, S_ADVANCE), 'float').toVar('w');` |
| 961 | `S_HEIGHT` | bitcast | `const h = bitcast(lane(id, S_HEIGHT), 'float').toVar('h');` |
| 1138 | `S_ROW` | u32 | `* Reads apply's S_ROW/S_COL + decode's S_GLYPH_ID (previous dispatches — the race` |
| 1138 | `S_COL` | u32 | `* Reads apply's S_ROW/S_COL + decode's S_GLYPH_ID (previous dispatches — the race` |
| 1138 | `S_GLYPH_ID` | bitcast | `* Reads apply's S_ROW/S_COL + decode's S_GLYPH_ID (previous dispatches — the race` |
| 1155 | `S_FLAGS` | u32 | `const flags = int(S.element(o.add(uint(S_FLAGS))));` |
| 1164 | `S_GLYPH_ID` | bitcast | `const gid = uint(bitcast(S.element(o.add(uint(S_GLYPH_ID))), 'float')).toVar('fGid');   // D` |
| 1171 | `S_COL` | u32 | `const tx = int(S.element(o.add(uint(S_COL))).toFloat().div(cpt)).clamp(int(0), int(FAR_SLAB ` |
| 1172 | `S_ROW` | u32 | `const ty = int(S.element(o.add(uint(S_ROW))).toFloat().div(rpt)).clamp(int(0), int(FAR_SLAB ` |
| 1474 | `S_BASE_X` | bitcast | `*  reconstructive (S_BASE_X + integer lanes): safe to call repeatedly with any` |

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
| 97 | `S_ROW` | u32 | `* The fold pass (scan on the GPU, serial here) writes ONLY the exact lanes — S_ROW,` |
| 98 | `S_COL` | u32 | `* S_COL, S_LINE_ADV, S_ORD. resolveX turns them into the fold-relative S_BASE_X (plus` |
| 98 | `S_LINE_ADV` | bitcast | `* S_COL, S_LINE_ADV, S_ORD. resolveX turns them into the fold-relative S_BASE_X (plus` |
| 98 | `S_ORD` | u32 | `* S_COL, S_LINE_ADV, S_ORD. resolveX turns them into the fold-relative S_BASE_X (plus` |
| 98 | `S_BASE_X` | bitcast | `* S_COL, S_LINE_ADV, S_ORD. resolveX turns them into the fold-relative S_BASE_X (plus` |
| 99 | `S_X` | bitcast | `* the unpaginated S_X/S_Y/S_Z), and paginate remaps from S_BASE_X + integers. Each` |
| 99 | `S_Y` | bitcast | `* the unpaginated S_X/S_Y/S_Z), and paginate remaps from S_BASE_X + integers. Each` |
| 99 | `S_Z` | bitcast | `* the unpaginated S_X/S_Y/S_Z), and paginate remaps from S_BASE_X + integers. Each` |
| 99 | `S_BASE_X` | bitcast | `* the unpaginated S_X/S_Y/S_Z), and paginate remaps from S_BASE_X + integers. Each` |
| 104 | `S_GLYPH_ID` | bitcast | `export const S_GLYPH_ID = 0;` |
| 105 | `S_ADVANCE` | bitcast | `export const S_ADVANCE = 1;` |
| 106 | `S_HEIGHT` | bitcast | `export const S_HEIGHT = 2;` |
| 107 | `S_X` | bitcast | `export const S_X = 3;` |
| 108 | `S_Y` | bitcast | `export const S_Y = 4;` |
| 109 | `S_Z` | bitcast | `export const S_Z = 5;` |
| 110 | `S_ROW` | u32 | `export const S_ROW = 6;      // exact: the glyph's visual row (wrap segments included)` |
| 111 | `S_COL` | u32 | `export const S_COL = 7;      // exact: glyphs since the last newline` |
| 112 | `S_FLAGS` | u32 | `export const S_FLAGS = 8;` |
| 113 | `S_BASE_X` | bitcast | `export const S_BASE_X = 9;   // resolveX's fold-relative x (+ item origin), written once —` |
| 116 | `S_LINE_ADV` | bitcast | `export const S_LINE_ADV = 10; // exact fold: f32 advance sum since line start (exclusive).` |
| 118 | `S_ORD` | u32 | `export const S_ORD = 11;      // exact fold: item-relative leader ordinal (newlines` |
| 123 | `S_FLAGS` | u32 | `// "is this a newline?" — is a decode-time fact and rides S_FLAGS as F_NEWLINE.` |
| 142 | `S_GLYPH_ID` | bitcast | `* S_GLYPH_ID is a FLOAT lane on purpose: it is copied straight from the trie's f32` |
| 146 | `S_GLYPH_ID` | bitcast | `S_GLYPH_ID, S_ADVANCE, S_HEIGHT, S_X, S_Y, S_Z, S_BASE_X, S_LINE_ADV,` |
| 146 | `S_ADVANCE` | bitcast | `S_GLYPH_ID, S_ADVANCE, S_HEIGHT, S_X, S_Y, S_Z, S_BASE_X, S_LINE_ADV,` |
| 146 | `S_HEIGHT` | bitcast | `S_GLYPH_ID, S_ADVANCE, S_HEIGHT, S_X, S_Y, S_Z, S_BASE_X, S_LINE_ADV,` |
| 146 | `S_X` | bitcast | `S_GLYPH_ID, S_ADVANCE, S_HEIGHT, S_X, S_Y, S_Z, S_BASE_X, S_LINE_ADV,` |
| 146 | `S_Y` | bitcast | `S_GLYPH_ID, S_ADVANCE, S_HEIGHT, S_X, S_Y, S_Z, S_BASE_X, S_LINE_ADV,` |
| 146 | `S_Z` | bitcast | `S_GLYPH_ID, S_ADVANCE, S_HEIGHT, S_X, S_Y, S_Z, S_BASE_X, S_LINE_ADV,` |
| 146 | `S_BASE_X` | bitcast | `S_GLYPH_ID, S_ADVANCE, S_HEIGHT, S_X, S_Y, S_Z, S_BASE_X, S_LINE_ADV,` |
| 146 | `S_LINE_ADV` | bitcast | `S_GLYPH_ID, S_ADVANCE, S_HEIGHT, S_X, S_Y, S_Z, S_BASE_X, S_LINE_ADV,` |
| 149 | `S_ROW` | u32 | `export const COUNT_LANES = Object.freeze(new Set([S_ROW, S_COL, S_FLAGS, S_ORD]));` |
| 149 | `S_COL` | u32 | `export const COUNT_LANES = Object.freeze(new Set([S_ROW, S_COL, S_FLAGS, S_ORD]));` |
| 149 | `S_FLAGS` | u32 | `export const COUNT_LANES = Object.freeze(new Set([S_ROW, S_COL, S_FLAGS, S_ORD]));` |
| 149 | `S_ORD` | u32 | `export const COUNT_LANES = Object.freeze(new Set([S_ROW, S_COL, S_FLAGS, S_ORD]));` |
| 236 | `S_ADVANCE` | bitcast | `slots[o + S_ADVANCE] = fbits(0);` |
| 237 | `S_HEIGHT` | bitcast | `slots[o + S_HEIGHT] = fbits(0);` |
| 253 | `S_GLYPH_ID` | bitcast | `slots[o + S_GLYPH_ID] = fbits(g.glyphId);` |
| 254 | `S_ADVANCE` | bitcast | `slots[o + S_ADVANCE] = fbits(g.advance);` |
| 255 | `S_HEIGHT` | bitcast | `slots[o + S_HEIGHT] = fbits(g.height);` |
| 256 | `S_FLAGS` | u32 | `slots[o + S_FLAGS] = F_LEADER` |
| 320 | `S_FLAGS` | u32 | `const flags = slots[o + S_FLAGS];` |
| 325 | `S_ROW` | u32 | `slots[o + S_ROW] = row;` |
| 326 | `S_COL` | u32 | `slots[o + S_COL] = col;` |
| 327 | `S_LINE_ADV` | bitcast | `slots[o + S_LINE_ADV] = fbits(lineAdv);` |
| 328 | `S_ORD` | u32 | `slots[o + S_ORD] = ord;` |
| 329 | `S_BASE_X` | bitcast | `slots[o + S_BASE_X] = fbits(x + ox);` |
| 330 | `S_X` | bitcast | `slots[o + S_X] = fbits(x + ox);` |
| 331 | `S_Y` | bitcast | `slots[o + S_Y] = fbits(-row * (params.lineHeight ?? fval(slots[o + S_HEIGHT])) + oy);` |
| 331 | `S_HEIGHT` | bitcast | `slots[o + S_Y] = fbits(-row * (params.lineHeight ?? fval(slots[o + S_HEIGHT])) + oy);` |
| 332 | `S_Z` | bitcast | `slots[o + S_Z] = fbits(-wrapRow * zStep + oz);` |
| 333 | `S_FLAGS` | u32 | `slots[o + S_FLAGS] = flags \| F_RENDERED;` |
| 353 | `S_ADVANCE` | bitcast | `lineAdv += fval(slots[o + S_ADVANCE]);` |
| 355 | `S_ADVANCE` | bitcast | `: Math.fround(segAdv + fval(slots[o + S_ADVANCE]));` |
| 369 | `S_LINE_ADV` | bitcast | `* prefixes. Foldless, x IS the line prefix (S_LINE_ADV).` |
| 375 | `S_BASE_X` | bitcast | `* Cross-thread reads: previous passes' lanes + the ordinal map. Writes: S_BASE_X,` |
| 376 | `S_X` | bitcast | `* S_X/S_Y/S_Z, the scalar reduce. Read set and write set are disjoint lanes —` |
| 376 | `S_Y` | bitcast | `* S_X/S_Y/S_Z, the scalar reduce. Read set and write set are disjoint lanes —` |
| 376 | `S_Z` | bitcast | `* S_X/S_Y/S_Z, the scalar reduce. Read set and write set are disjoint lanes —` |
| 386 | `S_FLAGS` | u32 | `if ((slots[o + S_FLAGS] & F_LEADER) === 0) return;` |
| 389 | `S_COL` | u32 | `const col = slots[o + S_COL];` |
| 390 | `S_ORD` | u32 | `const ord = slots[o + S_ORD];` |
| 400 | `S_ADVANCE` | bitcast | `x = Math.fround(x + fval(slots[q * SLOT_STRIDE + S_ADVANCE]));` |
| 403 | `S_LINE_ADV` | bitcast | `x = fval(slots[o + S_LINE_ADV]);` |
| 406 | `S_ROW` | u32 | `const row = slots[o + S_ROW];` |
| 408 | `S_BASE_X` | bitcast | `slots[o + S_BASE_X] = fbits(x + (p.origin?.x \|\| 0));` |
| 409 | `S_X` | bitcast | `slots[o + S_X] = fbits(x + (p.origin?.x \|\| 0));` |
| 410 | `S_Y` | bitcast | `slots[o + S_Y] = fbits(-row * (p.lineHeight ?? fval(slots[o + S_HEIGHT])) + (p.origin?.y \|\| ` |
| 410 | `S_HEIGHT` | bitcast | `slots[o + S_Y] = fbits(-row * (p.lineHeight ?? fval(slots[o + S_HEIGHT])) + (p.origin?.y \|\| ` |
| 411 | `S_Z` | bitcast | `slots[o + S_Z] = fbits(-wrapRow * (p.zStep \|\| 0) + (p.origin?.z \|\| 0));` |
| 455 | `S_BASE_X` | bitcast | `* The remap is RECONSTRUCTIVE, never accumulative: x reads the untouched S_BASE_X, and` |
| 468 | `S_FLAGS` | u32 | `if ((slots[o + S_FLAGS] & F_LEADER) === 0) return;` |
| 475 | `S_ROW` | u32 | `const row = slots[o + S_ROW], col = slots[o + S_COL];` |
| 475 | `S_COL` | u32 | `const row = slots[o + S_ROW], col = slots[o + S_COL];` |
| 495 | `S_X` | bitcast | `slots[o + S_X] = fbits(fval(slots[o + S_BASE_X]) + (yPage % wide) * (p.pageStrideX \|\| 0));` |
| 495 | `S_BASE_X` | bitcast | `slots[o + S_X] = fbits(fval(slots[o + S_BASE_X]) + (yPage % wide) * (p.pageStrideX \|\| 0));` |
| 496 | `S_Y` | bitcast | `slots[o + S_Y] = fbits(oy - (screenRow - yPage * rows) * p.lineHeight - band * (p.bandStride` |
| 497 | `S_Z` | bitcast | `slots[o + S_Z] = fbits(oz - seg * (p.zStep \|\| 0) + band * (p.depthPerBand \|\| 0) + xPage * (p` |
| 510 | `S_FLAGS` | u32 | `if ((slots[o + S_FLAGS] & F_LEADER) === 0) return;` |
| 511 | `S_X` | bitcast | `const x = fval(slots[o + S_X]), y = fval(slots[o + S_Y]), z = fval(slots[o + S_Z]);` |
| 511 | `S_Y` | bitcast | `const x = fval(slots[o + S_X]), y = fval(slots[o + S_Y]), z = fval(slots[o + S_Z]);` |
| 511 | `S_Z` | bitcast | `const x = fval(slots[o + S_X]), y = fval(slots[o + S_Y]), z = fval(slots[o + S_Z]);` |
| 512 | `S_ADVANCE` | bitcast | `const w = fval(slots[o + S_ADVANCE]), h = fval(slots[o + S_HEIGHT]);` |
| 512 | `S_HEIGHT` | bitcast | `const w = fval(slots[o + S_ADVANCE]), h = fval(slots[o + S_HEIGHT]);` |
| 593 | `S_FLAGS` | u32 | `if ((slots[id * SLOT_STRIDE + S_FLAGS] & F_LEADER) !== 0) leaders++;` |
| 657 | `S_ROW` | u32 | `// K10b farNormalize) that read ONLY previous-dispatch lanes (apply's S_ROW/S_COL,` |
| 657 | `S_COL` | u32 | `// K10b farNormalize) that read ONLY previous-dispatch lanes (apply's S_ROW/S_COL,` |
| 658 | `S_GLYPH_ID` | bitcast | `// decode's S_GLYPH_ID) plus CPU-written lanes (instanceColor via a storage view, the` |
| 696 | `S_FLAGS` | u32 | `const flags = slots[o + S_FLAGS] \| 0;` |
| 705 | `S_ROW` | u32 | `const row = slots[o + S_ROW], col = slots[o + S_COL];` |
| 705 | `S_COL` | u32 | `const row = slots[o + S_ROW], col = slots[o + S_COL];` |
| 709 | `S_GLYPH_ID` | bitcast | `const d = densityAt(fval(slots[o + S_GLYPH_ID]) \| 0) \|\| 0;` |

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
| 298 | `S_FLAGS` | u32 | `if ((slots[id * SLOT_STRIDE + S_FLAGS] & F_LEADER) !== 0) leaders++;` |

### `packages/glyph3d-core/src/core/glyphVertex.js`

| line | lane | treatment | code |
|---:|---|---|---|
| 32 | `S_GLYPH_ID` | bitcast | `import { SLOT_STRIDE, S_GLYPH_ID, S_ADVANCE, S_HEIGHT, S_X, S_ROW, S_COL } from '../compute/` |
| 32 | `S_ADVANCE` | bitcast | `import { SLOT_STRIDE, S_GLYPH_ID, S_ADVANCE, S_HEIGHT, S_X, S_ROW, S_COL } from '../compute/` |
| 32 | `S_HEIGHT` | bitcast | `import { SLOT_STRIDE, S_GLYPH_ID, S_ADVANCE, S_HEIGHT, S_X, S_ROW, S_COL } from '../compute/` |
| 32 | `S_X` | bitcast | `import { SLOT_STRIDE, S_GLYPH_ID, S_ADVANCE, S_HEIGHT, S_X, S_ROW, S_COL } from '../compute/` |
| 32 | `S_ROW` | u32 | `import { SLOT_STRIDE, S_GLYPH_ID, S_ADVANCE, S_HEIGHT, S_X, S_ROW, S_COL } from '../compute/` |
| 32 | `S_COL` | u32 | `import { SLOT_STRIDE, S_GLYPH_ID, S_ADVANCE, S_HEIGHT, S_X, S_ROW, S_COL } from '../compute/` |
| 200 | `S_ADVANCE` | bitcast | `// zeroed size lanes — decode re-zeroes S_ADVANCE/S_HEIGHT every run (a rewritten` |
| 200 | `S_HEIGHT` | bitcast | `// zeroed size lanes — decode re-zeroes S_ADVANCE/S_HEIGHT every run (a rewritten` |
| 207 | `S_X` *(positional Y/Z)* | bitcast | `// bitcast. S_X + 1 / S_X + 2 are the Y and Z lanes addressed POSITIONALLY —` |
| 208 | `S_X` | bitcast | `// they are float lanes despite the constant reading S_X, and a search for` |
| 209 | `S_Y` | bitcast | `// S_Y / S_Z will not find them.` |
| 209 | `S_Z` | bitcast | `// S_Y / S_Z will not find them.` |
| 211 | `S_X` *(positional Y/Z)* | bitcast | `iPos     = vec4(fl(S_X), fl(S_X + 1), fl(S_X + 2), float(0));` |
| 212 | `S_ADVANCE` | bitcast | `iSize    = vec2(fl(S_ADVANCE), fl(S_HEIGHT));` |
| 212 | `S_HEIGHT` | bitcast | `iSize    = vec2(fl(S_ADVANCE), fl(S_HEIGHT));` |
| 213 | `S_GLYPH_ID` | bitcast | `iGlyphId = fl(S_GLYPH_ID);   // DEFERRED: still a trie float` |
| 218 | `S_ROW` | u32 | `iRowCol  = vec2(byteSlots.element(base.add(int(S_ROW))).toFloat(), byteSlots.element(base.ad` |
| 218 | `S_COL` | u32 | `iRowCol  = vec2(byteSlots.element(base.add(int(S_ROW))).toFloat(), byteSlots.element(base.ad` |

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
