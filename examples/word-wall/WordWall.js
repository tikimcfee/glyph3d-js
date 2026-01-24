/**
 * WordWall - A lexicographically sorted wall of dictionary words
 *
 * Uses glyph3d-js GlyphRenderer directly for rendering.
 * This file handles:
 * - Layout logic (words in a grid)
 * - Word tracking (word → textId mapping)
 * - Highlight coordination
 */

import * as THREE from 'three';
import GlyphRenderer from '../../src/GlyphRenderer.js';

const DEFAULT_CONFIG = {
    // Layout
    wordsPerRow: 50,
    wordGap: 1.5,        // Gap between words in character widths
    lineHeight: 1.5,     // Line spacing multiplier
    maxWordLength: 18,   // Truncate display for very long words

    // Colors
    dimColor: { r: 0.3, g: 0.3, b: 0.35 },
    highlightColor: { r: 0.2, g: 1.0, b: 0.5 },
    definitionColor: { r: 1.0, g: 0.7, b: 0.2 },

    // Z offsets for highlighting
    baseZ: 0,
    highlightZ: 2.0,
    definitionZ: 1.0,
};

export class WordWall {
    constructor(scene, atlas, options = {}) {
        this.scene = scene;
        this.atlas = atlas;
        this.config = { ...DEFAULT_CONFIG, ...options };

        // Dictionary data
        this.dictionary = new Map();  // word → definition string
        this.sortedWords = [];

        // Pre-computed definition word lookups
        // word → Set<defWord> (only words that exist in the wall)
        this.definitionMap = new Map();

        // Word → rendering info mapping
        // { textId (renderer ID), row, col, x, y }
        this.wordInfo = new Map();

        // Highlight state
        this.highlightedWords = new Set();
        this.definitionWords = new Set();

        // Container group for transforms
        this.group = new THREE.Group();
        this.scene.add(this.group);

        // Will be created in build()
        this.renderer = null;

        // Definition chain line (created in build())
        this.chainLine = null;
        this.chainLineMaxPoints = 200;  // Max definition words we'll connect

        // Metrics (computed from atlas)
        this._charWidth = 0;
        this._charHeight = 0;

        // Stats
        this.stats = {
            totalWords: 0,
            totalGlyphs: 0,
            rows: 0,
            cols: 0,
            buildTime: 0
        };
    }

    /**
     * Load dictionary data
     */
    loadDictionary(dictData) {
        const startTime = performance.now();

        this.dictionary.clear();
        this.sortedWords = [];

        for (const [word, definition] of Object.entries(dictData)) {
            const normalized = word.toLowerCase().trim();
            if (normalized.length > 0 && normalized.length <= 30) {
                this.dictionary.set(normalized, definition);
            }
        }

        this.sortedWords = Array.from(this.dictionary.keys()).sort();

        // Build a Set for O(1) membership checks
        const wordSet = new Set(this.sortedWords);

        console.log(`WordWall: Loaded ${this.sortedWords.length} words in ${(performance.now() - startTime).toFixed(0)}ms`);

        // Pre-compute definition word mappings
        this._buildDefinitionMap(wordSet);

        return this;
    }

    /**
     * Pre-compute definition word lookups for fast highlighting
     * This parses all definitions once at load time instead of on every click
     */
    _buildDefinitionMap(wordSet) {
        const startTime = performance.now();
        this.definitionMap.clear();

        let totalDefWords = 0;
        let totalLinks = 0;

        for (const [word, definition] of this.dictionary) {
            // Parse definition into words
            const defWords = definition
                .toLowerCase()
                .split(/[^a-z]+/)
                .filter(w => w.length > 2);

            // Dedupe and filter to only words that exist in the wall
            const uniqueDefWords = new Set();
            for (const dw of defWords) {
                if (dw !== word && wordSet.has(dw)) {
                    uniqueDefWords.add(dw);
                }
            }

            if (uniqueDefWords.size > 0) {
                this.definitionMap.set(word, uniqueDefWords);
                totalDefWords++;
                totalLinks += uniqueDefWords.size;
            }
        }

        const buildTime = performance.now() - startTime;
        const avgLinks = totalDefWords > 0 ? (totalLinks / totalDefWords).toFixed(1) : 0;
        console.log(`WordWall: Built definition map in ${buildTime.toFixed(0)}ms`);
        console.log(`  - ${totalDefWords.toLocaleString()} words have definition links`);
        console.log(`  - ${totalLinks.toLocaleString()} total links (avg ${avgLinks} per word)`);
    }

    /**
     * Build the visual wall using GlyphRenderer
     */
    async build() {
        if (this.sortedWords.length === 0) {
            console.warn('WordWall: No words loaded');
            return this;
        }

        const startTime = performance.now();
        console.log(`WordWall: Building wall with ${this.sortedWords.length} words...`);

        // Clear previous
        if (this.renderer) {
            this.renderer.dispose();
        }
        this.wordInfo.clear();

        const { wordsPerRow, wordGap, lineHeight, maxWordLength, baseZ, dimColor } = this.config;

        // Estimate total glyphs for buffer sizing
        let totalGlyphs = 0;
        for (const word of this.sortedWords) {
            totalGlyphs += Math.min(word.length, maxWordLength);
        }

        console.log(`WordWall: Estimated ${totalGlyphs} glyphs, creating renderer...`);

        // Create renderer FIRST, then get its metrics to ensure consistency
        this.renderer = new GlyphRenderer(this.group, this.atlas, {
            maxInstances: Math.ceil(totalGlyphs * 1.1),  // 10% headroom
            defaultColor: dimColor
        });

        // Get metrics FROM the renderer - this ensures our layout matches exactly
        const metrics = this.renderer.metrics;
        this._charWidth = metrics.charWidth;
        this._charHeight = metrics.charHeight;
        this._letterSpacing = metrics.letterSpacing;
        this._glyphAdvance = this._charWidth + this._letterSpacing;

        console.log(`WordWall: Using renderer metrics - charWidth: ${this._charWidth.toFixed(4)}, letterSpacing: ${this._letterSpacing.toFixed(4)}, glyphAdvance: ${this._glyphAdvance.toFixed(4)}`);

        // Cell dimensions - use glyphAdvance for accurate spacing
        const cellWidth = (maxWordLength * this._glyphAdvance) + (wordGap * this._glyphAdvance);
        const rowHeight = this._charHeight * lineHeight;

        // Build batch items
        const batchItems = [];

        for (let i = 0; i < this.sortedWords.length; i++) {
            const word = this.sortedWords[i];
            const row = Math.floor(i / wordsPerRow);
            const col = i % wordsPerRow;

            const x = col * cellWidth;
            const y = -row * rowHeight;  // Negative = downward

            // Truncate for display if needed
            const displayWord = word.length > maxWordLength
                ? word.slice(0, maxWordLength - 1) + '…'
                : word;

            batchItems.push({
                text: displayWord,
                position: { x, y, z: baseZ },
                options: { color: dimColor, alignment: 'left' }
            });

            // Store info (textId will be assigned after renderBatch)
            this.wordInfo.set(word, { row, col, x, y, displayWord });
        }

        // Batch render all texts
        console.log(`WordWall: Rendering ${batchItems.length} texts...`);
        const textIds = this.renderer.renderBatch(batchItems);

        // Map words to their renderer IDs
        let idx = 0;
        for (const word of this.sortedWords) {
            const info = this.wordInfo.get(word);
            info.textId = textIds[idx];
            idx++;
        }

        // Stats
        const buildTime = performance.now() - startTime;
        this.stats = {
            totalWords: this.sortedWords.length,
            totalGlyphs: this.renderer.getStats().glyphCount,
            rows: Math.ceil(this.sortedWords.length / wordsPerRow),
            cols: wordsPerRow,
            buildTime
        };

        // Create the definition chain line
        this._createChainLine();

        console.log(`WordWall: Built in ${buildTime.toFixed(0)}ms`);
        console.log(`  - ${this.stats.totalWords.toLocaleString()} words`);
        console.log(`  - ${this.stats.totalGlyphs.toLocaleString()} glyphs`);
        console.log(`  - ${this.stats.rows} rows x ${this.stats.cols} cols`);

        return this;
    }

    /**
     * Create the reusable line geometry for definition chains
     */
    _createChainLine() {
        // Pre-allocate buffer for max points
        const positions = new Float32Array(this.chainLineMaxPoints * 3);

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setDrawRange(0, 0);  // Start with nothing visible

        // Line material with a nice gradient-like color
        const material = new THREE.LineBasicMaterial({
            color: 0x00ffaa,
            linewidth: 2,  // Note: linewidth > 1 only works on some platforms
            transparent: true,
            opacity: 0.8
        });

        this.chainLine = new THREE.Line(geometry, material);
        this.chainLine.frustumCulled = false;
        this.group.add(this.chainLine);
    }

    /**
     * Get the visual center of a word (for line drawing)
     */
    getWordCenter(word) {
        const info = this.wordInfo.get(word);
        if (!info) return null;

        // Word center: halfway through the word horizontally, vertically centered
        const wordWidth = info.displayWord.length * this._glyphAdvance;
        return {
            x: info.x + wordWidth / 2,
            y: info.y,  // y is already the glyph center
            z: this.config.definitionZ + 0.5  // Slightly in front of highlighted words
        };
    }

    /**
     * Draw a chain line connecting a sequence of words
     */
    drawWordChain(words) {
        if (!this.chainLine || words.length < 2) {
            this.clearChainLine();
            return;
        }

        const positions = this.chainLine.geometry.attributes.position.array;
        let pointCount = 0;

        for (const word of words) {
            if (pointCount >= this.chainLineMaxPoints) break;

            const center = this.getWordCenter(word);
            if (center) {
                const idx = pointCount * 3;
                positions[idx] = center.x;
                positions[idx + 1] = center.y;
                positions[idx + 2] = center.z;
                pointCount++;
            }
        }

        // Update the geometry
        this.chainLine.geometry.attributes.position.needsUpdate = true;
        this.chainLine.geometry.setDrawRange(0, pointCount);
    }

    /**
     * Clear the chain line
     */
    clearChainLine() {
        if (this.chainLine) {
            this.chainLine.geometry.setDrawRange(0, 0);
        }
    }

    // ============ Highlighting ============

    /**
     * Highlight a word and optionally its definition words
     *
     * Uses direct buffer writes - no rebuild needed!
     * Each updateColor/updatePosition writes directly to GPU buffer indices.
     */
    highlightWord(word, expandDefinition = true) {
        const normalized = word.toLowerCase().trim();

        // Clear previous highlights (direct buffer writes)
        this.clearHighlights();

        // Highlight primary word
        const info = this.wordInfo.get(normalized);
        if (info && info.textId !== undefined) {
            this._setWordHighlight(normalized, this.config.highlightColor, this.config.highlightZ);
            this.highlightedWords.add(normalized);
        }

        // Build ordered chain for line drawing: [primaryWord, ...definitionWords]
        const chainWords = [normalized];

        // Highlight definition words using pre-computed map (O(1) lookup!)
        if (expandDefinition) {
            const defWords = this.definitionMap.get(normalized);
            if (defWords) {
                for (const dw of defWords) {
                    const dwInfo = this.wordInfo.get(dw);
                    if (dwInfo && dwInfo.textId !== undefined) {
                        this._setWordHighlight(dw, this.config.definitionColor, this.config.definitionZ);
                        this.definitionWords.add(dw);
                        chainWords.push(dw);
                    }
                }
            }
        }

        // Draw the definition chain line
        if (chainWords.length > 1) {
            this.drawWordChain(chainWords);
        }
    }

    /**
     * Clear all highlights and chain lines
     */
    clearHighlights() {
        for (const word of this.highlightedWords) {
            this._setWordHighlight(word, this.config.dimColor, this.config.baseZ);
        }
        for (const word of this.definitionWords) {
            this._setWordHighlight(word, this.config.dimColor, this.config.baseZ);
        }

        this.highlightedWords.clear();
        this.definitionWords.clear();
        this.clearChainLine();
    }

    /**
     * Play a sentence - highlight words in sequence
     */
    async playSentence(sentence, intervalMs = 400) {
        const words = sentence.toLowerCase().split(/[^a-z]+/).filter(w => w.length > 0);
        console.log(`WordWall: Playing ${words.length} words`);

        for (const word of words) {
            this.highlightWord(word, true);
            await new Promise(r => setTimeout(r, intervalMs));
        }
    }

    // ============ Internal ============

    _setWordHighlight(word, color, z) {
        const info = this.wordInfo.get(word);
        if (!info || info.textId === undefined || !this.renderer) return;

        // Use GlyphRenderer's update methods directly
        this.renderer.updateColor(info.textId, color);
        this.renderer.updatePosition(info.textId, { x: info.x, y: info.y, z });
    }

    /**
     * Get definition words for a word (from pre-computed map)
     * Returns a Set of words, or null if none
     */
    getDefinitionWords(word) {
        return this.definitionMap.get(word.toLowerCase().trim()) || null;
    }

    // ============ Spatial Queries ============

    /**
     * Find which word is at a given world position (x, y)
     * Used for click detection
     *
     * Glyph positions (info.x, info.y) represent where the glyph quad is centered.
     * The visual bounds of a word span from:
     *   - Left: first glyph center - charWidth/2
     *   - Right: last glyph center + charWidth/2
     *   - Top: glyph center + charHeight/2
     *   - Bottom: glyph center - charHeight/2
     */
    getWordAtPosition(x, y) {
        const { wordsPerRow, wordGap, lineHeight, maxWordLength } = this.config;

        // Cell dimensions (for grid lookup)
        const cellWidth = (maxWordLength * this._glyphAdvance) + (wordGap * this._glyphAdvance);
        const rowHeight = this._charHeight * lineHeight;

        // Quick grid lookup to narrow down candidates
        // Estimate which row we're in (y is negative going down)
        const approxRow = Math.floor(-y / rowHeight);
        const approxCol = Math.floor(x / cellWidth);

        if (approxCol < 0 || approxRow < 0) return null;

        // Check the candidate cell and neighbors (in case we're on a boundary)
        const candidates = [];
        for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
                const row = approxRow + dr;
                const col = approxCol + dc;
                if (row < 0 || col < 0 || col >= wordsPerRow) continue;

                const wordIndex = row * wordsPerRow + col;
                if (wordIndex >= 0 && wordIndex < this.sortedWords.length) {
                    candidates.push(this.sortedWords[wordIndex]);
                }
            }
        }

        // Check each candidate's actual visual bounds
        const halfW = this._charWidth / 2;
        const halfH = this._charHeight / 2;
        const padding = this._charWidth * 0.2;  // Small click padding

        for (const word of candidates) {
            const info = this.wordInfo.get(word);
            if (!info) continue;

            // Visual bounds of this word
            // First glyph is at info.x, last glyph is at info.x + (len-1) * glyphAdvance
            const firstGlyphX = info.x;
            const lastGlyphX = info.x + (info.displayWord.length - 1) * this._glyphAdvance;

            const visualLeft = firstGlyphX - halfW - padding;
            const visualRight = lastGlyphX + halfW + padding;
            const visualTop = info.y + halfH + padding;
            const visualBottom = info.y - halfH - padding;

            if (x >= visualLeft && x <= visualRight &&
                y >= visualBottom && y <= visualTop) {
                return word;
            }
        }

        return null;
    }

    /**
     * Get the world position of a word (for camera targeting)
     */
    getWordPosition(word) {
        const info = this.wordInfo.get(word.toLowerCase().trim());
        if (!info) return null;

        return { x: info.x, y: info.y, z: this.config.baseZ };
    }

    // ============ Public API ============

    getBounds() {
        if (this.stats.totalWords === 0) return null;

        const { wordsPerRow, maxWordLength, wordGap, lineHeight } = this.config;

        // Use same cell dimensions as build()
        const cellWidth = (maxWordLength * this._glyphAdvance) + (wordGap * this._glyphAdvance);
        const rowHeight = this._charHeight * lineHeight;

        return {
            min: { x: 0, y: -this.stats.rows * rowHeight, z: this.config.baseZ },
            max: { x: wordsPerRow * cellWidth, y: 0, z: this.config.highlightZ },
            width: wordsPerRow * cellWidth,
            height: this.stats.rows * rowHeight
        };
    }

    getGroup() {
        return this.group;
    }

    setPosition(pos) {
        this.group.position.set(pos.x || 0, pos.y || 0, pos.z || 0);
    }

    setScale(s) {
        this.group.scale.setScalar(s);
    }

    getStats() {
        return {
            ...this.stats,
            highlightedCount: this.highlightedWords.size,
            definitionCount: this.definitionWords.size
        };
    }

    dispose() {
        if (this.renderer) {
            this.renderer.dispose();
            this.renderer = null;
        }
        this.scene.remove(this.group);
        this.dictionary.clear();
        this.sortedWords = [];
        this.wordInfo.clear();
    }
}

export default WordWall;
