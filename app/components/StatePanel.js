/**
 * StatePanel -- State Inspector sidebar panel.
 *
 * Flat list of all g3d.* localStorage keys grouped by namespace.
 * Each key is a single row: name, truncated value, size, clear button.
 * Event-driven refresh — no polling.
 */

import { stateController } from '@glyph3d/core/services/state/StateController.js';
import { STATE_DEFAULTS } from '../StatePersistence.js';

const PREFIX = 'g3d.';

export function statePanelHTML() {
    return `
        <div class="state-panel">
            <div class="state-hdr">
                <span class="state-title">State</span>
                <span id="state-total" class="state-badge">0</span>
                <span class="state-spacer"></span>
                <button class="state-icon-btn" id="state-export" title="Export JSON">&#8681;</button>
                <button class="state-icon-btn" id="state-import" title="Import JSON">&#8679;</button>
                <button class="state-icon-btn state-icon-danger" id="state-clear-all" title="Clear all">&#10005;</button>
            </div>
            <div id="state-list" class="state-list"></div>
            <input type="file" id="state-import-file" accept=".json" style="display:none">
        </div>
    `;
}

export function initStatePanel(panelEl) {
    const listEl = panelEl.querySelector('#state-list');
    const totalEl = panelEl.querySelector('#state-total');
    let lastSig = '';

    function refresh() {
        const keys = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k.startsWith(PREFIX)) keys.push(k);
        }
        keys.sort();

        let totalBytes = 0;
        const entries = keys.map(k => {
            const raw = localStorage.getItem(k) || '';
            const bytes = raw.length * 2;
            totalBytes += bytes;
            const short = k.slice(PREFIX.length);
            const dot = short.indexOf('.');
            const ns = dot === -1 ? short : short.slice(0, dot);
            return { k, short, ns, raw, bytes };
        });

        const sig = keys.join(',') + totalBytes;
        if (sig === lastSig) return;
        lastSig = sig;

        totalEl.textContent = entries.length;

        if (entries.length === 0) {
            listEl.innerHTML = '<div class="state-empty">No saved state</div>';
            return;
        }

        let html = '';
        let lastNs = '';
        for (const e of entries) {
            if (e.ns !== lastNs) {
                lastNs = e.ns;
                html += `<div class="state-ns-divider">${esc(e.ns)}</div>`;
            }
            const val = e.raw.length > 80 ? e.raw.slice(0, 80) + '\u2026' : e.raw;
            const size = e.bytes < 1024 ? e.bytes + 'B' : (e.bytes / 1024).toFixed(1) + 'K';
            const hasDef = e.short in STATE_DEFAULTS;
            html += `<div class="state-row" data-key="${esc(e.short)}">
                <div class="state-row-key">${esc(e.short)}</div>
                <div class="state-row-val">${esc(val)}</div>
                <div class="state-row-meta">
                    <span class="state-badge">${size}</span>
                    ${hasDef ? `<button class="state-row-btn" data-action="reset" data-key="${esc(e.short)}" title="Reset to default">&#8634;</button>` : ''}
                    <button class="state-row-btn state-row-btn-danger" data-action="clear" data-key="${esc(e.short)}" title="Delete">&times;</button>
                </div>
            </div>`;
        }
        listEl.innerHTML = html;
    }

    // Row actions
    listEl.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        if (btn.dataset.action === 'clear') {
            stateController.delete(btn.dataset.key);
        } else if (btn.dataset.action === 'reset' && btn.dataset.key in STATE_DEFAULTS) {
            stateController.set(btn.dataset.key, STATE_DEFAULTS[btn.dataset.key]);
        }
        refresh();
    });

    // Export
    panelEl.querySelector('#state-export').addEventListener('click', () => {
        const data = {};
        for (const k of stateController.listAll()) data[k] = stateController.get(k);
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `g3d-state-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
    });

    // Import
    const fileInput = panelEl.querySelector('#state-import-file');
    panelEl.querySelector('#state-import').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
        const file = fileInput.files[0];
        if (!file) return;
        try {
            const data = JSON.parse(await file.text());
            for (const [k, v] of Object.entries(data)) stateController.set(k, v);
        } catch (err) {
            console.error('[StatePanel] Import failed:', err);
        }
        fileInput.value = '';
        refresh();
    });

    // Clear all (two-click confirm)
    const clearBtn = panelEl.querySelector('#state-clear-all');
    let confirmTimer = null;
    clearBtn.addEventListener('click', () => {
        if (confirmTimer) {
            clearTimeout(confirmTimer);
            confirmTimer = null;
            stateController.clearAll();
            clearBtn.classList.remove('state-icon-confirm');
            refresh();
        } else {
            clearBtn.classList.add('state-icon-confirm');
            confirmTimer = setTimeout(() => {
                clearBtn.classList.remove('state-icon-confirm');
                confirmTimer = null;
            }, 3000);
        }
    });

    window.addEventListener('storage', refresh);
    window.addEventListener('state-changed', refresh);
    refresh();
}

function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
