/**
 * Wand.js — 3D word probe that follows cursor and lights up from picks
 *
 * Two layout modes:
 *   • Sphere (default) — Fibonacci sphere of taxonomy symbols.
 *     Used for the cursor-following hover wand.
 *   • Rect sheet — flat grid filling width × height.
 *     Used by WandField for sheetrock-like layers behind the code.
 *     Pass { width, height } in options to activate.
 *
 * Active picks glow in their block color; inactive symbols dim out.
 *
 * No classes. Factory function returns a plain object:
 *   createWand(scene, atlas, words, options?) → wand
 *
 *   wand.setTarget(x, y, z?)    — where to drift toward (lerp)
 *   wand.setPosition(x, y, z)   — snap to position immediately
 *   wand.update(picks, words)    — recolor from fresh picks
 *   wand.tick(dt)                — per-frame animation step
 *   wand.clear()                 — reset all to dim
 *   wand.dispose()               — tear down
 */

import * as THREE from 'three';
import GlyphRenderer from '../../src/GlyphRenderer.js';
import { BLOCKS } from './taxonomy.js';
import { mergePicks } from './spectrometer.js';


// ─── Layout ─────────────────────────────────────────────────────────

const BLOCK_ORDER = ['substance', 'action', 'pattern', 'quality', 'domain'];

/**
 * Distribute words on a Fibonacci sphere.
 * Sorted by block first → same-block words cluster into bands.
 *
 * @param {Array} words - element array from taxonomy
 * @param {number} radius - sphere radius in world units
 * @returns {Array<{word, position: {x,y,z}}>}
 */
export function buildSphereLayout(words, radius) {
    const sorted = [...words].sort((a, b) => {
        const ai = BLOCK_ORDER.indexOf(a.block);
        const bi = BLOCK_ORDER.indexOf(b.block);
        return ai !== bi ? ai - bi : a.period - b.period;
    });

    const n = sorted.length;
    const phi = Math.PI * (3 - Math.sqrt(5)); // golden angle ≈ 2.4

    return sorted.map((word, i) => {
        const y = 1 - (2 * i) / (n - 1);          // uniform -1 → 1
        const ringR = Math.sqrt(1 - y * y);         // ring radius at this latitude
        const theta = phi * i;                       // longitude via golden angle

        return {
            word,
            position: {
                x: ringR * Math.cos(theta) * radius,
                y: y * radius,
                z: ringR * Math.sin(theta) * radius,
            },
        };
    });
}


/**
 * Distribute words in a flat rectangular grid.
 * Fills the given width × height region, centered at origin.
 * Sorted by block so same-type words cluster together visually.
 *
 * @param {Array} words - element array from taxonomy
 * @param {number} width - total width of the rect in world units
 * @param {number} height - total height of the rect in world units
 * @returns {Array<{word, position: {x,y,z}}>}
 */
function buildRectLayout(words, width, height) {
    const sorted = [...words].sort((a, b) => {
        const ai = BLOCK_ORDER.indexOf(a.block);
        const bi = BLOCK_ORDER.indexOf(b.block);
        return ai !== bi ? ai - bi : a.period - b.period;
    });

    const n = sorted.length;
    const aspect = width / Math.max(height, 0.001);

    // Grid dimensions: try to fill the rect evenly
    const cols = Math.max(1, Math.round(Math.sqrt(n * aspect)));
    const rows = Math.max(1, Math.ceil(n / cols));

    const cellW = width / cols;
    const cellH = height / rows;

    return sorted.map((word, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);

        return {
            word,
            position: {
                x: (col + 0.5) * cellW - width / 2,
                y: height / 2 - (row + 0.5) * cellH,
                z: 0,   // flat — all in the same plane
            },
        };
    });
}


// ─── Color helpers ──────────────────────────────────────────────────

function scale3(c, s) {
    return { r: c.r * s, g: c.g * s, b: c.b * s };
}

function lerp3(a, b, t) {
    return {
        r: a.r + (b.r - a.r) * t,
        g: a.g + (b.g - a.g) * t,
        b: a.b + (b.b - a.b) * t,
    };
}

function clamp01(v) { return Math.min(1, Math.max(0, v)); }

function clamp3(c) {
    return { r: clamp01(c.r), g: clamp01(c.g), b: clamp01(c.b) };
}


// ─── Defaults ───────────────────────────────────────────────────────

const DEFAULTS = {
    radius:        14,      // sphere radius (world units) — sphere mode only
    width:         0,       // rect width  (> 0 activates rect mode)
    height:        0,       // rect height (> 0 activates rect mode)
    dimBrightness: 0.06,    // how dim inactive words are (fraction of block color)
    lerpSpeed:     5,       // position-follow speed
    wobbleSpeed:   0,       // disabled — was causing per-frame matrix dirtying
    wobbleAngle:   0,       // on hundreds of probes for negligible visual effect
    zOffset:       12,      // offset toward camera so wand floats in front of code
};


// ─── Factory ────────────────────────────────────────────────────────

/**
 * Create a wand — a floating 3D word probe.
 *
 * Sphere mode (default): pass { radius }.
 * Rect mode: pass { width, height } — flat sheet of symbols.
 *
 * @param {THREE.Scene} scene
 * @param {GlyphAtlas} atlas
 * @param {Array} words - element vocabulary from taxonomy
 * @param {object} [options]
 * @returns {object} wand
 */
export function createWand(scene, atlas, words, options = {}) {
    const cfg = { ...DEFAULTS, ...options };
    const useRect = cfg.width > 0 && cfg.height > 0;

    // ─── Scene container ──────────────────────────────────────
    const group = new THREE.Group();
    group.visible = true;
    scene.add(group);

    // ─── Glyph renderer (its own instance, separate from code view) ──
    // Symbols are 1-3 chars each
    const totalGlyphs = words.reduce((n, w) => n + w.symbol.length, 0);

    const renderer = new GlyphRenderer(group, atlas, {
        maxInstances: Math.ceil(totalGlyphs * 1.5) + 100,
        defaultColor: { r: 0.04, g: 0.04, b: 0.06 },
    });

    // ─── Layout: rect sheet or sphere ─────────────────────────
    const layout = useRect
        ? buildRectLayout(words, cfg.width, cfg.height)
        : buildSphereLayout(words, cfg.radius);
    const fallback = { r: 0.5, g: 0.5, b: 0.5 };

    const batchItems = layout.map(entry => ({
        text: entry.word.symbol,
        position: entry.position,
        options: {
            color: scale3(
                BLOCKS[entry.word.block]?.color || fallback,
                cfg.dimBrightness,
            ),
        },
    }));

    const textIds = renderer.renderBatch(batchItems);

    // ─── Lookup: word name → rendering info ───────────────────
    const wordMap = new Map();
    layout.forEach((entry, i) => {
        wordMap.set(entry.word.name, {
            textId: textIds[i],
            blockColor: BLOCKS[entry.word.block]?.color || fallback,
        });
    });

    // ─── Animation state ──────────────────────────────────────
    const targetPos = new THREE.Vector3(0, 0, cfg.zOffset);
    const currentPos = new THREE.Vector3(0, 0, cfg.zOffset);
    let wobblePhase = 0;
    let visible = true;

    // ─── Return the wand ──────────────────────────────────────
    return {
        get group() { return group; },
        get visible() { return visible; },

        /**
         * Set world-space target the wand should drift toward.
         * Typically the ray-plane intersection from hover detection,
         * automatically offset in z by cfg.zOffset.
         */
        setTarget(x, y, z = 0) {
            targetPos.set(x, y, z + cfg.zOffset);
        },

        /**
         * Snap to a position immediately (no lerp).
         * Used by WandField for static probe placement.
         */
        setPosition(x, y, z = 0) {
            targetPos.set(x, y, z);
            currentPos.set(x, y, z);
            group.position.set(x, y, z);
        },

        /**
         * Recolor all words from fresh analyzer picks.
         * Inactive words go dim; active ones ramp to full block color.
         *
         * @param {Array<{name, score, evidence}>} picks
         * @param {Array} wordsArg - same word set used for analysis
         */
        update(picks, wordsArg) {
            const merged = mergePicks(picks, wordsArg);

            renderer.beginBatchUpdate();

            for (const entry of merged) {
                const info = wordMap.get(entry.word.name);
                if (!info) continue;

                const base = info.blockColor;

                if (entry.intensity > 0) {
                    const t = entry.intensity;
                    const dim = scale3(base, cfg.dimBrightness);
                    const bright = clamp3({
                        r: base.r * (0.4 + t * 0.9),
                        g: base.g * (0.4 + t * 0.9),
                        b: base.b * (0.4 + t * 0.9),
                    });
                    renderer.updateColor(info.textId, lerp3(dim, bright, t));
                } else {
                    renderer.updateColor(info.textId, scale3(base, cfg.dimBrightness));
                }
            }

            renderer.endBatchUpdate();
        },

        /**
         * Per-frame tick: smooth position follow + subtle wobble.
         */
        tick(dt) {
            if (!visible) return;

            // Smooth position follow (exponential ease)
            currentPos.lerp(targetPos, 1 - Math.exp(-cfg.lerpSpeed * dt));
            group.position.copy(currentPos);

            // Gentle Y oscillation — just enough to show it's 3D
            wobblePhase += cfg.wobbleSpeed * dt;
            group.rotation.y = Math.sin(wobblePhase) * cfg.wobbleAngle;
        },

        /**
         * Reset all words to dim.
         */
        clear() {
            renderer.beginBatchUpdate();
            for (const [, info] of wordMap) {
                renderer.updateColor(
                    info.textId,
                    scale3(info.blockColor, cfg.dimBrightness),
                );
            }
            renderer.endBatchUpdate();
        },

        setVisible(v) {
            visible = v;
            group.visible = v;
        },

        dispose() {
            renderer.dispose();
            scene.remove(group);
        },
    };
}
