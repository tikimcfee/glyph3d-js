/**
 * Layout commands — the FIELD's layout, as distinct from a single grid's fold
 * (that's grid.layout). The content tree owns where files and directories sit in
 * the world; these verbs pick the packing scheme and re-lay the whole field.
 *
 * layout.scheme            → report the active scheme + what's available
 * layout.scheme <name>     → switch schemes and relayout (walk | district | …)
 * The overlay family shares one verb grammar (bare → report, on|off → toggle,
 * --flag value → dial live):
 *
 * layout.markers  → the per-directory bounding prisms (depth-gradient volumes)
 * layout.arrows   → the per-directory ownership lines (hub → files + child dirs)
 * layout.probes   → DIAGNOSTIC origin-vs-content-anchor dots
 * layout.labels   → the container labels: every visible directory named in space
 *                   (chain-compressed joined names, depth-scaled, approach fade)
 *
 * The scheme applies to every subsequent tree relayout too — file.open,
 * file.openDir, grid.layout/grid.window footprint changes all flow through
 * ContentTree.relayoutAndRest, so a directory-row "load it all" lands in
 * whatever scheme is active. Overlays rebuild on every relayout via
 * ContentTree.onRelayout — they decorate whatever scheme is live.
 */

import { box, kvLines } from '../formatResponse.js';
import { LAYOUT_SCHEMES, schemeNameOf } from '@glyph3d/core/collections/layouts/index.js';
import { schemeSettingsOpts } from '../../client/settings.js';
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
            // Naming a scheme starts its opts FRESH — seeded from the persisted Settings dials for
            // that scheme (so naming `jellyfish` picks up the Layout panel's values), then the
            // inline --flags below override. No settings for a scheme → {} (its baked defaults).
            opts = schemeSettingsOpts(name);
            i = 1;
        }
        for (; i < args.length; i += 2) {
            const flag = args[i];
            if (!flag.startsWith('--')) return { text: `ERR: expected --flag, got "${flag}"`, data: null };
            const raw = args[i + 1];
            if (raw === undefined) return { text: `ERR: ${flag} needs a value`, data: null };
            // Numeric knobs stay numeric (and non-negative); 'true'/'false' parse as a bool (toggle
            // knobs like jellyfish --warp-panels); anything else passes through as a string (enums).
            const key = flag.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
            const n = Number(raw);
            if (raw.trim() !== '' && Number.isFinite(n)) {
                if (n < 0) return { text: `ERR: ${flag} must be ≥ 0`, data: null };
                opts[key] = n;
            } else if (raw === 'true' || raw === 'false') {
                opts[key] = raw === 'true';
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
        usage: `[${Object.keys(LAYOUT_SCHEMES).join('|')}] [--depth-z N --rake-z N --dir-gap N --margin N --aspect N | jellyfish: --target-radius N --panel-w N --panel-h N --panel-gap N --face-gap N --drop N --child-gap N --col-gap N --row-gap N --hub-radius N --min-radius N --warp-panels true|false | library: --page-w N --page-h N --gap N --stack z|x|y --sort name|size|ext --reverse true|false --max-upscale N …]   (flags alone re-dial the active scheme)`,
        returns: '{ scheme, opts, files, dirs } or { scheme, opts, available }',
    });

    // ── The overlay family: markers · arrows · probes · labels ────────────────
    // One grammar for every ContentTree overlay verb: bare → report enabled + opts,
    // `on|off` → toggle, `--flag value` pairs → a configure() patch. Color keys take
    // hex ('7a3a8a', '#7a3a8a', '0x7a3a8a'), enum keys take one of their listed
    // words, everything else is a finite number ≥ 0.
    const registerOverlay = ({ verb, noun, ctxKey, title, colorKeys = new Set(), enums = {}, description, usage }) => {
        router.register(verb, (args, ctx) => {
            const overlay = ctx[ctxKey];
            if (!overlay) return { text: `ERR: no content-tree ${noun} in this context`, data: null };

            if (!args[0]) {
                const opts = Object.fromEntries(Object.entries(overlay.opts).map(([k, v]) =>
                    [k, colorKeys.has(k) ? '#' + v.toString(16).padStart(6, '0') : String(v)]));
                return {
                    text: box(title, kvLines({ enabled: String(overlay.enabled), ...opts }), 56) + `\nOK: ${verb}`,
                    data: { enabled: overlay.enabled, opts: { ...overlay.opts } },
                };
            }

            let i = 0;
            let enabled = overlay.enabled;
            if (args[0] === 'on' || args[0] === 'off') { enabled = args[0] === 'on'; i = 1; }
            else if (args[0] === 'toggle') { enabled = !overlay.enabled; i = 1; }   // stateless flip — bindable to a key
            else if (!args[0].startsWith('--')) return { text: `ERR: expected on|off|toggle or --flags, got "${args[0]}"`, data: null };

            const patch = {};
            for (; i < args.length; i += 2) {
                const flag = args[i];
                if (!flag.startsWith('--')) return { text: `ERR: expected --flag, got "${flag}"`, data: null };
                const raw = args[i + 1];
                if (raw === undefined) return { text: `ERR: ${flag} needs a value`, data: null };
                const key = flag.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
                if (enums[key]) {
                    if (!enums[key].includes(raw)) return { text: `ERR: ${flag} must be ${enums[key].join('|')}`, data: null };
                    patch[key] = raw;
                    continue;
                }
                if (colorKeys.has(key)) {
                    const hex = raw.replace(/^#|^0x/, '');
                    if (!/^[0-9a-fA-F]{6}$/.test(hex)) return { text: `ERR: ${flag} wants a 6-digit hex color`, data: null };
                    patch[key] = parseInt(hex, 16);
                    continue;
                }
                const n = Number(raw);
                if (!Number.isFinite(n) || n < 0) return { text: `ERR: ${flag} must be a finite number ≥ 0`, data: null };
                patch[key] = n;
            }

            if (Object.keys(patch).length) overlay.configure(patch);
            overlay.setEnabled(enabled);
            return {
                text: `OK: ${noun} ${enabled ? 'on' : 'off'}${Object.keys(patch).length ? ' · ' + Object.entries(patch).map(([k, v]) => `${k}=${colorKeys.has(k) ? '#' + v.toString(16) : v}`).join(' ') : ''}`,
                data: { enabled, patch },
            };
        }, { description, usage, returns: '{ enabled, patch } or { enabled, opts }' });
    };

    registerOverlay({
        verb: 'layout.markers', noun: 'markers', ctxKey: 'contentTreeMarkers', title: 'LAYOUT MARKERS',
        colorKeys: new Set(['colorA', 'colorB']),
        description: 'Toggle/dial the per-directory bounding prisms (depth-gradient colored volumes)',
        usage: '[on|off|toggle] [--opacity N --opacity-decay N --pad N --z-pad N --min-thickness N --edge-opacity N --color-a HEX --color-b HEX]',
    });

    // Ownership traces: per-directory circuit routing — a trunk bus down the outside
    // gutter, a rail per child through the row gutter, a drop onto the child's pin
    // (its frame top-center). World-unit stroke decays by depth (weight 0 = hairline).
    registerOverlay({
        verb: 'layout.arrows', noun: 'arrows', ctxKey: 'contentTreeArrows', title: 'LAYOUT ARROWS',
        colorKeys: new Set(['colorA', 'colorB']),
        description: 'Toggle/dial the per-directory ownership traces (circuit-routed in 3D: bus → z-jog → rail → chamfer → pin pad, never across a face; world-unit stroke, depth-decayed — weight 0 = 1px hairlines)',
        usage: '[on|off|toggle] [--weight N --weight-decay N --weight-min N --opacity N --bus-margin N --rail-gap N --chamfer N --pads 0|1 --pad-scale N --z-lift N --color-a HEX --color-b HEX]',
    });

    // Diagnostic: per-dir origin vs content-anchor dots + link. Color keys here are
    // the probe's own (originColor/contentColor/linkColor).
    registerOverlay({
        verb: 'layout.probes', noun: 'probes', ctxKey: 'contentTreeProbes', title: 'LAYOUT PROBES',
        colorKeys: new Set(['originColor', 'contentColor', 'linkColor']),
        enums: { anchor: ['top', 'top-left', 'top-right'] },
        description: 'DIAGNOSTIC: per-directory dots at the footprint origin vs the content anchor (+link) — reveals where arrows anchor',
        usage: '[on|off|toggle] [--size N --z-lift N --anchor top|top-left|top-right --origin-color HEX --content-color HEX --link-color HEX]',
    });

    // Container + book labels: every visible directory named in space — the chain-
    // compressed joined name, depth-scaled (physical LOD), easing to a readable name
    // tag as you arrive — and every book wearing its file name the same way.
    registerOverlay({
        verb: 'layout.labels', noun: 'labels', ctxKey: 'contentTreeLabels', title: 'LAYOUT LABELS',
        colorKeys: new Set(['colorA', 'colorB', 'plateColor']),
        description: 'Toggle/dial the container + book labels (chain-compressed dir names, per-book file names, container-fit sizing, approach spectrum, backplates)',
        usage: '[on|off|toggle] [--fit N --scale-min N --scale-max N --opacity N --min-alpha N --near-scale N --fade-start N --fade-end N --gap-y N --z-lift N --turn-ease N --turn-dip N --turn-pop N --show-count 0|1 --show-files 0|1 --plate 0|1 --plate-color HEX --plate-opacity N --plate-pad N --color-a HEX --color-b HEX]',
    });

    // Relayout motion: every re-lay is a glide — durable nodes ease from where they
    // were to where the scheme stamped them; off restores the instant teleport.
    registerOverlay({
        verb: 'layout.motion', noun: 'motion', ctxKey: 'contentTreeMotion', title: 'LAYOUT MOTION',
        description: 'Toggle/dial the relayout glide (nodes ease to their new slots on every re-lay; scheme switches and loads become visible motion)',
        usage: '[on|off|toggle] [--rate N --epsilon N --rotate 0|1]',
    });

}
