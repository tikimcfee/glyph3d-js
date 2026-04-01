/**
 * StateController -- namespaced localStorage persistence.
 *
 * Each key maps to exactly one localStorage entry: `g3d.{key}`.
 * No in-memory blob. No ghost-state. Reads always hit storage.
 *
 * Dispatches a `state-changed` CustomEvent on every `set()` / `delete()` /
 * `clearNamespace()` / `clearAll()` so UI panels can refresh without polling.
 */

const PREFIX = 'g3d.';

export class StateController {
    /**
     * Read a value by namespaced key.
     * @param {string} key -- e.g. 'camera.position', 'repo.url'
     * @param {*} [fallback] -- returned if key is absent or corrupt
     * @returns {*}
     */
    get(key, fallback = undefined) {
        try {
            const raw = localStorage.getItem(PREFIX + key);
            return raw !== null ? JSON.parse(raw) : fallback;
        } catch {
            return fallback;
        }
    }

    /**
     * Write a value by namespaced key.
     * Dispatches `state-changed` event for live UI updates.
     * @param {string} key
     * @param {*} value -- must be JSON-serializable
     */
    set(key, value) {
        try {
            localStorage.setItem(PREFIX + key, JSON.stringify(value));
            window.dispatchEvent(new CustomEvent('state-changed'));
        } catch { /* quota / private mode */ }
    }

    /**
     * Delete a single key.
     * @param {string} key
     */
    delete(key) {
        localStorage.removeItem(PREFIX + key);
        window.dispatchEvent(new CustomEvent('state-changed'));
    }

    /**
     * Delete all keys under a namespace prefix.
     * clearNamespace('camera') removes camera.position, camera.speed, etc.
     * @param {string} ns
     */
    clearNamespace(ns) {
        const target = PREFIX + ns + '.';
        const exact = PREFIX + ns;
        const toRemove = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k === exact || k.startsWith(target)) toRemove.push(k);
        }
        toRemove.forEach(k => localStorage.removeItem(k));
        if (toRemove.length > 0) {
            window.dispatchEvent(new CustomEvent('state-changed'));
        }
    }

    /**
     * Delete every g3d.* key.
     */
    clearAll() {
        const toRemove = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k.startsWith(PREFIX)) toRemove.push(k);
        }
        toRemove.forEach(k => localStorage.removeItem(k));
        if (toRemove.length > 0) {
            window.dispatchEvent(new CustomEvent('state-changed'));
        }
    }

    /**
     * List all g3d.* keys (without prefix).
     * @returns {string[]}
     */
    listAll() {
        const keys = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k.startsWith(PREFIX)) keys.push(k.slice(PREFIX.length));
        }
        return keys.sort();
    }

    /**
     * List all keys (without prefix) under a namespace.
     * @param {string} ns
     * @returns {string[]}
     */
    listNamespace(ns) {
        const target = PREFIX + ns + '.';
        const keys = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k.startsWith(target)) keys.push(k.slice(PREFIX.length));
        }
        return keys.sort();
    }

    /**
     * Read all keys under a namespace as a flat object.
     * getNamespace('camera') -> { 'camera.position': {...}, 'camera.speed': 100, ... }
     * @param {string} ns
     * @returns {Object}
     */
    getNamespace(ns) {
        const target = PREFIX + ns + '.';
        const result = {};
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k.startsWith(target)) {
                try {
                    result[k.slice(PREFIX.length)] = JSON.parse(localStorage.getItem(k));
                } catch { /* skip corrupt */ }
            }
        }
        return result;
    }
}

/** Singleton instance -- import this everywhere. */
export const stateController = new StateController();
