/**
 * TryThisCluster — the invitation cluster, positioned beside WelcomeCluster.
 *
 * Each line is a short, runnable command. Visitors read the keyword and
 * type it into the bar themselves — the bar IS the action surface. We
 * deliberately do NOT make these clickable in this iteration: the audience
 * we're courting is "I'm a CLI person who looked anyway," and them seeing
 * 'tour' as a keyword they can type is a more honest first interaction
 * than a button that does it for them.
 *
 * Each invitation has a `cmd` (what gets typed — also rendered as `label`),
 * and a `note` (description shown beside it). Demos like 'tour' and 'ping'
 * are registered as plain commands by HomeShell, so the invitations stay
 * as ordinary command strings — no special-casing here.
 *
 * Public API:
 *   const cluster = new TryThisCluster({ scene, atlas, invitations })
 *   cluster.grid                  → CodeGrid (Object3D)
 *   cluster.dispose()
 */

import CodeGrid from '../../src/collections/CodeGrid.js';

/**
 * Default invitations. Picked to play to current strengths:
 *   - tour    : camera animation, shows motion is real
 *   - status  : single command, shows the bar talks to the system
 *   - help    : prints the full command list — invitation to explore
 *
 * Order is the read order — most-evocative first.
 */
export const DEFAULT_INVITATIONS = [
    { cmd: 'tour',   label: 'tour',   note: 'camera sweep' },
    { cmd: 'help',   label: 'help',   note: 'all commands' },
    { cmd: 'status', label: 'status', note: 'system state' },
];

const ACCENT      = { r: 0.30, g: 0.85, b: 1.00 };  // keyword color — same cyan as browser/os in welcome
const HEADER_COLOR = { r: 1.00, g: 0.80, b: 0.35 };  // amber — calls attention to the header

const KEY_COL = 14;   // where the description column starts

function row(label, note) {
    const padded = '  ' + label.padEnd(KEY_COL - 2, ' ');
    return {
        line: padded + note,
        keyStart: 2,
        keyEnd: 2 + label.length,
    };
}

export default class TryThisCluster {
    /**
     * @param {Object} deps
     * @param {THREE.Scene} deps.scene
     * @param {Object} deps.atlas
     * @param {Array<{ cmd: string, label: string, note: string }>} [deps.invitations]
     */
    constructor({ scene, atlas, invitations = DEFAULT_INVITATIONS }) {
        this.invitations = invitations;

        const headerLines = [
            '→ try this',
            '',
        ];
        const rows = invitations.map(inv => row(inv.label, inv.note));

        const lines = [
            ...headerLines,
            ...rows.map(r => r.line),
        ];

        this.grid = new CodeGrid(scene, atlas, {
            name: 'home-try-this',
            showBackground: false,
            showFilename: false,
            // Dim base — keyword + header accents are additive on top.
            textColor: { r: 0.28, g: 0.28, b: 0.34 },
            gridScale: 1.0,
            worldScale: 0.10,
        });

        this.grid.loadText(lines.join('\n'));
        // Layout + scene attach: caller's job (see layout/ kit).

        // Header line — amber accent on the whole '→ try this' line.
        this.grid.highlightRange(0, 0, 0, headerLines[0].length, HEADER_COLOR);

        // Each invitation's keyword in accent color.
        const headerOffset = headerLines.length;
        for (let i = 0; i < rows.length; i++) {
            const r = rows[i];
            const li = headerOffset + i;
            this.grid.highlightRange(li, r.keyStart, li, r.keyEnd, ACCENT);
        }
    }

    dispose() {
        if (this.grid && typeof this.grid.dispose === 'function') {
            this.grid.dispose();
        }
        if (this.grid?.parent) {
            this.grid.parent.remove(this.grid);
        }
    }
}
