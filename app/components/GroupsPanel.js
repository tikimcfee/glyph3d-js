/**
 * GroupsPanel — live view of spatial window groups.
 *
 * Cards show window controls (min/max/close), a minimap preview of
 * member positions, layout mode toggles, and a collapsible member list.
 * Auto-refreshes via 500ms polling.
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
                <span class="key">Ctrl</span>+drag onto another to group.
                <span class="key">G</span> groups selected files.
            </div>
            <div id="groups-list" class="groups-list">
                <div class="groups-empty">No groups yet</div>
            </div>
            <div class="groups-actions">
                <button id="groups-dissolve-all" class="setting-btn groups-btn-danger">Dissolve All</button>
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
 * @param {SpatialAnimator} [opts.animator]
 * @param {THREE.PerspectiveCamera} [opts.camera]
 */
export function initGroupsPanel(panelEl, { spatialManager, registry, animator, camera }) {
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
                return `<div class="group-member">${esc(label)}</div>`;
            }).join('');

            const mode = group.mode || 'free';
            const n = esc(name);

            const modes = ['free', 'stack', 'splay', 'horizontal', 'vertical'];
            const modeLabels = { free: 'Free', stack: 'Stack', splay: 'Splay', horizontal: 'H', vertical: 'V' };
            const modeBar = modes.map(m =>
                `<button class="group-mode-btn${mode === m ? ' active' : ''}" data-mode="${m}" data-group="${n}" title="${m}">${modeLabels[m]}</button>`
            ).join('');

            return `
                <div class="group-card" data-group="${n}">
                    <div class="group-card-header">
                        <span class="group-color-dot" style="background:${colorCSS}"></span>
                        <span class="group-name">${n}</span>
                        <span class="group-member-count">${group.memberIds.length}</span>
                        <div class="group-wc">
                            <button class="group-wc-btn" data-action="focus" data-group="${n}" title="Focus camera on group">&#x25CE;</button>
                            <button class="group-wc-btn" data-action="hide" data-group="${n}" title="Minimize (Hide)">&#x2500;</button>
                            <button class="group-wc-btn" data-action="show" data-group="${n}" title="Maximize (Show)">&#x25A1;</button>
                            <button class="group-wc-btn group-wc-close" data-action="dissolve" data-group="${n}" title="Close (Dissolve)">&#x2715;</button>
                        </div>
                    </div>
                    <canvas class="group-minimap" data-group="${n}" width="160" height="80"></canvas>
                    <div class="group-mode-bar">${modeBar}</div>
                    <div class="group-members">${members}</div>
                </div>
            `;
        }).join('');

        if (lastRendered !== html) {
            listEl.innerHTML = html;
            lastRendered = html;
        }

        // Draw minimaps after HTML rebuild
        renderMinimaps(listEl, spatialManager, registry);
    }

    // Delegate click events on the list
    listEl.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-group]');
        if (!btn) return;
        const groupName = btn.dataset.group;

        if (btn.dataset.mode) {
            spatialManager.setLayout(groupName, btn.dataset.mode);
            refresh();
            return;
        }

        if (btn.dataset.action === 'focus') {
            focusOnGroup(groupName, spatialManager, registry, animator, camera);
        } else if (btn.dataset.action === 'hide') {
            spatialManager.hideGroup(groupName);
        } else if (btn.dataset.action === 'show') {
            spatialManager.showGroup(groupName);
        } else if (btn.dataset.action === 'dissolve') {
            spatialManager.dissolveGroup(groupName);
        }
        refresh();
    });

    // Click on minimap canvas → select the grid under cursor
    listEl.addEventListener('click', (e) => {
        const canvas = e.target.closest('canvas.group-minimap');
        if (!canvas || !canvas._hitRects) return;

        const rect = canvas.getBoundingClientRect();
        // Map CSS click to canvas pixel coords (canvas is stretched via CSS)
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        const cx = (e.clientX - rect.left) * scaleX;
        const cy = (e.clientY - rect.top) * scaleY;

        // Debug: draw click marker
        const dctx = canvas.getContext('2d');
        dctx.fillStyle = 'rgba(255,255,0,0.8)';
        dctx.beginPath();
        dctx.arc(cx, cy, 3, 0, Math.PI * 2);
        dctx.fill();

        // Find which rect was hit (reverse order = frontmost first)
        for (let i = canvas._hitRects.length - 1; i >= 0; i--) {
            const hr = canvas._hitRects[i];
            if (cx >= hr.px && cx <= hr.px + hr.pw && cy >= hr.py && cy <= hr.py + hr.ph) {
                // Flash the matched rect
                dctx.strokeStyle = 'rgba(255,255,0,1)';
                dctx.lineWidth = 2;
                dctx.strokeRect(hr.px, hr.py, hr.pw, hr.ph);

                const entry = registry.get(hr.id);
                const path = entry?.meta?.sourcePath || entry?.grid?.userData?.sourcePath;
                if (path) {
                    // Dispatch file-selected event so the tree panel syncs
                    window.dispatchEvent(new CustomEvent('file-selected', {
                        detail: { sourcePath: path }
                    }));
                    // Focus camera on the grid
                    if (animator && entry?.grid) {
                        const bounds = entry.grid.getBounds();
                        if (bounds && !bounds.isEmpty()) {
                            const bCenter = {
                                x: (bounds.min.x + bounds.max.x) / 2,
                                y: (bounds.min.y + bounds.max.y) / 2,
                            };
                            const bSize = {
                                x: bounds.max.x - bounds.min.x,
                                y: bounds.max.y - bounds.min.y,
                            };
                            const fovRad = camera.fov * Math.PI / 180;
                            const dH = (bSize.y / 0.85) / (2 * Math.tan(fovRad / 2));
                            const dW = (bSize.x / 0.85) / (2 * camera.aspect * Math.tan(fovRad / 2));
                            animator.animateTo(camera, 'position', {
                                x: bCenter.x,
                                y: bCenter.y,
                                z: bounds.max.z + Math.max(dH, dW, 10),
                            }, { duration: 0.3 });
                        }
                    }
                }
                break;
            }
        }
    });

    dissolveAllBtn.addEventListener('click', () => {
        spatialManager.clear();
        refresh();
    });

    setInterval(refresh, 500);
    refresh();
}

// ── Minimap rendering ────────────────────────────────────────

/**
 * Draw colored rectangles on each group's minimap canvas.
 * Uses a uniform-scale world→canvas transform (same algorithm as MinimapOverlay).
 */
function renderMinimaps(container, spatialManager, registry) {
    const canvases = container.querySelectorAll('canvas.group-minimap');
    for (const canvas of canvases) {
        const name = canvas.dataset.group;
        const group = spatialManager.getGroup(name);
        if (!group || group.memberIds.length === 0) continue;

        const color = spatialManager.getGroupColor(name);
        const ctx = canvas.getContext('2d');
        const cw = canvas.width;
        const ch = canvas.height;
        ctx.clearRect(0, 0, cw, ch);

        // Gather member bounds with their registry IDs
        const rects = [];
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const id of group.memberIds) {
            const entry = registry.get(id);
            const bounds = entry?.grid?.getBounds?.();
            if (!bounds || bounds.isEmpty()) continue;
            const x0 = bounds.min.x, y0 = bounds.min.y;
            const x1 = bounds.max.x, y1 = bounds.max.y;
            rects.push({ x0, y0, x1, y1, id });
            if (x0 < minX) minX = x0;
            if (y0 < minY) minY = y0;
            if (x1 > maxX) maxX = x1;
            if (y1 > maxY) maxY = y1;
        }
        if (rects.length === 0) continue;

        // Uniform scale with padding
        const pad = 6;
        const ww = maxX - minX || 1;
        const wh = maxY - minY || 1;
        const availW = cw - 2 * pad;
        const availH = ch - 2 * pad;
        const scale = Math.min(availW / ww, availH / wh);
        const offsetX = pad + (availW - ww * scale) / 2 - minX * scale;
        // Y is flipped: world +Y is up, canvas +Y is down
        const offsetY = ch - pad - (availH - wh * scale) / 2 + minY * scale;

        const r = color ? Math.round(color.r * 255) : 128;
        const g = color ? Math.round(color.g * 255) : 128;
        const b = color ? Math.round(color.b * 255) : 128;

        const hitRects = [];
        for (let i = 0; i < rects.length; i++) {
            const rc = rects[i];
            const px = rc.x0 * scale + offsetX;
            const py = offsetY - rc.y1 * scale; // flip Y
            const pw = (rc.x1 - rc.x0) * scale;
            const ph = (rc.y1 - rc.y0) * scale;

            ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${0.4 + 0.15 * (i / Math.max(rects.length - 1, 1))})`;
            ctx.fillRect(px, py, pw, ph);

            ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, 0.8)`;
            ctx.lineWidth = 1;
            ctx.strokeRect(px + 0.5, py + 0.5, pw - 1, ph - 1);

            hitRects.push({ px, py, pw, ph, id: rc.id });
        }
        // Store for click hit-testing
        canvas._hitRects = hitRects;
    }
}

/**
 * Smoothly animate camera to fit a group's bounds in view.
 */
function focusOnGroup(groupName, spatialManager, registry, animator, camera) {
    if (!animator || !camera) return;
    const group = spatialManager.getGroup(groupName);
    if (!group || group.memberIds.length === 0) return;

    // Compute union bounds of all group members
    const bounds = group.getBounds((id) => registry.get(id)?.grid || null);
    if (bounds.isEmpty()) return;

    const center = { x: 0, y: 0, z: 0 };
    const size = { x: 0, y: 0, z: 0 };
    center.x = (bounds.min.x + bounds.max.x) / 2;
    center.y = (bounds.min.y + bounds.max.y) / 2;
    center.z = (bounds.min.z + bounds.max.z) / 2;
    size.x = bounds.max.x - bounds.min.x;
    size.y = bounds.max.y - bounds.min.y;

    // Compute Z distance to fit the group (same math as VCC._zDistanceForFit)
    const fovRad = camera.fov * Math.PI / 180;
    const aspect = camera.aspect;
    const fill = 0.85;
    const dH = (size.y / fill) / (2 * Math.tan(fovRad / 2));
    const dW = (size.x / fill) / (2 * aspect * Math.tan(fovRad / 2));
    const distance = Math.max(dH, dW, 10);

    animator.animateTo(camera, 'position', {
        x: center.x,
        y: center.y,
        z: bounds.max.z + distance,
    }, { duration: 0.4 });
}

function esc(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
