#!/usr/bin/env node
/**
 * bake-atlas.mjs — Build-time glyph atlas generator.
 *
 * Generates pre-baked atlas PNG + JSON descriptor at multiple sizes using the
 * `canvas` npm package (node-canvas) for headless Canvas 2D rasterization.
 *
 * Each size pair (e.g. atlas-2048.png + atlas-2048.json) is a drop-in asset
 * for loadPrebakedAtlas() in src/GlyphAtlasLoader.js.
 *
 * Usage:
 *   node tools/bake-atlas.mjs [--sizes 512,1024,2048] [--output assets/] [--font "Monaco, Menlo, Courier New, monospace"] [--font-size 48]
 *
 * Requires:
 *   npm install canvas
 *   (node-canvas: https://github.com/Automattic/node-canvas)
 *
 * The script patches the global `document` object with a minimal shim so that
 * GlyphAtlas.js (written for browsers) can call document.createElement('canvas')
 * and get a node-canvas Canvas instance back. No other DOM surface is touched.
 */

import { createCanvas, Image } from 'canvas';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve, join } from 'path';
import { fileURLToPath } from 'url';

// ---- Path helpers ----
const __filename = fileURLToPath(import.meta.url);
const projectRoot = resolve(__filename, '../../');

// ---- CLI argument parsing ----
const args = process.argv.slice(2);

function getArg(flag, defaultValue) {
    const idx = args.indexOf(flag);
    if (idx === -1) return defaultValue;
    return args[idx + 1];
}

const sizesRaw  = getArg('--sizes', '512,1024,2048');
const outputDir = resolve(process.cwd(), getArg('--output', 'assets'));
const fontFamily = getArg('--font', 'Monaco, Menlo, Courier New, monospace');
const fontSize  = parseInt(getArg('--font-size', '48'), 10);

const sizes = sizesRaw.split(',').map(s => parseInt(s.trim(), 10)).filter(n => n > 0);

// ---- node-canvas DOM shim ----
// GlyphAtlas calls document.createElement('canvas'). Provide the minimal shim
// so it gets a node-canvas Canvas back. We avoid polluting global for anything
// we don't need.

global.document = {
    createElement(tag) {
        if (tag === 'canvas') {
            // Size will be set via .width / .height assignments in GlyphAtlas.generate()
            // node-canvas Canvas supports those assignments, returning a new surface.
            return createCanvas(1, 1);
        }
        throw new Error(`bake-atlas shim: document.createElement('${tag}') not supported`);
    },
};

// GlyphAtlas uses console.debug — available in Node, nothing to shim.

// ---- Dynamic import GlyphAtlas after shim is in place ----
const { default: GlyphAtlas } = await import(join(projectRoot, 'src/GlyphAtlas.js'));

// ---- Generate ----
mkdirSync(outputDir, { recursive: true });

for (const size of sizes) {
    console.log(`\n[bake-atlas] Generating ${size}x${size} atlas (${fontFamily} ${fontSize}px)...`);

    const atlas = new GlyphAtlas(fontFamily, fontSize, size);

    let lastPct = -1;
    await atlas.generate((done, total) => {
        const pct = Math.floor((done / total) * 100);
        if (pct !== lastPct) {
            process.stdout.write(`\r  Progress: ${pct}% (${done}/${total})`);
            lastPct = pct;
        }
    });
    process.stdout.write('\n');

    const { image: dataUrl, descriptor } = atlas.exportAtlas();

    // dataUrl is "data:image/png;base64,..." — extract the binary
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    const pngBuffer = Buffer.from(base64, 'base64');

    const pngPath  = join(outputDir, `atlas-${size}.png`);
    const jsonPath = join(outputDir, `atlas-${size}.json`);

    writeFileSync(pngPath, pngBuffer);
    writeFileSync(jsonPath, JSON.stringify(descriptor, null, 2));

    const stats = atlas.getPackingStats();
    console.log(`[bake-atlas] ${size}x${size}: ${stats.glyphCount} glyphs, ${stats.usedPercent}% used`);
    console.log(`  PNG  → ${pngPath} (${(pngBuffer.byteLength / 1024).toFixed(1)} KB)`);
    console.log(`  JSON → ${jsonPath}`);
}

console.log('\n[bake-atlas] Done.');
