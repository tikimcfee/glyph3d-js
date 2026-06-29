/**
 * Layout commands — the FIELD's layout, as distinct from a single grid's fold
 * (that's grid.layout). The content tree owns where files and directories sit in
 * the world; these verbs pick the packing scheme and re-lay the whole field.
 *
 * layout.scheme            → report the active scheme + what's available
 * layout.scheme <name>     → switch schemes and relayout (walk | district | …)
 * layout.markers           → report the bounding-prism state + options
 * layout.markers on|off    → toggle the per-directory bounding prisms
 *   [--opacity N --pad N --color-a HEX --color-b HEX …]  → dial them live
 *
 * layout.arrows            → report the ownership-line state + options
 * layout.arrows on|off     → toggle the per-directory ownership lines (hub → files + child dirs)
 *   [--opacity N --z-lift N --color-a HEX (files) --color-b HEX (dirs)]  → dial them live
 *
 * The scheme applies to every subsequent tree relayout too — file.open,
 * file.openDir, grid.layout/grid.window footprint changes all flow through
 * ContentTree.relayoutAndRest, so a directory-row "load it all" lands in
 * whatever scheme is active. Markers rebuild on every relayout via
 * ContentTree.onRelayout — they decorate whatever scheme is live.
 */

import { box, kvLines } from '../formatResponse.js';
import { LAYOUT_SCHEMES, schemeNameOf } from '@glyph3d/core/collections/layouts/index.js';
import { WORLD_FLOOR_Y } from './spatialHelpers.js';

/**
 * @param {import('../../../packages/glyph3d-core/src/services/orchestration/CommandRouter.js').default} router
 */
export default function registerLayoutCommands(router) {
    const names = Object.keys(LAYOUT_SCHEMES);

    router.register('layout.scheme', (args, ctx) => {
        const tree = ctx.contentTree;
        if (!tree) return { text: 'ERR: no content tree in this context', data: null };

        // No args → report (scheme + its live opt overrides).
        if (!args[0]) {
            const current = schemeNameOf(tree.layout) || '(custom)';
            const opts = Object.entries(tree.layoutOpts || {}).map(([k, v]) => `${k}=${v}`).join(' ') || '(defaults)';
            return {
                text: box('LAYOUT SCHEME', kvLines({ current, opts, available: names.join(' ') }), 56) + '\nOK: layout.scheme',
                data: { scheme: current, opts: tree.layoutOpts || {}, available: names },
            };
        }

        // Optional leading scheme name, then --flag value knobs. Kebab flags map onto the
        // scheme's opt keys (--depth-z → depthZ); schemes merge over their own DEFAULTS.
        // Naming a scheme starts its opts FRESH (a scheme is a complete bundle, same rule
        // as grid.layout presets); flags alone patch the active scheme's opts in place.
        let scheme = tree.layout;
        let name = schemeNameOf(scheme) || '(custom)';
        let opts = { ...(tree.layoutOpts || {}) };
        let i = 0;
        if (!args[0].startsWith('--')) {
            scheme = LAYOUT_SCHEMES[args[0]];
            if (!scheme) return { text: `ERR: unknown scheme "${args[0]}" (${names.join('|')})`, data: null };
            name = args[0];
            opts = {};
            i = 1;
        }
        for (; i < args.length; i += 2) {
            const flag = args[i];
            if (!flag.startsWith('--')) return { text: `ERR: expected --flag, got "${flag}"`, data: null };
            const raw = args[i + 1];
            if (raw === undefined) return { text: `ERR: ${flag} needs a value`, data: null };
            // Numeric knobs stay numeric (and non-negative); a non-numeric value passes
            // through as a string for any enum knob a scheme may expose.
            const key = flag.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
            const n = Number(raw);
            if (raw.trim() !== '' && Number.isFinite(n)) {
                if (n < 0) return { text: `ERR: ${flag} must be ≥ 0`, data: null };
                opts[key] = n;
            } else {
                opts[key] = raw;
            }
        }

        tree.setLayout(scheme, opts);
        tree.relayoutAndRest(WORLD_FLOOR_Y);
        const files = tree.paths().length;
        const optStr = Object.keys(opts).length ? ` · ${Object.entries(opts).map(([k, v]) => `${k}=${v}`).join(' ')}` : '';
        return {
            text: `OK: layout scheme = ${name}${optStr} (${files} files, ${tree.dirCount()} dirs re-laid)`,
            data: { scheme: name, opts, files, dirs: tree.dirCount() },
        };
    }, {
        description: "Report or set the content tree's packing scheme (+ knob overrides) and re-lay the field",
        usage: `[${Object.keys(LAYOUT_SCHEMES).join('|')}] [--depth-z N --rake-z N --dir-gap N --margin N --aspect N | jellyfish: --target-radius N --panel-w N --panel-h N --panel-gap N --face-gap N --drop N --child-gap N --col-gap N --row-gap N --hub-radius N --min-radius N …]   (flags alone re-dial the active scheme)`,
        returns: '{ scheme, opts, files, dirs } or { scheme, opts, available }',
    });

    // Gradient endpoints take hex ('7a3a8a', '#7a3a8a', '0x7a3a8a'); everything else is numeric.
    const COLOR_KEYS = new Set(['colorA', 'colorB']);
    router.register('layout.markers', (args, ctx) => {
        const markers = ctx.contentTreeMarkers;
        if (!markers) return { text: 'ERR: no content-tree markers in this context', data: null };

        if (!args[0]) {
            const opts = Object.fromEntries(Object.entries(markers.opts).map(([k, v]) =>
                [k, COLOR_KEYS.has(k) ? '#' + v.toString(16).padStart(6, '0') : String(v)]));
            return {
                text: box('LAYOUT MARKERS', kvLines({ enabled: String(markers.enabled), ...opts }), 56) + '\nOK: layout.markers',
                data: { enabled: markers.enabled, opts: { ...markers.opts } },
            };
        }

        let i = 0;
        let enabled = markers.enabled;
        if (args[0] === 'on' || args[0] === 'off') { enabled = args[0] === 'on'; i = 1; }
        else if (!args[0].startsWith('--')) return { text: `ERR: expected on|off or --flags, got "${args[0]}"`, data: null };

        const patch = {};
        for (; i < args.length; i += 2) {
            const flag = args[i];
            if (!flag.startsWith('--')) return { text: `ERR: expected --flag, got "${flag}"`, data: null };
            const raw = args[i + 1];
            if (raw === undefined) return { text: `ERR: ${flag} needs a value`, data: null };
            const key = flag.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
            if (COLOR_KEYS.has(key)) {
                const hex = raw.replace(/^#|^0x/, '');
                if (!/^[0-9a-fA-F]{6}$/.test(hex)) return { text: `ERR: ${flag} wants a 6-digit hex color`, data: null };
                patch[key] = parseInt(hex, 16);
                continue;
            }
            const n = Number(raw);
            if (!Number.isFinite(n) || n < 0) return { text: `ERR: ${flag} must be a finite number ≥ 0`, data: null };
            patch[key] = n;
        }

        if (Object.keys(patch).length) markers.configure(patch);
        markers.setEnabled(enabled);
        return {
            text: `OK: markers ${enabled ? 'on' : 'off'}${Object.keys(patch).length ? ' · ' + Object.entries(patch).map(([k, v]) => `${k}=${COLOR_KEYS.has(k) ? '#' + v.toString(16) : v}`).join(' ') : ''}`,
            data: { enabled, patch },
        };
    }, {
        description: 'Toggle/dial the per-directory bounding prisms (depth-gradient colored volumes)',
        usage: '[on|off] [--opacity N --opacity-decay N --pad N --z-pad N --min-thickness N --edge-opacity N --color-a HEX --color-b HEX]',
        returns: '{ enabled, patch } or { enabled, opts }',
    });

    // Ordered arrows: per-directory chains threading the child dirs in canonical order.
    // Same color/number knob grammar as layout.markers (colorA/colorB take hex).
    router.register('layout.arrows', (args, ctx) => {
        const arrows = ctx.contentTreeArrows;
        if (!arrows) return { text: 'ERR: no content-tree arrows in this context', data: null };

        if (!args[0]) {
            const opts = Object.fromEntries(Object.entries(arrows.opts).map(([k, v]) =>
                [k, COLOR_KEYS.has(k) ? '#' + v.toString(16).padStart(6, '0') : String(v)]));
            return {
                text: box('LAYOUT ARROWS', kvLines({ enabled: String(arrows.enabled), ...opts }), 56) + '\nOK: layout.arrows',
                data: { enabled: arrows.enabled, opts: { ...arrows.opts } },
            };
        }

        let i = 0;
        let enabled = arrows.enabled;
        if (args[0] === 'on' || args[0] === 'off') { enabled = args[0] === 'on'; i = 1; }
        else if (!args[0].startsWith('--')) return { text: `ERR: expected on|off or --flags, got "${args[0]}"`, data: null };

        const patch = {};
        for (; i < args.length; i += 2) {
            const flag = args[i];
            if (!flag.startsWith('--')) return { text: `ERR: expected --flag, got "${flag}"`, data: null };
            const raw = args[i + 1];
            if (raw === undefined) return { text: `ERR: ${flag} needs a value`, data: null };
            const key = flag.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
            if (COLOR_KEYS.has(key)) {
                const hex = raw.replace(/^#|^0x/, '');
                if (!/^[0-9a-fA-F]{6}$/.test(hex)) return { text: `ERR: ${flag} wants a 6-digit hex color`, data: null };
                patch[key] = parseInt(hex, 16);
                continue;
            }
            const n = Number(raw);
            if (!Number.isFinite(n) || n < 0) return { text: `ERR: ${flag} must be a finite number ≥ 0`, data: null };
            patch[key] = n;
        }

        if (Object.keys(patch).length) arrows.configure(patch);
        arrows.setEnabled(enabled);
        return {
            text: `OK: arrows ${enabled ? 'on' : 'off'}${Object.keys(patch).length ? ' · ' + Object.entries(patch).map(([k, v]) => `${k}=${COLOR_KEYS.has(k) ? '#' + v.toString(16) : v}`).join(' ') : ''}`,
            data: { enabled, patch },
        };
    }, {
        description: 'Toggle/dial the per-directory ordered-arrow chains (sibling reading-order threads)',
        usage: '[on|off] [--anchor top|top-left|top-right --opacity N --z-lift N --arrow-ratio N --arrow-angle N --color-a HEX --color-b HEX]',
        returns: '{ enabled, patch } or { enabled, opts }',
    });

    // Diagnostic: per-dir origin vs content-anchor dots + link. colorKeys here are the
    // probe's own (originColor/contentColor/linkColor); everything else numeric.
    const PROBE_COLORS = new Set(['originColor', 'contentColor', 'linkColor']);
    router.register('layout.probes', (args, ctx) => {
        const probes = ctx.contentTreeProbes;
        if (!probes) return { text: 'ERR: no content-tree probes in this context', data: null };

        if (!args[0]) {
            const opts = Object.fromEntries(Object.entries(probes.opts).map(([k, v]) =>
                [k, PROBE_COLORS.has(k) ? '#' + v.toString(16).padStart(6, '0') : String(v)]));
            return {
                text: box('LAYOUT PROBES', kvLines({ enabled: String(probes.enabled), ...opts }), 56) + '\nOK: layout.probes',
                data: { enabled: probes.enabled, opts: { ...probes.opts } },
            };
        }

        let i = 0;
        let enabled = probes.enabled;
        if (args[0] === 'on' || args[0] === 'off') { enabled = args[0] === 'on'; i = 1; }
        else if (!args[0].startsWith('--')) return { text: `ERR: expected on|off or --flags, got "${args[0]}"`, data: null };

        const patch = {};
        for (; i < args.length; i += 2) {
            const flag = args[i];
            if (!flag.startsWith('--')) return { text: `ERR: expected --flag, got "${flag}"`, data: null };
            const raw = args[i + 1];
            if (raw === undefined) return { text: `ERR: ${flag} needs a value`, data: null };
            const key = flag.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
            if (key === 'anchor') {
                if (!['top', 'top-left', 'top-right'].includes(raw)) return { text: `ERR: --anchor must be top|top-left|top-right`, data: null };
                patch.anchor = raw;
                continue;
            }
            if (PROBE_COLORS.has(key)) {
                const hex = raw.replace(/^#|^0x/, '');
                if (!/^[0-9a-fA-F]{6}$/.test(hex)) return { text: `ERR: ${flag} wants a 6-digit hex color`, data: null };
                patch[key] = parseInt(hex, 16);
                continue;
            }
            const n = Number(raw);
            if (!Number.isFinite(n) || n < 0) return { text: `ERR: ${flag} must be a finite number ≥ 0`, data: null };
            patch[key] = n;
        }

        if (Object.keys(patch).length) probes.configure(patch);
        probes.setEnabled(enabled);
        return {
            text: `OK: probes ${enabled ? 'on' : 'off'}${Object.keys(patch).length ? ' · ' + Object.entries(patch).map(([k, v]) => `${k}=${PROBE_COLORS.has(k) ? '#' + v.toString(16) : v}`).join(' ') : ''}`,
            data: { enabled, patch },
        };
    }, {
        description: 'DIAGNOSTIC: per-directory dots at the footprint origin vs the content anchor (+link) — reveals where arrows anchor',
        usage: '[on|off] [--size N --z-lift N --anchor top|top-left|top-right --origin-color HEX --content-color HEX --link-color HEX]',
        returns: '{ enabled, patch } or { enabled, opts }',
    });
}
