/**
 * Debug Console Overlay
 *
 * In-browser debug console showing real-time metrics, logs, and errors.
 * Toggleable with keyboard shortcut (~) or F12.
 */

import { createLogger, getAllLoggers } from './Logger.js';
import metrics from './Metrics.js';
import errorTracker from './ErrorTracker.js';

const log = createLogger('debug-console');

class DebugConsole {
    constructor() {
        this.isVisible = false;
        this.isMinimized = true;
        this.activeTab = 'fps';
        this.container = null;
        this.panels = new Map();

        // Log buffer for display
        this.logBuffer = [];
        this.maxLogEntries = 100;
    }

    /**
     * Initialize the debug console
     */
    init() {
        log.info('Initializing debug console');

        // Create DOM structure
        this._createDOM();

        // Register keyboard shortcuts
        this._registerKeyboardShortcuts();

        // Setup built-in panels
        this._setupBuiltInPanels();

        // Subscribe to observability events
        this._subscribeToEvents();

        // Start update loop
        this._startUpdateLoop();

        log.info('Debug console initialized (press ~ to toggle)');
    }

    /**
     * Create DOM structure
     */
    _createDOM() {
        // Container
        this.container = document.createElement('div');
        this.container.id = 'debug-console';
        this.container.className = 'debug-console minimized';
        this.container.innerHTML = `
            <div class="debug-console-header">
                <span class="title">Debug Console</span>
                <div class="controls">
                    <button class="btn-minimize" title="Toggle minimize">_</button>
                    <button class="btn-close" title="Close">×</button>
                </div>
            </div>
            <div class="debug-console-tabs">
                <button class="tab-btn active" data-tab="fps">FPS</button>
                <button class="tab-btn" data-tab="metrics">Metrics</button>
                <button class="tab-btn" data-tab="logs">Logs</button>
                <button class="tab-btn" data-tab="errors">Errors</button>
            </div>
            <div class="debug-console-content">
                <div class="panel" id="panel-fps"></div>
                <div class="panel" id="panel-metrics"></div>
                <div class="panel" id="panel-logs"></div>
                <div class="panel" id="panel-errors"></div>
            </div>
        `;

        // Add styles
        this._injectStyles();

        // Add to document
        document.body.appendChild(this.container);

        // Wire up events
        this._wireUpEvents();
    }

    /**
     * Inject CSS styles
     */
    _injectStyles() {
        const style = document.createElement('style');
        style.textContent = `
            .debug-console {
                position: fixed;
                top: 10px;
                right: 10px;
                background: rgba(0, 0, 0, 0.9);
                color: #0f0;
                font-family: 'Monaco', 'Menlo', 'Courier New', monospace;
                font-size: 12px;
                border: 1px solid #0f0;
                border-radius: 4px;
                z-index: 10000;
                min-width: 200px;
                max-width: 600px;
                max-height: 80vh;
                overflow: hidden;
                display: none;
                flex-direction: column;
                box-shadow: 0 4px 12px rgba(0, 255, 0, 0.3);
            }

            .debug-console.visible {
                display: flex;
            }

            .debug-console.minimized .debug-console-tabs,
            .debug-console.minimized .debug-console-content {
                display: none;
            }

            .debug-console.minimized {
                min-width: 150px;
                max-width: 200px;
            }

            .debug-console-header {
                padding: 8px 12px;
                background: rgba(0, 50, 0, 0.8);
                border-bottom: 1px solid #0f0;
                display: flex;
                justify-content: space-between;
                align-items: center;
                cursor: move;
                user-select: none;
            }

            .debug-console-header .title {
                font-weight: bold;
                font-size: 14px;
            }

            .debug-console-header .controls {
                display: flex;
                gap: 8px;
            }

            .debug-console-header button {
                background: none;
                border: 1px solid #0f0;
                color: #0f0;
                cursor: pointer;
                width: 24px;
                height: 24px;
                border-radius: 2px;
                font-size: 16px;
                line-height: 1;
                padding: 0;
                transition: background 0.2s;
            }

            .debug-console-header button:hover {
                background: rgba(0, 255, 0, 0.2);
            }

            .debug-console-tabs {
                display: flex;
                background: rgba(0, 30, 0, 0.8);
                border-bottom: 1px solid #0f0;
            }

            .debug-console-tabs .tab-btn {
                flex: 1;
                background: none;
                border: none;
                color: #0a0;
                padding: 8px;
                cursor: pointer;
                transition: all 0.2s;
                border-right: 1px solid #050;
            }

            .debug-console-tabs .tab-btn:last-child {
                border-right: none;
            }

            .debug-console-tabs .tab-btn:hover {
                background: rgba(0, 255, 0, 0.1);
                color: #0f0;
            }

            .debug-console-tabs .tab-btn.active {
                background: rgba(0, 255, 0, 0.2);
                color: #0f0;
                font-weight: bold;
            }

            .debug-console-content {
                flex: 1;
                overflow-y: auto;
                padding: 12px;
                min-height: 200px;
            }

            .debug-console-content .panel {
                display: none;
            }

            .debug-console-content .panel.active {
                display: block;
            }

            .metric-row {
                display: flex;
                justify-content: space-between;
                padding: 4px 0;
                border-bottom: 1px solid #030;
            }

            .metric-row:last-child {
                border-bottom: none;
            }

            .metric-label {
                color: #0a0;
            }

            .metric-value {
                color: #0f0;
                font-weight: bold;
            }

            .log-entry {
                padding: 4px 8px;
                margin: 2px 0;
                border-left: 3px solid;
                font-size: 11px;
                overflow-x: auto;
            }

            .log-entry.DEBUG { border-color: #555; color: #aaa; }
            .log-entry.INFO { border-color: #0a0; color: #0f0; }
            .log-entry.WARN { border-color: #aa0; color: #ff0; }
            .log-entry.ERROR { border-color: #a00; color: #f00; }
            .log-entry.METRIC { border-color: #00a; color: #0af; }

            .log-timestamp {
                color: #666;
                font-size: 10px;
            }

            .log-name {
                color: #0a0;
                font-weight: bold;
            }

            .error-entry {
                padding: 8px;
                margin: 4px 0;
                background: rgba(150, 0, 0, 0.2);
                border-left: 3px solid #f00;
                font-size: 11px;
            }

            .error-message {
                color: #f00;
                font-weight: bold;
                margin-bottom: 4px;
            }

            .error-context {
                color: #aaa;
                font-size: 10px;
            }

            /* Scrollbar styling */
            .debug-console-content::-webkit-scrollbar {
                width: 8px;
            }

            .debug-console-content::-webkit-scrollbar-track {
                background: #000;
            }

            .debug-console-content::-webkit-scrollbar-thumb {
                background: #0a0;
                border-radius: 4px;
            }

            .debug-console-content::-webkit-scrollbar-thumb:hover {
                background: #0f0;
            }
        `;
        document.head.appendChild(style);
    }

    /**
     * Wire up DOM events
     */
    _wireUpEvents() {
        // Close button
        const closeBtn = this.container.querySelector('.btn-close');
        closeBtn.addEventListener('click', () => this.hide());

        // Minimize button
        const minimizeBtn = this.container.querySelector('.btn-minimize');
        minimizeBtn.addEventListener('click', () => this.toggleMinimize());

        // Tab buttons
        const tabBtns = this.container.querySelectorAll('.tab-btn');
        tabBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                this.switchTab(btn.dataset.tab);
            });
        });

        // Draggable header
        this._makeDraggable();
    }

    /**
     * Make console draggable
     */
    _makeDraggable() {
        const header = this.container.querySelector('.debug-console-header');
        let isDragging = false;
        let currentX;
        let currentY;
        let initialX;
        let initialY;

        header.addEventListener('mousedown', (e) => {
            if (e.target.tagName === 'BUTTON') return;

            isDragging = true;
            initialX = e.clientX - this.container.offsetLeft;
            initialY = e.clientY - this.container.offsetTop;
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;

            e.preventDefault();
            currentX = e.clientX - initialX;
            currentY = e.clientY - initialY;

            this.container.style.left = currentX + 'px';
            this.container.style.top = currentY + 'px';
            this.container.style.right = 'auto';
        });

        document.addEventListener('mouseup', () => {
            isDragging = false;
        });
    }

    /**
     * Register keyboard shortcuts
     */
    _registerKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            // Toggle with ~ or F12
            if (e.key === '`' || e.key === 'F12') {
                e.preventDefault();
                this.toggle();
            }
        });
    }

    /**
     * Setup built-in panels
     */
    _setupBuiltInPanels() {
        // FPS panel
        this.addPanel('fps', () => this._renderFPSPanel());

        // Metrics panel
        this.addPanel('metrics', () => this._renderMetricsPanel());

        // Logs panel
        this.addPanel('logs', () => this._renderLogsPanel());

        // Errors panel
        this.addPanel('errors', () => this._renderErrorsPanel());
    }

    /**
     * Subscribe to observability events
     */
    _subscribeToEvents() {
        // Subscribe to logs from all loggers
        getAllLoggers().forEach(logger => {
            logger.addListener((entry) => {
                this.logBuffer.push(entry);
                if (this.logBuffer.length > this.maxLogEntries) {
                    this.logBuffer.shift();
                }
            });
        });

        // Subscribe to errors
        errorTracker.addListener((error) => {
            // Errors are already captured, just trigger update
            if (this.activeTab === 'errors') {
                this._updateActivePanel();
            }
        });
    }

    /**
     * Start update loop
     */
    _startUpdateLoop() {
        setInterval(() => {
            if (this.isVisible && !this.isMinimized) {
                this._updateActivePanel();
            }
        }, 1000); // Update every second
    }

    /**
     * Show console
     */
    show() {
        this.isVisible = true;
        this.container.classList.add('visible');
        this._updateActivePanel();
        log.debug('Debug console shown');
    }

    /**
     * Hide console
     */
    hide() {
        this.isVisible = false;
        this.container.classList.remove('visible');
        log.debug('Debug console hidden');
    }

    /**
     * Toggle console visibility
     */
    toggle() {
        if (this.isVisible) {
            this.hide();
        } else {
            this.show();
        }
    }

    /**
     * Toggle minimize state
     */
    toggleMinimize() {
        this.isMinimized = !this.isMinimized;
        if (this.isMinimized) {
            this.container.classList.add('minimized');
        } else {
            this.container.classList.remove('minimized');
            this._updateActivePanel();
        }
    }

    /**
     * Switch to a different tab
     */
    switchTab(tabName) {
        this.activeTab = tabName;

        // Update tab buttons
        const tabBtns = this.container.querySelectorAll('.tab-btn');
        tabBtns.forEach(btn => {
            if (btn.dataset.tab === tabName) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });

        // Update panels
        const panels = this.container.querySelectorAll('.panel');
        panels.forEach(panel => {
            if (panel.id === `panel-${tabName}`) {
                panel.classList.add('active');
            } else {
                panel.classList.remove('active');
            }
        });

        this._updateActivePanel();
    }

    /**
     * Add a custom panel
     */
    addPanel(name, renderFn) {
        this.panels.set(name, renderFn);
    }

    /**
     * Remove a panel
     */
    removePanel(name) {
        this.panels.delete(name);
    }

    /**
     * Update the active panel
     */
    _updateActivePanel() {
        const renderFn = this.panels.get(this.activeTab);
        if (renderFn) {
            const panel = this.container.querySelector(`#panel-${this.activeTab}`);
            if (panel) {
                panel.innerHTML = renderFn();
            }
        }
    }

    /**
     * Render FPS panel
     */
    _renderFPSPanel() {
        const fpsStats = metrics.getStats('render.fps');
        const frameTimeStats = metrics.getStats('render.frame_time');

        if (!fpsStats) {
            return '<div class="metric-row"><span>Waiting for data...</span></div>';
        }

        return `
            <div class="metric-row">
                <span class="metric-label">Current FPS:</span>
                <span class="metric-value">${Math.round(fpsStats.current || 0)}</span>
            </div>
            <div class="metric-row">
                <span class="metric-label">Average FPS:</span>
                <span class="metric-value">${Math.round(fpsStats.avg || 0)}</span>
            </div>
            <div class="metric-row">
                <span class="metric-label">Min FPS:</span>
                <span class="metric-value">${Math.round(fpsStats.min || 0)}</span>
            </div>
            <div class="metric-row">
                <span class="metric-label">Max FPS:</span>
                <span class="metric-value">${Math.round(fpsStats.max || 0)}</span>
            </div>
            ${frameTimeStats ? `
                <div class="metric-row">
                    <span class="metric-label">Frame Time (avg):</span>
                    <span class="metric-value">${frameTimeStats.avg.toFixed(2)}ms</span>
                </div>
            ` : ''}
        `;
    }

    /**
     * Render metrics panel
     */
    _renderMetricsPanel() {
        const allMetrics = metrics.getAllMetrics();

        if (allMetrics.length === 0) {
            return '<div class="metric-row"><span>No metrics collected yet</span></div>';
        }

        return allMetrics.map(metric => {
            const stats = metric.stats;
            if (!stats) return '';

            let valueDisplay;
            if (metric.type === 'counter') {
                valueDisplay = stats.current;
            } else if (metric.type === 'gauge') {
                valueDisplay = stats.current.toFixed(2);
            } else {
                valueDisplay = `avg: ${stats.avg.toFixed(2)}`;
            }

            return `
                <div class="metric-row">
                    <span class="metric-label">${metric.name}:</span>
                    <span class="metric-value">${valueDisplay}</span>
                </div>
            `;
        }).join('');
    }

    /**
     * Render logs panel
     */
    _renderLogsPanel() {
        if (this.logBuffer.length === 0) {
            return '<div>No logs yet</div>';
        }

        // Show last 50 logs
        const recentLogs = this.logBuffer.slice(-50).reverse();

        return recentLogs.map(entry => {
            const time = new Date(entry.timestamp).toLocaleTimeString();
            const contextStr = Object.keys(entry.context).length > 0
                ? `<div class="log-context">${JSON.stringify(entry.context, null, 2)}</div>`
                : '';

            return `
                <div class="log-entry ${entry.level}">
                    <span class="log-timestamp">${time}</span>
                    <span class="log-name">[${entry.name}]</span>
                    ${entry.message}
                    ${contextStr}
                </div>
            `;
        }).join('');
    }

    /**
     * Render errors panel
     */
    _renderErrorsPanel() {
        const errors = errorTracker.getErrors(20);

        if (errors.length === 0) {
            return '<div style="color: #0f0;">No errors! 🎉</div>';
        }

        return errors.map(error => {
            const time = new Date(error.timestamp).toLocaleTimeString();
            return `
                <div class="error-entry">
                    <div class="error-message">${error.message}</div>
                    <div class="error-context">
                        ${time} | ${error.name}
                        ${error.context.type ? `| ${error.context.type}` : ''}
                    </div>
                </div>
            `;
        }).join('');
    }
}

// Global debug console instance
const debugConsole = new DebugConsole();

export { debugConsole, DebugConsole };
export default debugConsole;
