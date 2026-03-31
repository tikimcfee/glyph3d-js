# Phase 0: Orchestration Layer Design

## Pipeline Architecture

```
                         Tour Data (JSON/text)
                                |
                         [1. Parser Layer]          src/services/tour/parsers/
                                |
                    Array<ParsedReference>
                                |
                         [2. Resolver]              src/services/tour/TourResolver.js
                                |
                    Array<ResolvedReference>
                                |
                         [3. Annotator]             src/services/tour/TourAnnotator.js
                                |
                    { highlights, labels }  (written to grids + registry)
                                |
                         [4. Connector]             src/services/tour/TourConnector.js
                                |
                    { lines, arrows }  (THREE.Line objects in scene)
                                |
                         [5. Tour Sequencer]        src/services/tour/TourSequencer.js
                                |
                    Step state machine + camera animation
                                |
                         [6. Command Layer]         app/commands/handlers/tourCommands.js
                                |
                    CommandRouter namespace `tour.*`
```

## Boundary Types

```js
/** @typedef {Object} ParsedReference
 *  @property {string} file        - path or suffix (e.g. "src/GlyphAtlas.js")
 *  @property {number} [line]      - 0-based line number
 *  @property {number} [endLine]   - end line for ranges
 *  @property {number} [col]       - 0-based column
 *  @property {number} [endCol]    - end column
 *  @property {string} [token]     - text pattern to find
 *  @property {string} [label]     - annotation text for this ref
 *  @property {string} [color]     - named color preset
 */

/** @typedef {Object} ResolvedReference
 *  @property {ParsedReference} ref         - original parsed ref
 *  @property {Object|null} grid            - CodeGrid instance or null
 *  @property {string|null} registryId      - registry ID of matched grid
 *  @property {number} confidence           - 0.0-1.0
 *  @property {'exact'|'suffix'|'fuzzy'|'none'} matchType
 */

/** @typedef {Object} TourStep
 *  @property {string} id                   - unique step ID
 *  @property {string} [title]              - step heading
 *  @property {string} [description]        - narration text
 *  @property {ResolvedReference[]} refs    - resolved references for this step
 *  @property {Object[]} annotations        - annotation IDs created for this step
 *  @property {Object[]} connections        - connector IDs created for this step
 *  @property {{x,y,z}} [cameraTarget]      - computed camera position
 *  @property {number} [cameraDuration]      - ms for camera animation (default 800)
 */

/** @typedef {Object} TourData
 *  @property {string} [id]                 - tour identifier
 *  @property {string} [title]              - tour title
 *  @property {TourStepInput[]} steps       - raw step definitions
 */

/** @typedef {Object} TourStepInput
 *  @property {string} [title]
 *  @property {string} [description]
 *  @property {ParsedReference[]} refs
 *  @property {{x,y,z}} [camera]            - explicit camera override
 */
```

## Resolver

Resolution strategy: registry-first, then suffix, then fuzzy. Confidence scoring
determines which match wins when multiple grids match.

```js
// src/services/tour/TourResolver.js

export default class TourResolver {
    /**
     * @param {import('../SceneRegistry.js').default} registry
     */
    constructor(registry) {
        this._registry = registry;
    }

    /**
     * Resolve a single parsed reference to a grid in the workspace.
     * @param {ParsedReference} ref
     * @returns {ResolvedReference}
     */
    resolve(ref) {
        // 1. Exact registry ID match
        const exact = this._registry.get(ref.file);
        if (exact) {
            return {
                ref,
                grid: exact.grid,
                registryId: exact.id,
                confidence: 1.0,
                matchType: 'exact',
            };
        }

        // 2. sourcePath/filename suffix match
        const suffixMatch = this._findBySuffix(ref.file);
        if (suffixMatch) {
            return {
                ref,
                grid: suffixMatch.grid,
                registryId: suffixMatch.id,
                confidence: suffixMatch.confidence,
                matchType: 'suffix',
            };
        }

        // 3. Fuzzy: basename-only match (lowest confidence)
        const fuzzyMatch = this._findByBasename(ref.file);
        if (fuzzyMatch) {
            return {
                ref,
                grid: fuzzyMatch.grid,
                registryId: fuzzyMatch.id,
                confidence: fuzzyMatch.confidence,
                matchType: 'fuzzy',
            };
        }

        // 4. No match
        return { ref, grid: null, registryId: null, confidence: 0, matchType: 'none' };
    }

    /**
     * Resolve all references in a tour step.
     * @param {ParsedReference[]} refs
     * @returns {ResolvedReference[]}
     */
    resolveAll(refs) {
        return refs.map(ref => this.resolve(ref));
    }

    /**
     * Suffix match: find grids whose sourcePath ends with the ref file string.
     * Longer suffix overlap = higher confidence.
     * When multiple grids match the same suffix, pick the longest overlap.
     * @private
     */
    _findBySuffix(file) {
        const entries = this._registry.findByType('grid');
        let best = null;
        let bestOverlap = 0;

        for (const entry of entries) {
            const sp = entry.meta.sourcePath || entry.meta.filename || entry.id;
            if (!sp.endsWith(file)) continue;

            // Confidence: ratio of query length to full path length
            // "GlyphAtlas.js" matching "src/GlyphAtlas.js" => 13/18 = 0.72
            const overlap = file.length / sp.length;
            if (overlap > bestOverlap) {
                bestOverlap = overlap;
                best = entry;
            }
        }

        if (!best) return null;
        // Suffix match confidence: 0.5 base + 0.4 scaled by overlap ratio
        const confidence = 0.5 + 0.4 * bestOverlap;
        return { grid: best.grid, id: best.id, confidence };
    }

    /**
     * Basename-only match: extract filename from ref, compare against grid filenames.
     * @private
     */
    _findByBasename(file) {
        const queryBase = file.split('/').pop();
        if (!queryBase) return null;

        const entries = this._registry.findByType('grid');
        const matches = [];

        for (const entry of entries) {
            const sp = entry.meta.sourcePath || entry.meta.filename || entry.id;
            const entryBase = sp.split('/').pop();
            if (entryBase === queryBase) {
                matches.push(entry);
            }
        }

        if (matches.length === 0) return null;
        if (matches.length === 1) {
            return { grid: matches[0].grid, id: matches[0].id, confidence: 0.4 };
        }

        // Multiple basename matches: ambiguous, return first but low confidence
        return { grid: matches[0].grid, id: matches[0].id, confidence: 0.2 };
    }
}
```

## Tour State Machine

```
          load()
  [idle] ---------> [loaded]
                     |    ^
            enter()  |    | goto(n)
                     v    |
                   [active]
                   |  ^  |
        next()     |  |  |  prev()
        -------->  |  |  |  <--------
                   v  |  v
               [active] (new stepIndex)
                     |
          clear()    |
                     v
                   [idle]
```

States: `idle`, `loaded` (tour data resolved, nothing displayed), `active` (a step is shown).

```js
// src/services/tour/TourSequencer.js

import TourResolver from './TourResolver.js';
import TourAnnotator from './TourAnnotator.js';
import TourConnector from './TourConnector.js';
import { animateCamera, getWorldBounds, frameBounds } from
    '../../../app/commands/handlers/spatialHelpers.js';

const TAG_PREFIX = 'tour';

export default class TourSequencer {
    /**
     * @param {Object} ctx - command context bag
     */
    constructor(ctx) {
        this._ctx = ctx;
        this._resolver = new TourResolver(ctx.registry);
        this._annotator = new TourAnnotator(ctx);
        this._connector = new TourConnector(ctx);

        /** @type {'idle'|'loaded'|'active'} */
        this.state = 'idle';

        /** @type {TourData|null} */
        this.tourData = null;

        /** @type {TourStep[]} */
        this.steps = [];

        /** @type {number} */
        this.stepIndex = -1;
    }

    /** @returns {TourStep|null} */
    get currentStep() {
        return this.stepIndex >= 0 ? this.steps[this.stepIndex] : null;
    }

    /**
     * Load tour data: resolve all references, build steps.
     * Idempotent: re-loading the same tour clears previous state first.
     * @param {TourData} data
     * @returns {{ stepCount: number, unresolved: string[] }}
     */
    load(data) {
        if (this.state !== 'idle') {
            this.clear();
        }

        this.tourData = data;
        const unresolved = [];

        this.steps = data.steps.map((input, i) => {
            const resolved = this._resolver.resolveAll(input.refs || []);

            for (const r of resolved) {
                if (r.matchType === 'none') {
                    unresolved.push(r.ref.file);
                }
            }

            return {
                id: `${TAG_PREFIX}-step-${i}`,
                title: input.title || `Step ${i + 1}`,
                description: input.description || '',
                refs: resolved,
                annotations: [],
                connections: [],
                cameraTarget: input.camera || null,
                cameraDuration: input.cameraDuration || 800,
            };
        });

        this.state = 'loaded';
        return { stepCount: this.steps.length, unresolved };
    }

    /**
     * Enter the tour at a specific step.
     * @param {number} index - 0-based step index
     * @returns {TourStep}
     */
    async goto(index) {
        if (this.state === 'idle') throw new Error('No tour loaded');
        if (index < 0 || index >= this.steps.length) {
            throw new Error(`Step ${index} out of range (0-${this.steps.length - 1})`);
        }

        // Tear down current step visuals
        if (this.state === 'active') {
            this._teardownStep(this.stepIndex);
        }

        this.stepIndex = index;
        this.state = 'active';

        const step = this.steps[index];

        // Apply annotations and connections
        step.annotations = this._annotator.apply(step);
        step.connections = this._connector.apply(step);

        // Animate camera
        await this._animateToStep(step);

        return step;
    }

    /** @returns {TourStep} */
    async next() {
        const target = this.state === 'loaded' ? 0 : this.stepIndex + 1;
        return this.goto(Math.min(target, this.steps.length - 1));
    }

    /** @returns {TourStep} */
    async prev() {
        return this.goto(Math.max((this.stepIndex || 0) - 1, 0));
    }

    /**
     * Clear all tour state and visuals. Returns to idle.
     */
    clear() {
        // Tear down current step
        if (this.state === 'active') {
            this._teardownStep(this.stepIndex);
        }

        // Remove all tour-tagged registry entries
        const removed = this._ctx.registry.unregisterByType('tour-annotation');
        for (const entry of removed) {
            entry.grid.dispose();
            this._ctx.scene.remove(entry.grid);
        }

        // Clear connector lines
        this._connector.clearAll();

        this.tourData = null;
        this.steps = [];
        this.stepIndex = -1;
        this.state = 'idle';
    }

    // ── Private ──────────────────────────────────────────────

    /**
     * Remove visuals for a step (highlights, labels, connectors).
     * @param {number} index
     * @private
     */
    _teardownStep(index) {
        const step = this.steps[index];
        if (!step) return;

        this._annotator.remove(step.annotations);
        this._connector.remove(step.connections);
        step.annotations = [];
        step.connections = [];
    }

    /**
     * Compute and animate camera to frame all resolved refs in a step.
     * @param {TourStep} step
     * @private
     */
    async _animateToStep(step) {
        // Explicit camera target overrides auto-framing
        if (step.cameraTarget) {
            const { x, y, z } = step.cameraTarget;
            await animateCamera(this._ctx, x, y, z, step.cameraDuration);
            return;
        }

        // Auto-frame: union bounds of all resolved grids
        const grids = step.refs
            .filter(r => r.grid)
            .map(r => r.grid);

        if (grids.length === 0) return;

        const THREE = await import('three');
        const unionBox = new THREE.Box3();
        for (const grid of grids) {
            const bounds = getWorldBounds(grid);
            if (bounds) {
                unionBox.expandByPoint(new THREE.Vector3(bounds.min.x, bounds.min.y, bounds.min.z));
                unionBox.expandByPoint(new THREE.Vector3(bounds.max.x, bounds.max.y, bounds.max.z));
            }
        }

        if (!unionBox.isEmpty()) {
            const size = new THREE.Vector3();
            const center = new THREE.Vector3();
            unionBox.getSize(size);
            unionBox.getCenter(center);
            const aabb = {
                min: { x: unionBox.min.x, y: unionBox.min.y, z: unionBox.min.z },
                max: { x: unionBox.max.x, y: unionBox.max.y, z: unionBox.max.z },
                size: { x: size.x, y: size.y, z: size.z },
                center: { x: center.x, y: center.y, z: center.z },
            };
            frameBounds(this._ctx, aabb, 5);
        }
    }
}
```

## Command Integration

Namespace: `tour.*`. Registered in `app/commands/handlers/tourCommands.js`,
added to `handlers/index.js`.

```js
// app/commands/handlers/tourCommands.js

import TourSequencer from '../../../src/services/tour/TourSequencer.js';
import { decodeBase64 } from '../../../src/utils/encoding.js';

/** Lazily initialize sequencer on the context bag */
function getSequencer(ctx) {
    if (!ctx._tourSequencer) {
        ctx._tourSequencer = new TourSequencer(ctx);
    }
    return ctx._tourSequencer;
}

export default function registerTourCommands(router) {

    // tour.load <base64-json>
    router.register('tour.load', (args, ctx) => {
        if (args.length < 1) {
            return { text: 'ERR: usage: tour.load <base64-json>', data: null };
        }
        let data;
        try { data = JSON.parse(decodeBase64(args[0])); } catch {
            return { text: 'ERR: invalid base64 JSON', data: null };
        }

        const seq = getSequencer(ctx);
        const result = seq.load(data);
        const warns = result.unresolved.length > 0
            ? ` (unresolved: ${result.unresolved.join(', ')})`
            : '';

        return {
            text: `OK: loaded tour with ${result.stepCount} steps${warns}`,
            data: result,
        };
    }, {
        description: 'Load a tour from base64-encoded JSON',
        usage: '<base64-json>',
    });

    // tour.next
    router.register('tour.next', async (args, ctx) => {
        const seq = getSequencer(ctx);
        if (seq.state === 'idle') {
            return { text: 'ERR: no tour loaded', data: null };
        }
        const step = await seq.next();
        return {
            text: `OK: step ${seq.stepIndex + 1}/${seq.steps.length}: ${step.title}`,
            data: { index: seq.stepIndex, step },
        };
    }, { description: 'Advance to next tour step' });

    // tour.prev
    router.register('tour.prev', async (args, ctx) => {
        const seq = getSequencer(ctx);
        if (seq.state === 'idle') {
            return { text: 'ERR: no tour loaded', data: null };
        }
        const step = await seq.prev();
        return {
            text: `OK: step ${seq.stepIndex + 1}/${seq.steps.length}: ${step.title}`,
            data: { index: seq.stepIndex, step },
        };
    }, { description: 'Go to previous tour step' });

    // tour.goto <step-index>
    router.register('tour.goto', async (args, ctx) => {
        if (args.length < 1) {
            return { text: 'ERR: usage: tour.goto <step-index>', data: null };
        }
        const index = parseInt(args[0]);
        if (isNaN(index)) {
            return { text: 'ERR: step index must be a number', data: null };
        }

        const seq = getSequencer(ctx);
        if (seq.state === 'idle') {
            return { text: 'ERR: no tour loaded', data: null };
        }
        try {
            const step = await seq.goto(index);
            return {
                text: `OK: step ${index + 1}/${seq.steps.length}: ${step.title}`,
                data: { index, step },
            };
        } catch (e) {
            return { text: `ERR: ${e.message}`, data: null };
        }
    }, { description: 'Jump to a specific tour step', usage: '<step-index>' });

    // tour.clear
    router.register('tour.clear', (args, ctx) => {
        const seq = getSequencer(ctx);
        seq.clear();
        return { text: 'OK: tour cleared', data: null };
    }, { description: 'Clear the active tour and all its annotations' });

    // tour.status
    router.register('tour.status', (args, ctx) => {
        const seq = getSequencer(ctx);
        return {
            text: `OK: state=${seq.state}, step=${seq.stepIndex + 1}/${seq.steps.length}`,
            data: {
                state: seq.state,
                stepIndex: seq.stepIndex,
                stepCount: seq.steps.length,
                tourId: seq.tourData?.id || null,
            },
        };
    }, { description: 'Show current tour state' });
}
```

## Idempotency: Tag-Based Cleanup

Every artifact the tour creates is tagged for deterministic teardown:

| Artifact      | Tag mechanism                          | Cleanup path                          |
|---------------|----------------------------------------|---------------------------------------|
| Highlights    | `grid.clearAllHighlights()` per grid   | `TourAnnotator.remove(ids)`           |
| Labels        | Registry type `'tour-annotation'`      | `registry.unregisterByType(type)`     |
| Connectors    | Map of `stepId -> THREE.Line[]`        | `TourConnector.remove(ids)`           |
| Camera state  | Canceled via `ctx._cancelCameraAnimation` | Automatic on next `goto()`         |

Re-applying the same tour data:
1. `load()` calls `clear()` first if state is not idle.
2. `clear()` removes all `tour-annotation` registry entries, disposes their grids,
   removes connector lines from scene, resets highlights on affected grids.
3. `load()` re-resolves all references (picks up newly loaded grids).
4. Net result: identical visual state regardless of how many times applied.

Step transitions are also idempotent: `goto(n)` always tears down the current step
before applying step `n`.

## Programmatic API

```js
// Usage from GitHubRepoViewer or any code with access to ctx:

import TourSequencer from './src/services/tour/TourSequencer.js';

const seq = new TourSequencer(ctx);

// Load from a log-derived tour
seq.load({
    id: 'error-trace-2024-03-28',
    steps: [
        {
            title: 'Entry point',
            description: 'Request enters at the HTTP handler',
            refs: [
                { file: 'server.js', line: 42, label: 'handleRequest()' },
            ],
        },
        {
            title: 'Database call',
            refs: [
                { file: 'db/query.js', line: 15, endLine: 28, color: 'red' },
                { file: 'server.js', line: 45, label: 'calls db.query()' },
            ],
        },
    ],
});

// Navigate
await seq.next();                // step 0
await seq.next();                // step 1
await seq.goto(0);               // back to step 0
seq.clear();                     // teardown

// Direct resolution without a tour
const resolver = new TourResolver(ctx.registry);
const result = resolver.resolve({ file: 'GlyphAtlas.js', line: 10 });
// result.grid, result.confidence, result.matchType
```

## File Placement

```
src/services/tour/
    TourResolver.js           # ref -> grid resolution with confidence scoring
    TourAnnotator.js          # highlights + labels for a step
    TourConnector.js          # THREE.Line objects between grids
    TourSequencer.js          # state machine, camera, step lifecycle
    parsers/
        index.js              # parser registry
        logParser.js          # log line -> ParsedReference[]
        stackTraceParser.js   # stack trace -> ParsedReference[]
        jsonParser.js         # raw JSON tour format passthrough

app/commands/handlers/
    tourCommands.js           # tour.* command namespace
```

Integration points to modify:
- `app/commands/handlers/index.js` -- add `registerTourCommands` import and call
- `src/services/SceneRegistry.js` -- type `'tour-annotation'` already accepted (string-typed, no enum)
- `app/commands/index.js` -- `ctx._tourSequencer` added lazily, no change needed

## TourAnnotator Sketch

```js
// src/services/tour/TourAnnotator.js

import CodeGrid from '../../collections/CodeGrid.js';

const COLOR_PRESETS = {
    blue:   { r: 0.3, g: 0.8, b: 1.0 },
    green:  { r: 0.2, g: 1.0, b: 0.4 },
    red:    { r: 1.0, g: 0.3, b: 0.3 },
    yellow: { r: 1.0, g: 0.9, b: 0.2 },
    purple: { r: 0.7, g: 0.3, b: 1.0 },
};

export default class TourAnnotator {
    constructor(ctx) {
        this._ctx = ctx;
    }

    /**
     * Apply highlights and labels for a step. Returns annotation IDs.
     * @param {TourStep} step
     * @returns {string[]}
     */
    apply(step) {
        const ids = [];

        for (const resolved of step.refs) {
            if (!resolved.grid) continue;
            const ref = resolved.ref;
            const color = COLOR_PRESETS[ref.color] || COLOR_PRESETS.blue;

            // Highlight the referenced range
            if (ref.line != null) {
                const endLine = ref.endLine ?? ref.line;
                const startCol = ref.col ?? 0;
                const endCol = ref.endCol ??
                    (resolved.grid.getVisibleCharCount?.(endLine) || 80);
                resolved.grid.highlightRange(ref.line, startCol, endLine, endCol, color);
            }

            // Token search highlight
            if (ref.token) {
                this._highlightToken(resolved.grid, ref.token, color);
            }

            // Floating label
            if (ref.label) {
                const id = this._createLabel(resolved, ref.label, step.id);
                ids.push(id);
            }
        }

        return ids;
    }

    /**
     * Remove annotations by ID.
     * @param {string[]} ids
     */
    remove(ids) {
        for (const id of ids) {
            const entry = this._ctx.registry.get(id);
            if (entry) {
                entry.grid.dispose();
                this._ctx.scene.remove(entry.grid);
                this._ctx.registry.unregister(id);
            }
        }
    }

    /** @private */
    _createLabel(resolved, text, stepId) {
        const id = `tour-label-${stepId}-${Date.now().toString(36)}`;
        const grid = new CodeGrid(this._ctx.scene, this._ctx.atlas, {
            name: id,
            showBackground: true,
            showFilename: false,
            textColor: { r: 1.0, g: 0.9, b: 0.6 },
            backgroundColor: 0x1a1a2e,
            backgroundOpacity: 0.85,
            backgroundPadding: 1.0,
            gridScale: 0.8,
        });

        grid.loadText(text);

        // Position label above the referenced grid
        const bounds = resolved.grid.getBounds?.();
        if (bounds) {
            grid.position.set(bounds.min.x, bounds.max.y + 2, bounds.min.z - 1);
        }

        this._ctx.scene.add(grid);
        this._ctx.registry.register(id, grid, { type: 'tour-annotation', stepId });

        return id;
    }

    /** @private */
    _highlightToken(grid, token, color) {
        if (!grid.lines) return;
        for (let lineIdx = 0; lineIdx < grid.lines.length; lineIdx++) {
            const line = grid.lines[lineIdx];
            let pos = 0;
            while ((pos = line.indexOf(token, pos)) !== -1) {
                grid.highlightRange(lineIdx, pos, lineIdx, pos + token.length, color);
                pos += token.length;
            }
        }
    }
}
```

## TourConnector Sketch

```js
// src/services/tour/TourConnector.js

import * as THREE from 'three';
import { getWorldBounds } from '../../../app/commands/handlers/spatialHelpers.js';

export default class TourConnector {
    constructor(ctx) {
        this._ctx = ctx;
        /** @type {Map<string, THREE.Line[]>} stepId -> lines */
        this._lines = new Map();
    }

    /**
     * Draw lines between resolved grids in a step.
     * Adjacent refs with resolved grids get connected.
     * @param {TourStep} step
     * @returns {string[]} connection IDs
     */
    apply(step) {
        const resolvedGrids = step.refs.filter(r => r.grid);
        if (resolvedGrids.length < 2) return [];

        const lines = [];
        const ids = [];

        for (let i = 0; i < resolvedGrids.length - 1; i++) {
            const from = resolvedGrids[i];
            const to = resolvedGrids[i + 1];

            const fromBounds = getWorldBounds(from.grid);
            const toBounds = getWorldBounds(to.grid);
            if (!fromBounds || !toBounds) continue;

            const line = this._createLine(fromBounds.center, toBounds.center);
            this._ctx.scene.add(line);
            lines.push(line);

            const id = `tour-conn-${step.id}-${i}`;
            ids.push(id);
        }

        this._lines.set(step.id, lines);
        return ids;
    }

    /**
     * Remove connection lines for given IDs.
     * @param {string[]} ids
     */
    remove(ids) {
        // Step ID is embedded in the connection ID: tour-conn-{stepId}-{n}
        const stepIds = new Set();
        for (const id of ids) {
            const match = id.match(/^tour-conn-(.+)-\d+$/);
            if (match) stepIds.add(match[1]);
        }

        for (const stepId of stepIds) {
            const lines = this._lines.get(stepId);
            if (!lines) continue;
            for (const line of lines) {
                this._ctx.scene.remove(line);
                line.geometry.dispose();
                line.material.dispose();
            }
            this._lines.delete(stepId);
        }
    }

    /** Remove all connection lines. */
    clearAll() {
        for (const [, lines] of this._lines) {
            for (const line of lines) {
                this._ctx.scene.remove(line);
                line.geometry.dispose();
                line.material.dispose();
            }
        }
        this._lines.clear();
    }

    /** @private */
    _createLine(from, to) {
        const points = [
            new THREE.Vector3(from.x, from.y, from.z),
            new THREE.Vector3(to.x, to.y, to.z),
        ];
        const geometry = new THREE.BufferGeometry().setFromPoints(points);
        const material = new THREE.LineBasicMaterial({
            color: 0x44aaff,
            transparent: true,
            opacity: 0.6,
        });
        return new THREE.Line(geometry, material);
    }
}
```
