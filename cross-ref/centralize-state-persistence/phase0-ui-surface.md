# State Management UI Panel -- Design Analysis

Agent: UI Surface
Focus: panel layout, interactions, integration into IDE shell

---

## 1. Panel Identity

**Panel ID**: `state`
**PANEL_TITLES entry**: `'state': 'STATE INSPECTOR'`
**Activity bar position**: After "groups", before the spacer (i.e., last in the top cluster)
**Icon**: `&#128451;` (U+1F5C3, file cabinet) -- visually reads as storage/persistence.
Fallback if emoji rendering is inconsistent: `&#9881;` (gear) is taken by repo; use `&#128190;` (floppy disk, U+1F4BE) as alternate.

**ide.html addition** (after the groups button, before `<div class="activity-spacer">`):
```html
<button class="activity-btn" data-panel="state" title="State Inspector">
    <span class="activity-icon">&#128190;</span>
</button>
```

**Sidebar panel div** (after `sp-groups`):
```html
<div class="sidebar-panel" id="sp-state"></div>
```

---

## 2. Panel HTML Structure -- `statePanelHTML()`

The panel shows every localStorage namespace as a collapsible card. Each card has:
- Namespace name + byte size badge
- Truncated raw JSON preview (first 120 chars)
- Per-namespace clear and reset-to-defaults buttons
- Global actions at the bottom: Export All, Import, Clear All

```javascript
export function statePanelHTML() {
    return `
        <div class="state-panel">
            <div class="state-panel-header">
                <span class="state-panel-title">Persisted State</span>
                <span id="state-total-size" class="groups-badge">0 B</span>
            </div>
            <div class="setting-hint">
                localStorage namespaces used by this app.
            </div>

            <div id="state-ns-list" class="state-ns-list">
                <!-- Populated by initStatePanel -->
            </div>

            <div class="setting-group setting-section-header">Actions</div>
            <div class="setting-group" style="display:flex; gap:8px">
                <button class="setting-btn" id="state-export" style="flex:1">Export JSON</button>
                <button class="setting-btn" id="state-import" style="flex:1">Import JSON</button>
            </div>
            <div class="setting-group">
                <button class="setting-btn state-btn-danger" id="state-clear-all">
                    Clear All State
                </button>
            </div>
            <input type="file" id="state-import-file" accept=".json" style="display:none">
        </div>
    `;
}
```

Each namespace card (generated dynamically in refresh):
```html
<div class="state-ns-card" data-ns="glyph3d-viewer-state">
    <div class="state-ns-header" data-ns="glyph3d-viewer-state">
        <span class="state-ns-chevron">&#9654;</span>
        <span class="state-ns-name">glyph3d-viewer-state</span>
        <span class="groups-badge">1.2 KB</span>
    </div>
    <div class="state-ns-body" style="display:none">
        <pre class="state-ns-preview">{"repoUrl":"https://gi..."</pre>
        <div class="state-ns-actions">
            <button class="setting-btn state-ns-btn" data-action="reset" data-ns="...">
                Reset Defaults
            </button>
            <button class="setting-btn state-btn-danger state-ns-btn" data-action="clear" data-ns="...">
                Clear
            </button>
        </div>
    </div>
</div>
```

---

## 3. Known Namespaces

Discovered from StatePersistence.js and GitHubRepoViewer.js:

| Key                        | DEFAULTS available | Description                     |
|----------------------------|--------------------|---------------------------------|
| `glyph3d-viewer-state`     | Yes (DEFAULTS obj) | Main app state blob             |
| `glyph3d-camera-settings`  | No (just remove)   | Camera persistence              |
| `glyph3d-ws-enabled`       | No (boolean flag)  | WebSocket toggle                |

The panel should also discover any *other* keys that start with `glyph3d-` by scanning
`Object.keys(localStorage).filter(k => k.startsWith('glyph3d-'))`. This future-proofs
against new namespaces being added without updating the panel.

---

## 4. Interactions

### 4a. Expand/Collapse namespace
Click the `.state-ns-header` row to toggle `.state-ns-body` visibility and rotate the
chevron. No polling needed -- this is pure DOM toggle.

### 4b. Clear individual namespace
`data-action="clear"` button removes the key from localStorage and re-renders.

### 4c. Reset to defaults
`data-action="reset"` button writes the DEFAULTS object back for `glyph3d-viewer-state`.
For keys without known defaults, this button is hidden (only "Clear" is shown).

### 4d. Export All
Collects all `glyph3d-*` keys into a single JSON object `{ [key]: parsedValue }` and
triggers a file download via `URL.createObjectURL` + anchor click.
Filename: `glyph3d-state-YYYY-MM-DD.json`.

### 4e. Import
Opens the hidden file input. On change, reads the JSON, validates it has at least one
`glyph3d-*` key, writes each key to localStorage, and refreshes the panel. Confirms
via a brief flash on the card headers (CSS transition on background-color).

### 4f. Clear All
Removes every `glyph3d-*` key from localStorage. Shows a confirmation step:
first click changes button text to "Confirm Clear All" with red background;
second click within 3s executes. Timeout reverts the button.

---

## 5. Live State Display -- Change Detection

**No polling.** Instead:

1. `initStatePanel` does one initial `refresh()`.
2. Listen to `window.addEventListener('storage', refresh)` -- fires when *other* tabs
   change localStorage (cross-tab sync for free).
3. For same-tab changes: wrap `localStorage.setItem` calls in StatePersistence with a
   `window.dispatchEvent(new CustomEvent('state-changed'))` notification.
   The panel listens to `'state-changed'` and calls `refresh()`.
4. The panel also refreshes when it becomes the active sidebar panel
   (`_showSidebarPanel('state')` triggers a one-shot refresh via MutationObserver on
   the `.active` class, or simpler: the IDEShell dispatches a custom event).

This avoids the 500ms `setInterval` that GroupsPanel uses. State changes are infrequent
(user actions, not per-frame), so event-driven updates are both cheaper and more responsive.

**`refresh()` change detection**: Serialize current localStorage snapshot to a string
hash (simple length + first/last chars) and compare to `lastSnapshot`. Only rebuild DOM
if changed -- same pattern as GroupsPanel's `lastRendered` string comparison.

---

## 6. Code Sketch -- `initStatePanel()`

```javascript
const KNOWN_DEFAULTS = {
    'glyph3d-viewer-state': DEFAULTS,  // imported from StatePersistence.js
};

export function initStatePanel(panelEl) {
    const listEl = panelEl.querySelector('#state-ns-list');
    const totalSizeEl = panelEl.querySelector('#state-total-size');
    let lastSnapshot = '';

    function getNamespaces() {
        const keys = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k.startsWith('glyph3d-')) keys.push(k);
        }
        return keys.sort();
    }

    function formatBytes(n) {
        if (n < 1024) return n + ' B';
        return (n / 1024).toFixed(1) + ' KB';
    }

    function refresh() {
        const keys = getNamespaces();
        let totalBytes = 0;

        const snapshot = keys.map(k => {
            const raw = localStorage.getItem(k) || '';
            totalBytes += raw.length * 2; // JS strings are UTF-16
            const preview = raw.length > 120 ? raw.slice(0, 120) + '...' : raw;
            const hasDefaults = k in KNOWN_DEFAULTS;
            return { key: k, size: raw.length * 2, preview, hasDefaults };
        });

        const sig = keys.join(',') + ':' + totalBytes;
        if (sig === lastSnapshot) return;
        lastSnapshot = sig;

        totalSizeEl.textContent = formatBytes(totalBytes);

        if (keys.length === 0) {
            listEl.innerHTML = '<div class="groups-empty">No persisted state</div>';
            return;
        }

        listEl.innerHTML = snapshot.map(ns => `
            <div class="state-ns-card" data-ns="${esc(ns.key)}">
                <div class="state-ns-header" data-ns="${esc(ns.key)}">
                    <span class="state-ns-chevron">&#9654;</span>
                    <span class="state-ns-name">${esc(ns.key)}</span>
                    <span class="groups-badge">${formatBytes(ns.size)}</span>
                </div>
                <div class="state-ns-body" style="display:none">
                    <pre class="state-ns-preview">${esc(ns.preview)}</pre>
                    <div class="state-ns-actions">
                        ${ns.hasDefaults
                            ? `<button class="setting-btn state-ns-btn"
                                       data-action="reset" data-ns="${esc(ns.key)}">
                                   Reset Defaults</button>`
                            : ''}
                        <button class="setting-btn state-btn-danger state-ns-btn"
                                data-action="clear" data-ns="${esc(ns.key)}">
                            Clear
                        </button>
                    </div>
                </div>
            </div>
        `).join('');
    }

    // Expand/collapse
    listEl.addEventListener('click', (e) => {
        const header = e.target.closest('.state-ns-header');
        if (!header) return;
        const card = header.closest('.state-ns-card');
        const body = card.querySelector('.state-ns-body');
        const chevron = header.querySelector('.state-ns-chevron');
        const open = body.style.display !== 'none';
        body.style.display = open ? 'none' : 'block';
        chevron.innerHTML = open ? '&#9654;' : '&#9660;';
    });

    // Per-namespace actions
    listEl.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const ns = btn.dataset.ns;
        if (btn.dataset.action === 'clear') {
            localStorage.removeItem(ns);
        } else if (btn.dataset.action === 'reset' && KNOWN_DEFAULTS[ns]) {
            localStorage.setItem(ns, JSON.stringify(KNOWN_DEFAULTS[ns]));
        }
        refresh();
    });

    // Export
    panelEl.querySelector('#state-export').addEventListener('click', () => {
        const data = {};
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (!k.startsWith('glyph3d-')) continue;
            try { data[k] = JSON.parse(localStorage.getItem(k)); }
            catch { data[k] = localStorage.getItem(k); }
        }
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `glyph3d-state-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
    });

    // Import
    const fileInput = panelEl.querySelector('#state-import-file');
    panelEl.querySelector('#state-import').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
        const file = fileInput.files[0];
        if (!file) return;
        const text = await file.text();
        const data = JSON.parse(text);
        for (const [k, v] of Object.entries(data)) {
            if (!k.startsWith('glyph3d-')) continue;
            localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
        }
        fileInput.value = '';
        refresh();
    });

    // Clear all with confirmation
    const clearAllBtn = panelEl.querySelector('#state-clear-all');
    let confirmTimer = null;
    clearAllBtn.addEventListener('click', () => {
        if (confirmTimer) {
            clearTimeout(confirmTimer);
            confirmTimer = null;
            getNamespaces().forEach(k => localStorage.removeItem(k));
            clearAllBtn.textContent = 'Clear All State';
            clearAllBtn.classList.remove('state-btn-confirm');
            refresh();
        } else {
            clearAllBtn.textContent = 'Confirm Clear All';
            clearAllBtn.classList.add('state-btn-confirm');
            confirmTimer = setTimeout(() => {
                clearAllBtn.textContent = 'Clear All State';
                clearAllBtn.classList.remove('state-btn-confirm');
                confirmTimer = null;
            }, 3000);
        }
    });

    // Event-driven refresh (no polling)
    window.addEventListener('storage', refresh);
    window.addEventListener('state-changed', refresh);
    refresh();
}

function esc(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;')
              .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
```

---

## 7. CSS Additions

```css
/* ===== State Inspector panel ===== */
.state-panel { display: flex; flex-direction: column; gap: 8px; }
.state-panel-header { display: flex; align-items: center; gap: 8px; }
.state-panel-title {
    font-size: 13px; font-weight: 600;
    color: var(--text-primary, #e0e0e0);
}
.state-ns-list {
    display: flex; flex-direction: column; gap: 4px;
    max-height: 50vh; overflow-y: auto;
}
.state-ns-card {
    background: var(--surface-1, #1a1a1a);
    border: 1px solid var(--border, #333);
    border-radius: 6px; overflow: hidden;
}
.state-ns-header {
    display: flex; align-items: center; gap: 6px;
    padding: 8px 10px; cursor: pointer;
    transition: background 0.15s;
}
.state-ns-header:hover { background: rgba(255, 170, 0, 0.05); }
.state-ns-chevron {
    font-size: 8px; color: #666; width: 12px;
    text-align: center; flex-shrink: 0;
    transition: transform 0.15s;
}
.state-ns-name {
    font-size: 12px; font-family: 'SF Mono', 'Fira Code', monospace;
    color: var(--text-primary, #e0e0e0); flex: 1;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.state-ns-body { padding: 0 10px 10px; }
.state-ns-preview {
    font-size: 10px; font-family: 'SF Mono', 'Fira Code', monospace;
    color: #777; background: rgba(0,0,0,0.3);
    border-radius: 4px; padding: 8px;
    max-height: 80px; overflow: auto;
    white-space: pre-wrap; word-break: break-all;
    margin: 0 0 8px 0;
}
.state-ns-actions { display: flex; gap: 6px; }
.state-ns-btn { flex: 1; padding: 8px; font-size: 11px; margin-top: 0; }
.state-btn-danger { color: #ff6666 !important; border-color: #442222 !important; }
.state-btn-danger:hover { background: #2a1a1a !important; border-color: #ff6666 !important; }
.state-btn-confirm { background: #3a1a1a !important; border-color: #ff4444 !important; animation: state-pulse 0.6s ease infinite alternate; }
@keyframes state-pulse { to { border-color: #ff6666; } }
```

---

## 8. Integration Points

**IDEShell.js** -- wire the panel in `_initPanels()` or equivalent:
```javascript
import { statePanelHTML, initStatePanel } from './components/StatePanel.js';
// ...
const stateEl = this.addPanel({ id: 'state', label: 'State', html: statePanelHTML() });
if (stateEl) initStatePanel(stateEl);
```

**StatePersistence.js** -- add notification after writes:
```javascript
_save() {
    saveState(this.state);
    window.dispatchEvent(new CustomEvent('state-changed'));
}
```

This single `CustomEvent` dispatch is the only modification to existing code needed.
The panel itself is entirely additive -- new file, new HTML div, new CSS block, one
`PANEL_TITLES` entry, one activity bar button.

---

## 9. Summary of Deliverables

| File                                | Change                                    |
|-------------------------------------|-------------------------------------------|
| `app/components/StatePanel.js`      | New file: `statePanelHTML`, `initStatePanel` |
| `app/ide.html`                      | Add activity-btn + `sp-state` div         |
| `app/ide.css`                       | Add `.state-*` styles (~35 lines)         |
| `app/IDEShell.js`                   | Add `PANEL_TITLES['state']`, import+init  |
| `app/StatePersistence.js`           | Add `CustomEvent` dispatch in `_save()`   |
