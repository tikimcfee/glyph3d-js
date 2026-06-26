/**
 * settings.* commands — get / set / reset user settings, the bus front for the
 * Settings panel. Backed by StateController (localStorage, client-only — no relay),
 * driven off the shared SETTINGS schema so the panel and these verbs never drift.
 *
 *   settings.set <key> <value>   persist + apply live (reload-required knobs say so)
 *   settings.get [key]           one value, or all
 *   settings.reset [key]         all back to defaults, or just one if a key is given
 */

import { SETTINGS, settingDef, getSetting, setSetting, resetSettings, resetSetting } from '../../client/settings.js';

/**
 * @param {import('../CommandRouter.js').default} router
 */
export default function registerSettingsCommands(router) {
    router.register('settings.set', (args, ctx) => {
        const key = args[0];
        const value = args.slice(1).join(' ');
        if (!key || value === '') return { text: 'ERR: usage: settings.set <key> <value>', data: null };
        if (!settingDef(key)) return { text: `ERR: unknown setting "${key}"`, data: null };
        const r = setSetting(ctx, key, value);
        return {
            text: `OK: ${key} = ${r.value}${r.reload ? ' (reload to apply)' : ''}`,
            data: { key, value: r.value, reload: r.reload },
        };
    }, { description: 'Set a setting — persists, and applies live where it can', usage: '<key> <value>' });

    router.register('settings.get', (args, _ctx) => {
        const key = args[0];
        if (key) {
            if (!settingDef(key)) return { text: `ERR: unknown setting "${key}"`, data: null };
            const value = getSetting(key);
            return { text: `OK: ${key} = ${value}`, data: { key, value } };
        }
        const settings = SETTINGS.map((s) => ({ key: s.key, value: getSetting(s.key) }));
        return { text: `OK: ${settings.map((s) => `${s.key}=${s.value}`).join('  ')}`, data: { settings } };
    }, { description: 'Get one setting value, or all of them', usage: '[key]' });

    router.register('settings.reset', (args, ctx) => {
        const key = args[0];
        if (key) {
            if (!settingDef(key)) return { text: `ERR: unknown setting "${key}"`, data: null };
            const r = resetSetting(ctx, key);
            return {
                text: `OK: ${key} reset to ${r.value}${r.reloadNeeded ? ' (reload to apply)' : ''}`,
                data: { key, ...r },
            };
        }
        const r = resetSettings(ctx);
        return {
            text: `OK: settings reset to defaults${r.reloadNeeded ? ' (reload for display settings)' : ''}`,
            data: r,
        };
    }, { description: 'Reset all settings to defaults, or one if a key is given', usage: '[key]' });
}
