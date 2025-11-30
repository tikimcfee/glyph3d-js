/**
 * Metrics Collection and Tracking
 *
 * Provides performance monitoring, metric aggregation, and statistics.
 * Supports counters, gauges, histograms, and timing measurements.
 */

class MetricValue {
    constructor(name, type, tags = {}) {
        this.name = name;
        this.type = type;
        this.tags = tags;
        this.values = [];
        this.lastValue = null;
        this.lastUpdated = null;
    }

    record(value) {
        this.lastValue = value;
        this.lastUpdated = Date.now();
        this.values.push({ value, timestamp: this.lastUpdated });

        // Keep only last 1000 values to prevent memory leak
        if (this.values.length > 1000) {
            this.values.shift();
        }
    }

    getStats() {
        if (this.values.length === 0) {
            return null;
        }

        const values = this.values.map(v => v.value);
        const sum = values.reduce((a, b) => a + b, 0);
        const avg = sum / values.length;
        const min = Math.min(...values);
        const max = Math.max(...values);

        // Calculate percentiles (p50, p95, p99)
        const sorted = [...values].sort((a, b) => a - b);
        const p50 = sorted[Math.floor(sorted.length * 0.5)];
        const p95 = sorted[Math.floor(sorted.length * 0.95)];
        const p99 = sorted[Math.floor(sorted.length * 0.99)];

        return {
            count: values.length,
            sum,
            avg,
            min,
            max,
            p50,
            p95,
            p99,
            current: this.lastValue,
            lastUpdated: this.lastUpdated
        };
    }
}

class Metrics {
    constructor() {
        this.metrics = new Map();
        this.listeners = [];
    }

    /**
     * Get or create a metric
     */
    _getMetric(name, type, tags = {}) {
        const key = `${name}:${JSON.stringify(tags)}`;
        if (!this.metrics.has(key)) {
            this.metrics.set(key, new MetricValue(name, type, tags));
        }
        return this.metrics.get(key);
    }

    /**
     * Emit metric event to listeners
     */
    _emit(metric, value) {
        this.listeners.forEach(callback => {
            try {
                callback({
                    name: metric.name,
                    type: metric.type,
                    value,
                    tags: metric.tags,
                    timestamp: Date.now()
                });
            } catch (err) {
                console.error('Metrics listener error:', err);
            }
        });
    }

    /**
     * Add a listener for metric events
     * @param {Function} callback - Called with metric event object
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
     * Increment a counter metric
     * @param {string} name - Metric name
     * @param {number} value - Amount to increment (default: 1)
     * @param {Object} tags - Additional tags
     */
    counter(name, value = 1, tags = {}) {
        const metric = this._getMetric(name, 'counter', tags);
        const newValue = (metric.lastValue || 0) + value;
        metric.record(newValue);
        this._emit(metric, newValue);
    }

    /**
     * Set a gauge metric (current value)
     * @param {string} name - Metric name
     * @param {number} value - Current value
     * @param {Object} tags - Additional tags
     */
    gauge(name, value, tags = {}) {
        const metric = this._getMetric(name, 'gauge', tags);
        metric.record(value);
        this._emit(metric, value);
    }

    /**
     * Record a histogram value (for distributions)
     * @param {string} name - Metric name
     * @param {number} value - Value to record
     * @param {Object} tags - Additional tags
     */
    histogram(name, value, tags = {}) {
        const metric = this._getMetric(name, 'histogram', tags);
        metric.record(value);
        this._emit(metric, value);
    }

    /**
     * Record a timing measurement
     * @param {string} name - Metric name
     * @param {number} duration - Duration in milliseconds
     * @param {Object} tags - Additional tags
     */
    timing(name, duration, tags = {}) {
        const metric = this._getMetric(name, 'timing', tags);
        metric.record(duration);
        this._emit(metric, duration);
    }

    /**
     * Start a timer for an operation
     * @param {string} name - Operation name
     * @param {Object} tags - Additional tags
     * @returns {Object} Timer object with stop() method
     */
    startTimer(name, tags = {}) {
        const startTime = performance.now();
        const metrics = this;

        return {
            stop() {
                const duration = performance.now() - startTime;
                metrics.timing(name, duration, tags);
                return duration;
            }
        };
    }

    /**
     * Record FPS (frames per second)
     * Convenience method that also tracks frame timing
     * @param {number} fps - Current FPS value
     */
    recordFPS(fps) {
        this.gauge('render.fps', fps);

        // Also record as frame time (ms per frame)
        const frameTime = 1000 / fps;
        this.timing('render.frame_time', frameTime);
    }

    /**
     * Get statistics for a specific metric
     * @param {string} name - Metric name
     * @param {Object} tags - Metric tags (optional)
     * @returns {Object} Statistics object or null
     */
    getStats(name, tags = {}) {
        const key = `${name}:${JSON.stringify(tags)}`;
        const metric = this.metrics.get(key);
        return metric ? metric.getStats() : null;
    }

    /**
     * Get all metrics
     * @returns {Array} Array of metric objects with stats
     */
    getAllMetrics() {
        const result = [];
        this.metrics.forEach((metric, key) => {
            result.push({
                name: metric.name,
                type: metric.type,
                tags: metric.tags,
                stats: metric.getStats()
            });
        });
        return result;
    }

    /**
     * Get metrics by name pattern
     * @param {string|RegExp} pattern - Name pattern to match
     * @returns {Array} Array of matching metrics
     */
    getMetricsByPattern(pattern) {
        const regex = typeof pattern === 'string'
            ? new RegExp(pattern)
            : pattern;

        return this.getAllMetrics().filter(m => regex.test(m.name));
    }

    /**
     * Reset a specific metric
     * @param {string} name - Metric name
     * @param {Object} tags - Metric tags (optional)
     */
    reset(name, tags = {}) {
        const key = `${name}:${JSON.stringify(tags)}`;
        this.metrics.delete(key);
    }

    /**
     * Reset all metrics
     */
    resetAll() {
        this.metrics.clear();
    }

    /**
     * Create a snapshot of current metrics
     * @returns {Object} Snapshot object with all metric stats
     */
    snapshot() {
        const snapshot = {
            timestamp: Date.now(),
            metrics: {}
        };

        this.metrics.forEach((metric, key) => {
            snapshot.metrics[key] = {
                name: metric.name,
                type: metric.type,
                tags: metric.tags,
                stats: metric.getStats()
            };
        });

        return snapshot;
    }
}

// Performance monitoring helpers
export class PerformanceMonitor {
    constructor(metrics) {
        this.metrics = metrics;
        this.observers = [];
    }

    /**
     * Monitor long tasks (> 50ms)
     */
    monitorLongTasks() {
        if ('PerformanceObserver' in window) {
            try {
                const observer = new PerformanceObserver((list) => {
                    for (const entry of list.getEntries()) {
                        this.metrics.timing('performance.long_task', entry.duration, {
                            name: entry.name
                        });
                    }
                });
                observer.observe({ entryTypes: ['longtask'] });
                this.observers.push(observer);
            } catch (err) {
                console.warn('Long task monitoring not supported:', err);
            }
        }
    }

    /**
     * Monitor resource loading
     */
    monitorResources() {
        if ('PerformanceObserver' in window) {
            try {
                const observer = new PerformanceObserver((list) => {
                    for (const entry of list.getEntries()) {
                        this.metrics.timing('performance.resource_load', entry.duration, {
                            name: entry.name,
                            type: entry.initiatorType
                        });
                    }
                });
                observer.observe({ entryTypes: ['resource'] });
                this.observers.push(observer);
            } catch (err) {
                console.warn('Resource monitoring not supported:', err);
            }
        }
    }

    /**
     * Monitor memory usage (Chrome only)
     * @param {number} interval - Sampling interval in ms (default: 5000)
     */
    monitorMemory(interval = 5000) {
        if (performance.memory) {
            const checkMemory = () => {
                this.metrics.gauge('performance.memory.used',
                    performance.memory.usedJSHeapSize);
                this.metrics.gauge('performance.memory.total',
                    performance.memory.totalJSHeapSize);
                this.metrics.gauge('performance.memory.limit',
                    performance.memory.jsHeapSizeLimit);
            };

            checkMemory();
            this.memoryInterval = setInterval(checkMemory, interval);
        }
    }

    /**
     * Stop all monitoring
     */
    stop() {
        this.observers.forEach(observer => observer.disconnect());
        this.observers = [];
        if (this.memoryInterval) {
            clearInterval(this.memoryInterval);
        }
    }
}

// Global metrics instance
const metrics = new Metrics();

export { metrics, Metrics, MetricValue };
export default metrics;
