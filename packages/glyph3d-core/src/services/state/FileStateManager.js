/**
 * FileStateManager — per-file metadata registry
 *
 * Central registry keyed by sourcePath. Providers (HeatmapProvider, etc.)
 * WRITE properties; visual managers (CodeColorManager) READ and react
 * via internal callbacks.
 *
 * Internal callbacks (not window events) because this is a data→visual
 * pipeline, not UI coordination. Callbacks avoid DOM bubbling overhead
 * and are testable without a browser global.
 *
 * Dispose chain: dispose() forcibly clears all listeners as a safety net.
 * Consumers should still call offPropertyChanged() in their own dispose()
 * for clean semantics.
 */

export class FileStateManager {
    constructor() {
        /** @type {Map<string, Map<string, *>>} sourcePath → propName → value */
        this._state = new Map();

        /** @type {Set<Function>} Callbacks: (sourcePath, propName, newValue, oldValue) => void */
        this._listeners = new Set();
    }

    /**
     * Set a single property for a file. Fires callbacks if value changed.
     * @param {string} sourcePath
     * @param {string} propName
     * @param {*} value
     */
    setProperty(sourcePath, propName, value) {
        let fileProps = this._state.get(sourcePath);
        if (!fileProps) {
            fileProps = new Map();
            this._state.set(sourcePath, fileProps);
        }

        const oldValue = fileProps.get(propName);
        if (oldValue === value) return;

        fileProps.set(propName, value);
        this._notify(sourcePath, propName, value, oldValue);
    }

    /**
     * Get a single property for a file.
     * @param {string} sourcePath
     * @param {string} propName
     * @returns {*} value, or undefined if not set
     */
    getProperty(sourcePath, propName) {
        const fileProps = this._state.get(sourcePath);
        return fileProps ? fileProps.get(propName) : undefined;
    }

    /**
     * Get all properties for a file as a plain object.
     * @param {string} sourcePath
     * @returns {Object|null} { propName: value, ... } or null
     */
    getProperties(sourcePath) {
        const fileProps = this._state.get(sourcePath);
        if (!fileProps) return null;

        const result = {};
        for (const [k, v] of fileProps) {
            result[k] = v;
        }
        return result;
    }

    /**
     * Batch-set properties for multiple files. Fires callbacks per changed property.
     * @param {Map<string, Object>} updates - Map<sourcePath, { propName: value }>
     */
    batchSetProperties(updates) {
        for (const [sourcePath, props] of updates) {
            for (const [propName, value] of Object.entries(props)) {
                this.setProperty(sourcePath, propName, value);
            }
        }
    }

    /**
     * Subscribe to property changes.
     * @param {Function} callback - (sourcePath, propName, newValue, oldValue) => void
     */
    onPropertyChanged(callback) {
        this._listeners.add(callback);
    }

    /**
     * Unsubscribe from property changes.
     * @param {Function} callback
     */
    offPropertyChanged(callback) {
        this._listeners.delete(callback);
    }

    /**
     * Wipe all data but keep listeners. Called on repo change.
     */
    clear() {
        this._state.clear();
    }

    /**
     * Nuclear cleanup — clear ALL listeners AND data.
     */
    dispose() {
        this._state.clear();
        this._listeners.clear();
    }

    // ============ Private ============

    /** @private */
    _notify(sourcePath, propName, newValue, oldValue) {
        for (const cb of this._listeners) {
            try {
                cb(sourcePath, propName, newValue, oldValue);
            } catch (err) {
                console.error('FileStateManager listener error:', err);
            }
        }
    }
}

export default FileStateManager;
