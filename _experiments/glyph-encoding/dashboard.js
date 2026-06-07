/**
 * One image that shows the whole chain validated. Panels are rendered from the
 * real font outlines; captions are rendered with the engine itself.
 *
 *   bun _experiments/glyph-encoding/dashboard.js   →   out/dashboard.png
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadAppEngine } from './shaper.js';
import { encode, pack, unpack, decodeSource, expandRender, sizes } from './codec.js';
import { shapeText } from '../../packages/glyph3d-core/src/shaping/shapeText.js';
import { IndexView, cpByte } from './index_view.js';
import { renderToImage, renderHighlighted, diffImages } from './raster.js';
import { encodePNG } from './png.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'out');
mkdirSync(OUT, { recursive: true });

const { chain, cache, resolve } = await loadAppEngine();

// ── compositor helpers ──────────────────────────────────────────────────────
const toRGB = (img) => {
  if (img.channels === 3) return img;
  const out = new Uint8Array(img.width * img.height * 3);
  for (let i = 0; i < img.width * img.height; i++) out[i * 3] = out[i * 3 + 1] = out[i * 3 + 2] = img.data[i];
  return { width: img.width, height: img.height, channels: 3, data: out };
};
const caption = (text, emPx = 12) =>
  toRGB(renderToImage(chain, [chain.shape(text).map((g) => g.g)], { emPx, maxLines: 1, maxCols: 4000 }));

function stack(items, { margin = 14, gap = 6, bg = 245 } = {}) {
  const W = Math.max(...items.map((it) => it.img.width)) + margin * 2;
  const H = items.reduce((h, it) => h + it.img.height + (it.gapBefore ?? gap), 0) + margin * 2;
  const data = new Uint8Array(W * H * 3).fill(bg);
  let y = margin;
  for (const it of items) {
    y += it.gapBefore ?? gap;
    if (it.rule) for (let x = margin; x < W - margin; x++) { const d = (y * W + x) * 3; data[d] = data[d+1] = data[d+2] = 200; }
    const src = it.img;
    for (let sy = 0; sy < src.height; sy++)
      for (let sx = 0; sx < src.width; sx++) {
        const s = (sy * src.width + sx) * 3, d = ((y + sy) * W + (margin + (it.indent ?? 0)) + sx) * 3;
        data[d] = src.data[s]; data[d + 1] = src.data[s + 1]; data[d + 2] = src.data[s + 2];
      }
    y += src.height;
  }
  return { width: W, height: H, channels: 3, data };
}

// How much each check actually discriminates: blank slot 0 = uncovered (pixel &
// slot checks are vacuous there; only byte round-trip has teeth); empty outline =
// colour-emoji/space (real slot, but not pixel-tested); outlined = full teeth.
function coverage(slotLines) {
  let total = 0, blank = 0, outlined = 0;
  for (const line of slotLines) for (const s of line) {
    total++;
    if (s === 0) blank++;
    else if (chain.glyphOutline(s).length > 0) outlined++;
  }
  return { total, blank, outlined, empty: total - blank - outlined };
}

// ── build + validate sample.js ──────────────────────────────────────────────
const text = readFileSync(join(HERE, 'corpus/sample.js'), 'utf8');
const map = unpack(pack(encode(text)));             // through packed bytes
const idx = new IndexView(map);
const refLines = shapeText(cache, text).lines.map((l) => l.shaped.map((g) => g.g));
const reconLines = expandRender(map, resolve);
const opts = { emPx: 10, maxLines: 28, maxCols: 84 };

const refImg = renderToImage(chain, refLines, opts);
const reconImg = renderToImage(chain, reconLines, opts);
const { image: diffImg, diff } = diffImages(refImg, reconImg);

const roundtripOK = decodeSource(map) === text;

// picking: check every slot against ground truth from the raw text
let pickOK = 0, pickTotal = 0;
{
  const lines = text.split('\n'); let byte = 0;
  for (let li = 0; li < lines.length; li++) {
    let col = 0;
    for (const ch of lines[li]) {
      const cp = ch.codePointAt(0), s = idx.lineColToSlot(li, col);
      const lc = idx.slotToLineCol(s), br = idx.slotToByteRange(s);
      if (lc.line === li && lc.col === col && idx.slotToCp(s) === cp &&
          br[0] === byte && idx.byteToSlot(byte) === s) pickOK++;
      pickTotal++; byte += cpByte(cp); col++;
    }
    if (li < lines.length - 1) byte += 1;
  }
}

// highlight: every "fibMemo" by byte-range → slots
const hi = new Set(); let hits = 0;
{
  const needle = 'fibMemo', nb = Buffer.byteLength(needle); let from = 0;
  while (true) {
    const at = text.indexOf(needle, from); if (at < 0) break;
    const b0 = Buffer.byteLength(text.slice(0, at), 'utf8');
    for (const s of idx.slotsForByteRange(b0, b0 + nb)) hi.add(s);
    hits++; from = at + needle.length;
  }
}
const hlImg = renderHighlighted(chain, reconLines, hi, opts);

const sz = sizes(text, map, pack(map));

// torture (robustness on hard Unicode)
const tText = readFileSync(join(HERE, 'corpus/torture.txt'), 'utf8');
const tMap = unpack(pack(encode(tText)));
const tRoundtrip = decodeSource(tMap) === tText;
const tLines = expandRender(tMap, resolve);
const tImg = renderToImage(chain, tLines, { emPx: 10, maxLines: 12, maxCols: 84 });

const covS = coverage(reconLines);
const covT = coverage(tLines);

// ── compose ─────────────────────────────────────────────────────────────────
const ok = (b) => (b ? '[OK]' : '[FAIL]');
const dashboard = stack([
  { img: caption('glyph-encoding  validation  /  sample.js', 15) },
  { img: caption(`${sz.glyphs} glyphs, ${sz.distinct} distinct   ${(sz.current / sz.mapBytes).toFixed(1)}x smaller than 40B/glyph  (${(sz.current / sz.mapBytesPacked).toFixed(0)}x bit-packed)`, 11) },
  { img: caption(`round-trip byte-exact ${ok(roundtripOK)}    glyph fidelity ${diff} px diff ${ok(diff === 0)}    picking ${pickOK}/${pickTotal} slot mappings exact ${ok(pickOK === pickTotal)}`, 11) },
  { img: caption(`teeth: byte round-trip covers 100% of glyphs; pixel test exercises ${covS.outlined}/${covS.total} (${covS.blank} blank, ${covS.empty} space/colour)`, 11) },

  { img: caption('[1] REFERENCE   direct FontChain shaping', 12), gapBefore: 16, rule: true },
  { img: toRGB(refImg), indent: 8 },
  { img: caption('[2] RECONSTRUCTED   text -> map -> packed bytes -> unpack -> expand', 12), gapBefore: 14, rule: true },
  { img: toRGB(reconImg), indent: 8 },
  { img: caption(`[3] DIFF   ${diff} px differ  =  pixel-identical ${ok(diff === 0)}`, 12), gapBefore: 14, rule: true },
  { img: diffImg, indent: 8 },
  { img: caption(`[4] PICKING   highlight 'fibMemo' by byte-range -> ${hits} exact hits`, 12), gapBefore: 14, rule: true },
  { img: hlImg, indent: 8 },
  { img: caption(`[5] torture.txt   round-trip ${ok(tRoundtrip)}   pixel-tested ${covT.outlined}/${covT.total} (${covT.blank} blank, ${covT.empty} colour/space) - CJK now real, emoji = slots only`, 12), gapBefore: 16, rule: true },
  { img: toRGB(tImg), indent: 8 },
]);

const file = join(OUT, 'dashboard.png');
writeFileSync(file, encodePNG(dashboard.width, dashboard.height, 3, dashboard.data));
console.log(`round-trip ${ok(roundtripOK)}  fidelity ${diff}px ${ok(diff === 0)}  picking ${pickOK}/${pickTotal} ${ok(pickOK === pickTotal)}  torture ${ok(tRoundtrip)}`);
console.log(`coverage sample: ${covS.outlined}/${covS.total} pixel-tested (${covS.blank} blank, ${covS.empty} space/colour) · torture: ${covT.outlined}/${covT.total} (${covT.blank} blank)`);
console.log(`→ ${file}  (${dashboard.width}x${dashboard.height})`);
chain.destroy();
