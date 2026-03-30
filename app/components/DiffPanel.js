/**
 * DiffPanel Component
 *
 * Drawer panel for loading and viewing PR diffs.
 * Provides PR URL input, file list with change stats, and diff summary.
 */

/** Panel HTML for drawer registration */
export function diffPanelHTML() {
    return `
        <div class="repo-section">
            <label class="repo-label" for="diff-pr-input">Pull Request URL</label>
            <input type="text" id="diff-pr-input" class="repo-input"
                   placeholder="owner/repo#123 or full PR URL">
        </div>
        <div class="repo-section">
            <button id="diff-load-btn" class="repo-btn">Load Diff</button>
        </div>
        <div id="diff-status" class="diff-status"></div>
        <div id="diff-summary" class="diff-summary hidden"></div>
        <div id="diff-file-list" class="diff-file-list"></div>
    `;
}

/**
 * Initialize diff panel interactivity
 * @param {HTMLElement} panel - The panel element
 * @param {Object} callbacks - Event callbacks
 * @param {Function} callbacks.onLoadPR - Called with parsed PR input when Load clicked
 * @param {Function} callbacks.onFileClick - Called with file index when file item clicked
 */
export function initDiffPanel(panel, callbacks = {}) {
    const prInput = panel.querySelector('#diff-pr-input');
    const loadBtn = panel.querySelector('#diff-load-btn');
    const statusEl = panel.querySelector('#diff-status');
    const summaryEl = panel.querySelector('#diff-summary');
    const fileListEl = panel.querySelector('#diff-file-list');

    loadBtn.addEventListener('click', () => {
        if (callbacks.onLoadPR) {
            callbacks.onLoadPR(prInput.value);
        }
    });

    prInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && callbacks.onLoadPR) {
            callbacks.onLoadPR(prInput.value);
        }
    });

    return {
        setStatus(message, type = 'info') {
            statusEl.textContent = message;
            statusEl.className = `diff-status ${type}`;
        },

        setLoading(loading) {
            loadBtn.disabled = loading;
            loadBtn.textContent = loading ? 'Loading...' : 'Load Diff';
        },

        showSummary(prData) {
            summaryEl.classList.remove('hidden');
            summaryEl.innerHTML = `
                <div class="diff-pr-title">${escapeHTML(prData.title)}</div>
                <div class="diff-pr-meta">
                    <span class="diff-pr-author">${escapeHTML(prData.author)}</span>
                    <span class="diff-pr-state ${prData.state}">${prData.state}</span>
                </div>
                <div class="diff-pr-stats">
                    <span class="diff-stat-add">+${prData.additions}</span>
                    <span class="diff-stat-remove">-${prData.deletions}</span>
                    <span class="diff-stat-files">${prData.changedFiles} files</span>
                </div>
            `;
        },

        showFileList(fileData) {
            fileListEl.innerHTML = '';
            fileData.forEach((file, idx) => {
                const item = document.createElement('div');
                item.className = `diff-file-item ${file.status}`;
                item.innerHTML = `
                    <span class="diff-file-status">${statusBadge(file.status)}</span>
                    <span class="diff-file-name">${escapeHTML(file.filename)}</span>
                    <span class="diff-file-stats">
                        <span class="diff-stat-add">+${file.additions}</span>
                        <span class="diff-stat-remove">-${file.deletions}</span>
                    </span>
                `;
                item.addEventListener('click', () => {
                    if (callbacks.onFileClick) callbacks.onFileClick(idx);
                    // Highlight selected
                    fileListEl.querySelectorAll('.diff-file-item').forEach(el =>
                        el.classList.toggle('selected', el === item)
                    );
                });
                fileListEl.appendChild(item);
            });
        },

        clear() {
            statusEl.textContent = '';
            summaryEl.classList.add('hidden');
            summaryEl.innerHTML = '';
            fileListEl.innerHTML = '';
        }
    };
}

function statusBadge(status) {
    switch (status) {
        case 'added':    return '<span class="badge badge-added">A</span>';
        case 'removed':  return '<span class="badge badge-removed">D</span>';
        case 'modified': return '<span class="badge badge-modified">M</span>';
        case 'renamed':  return '<span class="badge badge-renamed">R</span>';
        default:         return '<span class="badge">' + escapeHTML(status[0]?.toUpperCase() || '?') + '</span>';
    }
}

function escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
}
