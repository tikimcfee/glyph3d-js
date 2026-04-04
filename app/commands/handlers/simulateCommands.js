/**
 * Simulate commands: keyboard events and navigation status.
 *
 * simulate.key — dispatch a KeyboardEvent on document
 * nav.status   — report SpatialNavigator state (focus, mode, neighbors)
 */

import { box, kvLines } from '../formatResponse.js';

/**
 * Map common key names to their `code` property.
 * For printable ASCII the code is "Key<Upper>" or "Digit<n>".
 * For everything else we map explicitly.
 * @param {string} key
 * @returns {string}
 */
function keyToCode(key) {
    if (key.length === 1) {
        const c = key.toUpperCase();
        if (c >= 'A' && c <= 'Z') return `Key${c}`;
        if (key >= '0' && key <= '9') return `Digit${key}`;
        // Symbols — code not critical for event dispatch, just return an approximation
        return `Key${c}`;
    }
    const map = {
        'Enter': 'Enter',
        'Escape': 'Escape',
        'Tab': 'Tab',
        'Backspace': 'Backspace',
        'Delete': 'Delete',
        'ArrowLeft': 'ArrowLeft',
        'ArrowRight': 'ArrowRight',
        'ArrowUp': 'ArrowUp',
        'ArrowDown': 'ArrowDown',
        'Home': 'Home',
        'End': 'End',
        'PageUp': 'PageUp',
        'PageDown': 'PageDown',
        'F1': 'F1', 'F2': 'F2', 'F3': 'F3', 'F4': 'F4',
        'F5': 'F5', 'F6': 'F6', 'F7': 'F7', 'F8': 'F8',
        'F9': 'F9', 'F10': 'F10', 'F11': 'F11', 'F12': 'F12',
        ' ': 'Space',
        'Space': 'Space',
    };
    return map[key] || key;
}

/**
 * @param {import('../CommandRouter.js').default} router
 */
export default function registerSimulateCommands(router) {

    // ================================================================
    //  simulate.key <key> [modifiers...]
    //
    //  Dispatches a keydown KeyboardEvent on document.
    //  Modifiers: ctrl, meta, alt, shift (case-insensitive).
    //
    //  Examples:
    //    simulate.key h
    //    simulate.key Enter
    //    simulate.key Escape
    //    simulate.key j ctrl
    //    simulate.key ArrowLeft shift
    // ================================================================

    router.register('simulate.key', (args, ctx) => {
        if (args.length < 1) {
            return { text: 'ERR: usage: simulate.key <key> [ctrl] [meta] [alt] [shift]', data: null };
        }

        const key = args[0];
        const modifiers = args.slice(1).map(m => m.toLowerCase());

        const init = {
            key,
            code: keyToCode(key),
            bubbles: true,
            cancelable: true,
            ctrlKey: modifiers.includes('ctrl'),
            metaKey: modifiers.includes('meta'),
            altKey: modifiers.includes('alt'),
            shiftKey: modifiers.includes('shift'),
        };

        const event = new KeyboardEvent('keydown', init);
        document.dispatchEvent(event);

        const modStr = modifiers.length > 0 ? ` [${modifiers.join('+')}]` : '';
        return {
            text: `OK: dispatched keydown "${key}"${modStr}`,
            data: {
                key,
                code: init.code,
                ctrlKey: init.ctrlKey,
                metaKey: init.metaKey,
                altKey: init.altKey,
                shiftKey: init.shiftKey,
            },
        };
    }, {
        description: 'Dispatch a KeyboardEvent on document',
        usage: '<key> [ctrl] [meta] [alt] [shift]',
    });

    // ================================================================
    //  nav.status
    //
    //  Reports SpatialNavigator state: focus index, grid name, mode,
    //  and what h/j/k/l would navigate to from the current position.
    // ================================================================

    router.register('nav.status', (args, ctx) => {
        const nav = ctx.spatialNav;
        if (!nav) {
            return {
                text: 'ERR: SpatialNavigator not available (window._spatialNav not wired into context)',
                data: null,
            };
        }

        const grids = ctx.getGrids();
        const focusIndex = nav.focusIndex;
        const mode = nav.mode;

        let focusedName = '(none)';
        if (focusIndex >= 0) {
            const g = grids[focusIndex];
            if (g) {
                focusedName = g.getFilename?.() || g.getSourcePath?.() || `grid #${focusIndex}`;
            }
        }

        // Use the navigator's own search method — single source of truth
        function neighborName(direction) {
            if (focusIndex < 0) return '(no focus)';
            const current = grids[focusIndex];
            if (!current) return '?';
            const bestIdx = nav.findNearest(grids, current, direction);
            if (bestIdx < 0) return '(none)';
            const g = grids[bestIdx];
            const name = g.getFilename?.() || g.getSourcePath?.() || `grid #${bestIdx}`;
            return `#${bestIdx} ${name}`;
        }

        const data = {
            'focus':    focusIndex >= 0 ? `#${focusIndex} ${focusedName}` : '(none)',
            'mode':     mode,
            'grids':    String(grids.length),
            'left (h)': neighborName('left'),
            'right (l)':neighborName('right'),
            'up (k)':   neighborName('up'),
            'down (j)': neighborName('down'),
        };

        const lines = kvLines(data, 12);
        return {
            text: box('NAV STATUS', lines, 50) + '\nOK: nav.status',
            data: {
                focusIndex,
                focusedName: focusIndex >= 0 ? focusedName : null,
                mode,
                gridCount: grids.length,
                neighbors: {
                    left:  neighborName('left'),
                    right: neighborName('right'),
                    up:    neighborName('up'),
                    down:  neighborName('down'),
                },
            },
        };
    }, { description: 'Report SpatialNavigator focus, mode, and directional neighbors' });
}
