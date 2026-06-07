/**
 * Headless tap into the SHIPPING shaping pipeline.
 *
 * We use the real `FontChain` from @glyph3d/core (not a copy) — same per-codepoint
 * routing and dense global SLOT ids the GPU draws with. FontChain.init fetches its
 * fonts by URL; in Bun we shim `fetch` to resolve `file://` from disk so the real
 * code path runs unchanged. No DOM, no GPU.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import FontChain from '../../packages/glyph3d-core/src/shaping/FontChain.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FONT_DIR = join(HERE, '../../packages/glyph3d-core/src/fonts');

// Shim file:// for FontChain.init's fetch(spec.url). Harness glue, not product code.
const _fetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const s = typeof url === 'string' ? url : url?.url;
  if (s && s.startsWith('file://')) return new Response(readFileSync(fileURLToPath(s)));
  return _fetch(url, opts);
};

/**
 * The app's fallback order: clean mono → Nerd-Font icons → broad Unicode, then
 * optional system fonts (CJK outlines + color emoji) so the validation actually
 * EXERCISES the hard codepoints instead of collapsing them to blank slot 0.
 * Missing files are skipped by FontChain.init (graceful), so this stays portable.
 */
export const FONT_SPECS = [
  { url: 'file://' + join(FONT_DIR, 'Cousine-Regular.ttf'), name: 'Cousine' },
  { url: 'file://' + join(FONT_DIR, 'MesloLGS-NF-Mono.ttf'), name: 'MesloLGS-NF' },
  { url: 'file://' + join(FONT_DIR, 'DejaVuSans.ttf'), name: 'DejaVuSans' },
  { url: 'file:///usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc', name: 'NotoSansCJK' },
  { url: 'file:///usr/share/fonts/noto/NotoColorEmoji.ttf', name: 'NotoColorEmoji' },
];

/** @returns {Promise<FontChain>} an initialized FontChain. */
export async function loadChain() {
  const chain = new FontChain();
  await chain.init(FONT_SPECS);
  return chain;
}
