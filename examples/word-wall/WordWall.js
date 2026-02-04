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
    // Embedding-based layout
    useEmbeddings: true,  // If true, use embedding coordinates instead of grid
    embeddingScale: 50,    // Scale factor for embedding coordinates

    // Grid-based layout (fallback when no embeddings)
    wordsPerRow: 20,
    wordsPerColumn: 60,
    wordGap: 1.5,
    lineHeight: 1.5,
    layerSpacing: 3.0,
    maxWordLength: 18,

    // Colors
    dimColor: { r: 0.3, g: 0.3, b: 0.35 },
    highlightColor: { r: 0.2, g: 1.0, b: 0.5 },
    definitionColor: { r: 1.0, g: 0.7, b: 0.2 },

    // Highlight behavior
    highlightPop: 2.0,
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

        // Definition chain lines (one per meaning, created in build())
        this.chainLines = [];           // Array of THREE.Line objects
        this.chainLineUniforms = [];    // Array of uniform objects for each line
        this.maxChainLines = 8;         // Max number of simultaneous meaning chains
        this.chainLineMaxPoints = 100;  // Max points per chain

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
     * Load dictionary data and optional embedding coordinates
     * @param {Object} dictData - { word: definition, ... }
     * @param {Object} coordinates - { word: {x, y, z}, ... } or null
     */
    loadDictionary(dictData, coordinates = null) {
        const startTime = performance.now();

        this.dictionary.clear();
        this.sortedWords = [];
        this.embeddings = coordinates ? new Map() : null;

        for (const [word, definition] of Object.entries(dictData)) {
            const normalized = word.toLowerCase().trim();
            if (normalized.length > 0 && normalized.length <= 30) {
                this.dictionary.set(normalized, definition);
            }
        }

        // Store embeddings if provided
        if (coordinates) {
            for (const [word, coords] of Object.entries(coordinates)) {
                const normalized = word.toLowerCase().trim();
                if (this.dictionary.has(normalized)) {
                    this.embeddings.set(normalized, coords);
                }
            }
            console.log(`WordWall: ${this.embeddings.size} words have embeddings`);
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
     *
     * Handles multiple meanings separated by semicolons.
     * Preserves word order within each meaning for chain visualization.
     *
     * Structure: Map<word, { meanings: Array<string[]>, allWords: Set<string> }>
     *   - meanings: array of word arrays, one per semicolon-separated meaning
     *   - allWords: flat Set of all definition words (for quick highlight lookup)
     */
    _buildDefinitionMap(wordSet) {
        const startTime = performance.now();
        this.definitionMap.clear();

        let totalDefWords = 0;
        let totalLinks = 0;
        let totalMeanings = 0;

        for (const [word, definition] of this.dictionary) {
            // Split on semicolons to separate distinct meanings
            const meaningParts = definition.split(/;/);

            const meanings = [];
            const allWords = new Set();

            for (const part of meaningParts) {
                // Parse this meaning into ordered words
                const words = part
                    .toLowerCase()
                    .split(/[^a-z]+/)
                    .filter(w => w.length > 2 && w !== word && wordSet.has(w));

                if (words.length > 0) {
                    // Keep order but remove consecutive duplicates
                    const orderedWords = [];
                    for (const w of words) {
                        if (orderedWords.length === 0 || orderedWords[orderedWords.length - 1] !== w) {
                            orderedWords.push(w);
                            allWords.add(w);
                        }
                    }
                    if (orderedWords.length > 0) {
                        meanings.push(orderedWords);
                    }
                }
            }

            if (meanings.length > 0) {
                this.definitionMap.set(word, { meanings, allWords });
                totalDefWords++;
                totalLinks += allWords.size;
                totalMeanings += meanings.length;
            }
        }

        const buildTime = performance.now() - startTime;
        const avgLinks = totalDefWords > 0 ? (totalLinks / totalDefWords).toFixed(1) : 0;
        const avgMeanings = totalDefWords > 0 ? (totalMeanings / totalDefWords).toFixed(1) : 0;
        console.log(`WordWall: Built definition map in ${buildTime.toFixed(0)}ms`);
        console.log(`  - ${totalDefWords.toLocaleString()} words have definition links`);
        console.log(`  - ${totalLinks.toLocaleString()} total links (avg ${avgLinks} per word)`);
        console.log(`  - ${totalMeanings.toLocaleString()} total meanings (avg ${avgMeanings} per word)`);
    }

    /**
     * Build the 3D word visualization using GlyphRenderer
     * Supports both embedding-based and grid-based layouts
     */
    async build() {
        if (this.sortedWords.length === 0) {
            console.warn('WordWall: No words loaded');
            return this;
        }

        const startTime = performance.now();
        const useEmbeddings = this.config.useEmbeddings && this.embeddings && this.embeddings.size > 0;

        console.log(`WordWall: Building with ${this.sortedWords.length} words (mode: ${useEmbeddings ? 'embeddings' : 'grid'})...`);

        // Clear previous
        if (this.renderer) {
            this.renderer.dispose();
        }
        this.wordInfo.clear();

        const { maxWordLength, dimColor, embeddingScale } = this.config;

        // Estimate total glyphs for buffer sizing
        let totalGlyphs = 0;
        for (const word of this.sortedWords) {
            totalGlyphs += Math.min(word.length, maxWordLength);
        }

        console.log(`WordWall: Estimated ${totalGlyphs} glyphs, creating renderer...`);

        // Create renderer
        this.renderer = new GlyphRenderer(this.group, this.atlas, {
            maxInstances: Math.ceil(totalGlyphs * 1.1),
            defaultColor: dimColor
        });

        // Get metrics from renderer
        const metrics = this.renderer.metrics;
        this._charWidth = metrics.charWidth;
        this._charHeight = metrics.charHeight;
        this._letterSpacing = metrics.letterSpacing;
        this._glyphAdvance = this._charWidth + this._letterSpacing;

        console.log(`WordWall: Renderer metrics - charWidth: ${this._charWidth.toFixed(4)}`);

        // Build with appropriate layout
        if (useEmbeddings) {
            return this._buildWithEmbeddings(startTime);
        } else {
            return this._buildWithGrid(startTime);
        }
    }

    /**
     * Build using embedding coordinates
     */
    _buildWithEmbeddings(startTime) {
        const { maxWordLength, dimColor, embeddingScale } = this.config;

        // Track bounds for stats
        let minX = Infinity, maxX = -Infinity;
        let minY = Infinity, maxY = -Infinity;
        let minZ = Infinity, maxZ = -Infinity;

        // Track missing words
        const missingWords = [];
        const batchItems = [];
        let wordIndex = 0;

        for (const word of this.sortedWords) {
            const embedding = this.embeddings.get(word);

            if (!embedding) {
                missingWords.push(word);
                continue;
            }

            // Scale embedding coordinates
            const x = embedding.x * embeddingScale;
            const y = embedding.y * embeddingScale;
            const z = embedding.z * embeddingScale;

            // Track bounds
            minX = Math.min(minX, x); maxX = Math.max(maxX, x);
            minY = Math.min(minY, y); maxY = Math.max(maxY, y);
            minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);

            // Truncate for display
            const displayWord = word.length > maxWordLength
                ? word.slice(0, maxWordLength - 1) + '…'
                : word;

            // Color based on position in embedding space (for visual variety)
            const normX = (embedding.x + 10) / 20;  // Normalize roughly to 0-1
            const normY = (embedding.y + 10) / 20;
            const normZ = (embedding.z) / 20;
            const wordColor = {
                r: dimColor.r + normX * 0.15,
                g: dimColor.g + normY * 0.15,
                b: dimColor.b + normZ * 0.1
            };

            batchItems.push({
                text: displayWord,
                position: { x, y, z },
                options: { color: wordColor, alignment: 'left' }
            });

            // Store info
            this.wordInfo.set(word, {
                x, y, z,
                displayWord,
                originalColor: wordColor,
                wordIndex: wordIndex++
            });
        }

        // Log and expose missing words
        if (missingWords.length > 0) {
            console.warn(`WordWall: ${missingWords.length} words missing embeddings`);
            window.missingWords = missingWords;
            console.log('Missing words exposed as window.missingWords');
        }

        // Batch render
        console.log(`WordWall: Rendering ${batchItems.length} texts with embeddings...`);
        const textIds = this.renderer.renderBatch(batchItems);

        // Map words to renderer IDs
        let idx = 0;
        for (const word of this.sortedWords) {
            const info = this.wordInfo.get(word);
            if (info) {
                info.textId = textIds[idx++];
            }
        }

        // Store bounds for camera/hit detection
        this._bounds = {
            min: { x: minX, y: minY, z: minZ },
            max: { x: maxX, y: maxY, z: maxZ },
            width: maxX - minX,
            height: maxY - minY,
            depth: maxZ - minZ,
            center: {
                x: (minX + maxX) / 2,
                y: (minY + maxY) / 2,
                z: (minZ + maxZ) / 2
            }
        };

        // Stats
        const buildTime = performance.now() - startTime;
        this.stats = {
            totalWords: batchItems.length,
            totalGlyphs: this.renderer.getStats().glyphCount,
            missingWords: missingWords.length,
            bounds: this._bounds,
            buildTime,
            mode: 'embeddings'
        };

        // Create chain lines
        this._createChainLines();

        console.log(`WordWall: Built embedding cloud in ${buildTime.toFixed(0)}ms`);
        console.log(`  - ${this.stats.totalWords.toLocaleString()} words rendered`);
        console.log(`  - ${missingWords.length} words skipped (no embedding)`);
        console.log(`  - Bounds: X[${minX.toFixed(0)}, ${maxX.toFixed(0)}] Y[${minY.toFixed(0)}, ${maxY.toFixed(0)}] Z[${minZ.toFixed(0)}, ${maxZ.toFixed(0)}]`);

        return this;
    }

    /**
     * Build using grid layout (original volumetric cube)
     */
    _buildWithGrid(startTime) {
        const { wordsPerRow, wordsPerColumn, wordGap, lineHeight, layerSpacing, maxWordLength, dimColor } = this.config;

        // Calculate grid dimensions
        const wordsPerLayer = wordsPerRow * wordsPerColumn;
        const numLayers = Math.ceil(this.sortedWords.length / wordsPerLayer);

        console.log(`WordWall: Grid dimensions: ${wordsPerRow} x ${wordsPerColumn} x ${numLayers}`);

        // Cell dimensions
        const cellWidth = (maxWordLength * this._glyphAdvance) + (wordGap * this._glyphAdvance);
        const cellHeight = this._charHeight * lineHeight;
        const layerDepth = this._charHeight * layerSpacing;

        // Store for hit detection
        this._cellWidth = cellWidth;
        this._cellHeight = cellHeight;
        this._layerDepth = layerDepth;
        this._numLayers = numLayers;

        // Calculate cube dimensions
        const cubeWidth = wordsPerRow * cellWidth;
        const cubeHeight = wordsPerColumn * cellHeight;
        const cubeDepth = numLayers * layerDepth;

        // Build batch items
        const batchItems = [];

        for (let i = 0; i < this.sortedWords.length; i++) {
            const word = this.sortedWords[i];

            const layer = Math.floor(i / wordsPerLayer);
            const indexInLayer = i % wordsPerLayer;
            const row = Math.floor(indexInLayer / wordsPerRow);
            const col = indexInLayer % wordsPerRow;

            const x = (col * cellWidth) - cubeWidth / 2;
            const y = -(row * cellHeight) + cubeHeight / 2;
            const z = -(layer * layerDepth);

            const depthFade = 1.0 - (layer / numLayers) * 0.4;
            const layerColor = {
                r: dimColor.r * depthFade,
                g: dimColor.g * depthFade,
                b: dimColor.b * depthFade
            };

            const displayWord = word.length > maxWordLength
                ? word.slice(0, maxWordLength - 1) + '…'
                : word;

            batchItems.push({
                text: displayWord,
                position: { x, y, z },
                options: { color: layerColor, alignment: 'left' }
            });

            this.wordInfo.set(word, { layer, row, col, x, y, z, displayWord, originalColor: layerColor });
        }

        // Batch render
        console.log(`WordWall: Rendering ${batchItems.length} texts...`);
        const textIds = this.renderer.renderBatch(batchItems);

        // Map words to renderer IDs
        let idx = 0;
        for (const word of this.sortedWords) {
            const info = this.wordInfo.get(word);
            info.textId = textIds[idx++];
        }

        // Store bounds
        this._bounds = {
            min: { x: -cubeWidth / 2, y: -cubeHeight / 2, z: -cubeDepth },
            max: { x: cubeWidth / 2, y: cubeHeight / 2, z: 0 },
            width: cubeWidth,
            height: cubeHeight,
            depth: cubeDepth,
            center: { x: 0, y: 0, z: -cubeDepth / 2 }
        };

        // Stats
        const buildTime = performance.now() - startTime;
        this.stats = {
            totalWords: this.sortedWords.length,
            totalGlyphs: this.renderer.getStats().glyphCount,
            layers: numLayers,
            rows: wordsPerColumn,
            cols: wordsPerRow,
            cubeSize: { width: cubeWidth, height: cubeHeight, depth: cubeDepth },
            buildTime,
            mode: 'grid'
        };

        // Create chain lines
        this._createChainLines();

        console.log(`WordWall: Built 3D grid in ${buildTime.toFixed(0)}ms`);
        console.log(`  - ${this.stats.totalWords.toLocaleString()} words`);
        console.log(`  - ${numLayers} layers x ${wordsPerColumn} rows x ${wordsPerRow} cols`);

        return this;
    }

    /**
     * Color palette for different meaning chains
     * Each meaning gets a distinct color pair (start, end)
     */
    _getMeaningColors(meaningIndex) {
        const palettes = [
            { start: 0x00ffcc, end: 0x0088ff },  // Cyan → Blue
            { start: 0xff8800, end: 0xff0088 },  // Orange → Pink
            { start: 0x88ff00, end: 0x00ff88 },  // Lime → Mint
            { start: 0xff00ff, end: 0x8800ff },  // Magenta → Purple
            { start: 0xffff00, end: 0xff8800 },  // Yellow → Orange
            { start: 0x00ffff, end: 0x00ff00 },  // Cyan → Green
            { start: 0xff0000, end: 0xff8888 },  // Red → Pink
            { start: 0x8888ff, end: 0xff88ff },  // Periwinkle → Lavender
        ];
        return palettes[meaningIndex % palettes.length];
    }

    /**
     * Create multiple reusable line geometries for definition chains
     * Uses custom shaders for animated dashes, one line per meaning
     */
    _createChainLines() {
        // Clear any existing lines
        for (const line of this.chainLines) {
            this.group.remove(line);
            line.geometry.dispose();
            line.material.dispose();
        }
        this.chainLines = [];
        this.chainLineUniforms = [];

        // Vertex shader (shared)
        const vertexShader = `
            attribute float distance;
            varying float vDistance;
            varying float vNormalizedDist;
            uniform float totalDistance;

            void main() {
                vDistance = distance;
                vNormalizedDist = distance / max(totalDistance, 0.001);
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `;

        // Fragment shader (shared)
        const fragmentShader = `
            uniform float time;
            uniform float totalDistance;
            uniform float dashSize;
            uniform float gapSize;
            uniform float speed;
            uniform vec3 colorStart;
            uniform vec3 colorEnd;
            uniform float glowIntensity;

            varying float vDistance;
            varying float vNormalizedDist;

            void main() {
                // Animated dash pattern - flows from start toward end
                float cycleLength = dashSize + gapSize;
                float phase = mod(vDistance - time * speed, cycleLength);

                // Soft edges on dashes for glow effect
                float dashEdge = dashSize * 0.15;
                float dash = smoothstep(0.0, dashEdge, phase) *
                             smoothstep(dashSize, dashSize - dashEdge, phase);

                // Color gradient along the path
                vec3 color = mix(colorStart, colorEnd, vNormalizedDist);

                // Add subtle glow/pulse
                float glow = 1.0 + glowIntensity * sin(vDistance * 0.5 - time * 2.0);
                color *= glow;

                // Fade out toward the end slightly
                float endFade = 1.0 - smoothstep(0.85, 1.0, vNormalizedDist) * 0.5;

                gl_FragColor = vec4(color, dash * endFade);
            }
        `;

        // Create multiple line objects
        for (let i = 0; i < this.maxChainLines; i++) {
            const positions = new Float32Array(this.chainLineMaxPoints * 3);
            const distances = new Float32Array(this.chainLineMaxPoints);

            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
            geometry.setAttribute('distance', new THREE.BufferAttribute(distances, 1));
            geometry.setDrawRange(0, 0);

            const colors = this._getMeaningColors(i);

            const material = new THREE.ShaderMaterial({
                uniforms: {
                    time: { value: 0 },
                    totalDistance: { value: 1 },
                    dashSize: { value: 12.0 },
                    gapSize: { value: 8.0 },
                    speed: { value: 25.0 + i * 5 },  // Slightly different speeds
                    colorStart: { value: new THREE.Color(colors.start) },
                    colorEnd: { value: new THREE.Color(colors.end) },
                    glowIntensity: { value: 0.5 },
                },
                vertexShader,
                fragmentShader,
                transparent: true,
                depthWrite: false,
                blending: THREE.AdditiveBlending
            });

            const line = new THREE.Line(geometry, material);
            line.frustumCulled = false;
            this.group.add(line);

            this.chainLines.push(line);
            this.chainLineUniforms.push(material.uniforms);
        }
    }

    /**
     * Update all chain line animations (call each frame)
     */
    updateChainAnimation(deltaTime) {
        for (const uniforms of this.chainLineUniforms) {
            uniforms.time.value += deltaTime;
        }
    }

    /**
     * Get the visual center of a word (for line drawing)
     * Now works in full 3D - returns the word's actual position in the cube
     */
    getWordCenter(word) {
        const info = this.wordInfo.get(word);
        if (!info) return null;

        const wordWidth = info.displayWord.length * this._glyphAdvance;
        return {
            x: info.x + wordWidth / 2,
            y: info.y,
            z: info.z + this.config.highlightPop  // Pop forward slightly from its layer
        };
    }

    /**
     * Draw chain lines for multiple meanings
     * @param {string} primaryWord - The word being highlighted
     * @param {Array<string[]>} meanings - Array of word arrays, one per meaning
     */
    drawMeaningChains(primaryWord, meanings) {
        // Clear all lines first
        this.clearAllChainLines();

        const primaryCenter = this.getWordCenter(primaryWord);
        if (!primaryCenter) return;

        // Draw each meaning as a separate chain
        for (let m = 0; m < meanings.length && m < this.maxChainLines; m++) {
            const meaningWords = meanings[m];
            if (meaningWords.length === 0) continue;

            const line = this.chainLines[m];
            const uniforms = this.chainLineUniforms[m];
            const geometry = line.geometry;
            const positions = geometry.attributes.position.array;
            const distances = geometry.attributes.distance.array;

            let pointCount = 0;
            let cumulativeDistance = 0;
            let prevCenter = primaryCenter;

            // Start from primary word
            positions[0] = primaryCenter.x;
            positions[1] = primaryCenter.y;
            positions[2] = primaryCenter.z;
            distances[0] = 0;
            pointCount = 1;

            // Add each word in this meaning
            for (const word of meaningWords) {
                if (pointCount >= this.chainLineMaxPoints) break;

                const center = this.getWordCenter(word);
                if (center) {
                    const dx = center.x - prevCenter.x;
                    const dy = center.y - prevCenter.y;
                    const dz = center.z - prevCenter.z;
                    cumulativeDistance += Math.sqrt(dx*dx + dy*dy + dz*dz);

                    const idx = pointCount * 3;
                    positions[idx] = center.x;
                    positions[idx + 1] = center.y;
                    positions[idx + 2] = center.z;
                    distances[pointCount] = cumulativeDistance;

                    prevCenter = center;
                    pointCount++;
                }
            }

            // Update uniforms and buffers
            uniforms.totalDistance.value = cumulativeDistance;
            geometry.attributes.position.needsUpdate = true;
            geometry.attributes.distance.needsUpdate = true;
            geometry.setDrawRange(0, pointCount);
        }
    }

    /**
     * Clear all chain lines
     */
    clearAllChainLines() {
        for (const line of this.chainLines) {
            line.geometry.setDrawRange(0, 0);
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

        // Highlight primary word (pops forward from its layer)
        const info = this.wordInfo.get(normalized);
        if (info && info.textId !== undefined) {
            this._setWordHighlight(normalized, this.config.highlightColor, this.config.highlightPop);
            this.highlightedWords.add(normalized);
        }

        // Highlight definition words and draw meaning chains
        if (expandDefinition) {
            const defData = this.definitionMap.get(normalized);
            if (defData) {
                // Highlight ALL definition words (from all meanings)
                // Definition words pop forward slightly less than the primary
                for (const dw of defData.allWords) {
                    const dwInfo = this.wordInfo.get(dw);
                    if (dwInfo && dwInfo.textId !== undefined) {
                        this._setWordHighlight(dw, this.config.definitionColor, this.config.highlightPop * 0.5);
                        this.definitionWords.add(dw);
                    }
                }

                // Filter meanings to only include words that exist in the wall
                const validMeanings = defData.meanings.map(meaning =>
                    meaning.filter(w => this.wordInfo.has(w))
                ).filter(meaning => meaning.length > 0);

                // Draw separate chains for EACH meaning
                if (validMeanings.length > 0) {
                    this.drawMeaningChains(normalized, validMeanings);
                }
            }
        }
    }

    /**
     * Clear all highlights and chain lines
     */
    clearHighlights() {
        // Reset words to their original positions and colors (depth-faded)
        for (const word of this.highlightedWords) {
            const info = this.wordInfo.get(word);
            if (info && info.originalColor) {
                this._setWordHighlight(word, info.originalColor, 0);
            }
        }
        for (const word of this.definitionWords) {
            const info = this.wordInfo.get(word);
            if (info && info.originalColor) {
                this._setWordHighlight(word, info.originalColor, 0);
            }
        }

        this.highlightedWords.clear();
        this.definitionWords.clear();
        this.clearAllChainLines();
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

    _setWordHighlight(word, color, zOffset = 0) {
        const info = this.wordInfo.get(word);
        if (!info || info.textId === undefined || !this.renderer) return;

        // Use GlyphRenderer's update methods directly
        // In 3D mode, z is the word's layer position + optional highlight pop
        this.renderer.updateColor(info.textId, color);
        this.renderer.updatePosition(info.textId, {
            x: info.x,
            y: info.y,
            z: info.z + zOffset  // Add offset to word's actual Z position
        });
    }

    /**
     * Get definition data for a word (from pre-computed map)
     * Returns { meanings: Array<string[]>, allWords: Set<string> } or null
     */
    getDefinitionWords(word) {
        return this.definitionMap.get(word.toLowerCase().trim()) || null;
    }

    /**
     * Get the number of definition words for a word
     */
    getDefinitionWordCount(word) {
        const data = this.definitionMap.get(word.toLowerCase().trim());
        return data ? data.allWords.size : 0;
    }

    /**
     * Get the number of meanings for a word
     */
    getMeaningCount(word) {
        const data = this.definitionMap.get(word.toLowerCase().trim());
        return data ? data.meanings.length : 0;
    }

    // ============ Spatial Queries ============

    /**
     * Find which word is at a given 3D ray intersection
     * For volumetric mode, we need to check multiple layers
     *
     * @param {THREE.Ray} ray - The ray from camera through click point
     * @returns {string|null} The word at this position, or null
     */
    getWordAtRay(ray) {
        const { wordsPerRow, wordsPerColumn } = this.config;
        const wordsPerLayer = wordsPerRow * wordsPerColumn;

        const halfW = this._charWidth / 2;
        const halfH = this._charHeight / 2;
        const padding = this._charWidth * 0.3;

        // Check each layer from front to back (higher Z first)
        // Return the first hit (closest to camera)
        for (let layer = 0; layer < this._numLayers; layer++) {
            const layerZ = -(layer * this._layerDepth);

            // Intersect ray with this layer's Z plane
            const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -layerZ);
            const intersection = new THREE.Vector3();
            if (!ray.intersectPlane(plane, intersection)) continue;

            const x = intersection.x;
            const y = intersection.y;

            // Find candidate words in this layer
            // Convert to grid coordinates (accounting for centering)
            const cubeWidth = wordsPerRow * this._cellWidth;
            const cubeHeight = wordsPerColumn * this._cellHeight;

            const localX = x + cubeWidth / 2;
            const localY = -y + cubeHeight / 2;

            const approxCol = Math.floor(localX / this._cellWidth);
            const approxRow = Math.floor(localY / this._cellHeight);

            // Check nearby cells
            for (let dr = -1; dr <= 1; dr++) {
                for (let dc = -1; dc <= 1; dc++) {
                    const row = approxRow + dr;
                    const col = approxCol + dc;
                    if (row < 0 || col < 0 || row >= wordsPerColumn || col >= wordsPerRow) continue;

                    const indexInLayer = row * wordsPerRow + col;
                    const wordIndex = layer * wordsPerLayer + indexInLayer;
                    if (wordIndex >= this.sortedWords.length) continue;

                    const word = this.sortedWords[wordIndex];
                    const info = this.wordInfo.get(word);
                    if (!info || info.layer !== layer) continue;

                    // Check actual visual bounds
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
            }
        }

        return null;
    }

    /**
     * Legacy 2D position lookup (for compatibility)
     * In 3D mode, use getWordAtRay instead
     */
    getWordAtPosition(x, y) {
        // Create a simple ray pointing in -Z direction from (x, y, 100)
        const ray = new THREE.Ray(
            new THREE.Vector3(x, y, 100),
            new THREE.Vector3(0, 0, -1)
        );
        return this.getWordAtRay(ray);
    }

    /**
     * Get the world position of a word (for camera targeting)
     * Returns full 3D coordinates in volumetric mode
     */
    getWordPosition(word) {
        const info = this.wordInfo.get(word.toLowerCase().trim());
        if (!info) return null;

        return { x: info.x, y: info.y, z: info.z };
    }

    // ============ Public API ============

    /**
     * Get the 3D bounding box of the word cloud/cube
     */
    getBounds() {
        // Return pre-computed bounds from build()
        return this._bounds || null;
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
