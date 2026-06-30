/**
 * attention.* commands — external writers for the AttentionManager slots.
 *
 * Editable-3d-ide L1-A. Verb surface:
 *
 *   attention.set <slot> <id|none>     slot ∈ hover|primary|key
 *                                      id = registry id, or 'none'|null to clear
 *   attention.info                     returns the current state record
 *   attention.clear [slot]             clear one slot, or all when omitted
 *   attention.capture [toggle|on|off]  settle/unsettle greedy keyboard capture on the key entity
 *
 * `attention.set primary <id>` routes through the same slot the
 * compass and reader mode use, so the command bar is a consumer
 * of attention.primary rather than an independent attention axis.
 *
 * All verbs return the standard { text, data } shape so controllers
 * (glyph3d-cli) can script focus changes for tests.
 */

const VALID_SLOTS = ['hover', 'primary', 'key'];

/**
 * @param {import('../../../packages/glyph3d-core/src/services/orchestration/CommandRouter.js').default} router
 */
export default function registerAttentionCommands(router) {

    router.register('attention.set', (args, ctx) => {
        if (args.length < 2) {
            return {
                text: `ERR: usage: attention.set <slot> <id|none>  (slot ∈ ${VALID_SLOTS.join('|')})`,
                data: null,
            };
        }
        const slot = String(args[0]).toLowerCase();
        if (!VALID_SLOTS.includes(slot)) {
            return {
                text: `ERR: unknown slot '${slot}' (expected ${VALID_SLOTS.join('|')})`,
                data: null,
            };
        }
        if (!ctx.attentionManager) {
            return { text: 'ERR: AttentionManager not wired into ctx', data: null };
        }

        const rawId = args[1];
        const isClear = rawId == null || rawId === 'none' || rawId === '' || rawId === 'null';

        // Resolve the registry entry when setting, so downstream events
        // carry a usable reference. Missing entries are permitted (some
        // writers — like the hover probe — race ahead of registry updates)
        // but they log a debug warning.
        let entity = null;
        if (!isClear && ctx.registry) {
            entity = ctx.registry.get(String(rawId)) || null;
            if (!entity) {
                console.debug(`[attention.set] no registry entry for id='${rawId}' — setting anyway`);
            }
        }

        const value = ctx.attentionManager.set(
            slot,
            isClear ? null : String(rawId),
            { entity },
        );

        return {
            text: value
                ? `OK: attention.${slot}=${value.id}`
                : `OK: attention.${slot} cleared`,
            data: {
                slot,
                id: value?.id ?? null,
                entityType: value?.entity?.type ?? null,
                ts: value?.ts ?? null,
            },
        };
    }, {
        description: 'Set an attention slot (hover|primary|key) to a registry id (or "none" to clear)',
        usage: '<slot> <id|none>',
        returns: '{ slot, id, entityType, ts }',
    });

    router.register('attention.info', (args, ctx) => {
        if (!ctx.attentionManager) {
            return { text: 'ERR: AttentionManager not wired into ctx', data: null };
        }
        const info = ctx.attentionManager.info();
        const lines = VALID_SLOTS.map(s => {
            const v = info[s];
            return v
                ? `  ${s.padEnd(8)}${v.id}  (ts=${Math.round(v.ts)})`
                : `  ${s.padEnd(8)}(cleared)`;
        });
        lines.push(`  docks   ${info.docks.length} entries`);
        return {
            text: `OK: attention\n${lines.join('\n')}`,
            data: info,
        };
    }, {
        description: 'Show the current attention record + dock map',
        returns: '{ hover, primary, key, docks }',
    });

    router.register('attention.clear', (args, ctx) => {
        if (!ctx.attentionManager) {
            return { text: 'ERR: AttentionManager not wired into ctx', data: null };
        }
        if (args.length === 0) {
            ctx.attentionManager.clear();
            return { text: 'OK: attention cleared (all slots)', data: { cleared: VALID_SLOTS } };
        }
        const slot = String(args[0]).toLowerCase();
        if (!VALID_SLOTS.includes(slot)) {
            return {
                text: `ERR: unknown slot '${slot}' (expected ${VALID_SLOTS.join('|')})`,
                data: null,
            };
        }
        ctx.attentionManager.clear(slot);
        return { text: `OK: attention.${slot} cleared`, data: { cleared: [slot] } };
    }, {
        description: 'Clear one slot (arg) or all slots (no arg)',
        usage: '[slot]',
    });

    // Greedy keyboard CAPTURE on the key entity (settle/unsettle). When captured, the keyboard
    // responder chain routes everything — Esc included — to that entity; the reserved toggle chord
    // is the only key it won't get. Fired by the chord tier (keyboardRouter) and the chrome lock
    // button; scriptable from the CLI for tests. An optional <id> targets a specific entity (the
    // lock button passes its own, since its press bypasses click-to-focus) — capture implies key
    // focus, so we make it the keyboard target first. With no id it acts on the current key entity.
    router.register('attention.capture', (args, ctx) => {
        const am = ctx.attentionManager;
        if (!am) return { text: 'ERR: AttentionManager not wired into ctx', data: null };

        const arg = String(args[0] ?? 'toggle').toLowerCase();
        if (!['toggle', 'on', 'off'].includes(arg)) {
            return { text: `ERR: usage: attention.capture [toggle|on|off] [id]`, data: null };
        }
        const id = args[1] != null ? String(args[1]) : null;
        if (id && am.get('key')?.id !== id) {
            // Capture implies focus — make this entity the keyboard target AND the focused window
            // (the lock button bypasses click-to-focus, so do it here). Setting key to a new id drops
            // any capture on the entity it replaces, so the toggle below settles cleanly on the new one.
            const entity = ctx.registry?.get(id) || null;
            am.set('primary', id, { entity });
            am.set('key', id, { entity });
        }

        const key = am.get('key');
        if (!key) return { text: 'ERR: no key-focus entity to capture', data: null };
        const next = arg === 'on' ? true : arg === 'off' ? false : !am.isCaptured();
        am.setCaptured(next);
        return {
            text: `OK: capture ${next ? 'on' : 'off'} (${key.id})`,
            data: { captured: next, id: key.id, entityType: key.entity?.type ?? null },
        };
    }, {
        description: 'Settle/unsettle greedy keyboard capture on the key-focus entity (or a given id)',
        usage: '[toggle|on|off] [id]',
        returns: '{ captured, id, entityType }',
    });
}
