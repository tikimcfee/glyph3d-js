/**
 * Observability Module
 *
 * Central exports for all observability functionality:
 * - Structured logging
 * - Performance metrics
 * - Error tracking
 * - Debug console
 */

// Import modules for use in this file
import * as LoggerModule from './Logger.js';
import * as MetricsModule from './Metrics.js';
import * as ErrorTrackerModule from './ErrorTracker.js';
import * as DebugConsoleModule from './DebugConsole.js';
import * as LogCaptureModule from './LogCapture.js';

// Re-export from Logger
export {
    createLogger,
    getAllLoggers,
    setGlobalLogLevel,
    LogLevel,
    LogLevelNames,
    Logger,
    log
} from './Logger.js';

// Re-export from Metrics
export {
    metrics,
    Metrics,
    MetricValue,
    PerformanceMonitor
} from './Metrics.js';

// Re-export from Error Tracking
export {
    errorTracker,
    ErrorTracker
} from './ErrorTracker.js';

// Re-export from Debug Console
export {
    debugConsole,
    DebugConsole
} from './DebugConsole.js';

// Re-export from Log Capture
export {
    logCapture,
    LogCapture
} from './LogCapture.js';

// Convenience function to initialize all observability
export function initObservability(options = {}) {
    const {
        logLevel = 'INFO',
        showDebugConsole = false,
        enablePerformanceMonitoring = true
    } = options;

    // Set log level
    if (logLevel) {
        LoggerModule.setGlobalLogLevel(logLevel);
    }

    // Initialize debug console
    DebugConsoleModule.debugConsole.init();

    if (showDebugConsole) {
        DebugConsoleModule.debugConsole.show();
    }

    // Enable performance monitoring
    if (enablePerformanceMonitoring) {
        const perfMonitor = new MetricsModule.PerformanceMonitor(MetricsModule.metrics);
        perfMonitor.monitorLongTasks();
        perfMonitor.monitorResources();
        perfMonitor.monitorMemory();
    }

    return {
        debugConsole: DebugConsoleModule.debugConsole,
        metrics: MetricsModule.metrics,
        errorTracker: ErrorTrackerModule.errorTracker,
        logCapture: LogCaptureModule.logCapture,
        createLogger: LoggerModule.createLogger
    };
}

// Default export
export default {
    createLogger: LoggerModule.createLogger,
    metrics: MetricsModule.metrics,
    errorTracker: ErrorTrackerModule.errorTracker,
    debugConsole: DebugConsoleModule.debugConsole,
    logCapture: LogCaptureModule.logCapture,
    initObservability
};
