/**
 * Error Tracking and Handling
 *
 * Captures uncaught exceptions, promise rejections, and provides
 * structured error reporting with context.
 */

import { createLogger } from './Logger.js';
import metrics from './Metrics.js';

const log = createLogger('error-tracker');

class ErrorTracker {
    constructor() {
        this.errors = [];
        this.maxErrors = 100; // Keep last 100 errors
        this.listeners = [];
        this.isInitialized = false;
    }

    /**
     * Initialize global error handlers
     */
    init() {
        if (this.isInitialized) {
            log.warn('ErrorTracker already initialized');
            return;
        }

        // Uncaught exceptions
        window.addEventListener('error', (event) => {
            this.captureException(event.error, {
                type: 'uncaught_exception',
                filename: event.filename,
                lineno: event.lineno,
                colno: event.colno,
                message: event.message
            });

            // Prevent default browser error handling
            // (we're logging it ourselves)
            event.preventDefault();
        });

        // Unhandled promise rejections
        window.addEventListener('unhandledrejection', (event) => {
            this.captureException(event.reason, {
                type: 'unhandled_rejection',
                promise: event.promise
            });

            // Prevent default browser error handling
            event.preventDefault();
        });

        this.isInitialized = true;
        log.info('ErrorTracker initialized');
    }

    /**
     * Capture an exception with context
     * @param {Error} error - Error object
     * @param {Object} context - Additional context
     */
    captureException(error, context = {}) {
        const errorEntry = {
            timestamp: Date.now(),
            message: error?.message || String(error),
            stack: error?.stack,
            name: error?.name,
            context,
            id: this._generateErrorId()
        };

        // Store error
        this.errors.push(errorEntry);
        if (this.errors.length > this.maxErrors) {
            this.errors.shift();
        }

        // Log error
        log.error(errorEntry.message, error, context);

        // Track metric
        metrics.counter('errors.total', 1, {
            type: context.type || 'unknown',
            name: error?.name || 'unknown'
        });

        // Notify listeners
        this._emit(errorEntry);

        return errorEntry;
    }

    /**
     * Capture a message (not an Error object)
     * @param {string} message - Error message
     * @param {Object} context - Additional context
     */
    captureMessage(message, context = {}) {
        const errorEntry = {
            timestamp: Date.now(),
            message,
            stack: null,
            name: 'CapturedMessage',
            context,
            id: this._generateErrorId()
        };

        this.errors.push(errorEntry);
        if (this.errors.length > this.maxErrors) {
            this.errors.shift();
        }

        log.warn(message, context);

        metrics.counter('errors.messages', 1);

        this._emit(errorEntry);

        return errorEntry;
    }

    /**
     * Wrap a function to automatically capture errors
     * @param {Function} fn - Function to wrap
     * @param {Object} context - Context to attach to errors
     * @returns {Function} Wrapped function
     */
    wrap(fn, context = {}) {
        const tracker = this;
        return function wrappedFunction(...args) {
            try {
                const result = fn.apply(this, args);

                // Handle async functions
                if (result && typeof result.then === 'function') {
                    return result.catch(error => {
                        tracker.captureException(error, {
                            ...context,
                            function: fn.name,
                            async: true
                        });
                        throw error;
                    });
                }

                return result;
            } catch (error) {
                tracker.captureException(error, {
                    ...context,
                    function: fn.name,
                    async: false
                });
                throw error;
            }
        };
    }

    /**
     * Add breadcrumb (for debugging context)
     * @param {string} message - Breadcrumb message
     * @param {string} category - Category (e.g., 'navigation', 'user-action')
     * @param {Object} data - Additional data
     */
    addBreadcrumb(message, category = 'default', data = {}) {
        // Breadcrumbs could be stored and attached to errors
        // For now, just log them
        log.debug(`Breadcrumb [${category}]: ${message}`, data);
    }

    /**
     * Get all recorded errors
     * @param {number} limit - Max number of errors to return
     * @returns {Array} Array of error entries
     */
    getErrors(limit = null) {
        const errors = [...this.errors].reverse(); // Most recent first
        return limit ? errors.slice(0, limit) : errors;
    }

    /**
     * Get errors by type
     * @param {string} type - Error type to filter by
     * @returns {Array} Filtered error entries
     */
    getErrorsByType(type) {
        return this.errors.filter(e => e.context.type === type);
    }

    /**
     * Clear all stored errors
     */
    clearErrors() {
        this.errors = [];
        log.info('Error history cleared');
    }

    /**
     * Add a listener for error events
     * @param {Function} callback - Called with error entry
     */
    addListener(callback) {
        this.listeners.push(callback);
    }

    /**
     * Remove a listener
     */
    removeListener(callback) {
        this.listeners = this.listeners.filter(cb => cb !== callback);
    }

    /**
     * Emit error event to listeners
     */
    _emit(errorEntry) {
        this.listeners.forEach(callback => {
            try {
                callback(errorEntry);
            } catch (err) {
                console.error('ErrorTracker listener error:', err);
            }
        });
    }

    /**
     * Generate unique error ID
     */
    _generateErrorId() {
        return `err_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    /**
     * Get error statistics
     * @returns {Object} Error stats
     */
    getStats() {
        const stats = {
            total: this.errors.length,
            byType: {},
            byName: {},
            recent: this.errors.slice(-10).map(e => ({
                timestamp: e.timestamp,
                message: e.message,
                type: e.context.type
            }))
        };

        // Count by type
        this.errors.forEach(error => {
            const type = error.context.type || 'unknown';
            stats.byType[type] = (stats.byType[type] || 0) + 1;

            const name = error.name || 'unknown';
            stats.byName[name] = (stats.byName[name] || 0) + 1;
        });

        return stats;
    }
}

// Global error tracker instance
const errorTracker = new ErrorTracker();

// Auto-initialize when imported
errorTracker.init();

export { errorTracker, ErrorTracker };
export default errorTracker;
