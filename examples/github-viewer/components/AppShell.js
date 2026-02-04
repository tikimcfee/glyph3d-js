/**
 * AppShell Component
 *
 * Creates the static UI shell: header, loading overlay, FPS badge, and toast.
 * These are small, shared elements used across the app.
 */

/**
 * Create the header bar
 * @param {HTMLElement} container - Parent element
 * @returns {{ element: HTMLElement, repoLabel: HTMLElement }}
 */
export function createHeader(container) {
    const header = document.createElement('div');
    header.id = 'header';
    header.innerHTML = `
        <h1>GitHub 3D</h1>
        <span id="header-repo-label"></span>
        <a href="https://buymeacoffee.com/tikimcfee" target="_blank" rel="noopener" class="bmc-link">&#9749; support</a>
    `;
    container.appendChild(header);

    return {
        element: header,
        repoLabel: header.querySelector('#header-repo-label')
    };
}

/**
 * Create the loading overlay with progress bar
 * @param {HTMLElement} container - Parent element
 * @returns {{ element: HTMLElement, show: Function, hide: Function, update: Function }}
 */
export function createLoadingOverlay(container) {
    const loading = document.createElement('div');
    loading.id = 'loading';
    loading.className = 'hidden';
    loading.innerHTML = `
        <h2>Loading Repository</h2>
        <div id="progress-bar"><div id="progress-fill"></div></div>
        <div id="progress-text">Initializing...</div>
    `;
    container.appendChild(loading);

    const progressFill = loading.querySelector('#progress-fill');
    const progressText = loading.querySelector('#progress-text');

    return {
        element: loading,
        show(message) {
            loading.classList.remove('hidden');
            progressText.textContent = message;
        },
        hide() {
            loading.classList.add('hidden');
        },
        update(percent, message) {
            progressFill.style.width = (percent * 100) + '%';
            progressText.textContent = message;
        }
    };
}

/**
 * Create the floating FPS badge
 * @param {HTMLElement} container - Parent element
 * @returns {{ element: HTMLElement, fpsSpan: HTMLElement }}
 */
export function createFPSBadge(container) {
    const badge = document.createElement('div');
    badge.id = 'fps-badge';
    badge.innerHTML = `<span id="fps">--</span> fps`;
    container.appendChild(badge);

    return {
        element: badge,
        fpsSpan: badge.querySelector('#fps')
    };
}

/**
 * Create the toast notification element
 * @param {HTMLElement} container - Parent element
 * @returns {{ element: HTMLElement, show: Function }}
 */
export function createToast(container) {
    const toast = document.createElement('div');
    toast.id = 'toast';
    toast.className = 'hidden';
    container.appendChild(toast);

    let hideTimeout = null;

    return {
        element: toast,
        show(message, type = '') {
            if (hideTimeout) clearTimeout(hideTimeout);
            toast.textContent = message;
            toast.className = type;
            hideTimeout = setTimeout(() => {
                toast.classList.add('hidden');
            }, 3000);
        }
    };
}
