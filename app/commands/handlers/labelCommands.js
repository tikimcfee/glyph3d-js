/**
 * Screen overlay, map label, and carrel card commands:
 *   overlay.text <id> <x> <y> <px> <text...>
 *   overlay.clear [id]
 *   overlay.list [kind]
 *   label.list
 *   label.explain <id>
 *   label.freeze [on|off]
 *   carrel.card <name> [tier] [--show card|live]
 *   card.list
 */

import { box, table, kvLines } from '../formatResponse.js';
import PlaneOverlay from '../../client/PlaneOverlay.js';
import MapLabels from '../../client/MapLabels.js';
import { registerStripCommands } from '../../client/Strip.js';
import CarrelCards from '../../../packages/glyph3d-core/src/collections/CarrelCards.js';

/**
 * Ensure `ctx.planeOverlay` exists (supports both live client and headless tests).
 * @param {import('../../client/CommandProvider.jsx').AppContext} ctx
 * @returns {PlaneOverlay}
 */
export function ensureOverlay(ctx) {
    if (!ctx.planeOverlay) {
        ctx.planeOverlay = new PlaneOverlay(ctx);
    }
    return ctx.planeOverlay;
}

/**
 * Ensure `ctx.mapLabels` exists (supports both live client and headless tests).
 * @param {import('../../client/CommandProvider.jsx').AppContext} ctx
 * @returns {MapLabels}
 */
export function ensureMapLabels(ctx) {
    ensureOverlay(ctx);
    if (!ctx.mapLabels) {
        ctx.mapLabels = new MapLabels(ctx);
    }
    return ctx.mapLabels;
}

/**
 * Ensure `ctx.carrelCards` exists (supports both live client and headless tests).
 * @param {import('../../client/CommandProvider.jsx').AppContext} ctx
 * @returns {CarrelCards}
 */
export function ensureCarrelCards(ctx) {
    if (!ctx.carrelCards) {
        ctx.carrelCards = new CarrelCards(ctx);
    }
    return ctx.carrelCards;
}

/**
 * @param {import('../../client/CommandProvider.jsx').AppRouter} router
 */
export default function registerLabelCommands(router) {
    // ================================================================
    //  overlay.text <id> <x> <y> <px> <text...>
    // ================================================================
    router.register('overlay.text', (args, ctx) => {
        if (args.length < 5) {
            return { text: 'ERR: usage: overlay.text <id> <x> <y> <px> <text...>', data: null };
        }
        const id = String(args[0]);
        const x = Number(args[1]);
        const y = Number(args[2]);
        const px = Number(args[3]);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !(px > 0)) {
            return { text: 'ERR: x and y must be finite numbers and px must be > 0', data: null };
        }
        const rawText = args.slice(4).join(' ').replace(/\\n/g, '\n');
        const overlay = ensureOverlay(ctx);
        const rec = overlay.setText(id, { x, y, px, text: rawText, kind: 'manual' });
        const vp = overlay.syncCamera();
        const data = {
            id: rec.id,
            x: rec.x,
            y: rec.y,
            px: rec.px,
            scale: rec.scale,
            cols: rec.cols,
            rows: rec.rows,
            text: rec.text,
            textRect: { ...rec.textRect },
            rect: { ...rec.rect },
            viewport: vp,
        };
        return {
            text: `OK: overlay.text "${id}" at (${rec.x}, ${rec.y}) ${rec.px}px (${rec.cols}×${rec.rows})`,
            data,
        };
    }, {
        description: 'Place or update a device-pixel-snapped text item in the screen overlay',
        usage: '<id> <x> <y> <px> <text...>',
    });

    // ================================================================
    //  overlay.clear [id]
    // ================================================================
    router.register('overlay.clear', (args, ctx) => {
        const overlay = ensureOverlay(ctx);
        const id = args[0] ?? null;
        const removed = id ? overlay.clear(id) : overlay.clear(null, { kind: 'manual' });
        return {
            text: id ? `OK: overlay.clear "${id}" (${removed} removed)` : `OK: overlay.clear (${removed} removed)`,
            data: { id, removed },
        };
    }, {
        description: 'Remove one or all manual overlay text items',
        usage: '[id]',
    });

    // ================================================================
    //  overlay.list
    // ================================================================
    router.register('overlay.list', (args, ctx) => {
        const overlay = ensureOverlay(ctx);
        const vp = overlay.syncCamera();
        const items = overlay.list({ kind: args[0] ?? null });
        if (items.length === 0) {
            return {
                text: box('OVERLAY', ['(empty)'], 48) + '\nOK: 0 overlay items',
                data: { items: [], count: 0, viewport: vp },
            };
        }
        const headers = ['id', 'kind', 'x,y', 'px', 'w×h', 'text'];
        const rows = items.map((it) => [
            it.id,
            it.kind,
            `${it.x},${it.y}`,
            String(it.px),
            `${Math.round(it.rect.w)}×${Math.round(it.rect.h)}`,
            it.text.replace(/\n/g, '\\n').slice(0, 40),
        ]);
        return {
            text: table(headers, rows) + `\nOK: ${items.length} overlay item(s)`,
            data: { items, count: items.length, viewport: vp },
        };
    }, {
        description: 'List the screen overlay\'s items (all, or one kind: manual, strip, …), each with its device-px rect and page-CSS screenRect',
        usage: '[kind]',
    });

    // ================================================================
    //  label.list / maplabel.list
    // ================================================================
    const handleList = (_args, ctx) => {
        const ml = ensureMapLabels(ctx);
        const snap = ml.snapshot();
        if (snap.candidates.length === 0) {
            return {
                text: box('MAP LABELS', ['(no candidates)'], 48) + `\nOK: 0 candidates${snap.frozen ? ' (frozen)' : ''}`,
                data: snap,
            };
        }
        const headers = ['id', 'class', 'px', 'state', 'anchor', 'rect', 'whyHidden', 'text'];
        const rows = snap.candidates.map((c) => [
            c.id.length > 26 ? c.id.slice(0, 25) + '\u2026' : c.id,
            c.class,
            String(c.px),
            c.state,
            c.anchor || '—',
            c.rect ? `${Math.round(c.rect.x)},${Math.round(c.rect.y)} ${Math.round(c.rect.w)}×${Math.round(c.rect.h)}` : '—',
            c.whyHidden || '—',
            c.text.replace(/\n/g, ' '),
        ]);
        return {
            text: table(headers, rows) + `\nOK: ${snap.candidates.length} candidate(s), ${snap.placedCount} placed${snap.frozen ? ' [FROZEN]' : ''}`,
            data: snap,
        };
    };
    router.register('label.list', handleList, {
        description: 'List every map-label candidate with class, key, rect, px, state, and why hidden',
    });

    // ================================================================
    //  label.explain <id>
    // ================================================================
    const handleExplain = (args, ctx) => {
        if (args.length < 1) {
            return { text: 'ERR: usage: label.explain <id>', data: null };
        }
        const id = args[0];
        const ml = ensureMapLabels(ctx);
        const info = ml.explain(id);
        if (!info) {
            return { text: `ERR: no label candidate "${id}"`, data: null };
        }
        const lines = kvLines({
            id: info.id,
            class: `${info.class} (rank ${info.classRank}, interest ${info.interest.toFixed(2)})`,
            text: info.text,
            px: `${info.px}px (worldTitlePx: ${info.worldTitlePx != null ? info.worldTitlePx.toFixed(2) : 'none'})`,
            state: info.state,
            anchor: info.anchor || 'none',
            screen: info.screen ? `(${info.screen.x.toFixed(1)}, ${info.screen.y.toFixed(1)}) onScreen=${info.screen.onScreen}` : 'none',
            rect: info.rect ? `${Math.round(info.rect.x)},${Math.round(info.rect.y)} ${Math.round(info.rect.w)}×${Math.round(info.rect.h)}` : 'none',
            opacity: info.opacity != null ? info.opacity.toFixed(2) : '0',
            whyHidden: info.whyHidden || 'none',
            clusterId: info.clusterId || 'none',
            triedAnchors: (info.triedAnchors || []).map((t) => `${t.anchor}:${t.ok ? 'ok' : `blocked-by(${t.blockedBy})`}`).join(', ') || 'none',
        }, 14);
        return {
            text: box(`LABEL: ${info.id}`, lines, 64) + `\nOK: label.explain "${info.id}"`,
            data: info,
        };
    };
    router.register('label.explain', handleExplain, {
        description: 'Explain placement decision for a map-label candidate',
        usage: '<id>',
    });

    // ================================================================
    //  label.freeze [on|off]
    // ================================================================
    const handleFreeze = (args, ctx) => {
        const ml = ensureMapLabels(ctx);
        const arg = (args[0] || '').toLowerCase();
        let next = ml.frozen;
        if (arg === 'on' || arg === 'true' || arg === '1') next = true;
        else if (arg === 'off' || arg === 'false' || arg === '0') next = false;
        else if (!arg || arg === 'toggle') next = !ml.frozen;
        else return { text: 'ERR: usage: label.freeze [on|off]', data: null };

        ml.setFrozen(next);
        return {
            text: `OK: label.freeze ${ml.frozen ? 'on' : 'off'}`,
            data: { frozen: ml.frozen },
        };
    };
    router.register('label.freeze', handleFreeze, {
        description: 'Freeze or unfreeze map-label placement decisions',
        usage: '[on|off]',
    });

    // ================================================================
    //  carrel.card <name> [tier] [--show card|live]
    // ================================================================
    router.register('carrel.card', (args, ctx) => {
        if (args.length < 1) {
            return { text: 'ERR: usage: carrel.card <name> [256|512|1024|2048|native] [--show card|live]', data: null };
        }
        const rawName = String(args[0]).replace(/^carrel:/, '');
        const carrel = ctx.carrels?.get?.(rawName) ?? null;
        if (!carrel) {
            return { text: `ERR: no carrel "${rawName}"`, data: null };
        }

        let tier;
        let showMode = null;
        for (let i = 1; i < args.length; i++) {
            const a = String(args[i]);
            if (a === '--show' && args[i + 1]) {
                showMode = String(args[++i]).toLowerCase();
            } else if (a === 'native') {
                tier = 'native';
            } else if (/^\d+$/.test(a)) {
                tier = Number(a);
            }
        }

        const cards = ensureCarrelCards(ctx);
        const info = cards.capture(carrel, { tier, reason: 'manual' });
        if (!info) {
            return { text: `ERR: failed to capture card for "${rawName}"`, data: null };
        }
        if (showMode === 'card' || showMode === 'live') {
            cards.setDisplayMode(carrel, showMode);
            info.showing = cards.get(rawName)?.showing ?? info.showing;
        }
        return {
            text: `OK: carrel.card "${rawName}" ${info.width}×${info.height} (tier=${info.tier}, ${info.captureMs}ms, ${(info.bytes / 1024).toFixed(1)}KB, showing=${info.showing})`,
            data: info,
        };
    }, {
        description: 'Force-refresh a carrel impostor card into its WebGLRenderTarget',
        usage: '<name> [256|512|1024|2048|native] [--show card|live]',
    });

    // ================================================================
    //  card.list
    // ================================================================
    router.register('card.list', (_args, ctx) => {
        const cards = ensureCarrelCards(ctx);
        const snap = cards.list();
        if (snap.cards.length === 0) {
            return {
                text: box('CARREL CARDS', ['(no cards)'], 48) + '\nOK: 0 carrel cards',
                data: snap,
            };
        }
        const headers = ['name', 'mode', 'showing', 'tier', 'dims', 'ageMs', 'KB', 'stale', 'captureMs'];
        const rows = snap.cards.map((c) => [
            c.name,
            c.mode || '—',
            c.showing,
            String(c.tier ?? '—'),
            c.width && c.height ? `${c.width}×${c.height}` : '—',
            c.ageMs != null ? `${c.ageMs}ms` : '—',
            (c.bytes / 1024).toFixed(1),
            c.stale ? 'stale' : (c.nearLive ? 'live' : 'postcard'),
            `${c.captureMs ?? 0}ms`,
        ]);
        const mbUsed = (snap.totalBytes / (1024 * 1024)).toFixed(2);
        const mbCap = (snap.maxBytes / (1024 * 1024)).toFixed(0);
        return {
            text: table(headers, rows) + `\nOK: ${snap.cards.length} card(s), ${mbUsed} / ${mbCap} MB`,
            data: snap,
        };
    }, {
        description: 'List all carrel impostor cards with tier, age, bytes, and liveness state',
    });

    registerStripCommands(router);
}
