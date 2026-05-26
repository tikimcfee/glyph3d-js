/**
 * Log Capture Utility
 *
 * Captures all log entries from registered loggers, metrics snapshots,
 * and error history. Exports to a downloadable text file for debugging.
 */

import { getAllLoggers, LogLevelNames } from './Logger.js';
import metrics from './Metrics.js';
import errorTracker from './ErrorTracker.js';

class LogCapture {
    constructor() {
        this.entries = [];
        this.isCapturing = false;
        this.maxEntries = 10000;
        this._listeners = new Map();
        this.startTime = null;
    }

    /**
     * Start capturing logs from all registered loggers
     */
    start() {
        if (this.isCapturing) return;
        this.isCapturing = true;
        this.startTime = Date.now();

        this.entries.push({
            timestamp: Date.now(),
            level: 'INFO',
            name: 'log-capture',
            message: '=== Log capture started ===',
            context: {}
        });

        // Subscribe to all existing loggers
        getAllLoggers().forEach((logger, name) => {
            this._subscribeToLogger(logger, name);
        });
    }

    /**
     * Stop capturing logs
     */
    stop() {
        if (!this.isCapturing) return;

        this.entries.push({
            timestamp: Date.now(),
            level: 'INFO',
            name: 'log-capture',
            message: '=== Log capture stopped ===',
            context: {}
        });

        this.isCapturing = false;

        // Unsubscribe from all loggers
        this._listeners.forEach((callback, loggerName) => {
            const logger = getAllLoggers().get(loggerName);
            if (logger) {
                logger.removeListener(callback);
            }
        });
        this._listeners.clear();
    }

    /**
     * Subscribe to a logger's events
     * @param {Logger} logger
     * @param {string} name
     */
    _subscribeToLogger(logger, name) {
        if (this._listeners.has(name)) return;

        const callback = (entry) => {
            if (!this.isCapturing) return;
            this.entries.push(entry);
            if (this.entries.length > this.maxEntries) {
                this.entries.shift();
            }
        };

        logger.addListener(callback);
        this._listeners.set(name, callback);
    }

    /**
     * Clear all captured entries
     */
    clear() {
        this.entries = [];
        this.startTime = null;
    }

    /**
     * Get the number of captured entries
     * @returns {number}
     */
    get count() {
        return this.entries.length;
    }

    /**
     * Export captured logs, metrics, and errors as formatted text
     * @returns {string}
     */
    exportAsText() {
        const sections = [];
        const now = new Date();
        const duration = this.startTime
            ? ((Date.now() - this.startTime) / 1000).toFixed(1)
            : '?';

        // Header
        sections.push([
            '========================================',
            '  glyph3d-js Debug Log Export',
            '========================================',
            `Exported: ${now.toISOString()}`,
            `Capture duration: ${duration}s`,
            `Log entries: ${this.entries.length}`,
            `User Agent: ${navigator.userAgent}`,
            `Window size: ${window.innerWidth}x${window.innerHeight}`,
            `Device pixel ratio: ${window.devicePixelRatio}`,
            ''
        ].join('\n'));

        // Metrics snapshot
        sections.push(this._formatMetrics());

        // Errors
        sections.push(this._formatErrors());

        // Log entries
        sections.push(this._formatLogs());

        return sections.join('\n');
    }

    /**
     * Format metrics snapshot as text
     * @returns {string}
     */
    _formatMetrics() {
        const lines = [
            '--- METRICS SNAPSHOT ---',
            ''
        ];

        const snapshot = metrics.snapshot();
        if (!snapshot || Object.keys(snapshot).length === 0) {
            lines.push('(no metrics recorded)');
        } else {
            for (const [name, data] of Object.entries(snapshot)) {
                if (data.stats) {
                    const s = data.stats;
                    lines.push(`${name}: current=${s.current} avg=${s.avg?.toFixed(2)} min=${s.min} max=${s.max} count=${s.count}`);
                } else {
                    lines.push(`${name}: ${JSON.stringify(data)}`);
                }
            }
        }

        lines.push('');
        return lines.join('\n');
    }

    /**
     * Format error history as text
     * @returns {string}
     */
    _formatErrors() {
        const lines = [
            '--- ERRORS ---',
            ''
        ];

        const errors = errorTracker.getErrors(50);
        if (errors.length === 0) {
            lines.push('(no errors captured)');
        } else {
            for (const err of errors) {
                const time = new Date(err.timestamp).toISOString();
                lines.push(`[${time}] ${err.name}: ${err.message}`);
                if (err.context?.stack) {
                    lines.push(`  Stack: ${err.context.stack.split('\n').slice(0, 3).join('\n  ')}`);
                }
                if (err.context?.type) {
                    lines.push(`  Type: ${err.context.type}`);
                }
            }
        }

        lines.push('');
        return lines.join('\n');
    }

    /**
     * Format log entries as text
     * @returns {string}
     */
    _formatLogs() {
        const lines = [
            '--- LOG ENTRIES ---',
            ''
        ];

        if (this.entries.length === 0) {
            lines.push('(no logs captured)');
        } else {
            for (const entry of this.entries) {
                const time = new Date(entry.timestamp).toISOString();
                const level = (entry.level || 'INFO').padEnd(6);
                const name = entry.name || 'unknown';
                let line = `[${time}] [${level}] [${name}] ${entry.message}`;

                if (entry.context && Object.keys(entry.context).length > 0) {
                    line += ` | ${JSON.stringify(entry.context)}`;
                }

                lines.push(line);
            }
        }

        lines.push('');
        return lines.join('\n');
    }

    /**
     * Trigger a file download of the captured logs
     * @param {string} filename - Optional filename (default: auto-generated)
     */
    download(filename) {
        const text = this.exportAsText();
        const name = filename || `glyph3d-debug-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;

        const blob = new Blob([text], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
}

// Singleton instance
const logCapture = new LogCapture();

export { logCapture, LogCapture };
export default logCapture;
