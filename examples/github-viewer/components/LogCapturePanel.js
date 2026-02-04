/**
 * LogCapturePanel Component
 *
 * Drawer panel for capturing, previewing, and downloading debug logs.
 * Integrates with the LogCapture utility from glyph3d-js observability.
 */

import { logCapture } from '../../../src/utils/LogCapture.js';

/** Panel HTML for the drawer registration */
export function logCapturePanelHTML() {
    return `
        <div class="log-capture-controls">
            <button id="log-capture-toggle" class="log-capture-btn">Start Capture</button>
            <button id="log-capture-download" class="log-capture-btn download" disabled>Download</button>
            <button id="log-capture-clear" class="log-capture-btn" disabled>Clear</button>
        </div>
        <div id="log-capture-status" class="log-capture-status">
            Capture is <strong>stopped</strong>. Press Start to begin recording logs.
        </div>
        <div id="log-capture-preview" class="log-capture-preview"></div>
    `;
}

/**
 * Initialize log capture panel interactivity
 * Call this after the drawer panel has been added to the DOM.
 *
 * @param {HTMLElement} panel - The panel element containing log capture UI
 */
export function initLogCapturePanel(panel) {
    const toggleBtn = panel.querySelector('#log-capture-toggle');
    const downloadBtn = panel.querySelector('#log-capture-download');
    const clearBtn = panel.querySelector('#log-capture-clear');
    const statusEl = panel.querySelector('#log-capture-status');
    const previewEl = panel.querySelector('#log-capture-preview');

    let updateInterval = null;

    function updateStatus() {
        const count = logCapture.count;
        const isCapturing = logCapture.isCapturing;
        const duration = logCapture.startTime
            ? ((Date.now() - logCapture.startTime) / 1000).toFixed(0)
            : 0;

        if (isCapturing) {
            statusEl.innerHTML = `
                <span class="recording">RECORDING</span> -
                <span class="count">${count}</span> entries captured
                (${duration}s)
            `;
        } else if (count > 0) {
            statusEl.innerHTML = `
                Stopped - <span class="count">${count}</span> entries captured.
                Download or clear to reset.
            `;
        } else {
            statusEl.innerHTML = `Capture is <strong>stopped</strong>. Press Start to begin recording logs.`;
        }

        downloadBtn.disabled = count === 0;
        clearBtn.disabled = count === 0 && !isCapturing;
    }

    function updatePreview() {
        const entries = logCapture.entries;
        if (entries.length === 0) {
            previewEl.innerHTML = '';
            return;
        }

        // Show last 50 entries
        const recent = entries.slice(-50);
        previewEl.innerHTML = recent.map(entry => {
            const time = new Date(entry.timestamp).toLocaleTimeString();
            const level = entry.level || 'INFO';
            const name = entry.name || '';
            const msg = entry.message || '';
            return `<div class="log-line ${level}">[${time}] [${level}] [${name}] ${escapeHTML(msg)}</div>`;
        }).join('');

        // Auto-scroll to bottom
        previewEl.scrollTop = previewEl.scrollHeight;
    }

    toggleBtn.addEventListener('click', () => {
        if (logCapture.isCapturing) {
            logCapture.stop();
            toggleBtn.textContent = 'Start Capture';
            toggleBtn.classList.remove('active');
            if (updateInterval) {
                clearInterval(updateInterval);
                updateInterval = null;
            }
        } else {
            logCapture.start();
            toggleBtn.textContent = 'Stop Capture';
            toggleBtn.classList.add('active');
            // Update preview every second while capturing
            updateInterval = setInterval(() => {
                updateStatus();
                updatePreview();
            }, 1000);
        }
        updateStatus();
        updatePreview();
    });

    downloadBtn.addEventListener('click', () => {
        logCapture.download();
    });

    clearBtn.addEventListener('click', () => {
        logCapture.clear();
        previewEl.innerHTML = '';
        updateStatus();
    });

    // Initial state
    updateStatus();
}

/**
 * Escape HTML special characters
 * @param {string} str
 * @returns {string}
 */
function escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}
