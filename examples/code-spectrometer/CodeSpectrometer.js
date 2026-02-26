/**
 * CodeSpectrometer - Periodic table of code concepts, rendered in 3D
 *
 * Lays out taxonomy elements in a periodic-table-like grid using glyph3d-js.
 * Each element shows:
 *   - Its symbol (large, prominent)
 *   - Its full name (smaller, below)
 *   - A colored background that intensifies when code analysis finds matches
 *
 * The layout follows the taxonomy's period (row) and group (column) structure,
 * with gaps that mirror the periodic table's distinctive shape.
 */

import * as THREE from 'three';
import GlyphRenderer from '../../src/GlyphRenderer.js';
import { ELEMENTS, BLOCKS, getElementColor, getTableDimensions } from './taxonomy.js';

const CONFIG = {
    // Cell sizing
    cellWidth: 8,           // Width of each element cell (in world units)
    cellHeight: 5,          // Height of each element cell
    cellPadding: 0.8,       // Padding between cells
    groupGap: 1.5,          // Extra gap between groups at specific positions
    periodGap: 2.0,         // Extra gap between main table and lanthanide/actinide rows

    // Text sizing
    symbolScale: 1.0,       // Scale for element symbols
    nameScale: 0.5,         // Scale for element names

    // Visual
    dimAlpha: 0.15,         // How dim unmatched elements are
    glowStrength: 2.0,      // How much matched elements pop in Z
    backgroundColor: { r: 0.05, g: 0.05, b: 0.08 },

    // Animation
    pulseSpeed: 2.0,        // Speed of intensity pulse animation
    fadeSpeed: 3.0,         // Speed of fade transitions
};

export class CodeSpectrometer {
    constructor(scene, atlas, options = {}) {
        this.scene = scene;
        this.atlas = atlas;
        this.config = { ...CONFIG, ...options };

        // Container
        this.group = new THREE.Group();
        this.scene.add(this.group);

        // Renderers
        this.symbolRenderer = null;   // For element symbols (Ty, Vl, etc.)
        this.nameRenderer = null;     // For element names (type, value, etc.)
        this.countRenderer = null;    // For hit counts

        // Element tracking
        this.elementInfo = new Map();  // element.name → { textIds, position, currentIntensity }

        // Background panels
        this.panels = [];              // THREE.Mesh objects for cell backgrounds
        this.panelMaterials = [];      // Materials for updating colors

        // Analysis state
        this.currentResults = null;
        this.targetIntensities = new Map();  // element.name → target intensity (0-1)
        this.currentIntensities = new Map(); // element.name → current intensity (animated)

        // Bounds
        this._bounds = null;

        // Metrics
        this._charWidth = 0;
        this._charHeight = 0;
    }

    /**
     * Build the periodic table visualization
     */
    async build() {
        const startTime = performance.now();
        const { cellWidth, cellHeight, cellPadding } = this.config;
        const dims = getTableDimensions();

        console.log(`CodeSpectrometer: Building table (${dims.periods} periods × ${dims.groups} groups, ${ELEMENTS.length} elements)...`);

        // Estimate glyph counts
        let symbolGlyphs = 0;
        let nameGlyphs = 0;
        for (const el of ELEMENTS) {
            symbolGlyphs += el.symbol.length;
            nameGlyphs += el.name.length;
        }
        // Count glyphs are up to 5 digits per element
        const countGlyphs = ELEMENTS.length * 5;

        // Create renderers
        this.symbolRenderer = new GlyphRenderer(this.group, this.atlas, {
            maxInstances: Math.ceil(symbolGlyphs * 1.2),
            defaultColor: { r: 0.8, g: 0.8, b: 0.8 },
        });

        this.nameRenderer = new GlyphRenderer(this.group, this.atlas, {
            maxInstances: Math.ceil(nameGlyphs * 1.2),
            defaultColor: { r: 0.4, g: 0.4, b: 0.4 },
        });

        this.countRenderer = new GlyphRenderer(this.group, this.atlas, {
            maxInstances: Math.ceil(countGlyphs * 1.2),
            defaultColor: { r: 0.6, g: 0.6, b: 0.6 },
        });

        // Get metrics
        const metrics = this.symbolRenderer.metrics;
        this._charWidth = metrics.charWidth;
        this._charHeight = metrics.charHeight;

        // Calculate positions and build
        const symbolBatch = [];
        const nameBatch = [];
        const countBatch = [];

        let minX = Infinity, maxX = -Infinity;
        let minY = Infinity, maxY = -Infinity;

        for (const el of ELEMENTS) {
            const pos = this._getElementPosition(el);

            // Track bounds
            minX = Math.min(minX, pos.x);
            maxX = Math.max(maxX, pos.x + cellWidth);
            minY = Math.min(minY, pos.y - cellHeight);
            maxY = Math.max(maxY, pos.y);

            // Symbol (large, centered in cell)
            const symbolX = pos.x + (cellWidth - el.symbol.length * this._charWidth * 1.8) / 2;
            const symbolY = pos.y - cellHeight * 0.35;

            symbolBatch.push({
                text: el.symbol,
                position: { x: symbolX, y: symbolY, z: 0.1 },
                options: {
                    color: getElementColor(el, 0.3),
                    scale: 1.8,
                },
            });

            // Name (smaller, below symbol)
            const nameX = pos.x + (cellWidth - el.name.length * this._charWidth * 0.7) / 2;
            const nameY = pos.y - cellHeight * 0.72;

            nameBatch.push({
                text: el.name,
                position: { x: nameX, y: nameY, z: 0.1 },
                options: {
                    color: { r: 0.25, g: 0.25, b: 0.3 },
                    scale: 0.7,
                },
            });

            // Count placeholder (hidden until analysis runs)
            const countX = pos.x + cellWidth * 0.65;
            const countY = pos.y - cellHeight * 0.15;

            countBatch.push({
                text: '    ',  // 4 spaces placeholder
                position: { x: countX, y: countY, z: 0.2 },
                options: {
                    color: { r: 0, g: 0, b: 0 },  // invisible until needed
                    scale: 0.5,
                },
            });

            // Create background panel
            this._createPanel(el, pos);

            // Store info
            this.elementInfo.set(el.name, {
                element: el,
                position: pos,
                currentIntensity: 0,
            });
            this.targetIntensities.set(el.name, 0);
            this.currentIntensities.set(el.name, 0);
        }

        // Batch render all text
        const symbolIds = this.symbolRenderer.renderBatch(symbolBatch);
        const nameIds = this.nameRenderer.renderBatch(nameBatch);
        const countIds = this.countRenderer.renderBatch(countBatch);

        // Store text IDs
        let idx = 0;
        for (const el of ELEMENTS) {
            const info = this.elementInfo.get(el.name);
            info.symbolTextId = symbolIds[idx];
            info.nameTextId = nameIds[idx];
            info.countTextId = countIds[idx];
            idx++;
        }

        // Store bounds
        this._bounds = {
            min: { x: minX, y: minY - 2, z: -1 },
            max: { x: maxX + 2, y: maxY + 2, z: 5 },
            width: maxX - minX + 2,
            height: maxY - minY + 4,
            center: {
                x: (minX + maxX) / 2,
                y: (minY + maxY) / 2,
                z: 0,
            },
        };

        // Add block legend
        this._createLegend();

        const buildTime = performance.now() - startTime;
        console.log(`CodeSpectrometer: Built in ${buildTime.toFixed(0)}ms (${ELEMENTS.length} elements)`);

        return this;
    }

    /**
     * Calculate the position of an element in the table
     */
    _getElementPosition(element) {
        const { cellWidth, cellHeight, cellPadding, periodGap } = this.config;
        const totalCellW = cellWidth + cellPadding;
        const totalCellH = cellHeight + cellPadding;

        let x = (element.group - 1) * totalCellW;
        let y = -(element.period - 1) * totalCellH;

        // Extra gap before periods 7 and 8 (lanthanide/actinide-style rows)
        if (element.period >= 7) {
            y -= periodGap;
        }
        if (element.period >= 8) {
            y -= periodGap * 0.5;
        }

        return { x, y };
    }

    /**
     * Create a background panel for an element cell
     */
    _createPanel(element, pos) {
        const { cellWidth, cellHeight } = this.config;

        const geometry = new THREE.PlaneGeometry(cellWidth, cellHeight);
        const block = BLOCKS[element.block];
        const color = block ? block.color : { r: 0.3, g: 0.3, b: 0.3 };

        const material = new THREE.MeshBasicMaterial({
            color: new THREE.Color(color.r * 0.08, color.g * 0.08, color.b * 0.08),
            transparent: true,
            opacity: 0.6,
            side: THREE.DoubleSide,
        });

        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.set(
            pos.x + cellWidth / 2,
            pos.y - cellHeight / 2,
            -0.01
        );
        this.group.add(mesh);

        // Store for later updates
        this.panels.push(mesh);
        this.panelMaterials.push({ material, element, block });
    }

    /**
     * Create a legend showing block colors and names
     */
    _createLegend() {
        const bounds = this._bounds;
        if (!bounds) return;

        const legendY = bounds.min.y - 5;
        let legendX = bounds.min.x;
        const spacing = 30;

        for (const [key, block] of Object.entries(BLOCKS)) {
            // Color swatch (small panel)
            const swatchGeo = new THREE.PlaneGeometry(2, 1.5);
            const swatchMat = new THREE.MeshBasicMaterial({
                color: new THREE.Color(block.color.r * 0.5, block.color.g * 0.5, block.color.b * 0.5),
                transparent: true,
                opacity: 0.8,
            });
            const swatch = new THREE.Mesh(swatchGeo, swatchMat);
            swatch.position.set(legendX + 1, legendY, -0.01);
            this.group.add(swatch);

            // Label
            this.nameRenderer.render(block.name,
                { x: legendX + 3, y: legendY - 0.3, z: 0.1 },
                {
                    color: { r: block.color.r * 0.6, g: block.color.g * 0.6, b: block.color.b * 0.6 },
                    scale: 0.6,
                }
            );

            legendX += spacing;
        }
    }

    /**
     * Apply analysis results — sets target intensities for animation
     */
    applyResults(analysisResults) {
        this.currentResults = analysisResults;

        for (const [name, result] of analysisResults) {
            if (this.targetIntensities.has(name)) {
                this.targetIntensities.set(name, result.intensity || 0);
            }
        }
    }

    /**
     * Clear all highlights — reset to dim state
     */
    clearResults() {
        this.currentResults = null;
        for (const name of this.targetIntensities.keys()) {
            this.targetIntensities.set(name, 0);
        }
    }

    /**
     * Update animation (call each frame)
     * Smoothly transitions element intensities toward targets
     */
    update(deltaTime) {
        const { fadeSpeed, glowStrength } = this.config;
        let anyChanged = false;

        let idx = 0;
        for (const el of ELEMENTS) {
            const name = el.name;
            const target = this.targetIntensities.get(name) || 0;
            const current = this.currentIntensities.get(name) || 0;

            // Lerp toward target
            const diff = target - current;
            if (Math.abs(diff) > 0.001) {
                const newIntensity = current + diff * Math.min(fadeSpeed * deltaTime, 1);
                this.currentIntensities.set(name, newIntensity);
                anyChanged = true;

                // Update panel color
                const panelInfo = this.panelMaterials[idx];
                if (panelInfo) {
                    const block = panelInfo.block;
                    const baseAlpha = 0.08;
                    const intensity = newIntensity;
                    panelInfo.material.color.setRGB(
                        block.color.r * (baseAlpha + intensity * 0.4),
                        block.color.g * (baseAlpha + intensity * 0.4),
                        block.color.b * (baseAlpha + intensity * 0.4)
                    );
                    panelInfo.material.opacity = 0.6 + intensity * 0.4;
                }

                // Update symbol color
                const info = this.elementInfo.get(name);
                if (info && this.symbolRenderer) {
                    const color = getElementColor(el, 0.3 + newIntensity * 0.7);
                    this.symbolRenderer.updateColor(info.symbolTextId, color);

                    // Pop forward based on intensity
                    const z = 0.1 + newIntensity * glowStrength;
                    this.symbolRenderer.updatePosition(info.symbolTextId, {
                        x: info.position.x + (this.config.cellWidth - el.symbol.length * this._charWidth * 1.8) / 2,
                        y: info.position.y - this.config.cellHeight * 0.35,
                        z,
                    });
                }

                // Update count text
                if (info && this.currentResults && this.countRenderer) {
                    const result = this.currentResults.get(name);
                    if (result && result.count > 0) {
                        const countText = String(result.count).padStart(4, ' ');
                        const countColor = getElementColor(el, newIntensity * 0.6);

                        // We can't easily update text content with the current renderer,
                        // so we update color/position to make it visible
                        this.countRenderer.updateColor(info.countTextId, countColor);
                    }
                }
            }

            idx++;
        }

        return anyChanged;
    }

    // ─── Public API ─────────────────────────────────────────────────

    getBounds() {
        return this._bounds;
    }

    getGroup() {
        return this.group;
    }

    setScale(s) {
        this.group.scale.setScalar(s);
    }

    setPosition(pos) {
        this.group.position.set(pos.x || 0, pos.y || 0, pos.z || 0);
    }

    getElementAtRay(ray) {
        // Simple ray-plane intersection for click detection
        const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
        const intersection = new THREE.Vector3();
        if (!ray.intersectPlane(plane, intersection)) return null;

        const { cellWidth, cellHeight, cellPadding } = this.config;

        // Check each element's bounds
        for (const [name, info] of this.elementInfo) {
            const pos = info.position;
            if (intersection.x >= pos.x && intersection.x <= pos.x + cellWidth &&
                intersection.y <= pos.y && intersection.y >= pos.y - cellHeight) {
                return info.element;
            }
        }

        return null;
    }

    dispose() {
        if (this.symbolRenderer) this.symbolRenderer.dispose();
        if (this.nameRenderer) this.nameRenderer.dispose();
        if (this.countRenderer) this.countRenderer.dispose();

        for (const mesh of this.panels) {
            mesh.geometry.dispose();
            mesh.material.dispose();
            this.group.remove(mesh);
        }

        this.scene.remove(this.group);
        this.panels = [];
        this.panelMaterials = [];
        this.elementInfo.clear();
    }
}

export default CodeSpectrometer;
