/**
 * view.* commands — toggles for high-level view primitives (the 3D minimap overview today;
 * a viewcube and friends later). Backed by the SETTINGS store so the toolbar button, the
 * Settings panel, and the CLI all flip the SAME persisted key; main.jsx mounts/unmounts the
 * widget in response to StateController's `state-changed` event.
 */

import { getSetting, setSetting } from '../../client/settings.js';

/** Resolve an [on|off|toggle] arg against the current value. */
const resolve = (arg, cur) => {
    const a = (arg || 'toggle').toLowerCase();
    if (a === 'on' || a === 'true' || a === '1') return true;
    if (a === 'off' || a === 'false' || a === '0') return false;
    return !cur;
};

/**
 * @param {import('../CommandRouter.js').default} router
 */
export default function registerViewCommands(router) {
    router.register('view.minimap', (args, ctx) => {
        const next = resolve(args[0], getSetting('view.minimap'));
        setSetting(ctx, 'view.minimap', next);
        return { text: `OK: minimap ${next ? 'on' : 'off'}`, data: { minimap: next } };
    }, { description: 'Toggle the 3D minimap overview', usage: '[on|off|toggle]' });
}
