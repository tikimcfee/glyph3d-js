/**
 * Structured Logger
 *
 * Provides hierarchical, scoped logging with multiple severity levels.
 * Supports context enrichment and filtering by log level.
 */

const LogLevel = {
    TRACE: 0,
    DEBUG: 1,
    INFO: 2,
    WARN: 3,
    ERROR: 4,
    METRIC: 5
};

const LogLevelNames = {
    0: 'TRACE',
    1: 'DEBUG',
    2: 'INFO',
    3: 'WARN',
    4: 'ERROR',
    5: 'METRIC'
};

class Logger {
    /**
     * Create a new Logger instance
     * @param {string} name - Logger name (e.g., 'renderer', 'graph-builder')
     * @param {Logger} parent - Parent logger (for hierarchical naming)
     * @param {number} minLevel - Minimum log level to display (default: DEBUG)
     */
    constructor(name, parent = null, minLevel = LogLevel.INFO) {
        this.name = name;
        this.parent = parent;
        this.minLevel = minLevel;
        this.fullName = parent ? `${parent.fullName}.${name}` : name;

        // Listeners for log events (used by DebugConsole)
        this.listeners = [];
    }

    /**
     * Set minimum log level
     * @param {number|string} level - LogLevel enum value or string name
     */
    setLevel(level) {
        if (typeof level === 'string') {
            const levelName = level.toUpperCase();
            // Find the numeric key for this level name, convert to number
            const foundKey = Object.keys(LogLevelNames).find(
                key => LogLevelNames[key] === levelName
            );
            this.minLevel = foundKey !== undefined ? parseInt(foundKey, 10) : LogLevel.DEBUG;
        } else {
            this.minLevel = level;
        }
    }

    /**
     * Add a listener for log events
     * @param {Function} callback - Called with (level, message, context)
     */
    addListener(callback) {
        this.listeners.push(callback);
    }

    /**
     * Remove a listener
     * @param {Function} callback - The callback to remove
     */
    removeListener(callback) {
        this.listeners = this.listeners.filter(cb => cb !== callback);
    }

    /**
     * Emit log event to listeners
     */
    _emit(level, message, context) {
        const logEntry = {
            timestamp: Date.now(),
            level: LogLevelNames[level],
            name: this.fullName,
            message,
            context
        };

        this.listeners.forEach(callback => {
            try {
                callback(logEntry);
            } catch (err) {
                console.error('Logger listener error:', err);
            }
        });

        // Propagate to parent
        if (this.parent) {
            this.parent._emit(level, message, context);
        }
    }

    /**
     * Internal log method
     */
    _log(level, message, context = {}) {
        if (level < this.minLevel) {
            return;
        }

        const timestamp = new Date().toISOString().substr(11, 12);
        const levelName = LogLevelNames[level];
        const prefix = `[${timestamp}] [${levelName}] [${this.fullName}]`;

        // Emit to listeners first
        this._emit(level, message, context);

        // Console output with appropriate method
        const hasContext = Object.keys(context).length > 0;

        switch (level) {
            case LogLevel.TRACE:
                if (hasContext) {
                    console.debug(prefix, message, context);
                } else {
                    console.debug(prefix, message);
                }
                break;
            case LogLevel.DEBUG:
                if (hasContext) {
                    console.debug(prefix, message, context);
                } else {
                    console.debug(prefix, message);
                }
                break;
            case LogLevel.INFO:
                if (hasContext) {
                    console.info(prefix, message, context);
                } else {
                    console.info(prefix, message);
                }
                break;
            case LogLevel.WARN:
                if (hasContext) {
                    console.warn(prefix, message, context);
                } else {
                    console.warn(prefix, message);
                }
                break;
            case LogLevel.ERROR:
                if (hasContext) {
                    console.error(prefix, message, context);
                } else {
                    console.error(prefix, message);
                }
                break;
            case LogLevel.METRIC:
                if (hasContext) {
                    console.log(prefix, message, context);
                } else {
                    console.log(prefix, message);
                }
                break;
        }
    }

    /**
     * Log trace message (per-object, per-frame, per-batch details)
     * @param {string} message - Log message
     * @param {Object} context - Additional context data
     */
    trace(message, context = {}) {
        this._log(LogLevel.TRACE, message, context);
    }

    /**
     * Log debug message (subsystem lifecycle, phase timing)
     * @param {string} message - Log message
     * @param {Object} context - Additional context data
     */
    debug(message, context = {}) {
        this._log(LogLevel.DEBUG, message, context);
    }

    /**
     * Log informational message (normal operation)
     * @param {string} message - Log message
     * @param {Object} context - Additional context data
     */
    info(message, context = {}) {
        this._log(LogLevel.INFO, message, context);
    }

    /**
     * Log warning (something unexpected but handled)
     * @param {string} message - Log message
     * @param {Object} context - Additional context data
     */
    warn(message, context = {}) {
        this._log(LogLevel.WARN, message, context);
    }

    /**
     * Log error (something went wrong)
     * @param {string} message - Log message
     * @param {Error} error - Error object (optional)
     * @param {Object} context - Additional context data
     */
    error(message, error = null, context = {}) {
        const errorContext = { ...context };

        if (error) {
            errorContext.error = {
                message: error.message,
                stack: error.stack,
                name: error.name
            };
        }

        this._log(LogLevel.ERROR, message, errorContext);
    }

    /**
     * Log metric/performance data
     * @param {string} name - Metric name
     * @param {number|Object} value - Metric value or object with multiple values
     * @param {Object} tags - Additional tags for categorization
     */
    metric(name, value, tags = {}) {
        const context = {
            metric: name,
            value,
            ...tags
        };

        this._log(LogLevel.METRIC, `Metric: ${name}`, context);
    }

    /**
     * Create a child logger with scoped name
     * @param {string} childName - Name for the child logger
     * @returns {Logger} New child logger instance
     */
    createChild(childName) {
        return new Logger(childName, this, this.minLevel);
    }

    /**
     * Create a performance timer for a specific operation
     * @param {string} operationName - Name of the operation to time
     * @returns {Object} Timer object with stop() method
     */
    startTimer(operationName) {
        const startTime = performance.now();
        const logger = this;

        return {
            stop() {
                const duration = performance.now() - startTime;
                logger.metric(`${operationName}.duration`, duration, {
                    unit: 'ms'
                });
                return duration;
            }
        };
    }
}

// Global logger registry
const loggers = new Map();

/**
 * Create or retrieve a logger by name
 * @param {string} name - Logger name
 * @param {number} minLevel - Minimum log level (optional)
 * @returns {Logger} Logger instance
 */
export function createLogger(name, minLevel = LogLevel.INFO) {
    if (!loggers.has(name)) {
        loggers.set(name, new Logger(name, null, minLevel));
    }
    return loggers.get(name);
}

/**
 * Get all registered loggers
 * @returns {Map} Map of logger names to instances
 */
export function getAllLoggers() {
    return loggers;
}

/**
 * Set global minimum log level for all loggers
 * @param {number|string} level - LogLevel enum or string name
 */
export function setGlobalLogLevel(level) {
    loggers.forEach(logger => logger.setLevel(level));
}

// Export LogLevel for use by consumers
export { LogLevel, LogLevelNames, Logger };

// Create default app logger
export const log = createLogger('app');

export default Logger;
