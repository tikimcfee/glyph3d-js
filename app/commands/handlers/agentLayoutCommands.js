/**
 * Agent layout commands: layout.agents, layout.focus, layout.correlate,
 * layout.undim, layout.agents.list
 *
 * Arranges agent windows (CodeGrids) in 3D space using named layout styles.
 * Agent windows are identified by name prefix "agent:" on the grid.
 *
 * Uses shared gridVisualState for save/restore so highlight and layout
 * commands do not conflict.
 */

import { box, kvLines, table } from '../formatResponse.js';
import { COLORS } from './colorConstants.js';
import { saveGridState, restoreGridState, restoreAllGridStates } from './gridVisualState.js';

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
    focusZ: 20,       // Z offset for focused window (pull forward)
};

/**
 * Find all grids that are agent windows.
 * Uses the scene registry (type 'agent' or 'window').
 * @param {Object} ctx - command context bag
 * @returns {Array<{grid: Object, label: string, registryId: string}>}
 */
function findAgentGrids(ctx) {
    const registry = ctx.registry;
    if (!registry) return [];

    const entries = [
        ...registry.findByType('agent'),
        ...registry.findByType('window'),
    ];

    return entries.map(entry => ({
        grid: entry.grid,
        label: entry.meta.label || entry.meta.windowId || entry.id,
        registryId: entry.id,
    }));
}

/**
 * Get the world-space width and height of a grid.
 * @param {Object} grid - CodeGrid instance
 * @returns {{w: number, h: number}}
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
 */
function layoutGrid(agents, spacing = AGENT_SPACING) {
    const n = agents.length;
    const cols = Math.ceil(Math.sqrt(n));
    const positions = [];

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

        let x = 0;
        for (let c = 0; c < col; c++) x += colWidths[c] + spacing.gridGapX;

        let y = 0;
        for (let r = 0; r < row; r++) y -= rowHeights[r] + spacing.gridGapY;

        positions.push({ x, y, z: 0 });
    }
    return positions;
}

/**
 * Radial layout: agents arranged in a circle facing inward.
 */
function layoutRadial(agents, spacing = AGENT_SPACING) {
    const n = agents.length;
    const radius = spacing.radialRadius;
    const positions = [];

    for (let i = 0; i < n; i++) {
        const angle = (Math.PI / 2) + (2 * Math.PI * i / n);
        const { w } = gridSize(agents[i].grid);
        const x = Math.cos(angle) * radius - w / 2;
        const y = Math.sin(angle) * radius;
        positions.push({ x, y, z: 0 });
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

        const agents = findAgentGrids(ctx);
        if (agents.length === 0) {
            return {
                text: 'ERR: no agent windows found. Create grids with name "agent:<label>".',
                data: null
            };
        }

        // Restore any saved visual states before rearranging
        restoreAllGridStates(ctx);

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

        // Reset colors to identity (white) and scale to 1
        for (const { grid } of agents) {
            const coll = grid.getCollection?.() || grid.collection || grid.glyphCollection;
            if (coll?.setGroupColor) {
                coll.setGroupColor(0, { ...COLORS.IDENTITY });
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
                    registryId: a.registryId,
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

        // Cancel any in-flight camera animation
        ctx._cancelCameraAnimation?.();

        const targetLabel = args.join(' ').toLowerCase();
        const agents = findAgentGrids(ctx);

        if (agents.length === 0) {
            return { text: 'ERR: no agent windows found', data: null };
        }

        // Find the target agent (exact match first, then substring)
        const target = agents.find(a => a.label.toLowerCase() === targetLabel) ||
                       agents.find(a => a.label.toLowerCase().includes(targetLabel));

        if (!target) {
            const available = agents.map(a => a.label).join(', ');
            return {
                text: `ERR: no agent matching '${targetLabel}'. Available: ${available}`,
                data: null
            };
        }

        // Save state and apply dim/focus for each agent
        for (const { grid, label, index } of agents) {
            saveGridState(ctx, index);
            const coll = grid.getCollection?.() || grid.collection || grid.glyphCollection;

            if (label === target.label) {
                // Highlight: full brightness (identity), pull forward in Z
                if (coll?.setGroupColor) {
                    coll.setGroupColor(0, { ...COLORS.HIGHLIGHT });
                }
                const saved = ctx.gridVisualState.get(index);
                grid.position.z = (saved?.originalZ || 0) + AGENT_SPACING.focusZ;
            } else {
                // Dim: reduced brightness
                if (coll?.setGroupColor) {
                    coll.setGroupColor(0, { ...COLORS.DIMMED });
                }
            }
        }

        // Move camera to focus on target
        if (ctx.cameraController) {
            const focusIdx = ctx.getGrids().indexOf(target.grid);
            if (focusIdx >= 0) ctx.cameraController.focusOnGrid(focusIdx);
        }

        return {
            text: `OK: focused on agent '${target.label}' (${target.registryId})`,
            data: {
                focused: target.label,
                registryId: target.registryId,
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

        // Cancel any in-flight camera animation
        ctx._cancelCameraAnimation?.();

        const [label1, label2] = args.map(a => a.toLowerCase());
        const agents = findAgentGrids(ctx);

        const agent1 = agents.find(a => a.label.toLowerCase() === label1) ||
                        agents.find(a => a.label.toLowerCase().includes(label1));
        const agent2 = agents.find(a => a.label.toLowerCase() === label2) ||
                        agents.find(a => a.label.toLowerCase().includes(label2));

        if (!agent1) return { text: `ERR: no agent matching '${label1}'`, data: null };
        if (!agent2) return { text: `ERR: no agent matching '${label2}'`, data: null };
        if (agent1.label === agent2.label) {
            return { text: 'ERR: cannot correlate an agent with itself', data: null };
        }

        // Save state for all agents
        for (const { index } of agents) {
            saveGridState(ctx, index);
        }

        // Position side by side, centered at origin
        const size1 = gridSize(agent1.grid);
        const size2 = gridSize(agent2.grid);
        const totalWidth = size1.w + AGENT_SPACING.correlateGap + size2.w;
        const startX = -totalWidth / 2;

        agent1.grid.position.set(startX, 0, AGENT_SPACING.focusZ);
        agent2.grid.position.set(
            startX + size1.w + AGENT_SPACING.correlateGap, 0, AGENT_SPACING.focusZ
        );

        // Highlight the correlated pair, dim everything else
        const pairColor = { ...COLORS.HIGHLIGHT };
        for (const { grid, label } of agents) {
            const coll = grid.getCollection?.() || grid.collection || grid.glyphCollection;
            if (label === agent1.label || label === agent2.label) {
                if (coll?.setGroupColor) {
                    coll.setGroupColor(0, pairColor);
                }
            } else {
                if (coll?.setGroupColor) {
                    coll.setGroupColor(0, { ...COLORS.DIMMED });
                }
                grid.position.z = -20;
            }
        }

        // Move camera to view the pair
        const centerX = startX + totalWidth / 2;
        const centerY = -Math.max(size1.h, size2.h) / 2;
        if (ctx.camera) {
            ctx.camera.position.set(centerX, centerY, AGENT_SPACING.focusZ + 100);
            ctx.camera.lookAt(centerX, centerY, 0);

            // Sync CameraController pitch/yaw after lookAt
            if (ctx.cameraController) {
                const euler = ctx.camera.rotation.clone();
                euler.order = 'YXZ';
                ctx.cameraController.pitch = euler.x;
                ctx.cameraController.yaw = euler.y;
            }
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
        const agents = findAgentGrids(ctx);
        if (agents.length === 0) {
            return { text: 'No agent windows found.', data: { agents: [] } };
        }

        const headers = ['#', 'label', 'registryId', 'glyphs', 'position'];
        const rows = agents.map((a, i) => {
            const pos = a.grid.position;
            return [
                String(i),
                a.label,
                a.registryId.length > 20 ? '\u2026' + a.registryId.slice(-19) : a.registryId,
                String(a.grid.getGlyphCount()),
                `${pos.x.toFixed(0)},${pos.y.toFixed(0)},${pos.z.toFixed(0)}`
            ];
        });

        return {
            text: table(headers, rows) + `\n${agents.length} agent windows`,
            data: {
                agents: agents.map(a => ({
                    label: a.label,
                    registryId: a.registryId,
                    glyphs: a.grid.getGlyphCount()
                }))
            }
        };
    }, { description: 'List all agent windows' });

    // --- layout.undim ---
    router.register('layout.undim', (args, ctx) => {
        const count = restoreAllGridStates(ctx);
        return {
            text: `OK: ${count} grid(s) restored to original state`,
            data: { count }
        };
    }, { description: 'Restore all grids to their pre-focus/highlight state' });
}
