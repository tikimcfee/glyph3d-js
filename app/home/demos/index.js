/**
 * Demo registry — register all `demo.*` commands on a CommandRouter.
 *
 * Each demo is an async function in its own file; this module wires
 * them to router commands and provides a `demo` meta-command that
 * lists what's available so visitors can discover by tab-completing.
 *
 * Pattern (per demo):
 *   demoXxx({ grid, bar, run }) → Promise<{ text }>
 *
 * The runner gives every demo a fresh AbortSignal — calling another
 * demo cancels the previous one, so spamming `demo.<name>` is safe.
 */

import { AbortableDemoRunner } from './helpers.js';
import demoLayoutMorph from './layoutmorph.js';
import demoRepo        from './repo.js';
// demoColors deferred — per-glyph iteration in the v4 GPU backend is
// flaky for end-of-line glyphs, so the visual reads wrong. Position/
// offset demos showcase the layout kit instead, which is what visitors
// most need to grok anyway.

/**
 * @param {Object} router  CommandRouter
 * @param {Object} deps
 * @param {Object} deps.welcome   WelcomeCluster (has .grid, .redraw())
 * @param {Object} deps.tryThis   TryThisCluster (has .grid, .redraw())
 * @param {Object} deps.bar       HomeCommandBar (has appendOutput())
 * @returns {AbortableDemoRunner}  the shared runner; HomeShell can cancel via it
 */
export function registerDemos(router, deps) {
    const runner = new AbortableDemoRunner();
    const { welcome, tryThis, bar } = deps;

    // Catalog: name → { run, description, restore }. `restore` is called
    // after the demo finishes or cancels so we can put the page back
    // exactly how the visitor found it.
    const catalog = {
        'demo.layoutmorph': {
            description: 'Watch the layout kit re-compose itself in motion.',
            run: (run) => demoLayoutMorph({
                welcome, tryThis,
                layoutRoot: deps.layoutRoot,
                bar, run,
            }),
            restore: () => { deps.layoutRoot?.layout(); deps.reframe?.(); },
        },
        'demo.repo': {
            description: 'Load app/home/ from disk and lay it out as files.',
            run: (run) => demoRepo({
                scene: deps.scene,
                atlas: deps.atlas,
                bridge: deps.bridge,
                camera: deps.camera,
                cameraController: deps.cameraController,
                layoutRoot: deps.layoutRoot,
                welcome, tryThis,
                bar, run,
            }),
            restore: () => { deps.reframe?.(); },
        },
    };

    // Meta-command: `demo` with no args lists the catalog.
    router.register('demo', () => {
        const lines = [
            'Show me the engine. Pick one (or tab-complete):',
            '',
        ];
        for (const [name, entry] of Object.entries(catalog)) {
            lines.push(`  ${name.padEnd(18, ' ')} ${entry.description}`);
        }
        lines.push('');
        lines.push('Re-typing the same name cancels and restarts it.');
        return { text: lines.join('\n') };
    }, { description: 'List engine showcase demos.' });

    // Register each sub-demo as `demo.<name>`.
    for (const [name, entry] of Object.entries(catalog)) {
        router.register(name, async () => {
            const result = await runner.start(name, entry.run);
            try { entry.restore?.(); } catch {}
            if (result.cancelled) return { text: `${name} cancelled.` };
            if (result.error)     throw result.error;
            return { text: `${name} done.` };
        }, { description: entry.description });
    }

    return runner;
}
