/**
 * GroupsPanel — live view of spatial window groups.
 *
 * Shows active groups with member counts, layout mode toggles,
 * and per-group actions (splay/stack/free, hide/show, dissolve).
 * Auto-refreshes on group changes via polling (lightweight, no
 * new event infrastructure needed).
 */

/**
 * Build the initial panel HTML.
 * @returns {string}
 */
export function groupsPanelHTML() {
    return `
        <div class="groups-panel">
            <div class="groups-panel-header">
                <span class="groups-panel-title">Window Groups</span>
                <span id="groups-count" class="groups-badge">0</span>
            </div>
            <div class="groups-hint">
                Drag a window onto another to create a group.
                <br>Use <span class="key">G</span> to group selected files.
            </div>
            <div id="groups-list" class="groups-list">
                <div class="groups-empty">No groups yet</div>
            </div>
            <div class="groups-actions">
                <button id="groups-dissolve-all" class="setting-btn groups-btn-danger">Dissolve All Groups</button>
            </div>
        </div>
    `;
}

/**
 * Wire the groups panel to a SpatialWindowManager.
 *
 * @param {HTMLElement} panelEl - the panel DOM element
 * @param {Object} opts
 * @param {SpatialWindowManager} opts.spatialManager
 * @param {SceneRegistry} opts.registry
 */
export function initGroupsPanel(panelEl, { spatialManager, registry }) {
    if (!spatialManager) return;

    const listEl = panelEl.querySelector('#groups-list');
    const countEl = panelEl.querySelector('#groups-count');
    const dissolveAllBtn = panelEl.querySelector('#groups-dissolve-all');

    let lastRendered = '';

    function refresh() {
        const names = spatialManager.getGroupNames();
        countEl.textContent = names.length;

        if (names.length === 0) {
            const html = '<div class="groups-empty">No groups yet</div>';
            if (lastRendered !== html) {
                listEl.innerHTML = html;
                lastRendered = html;
            }
            return;
        }

        const html = names.map(name => {
            const group = spatialManager.getGroup(name);
            if (!group) return '';
            const color = spatialManager.getGroupColor(name);
            const colorCSS = color
                ? `rgb(${Math.round(color.r * 255)}, ${Math.round(color.g * 255)}, ${Math.round(color.b * 255)})`
                : '#888';

            const members = group.memberIds.map(id => {
                const entry = registry.get(id);
                const label = entry?.meta?.sourcePath?.split('/').pop()
                    || entry?.grid?.title
                    || id;
                return `<div class="group-member">${escapeHTML(label)}</div>`;
            }).join('');

            const mode = group.mode || 'free';

            return `
                <div class="group-card" data-group="${escapeHTML(name)}">
                    <div class="group-card-header">
                        <span class="group-color-dot" style="background:${colorCSS}"></span>
                        <span class="group-name">${escapeHTML(name)}</span>
                        <span class="group-member-count">${group.memberIds.length}</span>
                    </div>
                    <div class="group-mode-bar">
                        <button class="group-mode-btn${mode === 'free' ? ' active' : ''}" data-mode="free" data-group="${escapeHTML(name)}">Free</button>
                        <button class="group-mode-btn${mode === 'stack' ? ' active' : ''}" data-mode="stack" data-group="${escapeHTML(name)}">Stack</button>
                        <button class="group-mode-btn${mode === 'splay' ? ' active' : ''}" data-mode="splay" data-group="${escapeHTML(name)}">Splay</button>
                    </div>
                    <div class="group-members">${members}</div>
                    <div class="group-card-actions">
                        <button class="group-action-btn" data-action="hide" data-group="${escapeHTML(name)}">Hide</button>
                        <button class="group-action-btn" data-action="show" data-group="${escapeHTML(name)}">Show</button>
                        <button class="group-action-btn group-btn-danger-sm" data-action="dissolve" data-group="${escapeHTML(name)}">Dissolve</button>
                    </div>
                </div>
            `;
        }).join('');

        if (lastRendered !== html) {
            listEl.innerHTML = html;
            lastRendered = html;
        }
    }

    // Delegate click events on the list
    listEl.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-group]');
        if (!btn) return;
        const groupName = btn.dataset.group;

        // Mode buttons
        if (btn.dataset.mode) {
            spatialManager.setLayout(groupName, btn.dataset.mode);
            refresh();
            return;
        }

        // Action buttons
        if (btn.dataset.action === 'hide') {
            spatialManager.hideGroup(groupName);
        } else if (btn.dataset.action === 'show') {
            spatialManager.showGroup(groupName);
        } else if (btn.dataset.action === 'dissolve') {
            spatialManager.dissolveGroup(groupName);
        }
        refresh();
    });

    // Dissolve all
    dissolveAllBtn.addEventListener('click', () => {
        spatialManager.clear();
        refresh();
    });

    // Poll for changes (lightweight — just checks group count + names)
    let pollId = setInterval(refresh, 500);

    // Initial render
    refresh();

    // Return cleanup function
    return () => clearInterval(pollId);
}

function escapeHTML(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
