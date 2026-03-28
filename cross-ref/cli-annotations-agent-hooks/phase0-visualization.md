# Phase 0: Visualization -- Agent Window Layout in 3D Space

## 1. Architecture Overview

Agent windows are CodeGrids created via `grid.create`. Layout is pure positioning
logic -- no new Three.js code. Everything works through existing WebSocket commands:
`grid.position`, `grid.color`, `grid.scale`, `camera.focus`, `camera.move`,
`camera.lookat`, `grid.visibility`.

Three deliverables:

| File | Side | Purpose |
|------|------|---------|
| `agentLayoutCommands.js` | Browser | New command module registered in CommandRouter |
| `AgentLayoutHelper.mjs` | CLI (Node.js) | Positions windows via CliConnection.send() |
| Cross-ref phase layout | CLI (Node.js) | Phase-aware layout algorithm inside AgentLayoutHelper |

## 2. Browser-Side: agentLayoutCommands.js

This file registers `layout.agents`, `layout.focus`, and `layout.correlate` commands
in the existing CommandRouter system. It goes in:

```
examples/github-viewer/websocket/commands/agentLayoutCommands.js
```

### Full Implementation

```javascript
/**
 * Agent layout commands: layout.agents, layout.focus, layout.correlate
 * Arranges agent windows (CodeGrids) in 3D space using named layout styles.
 *
 * Agent windows are identified by name prefix "agent:" on the grid.
 * E.g., grid.create <text> agent:protocol
 */

import { box, kvLines, table } from '../TUIFormatter.js';

/**
 * Default spacing constants for agent layout.
 * Tuned for typical agent window sizes (40-80 cols, 20-60 lines).
 */
const AGENT_SPACING = {
    horizontal: 15,   // gap between windows in row layout
    vertical: 12,     // gap between windows in column layout
    gridGapX: 15,     // gap between columns in grid layout
    gridGapY: 12,     // gap between rows in grid layout
    radialRadius: 80, // radius of radial arrangement
    correlateGap: 8,  // gap between correlated pair
    dimAlpha: 0.3,    // dimmed window opacity (color multiplier)
    focusZ: 20,       // Z offset for focused window (pull forward)
};

/**
 * Find all grids that are agent windows.
 * Convention: grid name or filename starts with "agent:" or has userData.agentLabel.
 * @param {Function} getGrids - ctx.getGrids()
 * @returns {Array<{grid: Object, label: string, index: number}>}
 */
function findAgentGrids(getGrids) {
    const grids = getGrids();
    const agents = [];
    for (let i = 0; i < grids.length; i++) {
        const g = grids[i];
        const name = g.getFilename() || g.name || '';
        const label = g.userData?.agentLabel || null;

        if (label) {
            agents.push({ grid: g, label, index: i });
        } else if (name.startsWith('agent:')) {
            agents.push({ grid: g, label: name.slice(6), index: i });
        }
    }
    return agents;
}

/**
 * Get the world-space width and height of a grid.
 * Uses getBounds() which is already computed from content.
 */
function gridSize(grid) {
    const b = grid.getBounds();
    return {
        w: b.max.x - b.min.x,
        h: b.max.y - b.min.y,
    };
}

// ============ Layout Algorithms ============

/**
 * Row layout: all agent windows side by side on the X axis.
 * Sorted by creation order (array index).
 * Anchored at Y=0, starting at X=0.
 */
function layoutRow(agents, spacing = AGENT_SPACING) {
    let x = 0;
    const positions = [];

    for (const { grid } of agents) {
        const { w } = gridSize(grid);
        positions.push({ x, y: 0, z: 0 });
        x += w + spacing.horizontal;
    }
    return positions;
}

/**
 * Column layout: stacked vertically on the Y axis.
 * First agent at top (Y=0), subsequent agents below.
 */
function layoutColumn(agents, spacing = AGENT_SPACING) {
    let y = 0;
    const positions = [];

    for (const { grid } of agents) {
        const { h } = gridSize(grid);
        positions.push({ x: 0, y, z: 0 });
        y -= h + spacing.vertical;
    }
    return positions;
}

/**
 * Grid layout: 2D grid with auto-computed column count.
 * Targets a roughly square arrangement.
 * Columns = ceil(sqrt(N)).
 */
function layoutGrid(agents, spacing = AGENT_SPACING) {
    const n = agents.length;
    const cols = Math.ceil(Math.sqrt(n));
    const positions = [];

    // Pre-compute column widths and row heights for alignment
    const colWidths = [];
    const rowHeights = [];

    for (let i = 0; i < n; i++) {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const { w, h } = gridSize(agents[i].grid);

        colWidths[col] = Math.max(colWidths[col] || 0, w);
        rowHeights[row] = Math.max(rowHeights[row] || 0, h);
    }

    for (let i = 0; i < n; i++) {
        const col = i % cols;
        const row = Math.floor(i / cols);

        // X = sum of previous column widths + gaps
        let x = 0;
        for (let c = 0; c < col; c++) {
            x += colWidths[c] + spacing.gridGapX;
        }

        // Y = negative sum of previous row heights + gaps (grows downward)
        let y = 0;
        for (let r = 0; r < row; r++) {
            y -= rowHeights[r] + spacing.gridGapY;
        }

        positions.push({ x, y, z: 0 });
    }
    return positions;
}

/**
 * Radial layout: agents arranged in a circle, facing inward.
 * The circle lies in the XY plane, centered at origin.
 * Each agent is rotated to face the center (via position only --
 * CodeGrids face -Z by default, so we use Z offset to create depth).
 *
 * For N agents, angle step = 2*PI / N, starting from top (PI/2).
 */
function layoutRadial(agents, spacing = AGENT_SPACING) {
    const n = agents.length;
    const radius = spacing.radialRadius;
    const positions = [];

    for (let i = 0; i < n; i++) {
        const angle = (Math.PI / 2) + (2 * Math.PI * i / n);
        const { w } = gridSize(agents[i].grid);

        // Position on circle, offset by half-width so the grid center
        // sits on the circle, not the grid origin (top-left).
        const x = Math.cos(angle) * radius - w / 2;
        const y = Math.sin(angle) * radius;
        const z = 0;

        positions.push({ x, y, z });
    }
    return positions;
}

// ============ Command Registration ============

/**
 * @param {import('../CommandRouter.js').default} router
 */
export default function registerAgentLayoutCommands(router) {

    // --- layout.agents <style> ---
    router.register('layout.agents', (args, ctx) => {
        const style = (args[0] || 'row').toLowerCase();
        const validStyles = ['row', 'column', 'grid', 'radial'];

        if (!validStyles.includes(style)) {
            return {
                text: `ERR: unknown style '${style}'. Valid: ${validStyles.join(', ')}`,
                data: null
            };
        }

        const agents = findAgentGrids(ctx.getGrids);
        if (agents.length === 0) {
            return {
                text: 'ERR: no agent windows found. Create grids with name "agent:<label>".',
                data: null
            };
        }

        // Compute positions
        let positions;
        switch (style) {
            case 'row':    positions = layoutRow(agents); break;
            case 'column': positions = layoutColumn(agents); break;
            case 'grid':   positions = layoutGrid(agents); break;
            case 'radial': positions = layoutRadial(agents); break;
        }

        // Apply positions
        for (let i = 0; i < agents.length; i++) {
            const { grid } = agents[i];
            const p = positions[i];
            grid.position.set(p.x, p.y, p.z);
        }

        // Reset colors and scale (undo any prior focus/dim)
        for (const { grid } of agents) {
            const coll = grid.getCollection();
            if (coll && coll.setGroupColor) {
                coll.setGroupColor(0, { r: 0, g: 1, b: 0 });
            }
            grid.scale.setScalar(1);
        }

        const labels = agents.map(a => a.label).join(', ');
        return {
            text: `OK: ${agents.length} agents arranged in '${style}' layout [${labels}]`,
            data: {
                style,
                count: agents.length,
                agents: agents.map((a, i) => ({
                    label: a.label,
                    index: a.index,
                    position: positions[i]
                }))
            }
        };
    }, {
        description: 'Arrange agent windows using a named style',
        usage: '<row|column|grid|radial>'
    });

    // --- layout.focus <agent-label> ---
    router.register('layout.focus', (args, ctx) => {
        if (args.length < 1) {
            return { text: 'ERR: usage: layout.focus <agent-label>', data: null };
        }

        const targetLabel = args.join(' ').toLowerCase();
        const agents = findAgentGrids(ctx.getGrids);

        if (agents.length === 0) {
            return { text: 'ERR: no agent windows found', data: null };
        }

        // Find the target agent
        const target = agents.find(a =>
            a.label.toLowerCase() === targetLabel ||
            a.label.toLowerCase().includes(targetLabel)
        );

        if (!target) {
            const available = agents.map(a => a.label).join(', ');
            return {
                text: `ERR: no agent matching '${targetLabel}'. Available: ${available}`,
                data: null
            };
        }

        // Dim all non-target agents, highlight the target
        for (const { grid, label } of agents) {
            const coll = grid.getCollection();
            if (label === target.label) {
                // Highlight: full brightness, pull forward in Z
                if (coll && coll.setGroupColor) {
                    coll.setGroupColor(0, { r: 0, g: 1, b: 0 });
                }
                grid.position.z = AGENT_SPACING.focusZ;
            } else {
                // Dim: reduced brightness, push back
                if (coll && coll.setGroupColor) {
                    coll.setGroupColor(0, {
                        r: 0,
                        g: AGENT_SPACING.dimAlpha,
                        b: 0
                    });
                }
                grid.position.z = 0;
            }
        }

        // Move camera to focus on target
        if (ctx.cameraController) {
            ctx.cameraController.focusOnGrid(target.index);
        }

        return {
            text: `OK: focused on agent '${target.label}' (grid #${target.index})`,
            data: {
                focused: target.label,
                index: target.index,
                dimmed: agents
                    .filter(a => a.label !== target.label)
                    .map(a => a.label)
            }
        };
    }, {
        description: 'Focus camera on agent window, dim others',
        usage: '<agent-label>'
    });

    // --- layout.correlate <agent1> <agent2> ---
    router.register('layout.correlate', (args, ctx) => {
        if (args.length < 2) {
            return { text: 'ERR: usage: layout.correlate <agent1> <agent2>', data: null };
        }

        const [label1, label2] = args.map(a => a.toLowerCase());
        const agents = findAgentGrids(ctx.getGrids);

        const agent1 = agents.find(a => a.label.toLowerCase() === label1 ||
                                        a.label.toLowerCase().includes(label1));
        const agent2 = agents.find(a => a.label.toLowerCase() === label2 ||
                                        a.label.toLowerCase().includes(label2));

        if (!agent1) return { text: `ERR: no agent matching '${label1}'`, data: null };
        if (!agent2) return { text: `ERR: no agent matching '${label2}'`, data: null };
        if (agent1.label === agent2.label) {
            return { text: 'ERR: cannot correlate an agent with itself', data: null };
        }

        // Position side by side, centered at origin
        const size1 = gridSize(agent1.grid);
        const size2 = gridSize(agent2.grid);
        const totalWidth = size1.w + AGENT_SPACING.correlateGap + size2.w;
        const startX = -totalWidth / 2;

        agent1.grid.position.set(startX, 0, AGENT_SPACING.focusZ);
        agent2.grid.position.set(startX + size1.w + AGENT_SPACING.correlateGap, 0, AGENT_SPACING.focusZ);

        // Highlight the correlated pair, dim everything else
        const pairColor = { r: 0.2, g: 1.0, b: 0.6 };
        for (const { grid, label } of agents) {
            const coll = grid.getCollection();
            if (label === agent1.label || label === agent2.label) {
                if (coll && coll.setGroupColor) {
                    coll.setGroupColor(0, pairColor);
                }
            } else {
                if (coll && coll.setGroupColor) {
                    coll.setGroupColor(0, {
                        r: 0,
                        g: AGENT_SPACING.dimAlpha,
                        b: 0
                    });
                }
                grid.position.z = -20;
            }
        }

        // Move camera to view the pair
        const centerX = startX + totalWidth / 2;
        const centerY = -Math.max(size1.h, size2.h) / 2;
        if (ctx.cameraController) {
            const cam = ctx.camera;
            cam.position.set(centerX, centerY, AGENT_SPACING.focusZ + 100);
            cam.lookAt(centerX, centerY, 0);
        }

        return {
            text: `OK: correlating '${agent1.label}' <-> '${agent2.label}'`,
            data: {
                pair: [agent1.label, agent2.label],
                positions: [
                    { x: agent1.grid.position.x, y: 0, z: AGENT_SPACING.focusZ },
                    { x: agent2.grid.position.x, y: 0, z: AGENT_SPACING.focusZ }
                ]
            }
        };
    }, {
        description: 'Position two agent windows side by side and highlight',
        usage: '<agent1-label> <agent2-label>'
    });

    // --- layout.agents.list ---
    router.register('layout.agents.list', (args, ctx) => {
        const agents = findAgentGrids(ctx.getGrids);
        if (agents.length === 0) {
            return { text: 'No agent windows found.', data: { agents: [] } };
        }

        const headers = ['#', 'label', 'grid#', 'glyphs', 'position'];
        const rows = agents.map(a => {
            const pos = a.grid.position;
            return [
                String(agents.indexOf(a)),
                a.label,
                String(a.index),
                String(a.grid.getGlyphCount()),
                `${pos.x.toFixed(0)},${pos.y.toFixed(0)},${pos.z.toFixed(0)}`
            ];
        });

        return {
            text: table(headers, rows) + `\n${agents.length} agent windows`,
            data: {
                agents: agents.map(a => ({
                    label: a.label,
                    gridIndex: a.index,
                    glyphs: a.grid.getGlyphCount()
                }))
            }
        };
    }, { description: 'List all agent windows' });

    // --- layout.undim ---
    router.register('layout.undim', (args, ctx) => {
        const agents = findAgentGrids(ctx.getGrids);
        for (const { grid } of agents) {
            const coll = grid.getCollection();
            if (coll && coll.setGroupColor) {
                coll.setGroupColor(0, { r: 0, g: 1, b: 0 });
            }
            grid.position.z = 0;
        }
        return {
            text: `OK: ${agents.length} agent windows restored to full brightness`,
            data: { count: agents.length }
        };
    }, { description: 'Reset all agent windows to full brightness' });
}
```

### Registration

Add to `examples/github-viewer/websocket/commands/index.js`:

```javascript
import registerAgentLayoutCommands from './agentLayoutCommands.js';

export function registerAllCommands(router) {
    // ... existing registrations ...
    registerAgentLayoutCommands(router);
}
```

## 3. CLI-Side: AgentLayoutHelper.mjs

This module runs in Node.js alongside the cross-ref orchestrator. It wraps
CliConnection to provide a high-level API for creating and positioning agent
windows. The cross-ref skill (or any CLI agent) calls these methods.

File location:

```
examples/github-viewer/cli/AgentLayoutHelper.mjs
```

### Full Implementation

```javascript
/**
 * AgentLayoutHelper -- CLI-side layout coordinator for agent windows.
 *
 * Wraps CliConnection to provide a high-level API:
 *   - createAgentWindow(label, content)  -- grid.create + tag as agent
 *   - updateAgentContent(label, content) -- grid.text on existing window
 *   - arrangeAgents(style)              -- layout.agents <style>
 *   - focusAgent(label)                 -- layout.focus <label>
 *   - correlateAgents(a, b)             -- layout.correlate <a> <b>
 *   - setPhaseLayout(phase, agentLabels) -- cross-ref phase positioning
 *
 * All methods are async and return the command response.
 * Requires a connected CliConnection instance.
 */

import CliConnection from './CliConnection.mjs';

export default class AgentLayoutHelper {
    /**
     * @param {CliConnection} conn - Connected WebSocket client
     */
    constructor(conn) {
        /** @type {CliConnection} */
        this.conn = conn;

        /**
         * Maps agent labels to grid indices in the viewer.
         * Updated on create, used for position/content updates.
         * @type {Map<string, number>}
         */
        this.agentGridMap = new Map();
    }

    // ============ Factory ============

    /**
     * Create a helper with its own connection.
     * @param {string} [url='ws://localhost:8765']
     * @returns {Promise<AgentLayoutHelper>}
     */
    static async connect(url = 'ws://localhost:8765') {
        const conn = new CliConnection(url);
        await conn.connect();
        const helper = new AgentLayoutHelper(conn);
        return helper;
    }

    // ============ Window Management ============

    /**
     * Create an agent window in the 3D viewer.
     * @param {string} label - Agent label (e.g., 'protocol', 'usability')
     * @param {string} content - Text content to display
     * @returns {Promise<{index: number, label: string}>}
     */
    async createAgentWindow(label, content) {
        const b64 = Buffer.from(content).toString('base64');
        const name = `agent:${label}`;

        const result = await this.conn.send(`grid.create ${b64} ${name}`);

        // Extract grid index from response data
        const index = result.data?.index ?? this._parseIndex(result.text);
        if (index !== null && index !== undefined) {
            this.agentGridMap.set(label, index);
        }

        return { index, label };
    }

    /**
     * Update content of an existing agent window.
     * @param {string} label - Agent label
     * @param {string} content - New text content
     * @returns {Promise<Object>}
     */
    async updateAgentContent(label, content) {
        const index = this.agentGridMap.get(label);
        if (index === undefined) {
            throw new Error(`No agent window for label '${label}'`);
        }

        const b64 = Buffer.from(content).toString('base64');
        return this.conn.send(`grid.text ${index} ${b64}`);
    }

    /**
     * Remove an agent window.
     * @param {string} label - Agent label
     * @returns {Promise<Object>}
     */
    async removeAgentWindow(label) {
        const index = this.agentGridMap.get(label);
        if (index === undefined) {
            throw new Error(`No agent window for label '${label}'`);
        }

        const result = await this.conn.send(`grid.remove ${index}`);
        this.agentGridMap.delete(label);

        // After removal, indices shift. Rebuild the map.
        await this._rebuildGridMap();

        return result;
    }

    // ============ Layout Commands ============

    /**
     * Arrange all agent windows using a named style.
     * @param {'row'|'column'|'grid'|'radial'} style
     * @returns {Promise<Object>}
     */
    async arrangeAgents(style = 'row') {
        return this.conn.send(`layout.agents ${style}`);
    }

    /**
     * Focus camera on a specific agent window.
     * @param {string} label - Agent label
     * @returns {Promise<Object>}
     */
    async focusAgent(label) {
        return this.conn.send(`layout.focus ${label}`);
    }

    /**
     * Correlate two agent windows side by side.
     * @param {string} label1
     * @param {string} label2
     * @returns {Promise<Object>}
     */
    async correlateAgents(label1, label2) {
        return this.conn.send(`layout.correlate ${label1} ${label2}`);
    }

    /**
     * Reset all agent windows to full brightness.
     * @returns {Promise<Object>}
     */
    async undimAll() {
        return this.conn.send('layout.undim');
    }

    /**
     * Set position of a specific agent window.
     * @param {string} label - Agent label
     * @param {number} x
     * @param {number} y
     * @param {number} z
     * @returns {Promise<Object>}
     */
    async positionAgent(label, x, y, z) {
        const index = this.agentGridMap.get(label);
        if (index === undefined) {
            throw new Error(`No agent window for label '${label}'`);
        }
        return this.conn.send(`grid.position ${index} ${x} ${y} ${z}`);
    }

    /**
     * Set color of a specific agent window.
     * @param {string} label - Agent label
     * @param {number} r - Red (0-1)
     * @param {number} g - Green (0-1)
     * @param {number} b - Blue (0-1)
     * @returns {Promise<Object>}
     */
    async colorAgent(label, r, g, b) {
        const index = this.agentGridMap.get(label);
        if (index === undefined) {
            throw new Error(`No agent window for label '${label}'`);
        }
        return this.conn.send(`grid.color ${index} ${r} ${g} ${b}`);
    }

    /**
     * Set scale of a specific agent window.
     * @param {string} label - Agent label
     * @param {number} scale
     * @returns {Promise<Object>}
     */
    async scaleAgent(label, scale) {
        const index = this.agentGridMap.get(label);
        if (index === undefined) {
            throw new Error(`No agent window for label '${label}'`);
        }
        return this.conn.send(`grid.scale ${index} ${scale}`);
    }

    // ============ Phase-Based Layout (Cross-Ref) ============

    /**
     * Apply a cross-ref phase layout to the current agent windows.
     *
     * Phase 0: Row layout -- agents side by side, all equal prominence.
     * Phase 1: Reviewer pairs -- each reviewer next to its first review target.
     * Phase 2: Inverse pairs -- same as phase 1 but reversed pairings.
     * Phase 3: Cluster -- all agents converge to a tight radial arrangement.
     *
     * @param {number} phase - Phase number (0-3)
     * @param {string[]} agentLabels - Ordered list of agent labels
     * @param {Object} [options]
     * @param {number} [options.windowWidth=120] - Estimated window width in world units
     * @param {number} [options.windowHeight=80] - Estimated window height in world units
     * @param {number} [options.gap=15] - Gap between windows
     * @returns {Promise<Object>}
     */
    async setPhaseLayout(phase, agentLabels, options = {}) {
        const W = options.windowWidth || 120;
        const H = options.windowHeight || 80;
        const gap = options.gap || 15;

        switch (phase) {
            case 0:
                return this._layoutPhase0(agentLabels, W, gap);
            case 1:
                return this._layoutPhase1(agentLabels, W, H, gap);
            case 2:
                return this._layoutPhase2(agentLabels, W, H, gap);
            case 3:
                return this._layoutPhase3(agentLabels, W, H);
            default:
                throw new Error(`Unknown phase: ${phase}`);
        }
    }

    /**
     * Phase 0: Simple row layout.
     * All agents side by side horizontally, uniform color.
     * Represents the initial independent analysis state.
     *
     *   [protocol] [transport] [usability]
     *
     * @private
     */
    async _layoutPhase0(labels, W, gap) {
        const results = [];

        // Position each agent in a row
        for (let i = 0; i < labels.length; i++) {
            const x = i * (W + gap);
            const result = await this.positionAgent(labels[i], x, 0, 0);
            results.push(result);
        }

        // Uniform bright color for all
        for (const label of labels) {
            await this.colorAgent(label, 0, 1, 0);
        }

        // Fit camera to show all
        await this.conn.send('camera.fitall');

        return {
            text: `OK: phase 0 layout -- ${labels.length} agents in row`,
            data: { phase: 0, layout: 'row', agents: labels }
        };
    }

    /**
     * Phase 1: Forward cross-reference pairs.
     * Each agent is positioned next to its first review target.
     * Agent i reviews agents [0..N-1] excluding itself, in declaration order.
     * So agent i's first target is agent 0 (if i != 0) or agent 1 (if i == 0).
     *
     * Layout: pairs stacked vertically.
     *
     *   [protocol]  [transport]     <- protocol reviews transport first
     *   [transport]  [protocol]     <- transport reviews protocol first
     *   [usability]  [protocol]     <- usability reviews protocol first
     *
     * The reviewer is highlighted, the target is slightly dimmed.
     *
     * @private
     */
    async _layoutPhase1(labels, W, H, gap) {
        const results = [];
        const pairs = this._computeForwardPairs(labels);

        for (let i = 0; i < pairs.length; i++) {
            const { reviewer, target } = pairs[i];
            const y = -(i * (H + gap));

            // Reviewer on the left
            await this.positionAgent(reviewer, 0, y, 0);
            await this.colorAgent(reviewer, 0.2, 1.0, 0.4);

            // Target on the right
            await this.positionAgent(target, W + gap, y, 0);
            await this.colorAgent(target, 0.0, 0.6, 0.2);
        }

        await this.conn.send('camera.fitall');

        return {
            text: `OK: phase 1 layout -- ${pairs.length} reviewer pairs`,
            data: { phase: 1, layout: 'pairs', pairs }
        };
    }

    /**
     * Phase 2: Inverse cross-reference pairs.
     * Same as phase 1 but each agent's first target is now from
     * the REVERSED list (agent i's first target is the last agent
     * that isn't itself).
     *
     * @private
     */
    async _layoutPhase2(labels, W, H, gap) {
        const results = [];
        const pairs = this._computeInversePairs(labels);

        for (let i = 0; i < pairs.length; i++) {
            const { reviewer, target } = pairs[i];
            const y = -(i * (H + gap));

            // Reviewer on the right (reversed from phase 1)
            await this.positionAgent(reviewer, W + gap, y, 0);
            await this.colorAgent(reviewer, 0.4, 0.8, 1.0);

            // Target on the left
            await this.positionAgent(target, 0, y, 0);
            await this.colorAgent(target, 0.1, 0.4, 0.6);
        }

        await this.conn.send('camera.fitall');

        return {
            text: `OK: phase 2 layout -- ${pairs.length} inverse pairs`,
            data: { phase: 2, layout: 'inverse-pairs', pairs }
        };
    }

    /**
     * Phase 3: Convergence cluster.
     * All agents arranged in a tight radial layout, equal prominence.
     * Represents the converged state where all perspectives merge.
     * Smaller radius than normal radial -- agents are close together.
     *
     * @private
     */
    async _layoutPhase3(labels, W, H) {
        const n = labels.length;
        const radius = Math.max(W, H) * 0.8;

        for (let i = 0; i < n; i++) {
            const angle = (Math.PI / 2) + (2 * Math.PI * i / n);
            const x = Math.cos(angle) * radius;
            const y = Math.sin(angle) * radius;

            await this.positionAgent(labels[i], x, y, 0);
            // Gold/amber color for convergence
            await this.colorAgent(labels[i], 1.0, 0.85, 0.3);
        }

        await this.conn.send('camera.fitall');

        return {
            text: `OK: phase 3 layout -- ${n} agents in convergence cluster`,
            data: { phase: 3, layout: 'radial-cluster', agents: labels }
        };
    }

    // ============ Pairing Logic ============

    /**
     * Compute forward review pairs (Phase 1).
     * Agent i reviews all others in declaration order.
     * Returns (reviewer, firstTarget) pairs for visualization.
     * @private
     */
    _computeForwardPairs(labels) {
        const pairs = [];
        for (let i = 0; i < labels.length; i++) {
            // First target in declaration order, excluding self
            const others = labels.filter((_, j) => j !== i);
            if (others.length > 0) {
                pairs.push({ reviewer: labels[i], target: others[0] });
            }
        }
        return pairs;
    }

    /**
     * Compute inverse review pairs (Phase 2).
     * Agent i reviews all others in reverse declaration order.
     * Returns (reviewer, firstTarget) pairs for visualization.
     * @private
     */
    _computeInversePairs(labels) {
        const pairs = [];
        for (let i = 0; i < labels.length; i++) {
            // Reversed order, excluding self
            const others = labels.filter((_, j) => j !== i).reverse();
            if (others.length > 0) {
                pairs.push({ reviewer: labels[i], target: others[0] });
            }
        }
        return pairs;
    }

    // ============ Utilities ============

    /**
     * Parse grid index from response text like "OK: created grid #5 ..."
     * @private
     */
    _parseIndex(text) {
        const match = text.match(/grid #(\d+)/);
        return match ? parseInt(match[1]) : null;
    }

    /**
     * Rebuild agentGridMap by querying grid.list and matching agent: names.
     * Called after removals which shift indices.
     * @private
     */
    async _rebuildGridMap() {
        const result = await this.conn.send('grid.list');
        this.agentGridMap.clear();

        if (result.data?.grids) {
            for (const g of result.data.grids) {
                const name = g.filename || g.name || '';
                if (name.startsWith('agent:')) {
                    this.agentGridMap.set(name.slice(6), g.index);
                }
            }
        }
    }

    /**
     * Disconnect from the viewer.
     */
    close() {
        this.conn.close();
    }
}
```

## 4. Integration with AgentWindowManager

The AgentWindowManager (to be built by the agent-hooks perspective) should use
AgentLayoutHelper as its layout backend. The integration point is clean:

```javascript
// In AgentWindowManager (agent-hooks side)

import AgentLayoutHelper from './AgentLayoutHelper.mjs';

class AgentWindowManager {
    constructor(conn) {
        this.layout = new AgentLayoutHelper(conn);
        this.agents = new Map(); // label -> { status, phase, ... }
    }

    /**
     * Called by agent hooks when a new agent spawns.
     * Creates a window and auto-positions it.
     */
    async onAgentSpawn(label, initialContent) {
        // Create the window
        await this.layout.createAgentWindow(label, initialContent);
        this.agents.set(label, { status: 'running', phase: 0 });

        // Re-layout all existing windows
        await this.layout.arrangeAgents('row');
    }

    /**
     * Called when agent produces output.
     */
    async onAgentOutput(label, content) {
        await this.layout.updateAgentContent(label, content);
    }

    /**
     * Called by cross-ref orchestrator when phase changes.
     */
    async onPhaseChange(phase, agentLabels) {
        await this.layout.setPhaseLayout(phase, agentLabels);
    }

    /**
     * Called when user wants to inspect a specific agent.
     */
    async onAgentSelect(label) {
        await this.layout.focusAgent(label);
    }
}
```

## 5. Cross-Ref Phase Layout Algorithm

The phase layout encodes the semantics of the cross-ref process into spatial arrangement:

### Phase 0 -- Independent Analysis

```
 X axis -->

 [protocol]    [transport]    [usability]
    0,0           135,0          270,0
```

Equal spacing, equal color (green), row arrangement. Each agent works independently.
Camera fits all windows. This is visually neutral -- no relationships implied.

### Phase 1 -- Forward Cross-Reference

```
 Y axis (down) -->

  [protocol]   -> [transport]      protocol reviews transport first
  [transport]  -> [protocol]       transport reviews protocol first
  [usability]  -> [protocol]       usability reviews protocol first
```

Reviewer-target pairs stacked vertically. The reviewer is on the left (bright green),
the target on the right (dim green). Each row shows who is reviewing whom.

Note: each agent reviews ALL others, but we visualize only the first-target pair
because that's the primary visual relationship. The full review order is embedded
in the file naming (`round1-protocol-reviews-transport-usability.md`).

### Phase 2 -- Inverse Cross-Reference

```
  [transport]  <- [protocol]       protocol now reviews usability first (reversed)
  [usability]  <- [transport]      transport now reviews usability first (reversed)
  [transport]  <- [usability]      usability now reviews transport first (reversed)
```

Same pair layout but mirrored (reviewer on right, target on left) and with a blue
color scheme to visually distinguish from Phase 1. The reversal of review order
is reflected in both position and color.

### Phase 3 -- Convergence

```
          [protocol]
         /          \
   [usability]  [transport]
```

Tight radial cluster. All agents equidistant from center, gold/amber color.
Radius is smaller than the normal `layout.agents radial` because convergence
means the perspectives are merging. Camera centered on the cluster.

## 6. Example Sessions

### Session 1: Basic Agent Layout

```
$ node examples/github-viewer/cli/glyph-cli.mjs

> grid.create SGVsbG8gZnJvbSBwcm90b2NvbCBhZ2VudA== agent:protocol
OK: created grid #0 (26 glyphs, 1 lines)

> grid.create SGVsbG8gZnJvbSB0cmFuc3BvcnQgYWdlbnQ= agent:transport
OK: created grid #1 (27 glyphs, 1 lines)

> grid.create SGVsbG8gZnJvbSB1c2FiaWxpdHkgYWdlbnQ= agent:usability
OK: created grid #2 (27 glyphs, 1 lines)

> layout.agents row
OK: 3 agents arranged in 'row' layout [protocol, transport, usability]

> layout.agents grid
OK: 3 agents arranged in 'grid' layout [protocol, transport, usability]

> layout.agents radial
OK: 3 agents arranged in 'radial' layout [protocol, transport, usability]

> layout.focus protocol
OK: focused on agent 'protocol' (grid #0)

> layout.correlate protocol transport
OK: correlating 'protocol' <-> 'transport'

> layout.undim
OK: 3 agent windows restored to full brightness
```

### Session 2: Cross-Ref Phase Progression (programmatic)

```javascript
import AgentLayoutHelper from './AgentLayoutHelper.mjs';

const layout = await AgentLayoutHelper.connect();
const labels = ['protocol', 'transport', 'usability'];

// Phase 0: Create windows with initial analysis content
for (const label of labels) {
    const content = await fs.readFile(`cross-ref/my-topic/phase0-${label}.md`, 'utf8');
    await layout.createAgentWindow(label, content);
}
await layout.setPhaseLayout(0, labels);
// --> All three windows in a row, green, camera fits all

// Phase 1: Forward cross-reference starts
// Update windows with round 1 content as it arrives
for (const label of labels) {
    const content = await fs.readFile(
        `cross-ref/my-topic/round1-${label}-reviews-....md`, 'utf8'
    );
    await layout.updateAgentContent(label, content);
}
await layout.setPhaseLayout(1, labels);
// --> Reviewer-target pairs, green scheme

// Phase 2: Inverse cross-reference
for (const label of labels) {
    const content = await fs.readFile(
        `cross-ref/my-topic/round2-${label}-reviews-....md`, 'utf8'
    );
    await layout.updateAgentContent(label, content);
}
await layout.setPhaseLayout(2, labels);
// --> Inverse pairs, blue scheme

// Phase 3: Convergence
await layout.setPhaseLayout(3, labels);
// --> Tight radial cluster, gold

// Focus on winner for Phase 4
await layout.focusAgent('protocol');

layout.close();
```

### Session 3: Dynamic Agent Spawn

```javascript
// AgentWindowManager integration -- auto-layout on spawn

const manager = new AgentWindowManager(conn);

// Cross-ref orchestrator spawns agents
await manager.onAgentSpawn('protocol', '# Protocol Analysis\n\nAnalyzing wire format...');
// --> 1 window centered

await manager.onAgentSpawn('transport', '# Transport Analysis\n\nEvaluating channels...');
// --> 2 windows in row

await manager.onAgentSpawn('usability', '# Usability Analysis\n\nChecking ergonomics...');
// --> 3 windows in row, camera fits all

// Agent produces output
await manager.onAgentOutput('protocol', '# Protocol Analysis\n\n## Wire Format\n...(full analysis)');
// --> protocol window content updated in-place

// Phase changes
await manager.onPhaseChange(1, ['protocol', 'transport', 'usability']);
// --> Switches to reviewer-pair layout
```

## 7. Files to Create/Modify

### New Files

| Path | Purpose |
|------|---------|
| `examples/github-viewer/websocket/commands/agentLayoutCommands.js` | Browser-side layout commands |
| `examples/github-viewer/cli/AgentLayoutHelper.mjs` | CLI-side layout helper |

### Modified Files

| Path | Change |
|------|--------|
| `examples/github-viewer/websocket/commands/index.js` | Add `import registerAgentLayoutCommands` and call it |

## 8. Design Decisions

**Why commands, not direct Three.js?** The existing architecture routes all
mutations through the CommandRouter. Layout commands compose on top of
`grid.position`, `grid.color`, `grid.scale`, and `camera.*`. This means
layout works identically whether driven from CLI, WebSocket, or browser console.

**Why label-based identification?** Grid indices shift when grids are removed.
Labels are stable identifiers. The convention `agent:<label>` in the grid name
makes agent windows discoverable without a separate registry on the browser side.

**Why estimated window sizes in phase layout?** The CLI side cannot query grid
bounds synchronously (would require a round-trip for each grid). Instead, we use
reasonable defaults (120x80 world units) and let the browser-side `layout.agents`
command use actual bounds when called directly. For the phase layout, approximate
positioning is acceptable because `camera.fitall` corrects the view regardless.

**Why not use GridLayoutManager directly?** GridLayoutManager requires CodeGrid
instances (Three.js objects). The CLI side has no Three.js. The phase layout
works through WebSocket commands only. On the browser side, `layout.agents`
could optionally delegate to GridLayoutManager, but the direct position
computation is simpler for the fixed layout patterns we need.

**Why separate colors per phase?** Color encodes phase semantics visually:
green = independent analysis (phase 0-1), blue = inverse review (phase 2),
gold = convergence (phase 3). A viewer watching the 3D space can instantly
tell which phase the cross-ref process is in without reading any text.
