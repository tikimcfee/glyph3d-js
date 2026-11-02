/**
 * FileWatch — an open file follows its file on disk, whoever changed it.
 *
 * An agent's Edit/Write lands from the event's own text (AgentEdits); a change that carries no
 * text — a shell's `sed`, a formatter, a build, a `git checkout` — reaches the display through the
 * relay's file watcher (cli/fs_watch.go): this keeps `fs/watch` in step with the code grids that are
 * open (registry ids are their paths), re-subscribes after a reconnect (the relay drops a display's
 * subscriptions when it goes), and lands each `fs/changed` through the same anchor-holding swap
 * (landFileText): the line you're reading keeps its screen row; a grid you're editing (a caret, or
 * unsaved edits) is never overwritten; an unchanged text is a no-op (an agent edit that already
 * landed, our own file.save). Settings ▸ Files `files.followDisk` turns it off.
 */

import { landFileText } from './AgentEdits.js';
import { getSetting } from './settings.js';

/** An open file's grid: a registered code grid whose id is an absolute path. */
const isOpenFile = (e) => e?.type === 'grid' && typeof e.id === 'string' && e.id.startsWith('/') && typeof e.grid?.loadText === 'function';

export default class FileWatch {
    /** @param {Object} ctx AppContext (registry, fileProvider…) @param {Object} bridge WebSocketBridge */
    constructor(ctx, bridge) {
        this.ctx = ctx;
        this.bridge = bridge;
        /** @type {Set<string>} paths the relay is watching for us */
        this.watched = new Set();
        this._sync = () => { this.sync().catch((e) => console.warn('[files] watch sync failed —', e?.message || e)); };
        this._offNote = bridge.onRpcNotification?.((method, params) => {
            if (method === 'fs/changed') this._changed(params?.paths);
        }) ?? null;
        ctx.registry?.addChangeListener?.(this._sync);
        this.landed = 0;
    }

    /** The relay (re)connected: it holds no subscriptions of ours — send them all again. */
    reconnect() {
        this.watched.clear();
        this._sync();
    }

    /** Bring the relay's subscriptions in step with the open files. */
    async sync() {
        if (!this.bridge?.connected) return;
        const want = new Set();
        if (getSetting('files.followDisk') !== false) {
            for (const e of this.ctx.registry?.list?.() ?? []) if (isOpenFile(e)) want.add(e.id);
        }
        const add = [...want].filter((p) => !this.watched.has(p));
        const drop = [...this.watched].filter((p) => !want.has(p));
        if (!add.length && !drop.length) return;
        for (const p of add) this.watched.add(p);
        for (const p of drop) this.watched.delete(p);
        if (add.length) await this.bridge.rpcRequest('fs/watch', { paths: add });
        if (drop.length) await this.bridge.rpcRequest('fs/unwatch', { paths: drop });
    }

    /** @private */
    async _changed(paths) {
        if (!Array.isArray(paths) || getSetting('files.followDisk') === false) return;
        for (const p of paths) {
            if (!this.watched.has(p)) continue;
            try {
                const r = await landFileText(this.ctx, p, null, 'a change on disk');
                if (r) this.landed++;
            } catch (e) { console.warn(`[files] ${p}: following the change on disk failed —`, e?.message || e); }
        }
    }

    dispose() {
        this._offNote?.();
        this.ctx.registry?.removeChangeListener?.(this._sync);
    }
}
