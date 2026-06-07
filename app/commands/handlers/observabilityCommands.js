/**
 * Observability commands — log / error / metric as first-class verbs.
 *
 * Step 1 of the observability direction: thin command-bus wrappers over the existing
 * Logger / Metrics / ErrorTracker, so the same telemetry the app produces is queryable
 * through the bus (CLI + UI + relay + test harness, one source of truth). "Error-fetching
 * as a command" generalized. No new data model, no deps — spans/correlation come later.
 *
 * The dispatcher (CommandRouter._run) already routes handler throws into ErrorTracker, so
 * error.list surfaces the bus's own failures; the test harness reads it as its backstop.
 */

import errorTracker from '@glyph3d/core/utils/ErrorTracker.js';
import metrics from '@glyph3d/core/utils/Metrics.js';
import { setGlobalLogLevel, getAllLoggers } from '@glyph3d/core/utils/Logger.js';
import { recentConsole } from '@glyph3d/core/services/orchestration/consoleForwarder.js';

/**
 * @param {import('@glyph3d/core/services/orchestration/CommandRouter.js').default} router
 */
export default function registerObservabilityCommands(router) {
    // ── error.* — the structured error buffer (ErrorTracker) ──
    router.register('error.list', (args) => {
        const n = args[0] ? Number(args[0]) : 20;
        const errors = errorTracker.getErrors(n);
        return { text: errors.length ? `${errors.length} error(s)` : 'no errors', data: { errors } };
    }, { description: 'List recent captured errors (most recent first)', usage: '[count]', returns: '{errors}' });

    router.register('error.clear', () => {
        errorTracker.clearErrors();
        return { text: 'OK: errors cleared', data: null };
    }, { description: 'Clear the captured-error buffer' });

    router.register('error.stats', () => {
        const stats = errorTracker.getStats();
        const types = Object.keys(stats.byType);
        return { text: `${stats.total} error(s); types: ${types.join(', ') || 'none'}`, data: stats };
    }, { description: 'Error counts by type/name', returns: '{total,byType,byName,recent}' });

    // ── log.* — runtime verbosity + the log ring ──
    router.register('log.tail', (args) => {
        const n = args[0] ? Number(args[0]) : 30;
        const entries = recentConsole(n);
        return { text: `${entries.length} log line(s)`, data: { entries } };
    }, { description: 'Tail recent console output (all levels) from the single capture ring', usage: '[count]', returns: '{entries}' });

    router.register('log.level', (args) => {
        const level = args[0];
        if (!level) {
            const levels = [...getAllLoggers().entries()].map(([name, l]) => `${name}=${l.minLevel}`);
            return { text: 'usage: log.level <TRACE|DEBUG|INFO|WARN|ERROR> [scope]', data: { levels } };
        }
        const scope = args[1];
        if (scope) {
            const logger = getAllLoggers().get(scope);
            if (!logger) return { text: `ERR: no logger '${scope}'`, data: null };
            logger.setLevel(level);
            return { text: `OK: ${scope} → ${level.toUpperCase()}`, data: null };
        }
        setGlobalLogLevel(level);
        return { text: `OK: all loggers → ${level.toUpperCase()}`, data: null };
    }, { description: 'Get or set log verbosity, globally or per scope', usage: '<level> [scope]' });

    // ── metric.* — the metrics registry ──
    router.register('metric.list', (args) => {
        const pattern = args[0];
        const all = pattern ? metrics.getMetricsByPattern(pattern) : metrics.getAllMetrics();
        return { text: `${all.length} metric(s)`, data: { metrics: all } };
    }, { description: 'List metrics (optionally by name pattern) with stats', usage: '[pattern]', returns: '{metrics}' });

    router.register('metric.get', (args) => {
        if (!args[0]) return { text: 'ERR: usage: metric.get <name>', data: null };
        const stats = metrics.getStats(args[0]);
        if (!stats) return { text: `ERR: no metric '${args[0]}'`, data: null };
        return { text: `${args[0]}: current=${stats.current} avg=${stats.avg?.toFixed?.(2)} count=${stats.count}`, data: stats };
    }, { description: 'Stats for one metric (no-tag series)', usage: '<name>', returns: 'stats' });
}
