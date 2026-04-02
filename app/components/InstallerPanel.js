/**
 * InstallerPanel — Agent-helper IDE installer UI.
 *
 * Detects visitor's OS/architecture, shows one-liner install commands,
 * manual download links, and agent-friendly instructions.
 */

const REPO = 'tikimcfee/glyph3d-js';
const BINARY = 'glyph3d-cli';

const PLATFORMS = [
    { os: 'linux',   arch: 'amd64', label: 'Linux x86_64',         file: `${BINARY}-linux-amd64` },
    { os: 'linux',   arch: 'arm64', label: 'Linux ARM64',          file: `${BINARY}-linux-arm64` },
    { os: 'darwin',  arch: 'amd64', label: 'macOS Intel',          file: `${BINARY}-darwin-amd64` },
    { os: 'darwin',  arch: 'arm64', label: 'macOS Apple Silicon',  file: `${BINARY}-darwin-arm64` },
    { os: 'windows', arch: 'amd64', label: 'Windows x86_64',      file: `${BINARY}-windows-amd64.exe` },
];

/**
 * Detect visitor's OS and architecture from browser APIs.
 * @returns {{ os: string, arch: string }}
 */
function detectPlatform() {
    const ua = navigator.userAgent.toLowerCase();
    const platform = (navigator.platform || '').toLowerCase();

    let os = 'linux'; // default
    if (ua.includes('mac') || platform.includes('mac'))       os = 'darwin';
    else if (ua.includes('win') || platform.includes('win'))  os = 'windows';

    let arch = 'amd64'; // default
    // ARM64 detection
    if (ua.includes('arm64') || ua.includes('aarch64') || platform.includes('arm')) {
        arch = 'arm64';
    }
    // navigator.userAgentData (Chromium 90+)
    if (navigator.userAgentData) {
        const pf = navigator.userAgentData.platform?.toLowerCase() || '';
        if (pf.includes('mac'))     os = 'darwin';
        else if (pf.includes('win')) os = 'windows';
        else if (pf.includes('linux')) os = 'linux';

        // High-entropy arch hint (may require getHighEntropyValues)
        try {
            navigator.userAgentData.getHighEntropyValues(['architecture']).then(data => {
                if (data.architecture === 'arm') arch = 'arm64';
            }).catch(() => {});
        } catch (_) { /* not available */ }
    }

    return { os, arch };
}

/**
 * Find the best matching platform entry.
 * @param {{ os: string, arch: string }} detected
 * @returns {typeof PLATFORMS[0]}
 */
function bestMatch(detected) {
    return PLATFORMS.find(p => p.os === detected.os && p.arch === detected.arch)
        || PLATFORMS.find(p => p.os === detected.os)
        || PLATFORMS[0];
}

/**
 * Generate the installer panel HTML.
 * @returns {string}
 */
export function installerPanelHTML() {
    const detected = detectPlatform();
    const match = bestMatch(detected);
    const releaseURL = `https://github.com/${REPO}/releases/latest`;

    const installCmd = match.os === 'windows'
        ? `irm https://raw.githubusercontent.com/${REPO}/main/tools/install.ps1 | iex`
        : `curl -fsSL https://raw.githubusercontent.com/${REPO}/main/tools/install.sh | sh`;

    const osLabel = { darwin: 'macOS', linux: 'Linux', windows: 'Windows' }[match.os] || match.os;
    const archLabel = match.arch === 'arm64' ? 'ARM64' : 'x86_64';

    return `
        <div class="installer-panel">
            <div class="setting-group">
                <div class="installer-detected">
                    Detected: <strong>${osLabel} ${archLabel}</strong>
                </div>
            </div>

            <div class="setting-group setting-section-header">Quick Install</div>
            <div class="setting-group">
                <div class="installer-cmd-wrap">
                    <code class="installer-cmd" id="install-cmd">${installCmd}</code>
                    <button class="installer-copy-btn" id="install-copy" title="Copy to clipboard">&#9112;</button>
                </div>
                <div class="setting-hint">
                    Downloads the latest <code>${match.file}</code> and installs to <code>~/.local/bin/</code>
                </div>
            </div>

            <div class="setting-group setting-section-header">Agent Instructions</div>
            <div class="setting-group">
                <div class="setting-hint" style="margin-bottom:8px">
                    For Claude Code or other AI agents &mdash; run this in a Bash tool:
                </div>
                <div class="installer-cmd-wrap">
                    <code class="installer-cmd" id="agent-cmd">${installCmd}</code>
                    <button class="installer-copy-btn" id="agent-copy" title="Copy to clipboard">&#9112;</button>
                </div>
                <div class="setting-hint" style="margin-top:6px">
                    Then start the server:
                </div>
                <div class="installer-cmd-wrap">
                    <code class="installer-cmd" id="serve-cmd">glyph3d-cli serve</code>
                    <button class="installer-copy-btn" id="serve-copy" title="Copy to clipboard">&#9112;</button>
                </div>
                <div class="setting-hint" style="margin-top:6px">
                    Open <code>http://localhost:8080/app/ide.html</code> to view.
                </div>
            </div>

            <div class="setting-group setting-section-header">Manual Download</div>
            <div class="setting-group">
                <div class="installer-downloads" id="installer-downloads">
                    ${PLATFORMS.map(p => {
                        const isCurrent = p.os === match.os && p.arch === match.arch;
                        return `
                            <a class="installer-dl-link${isCurrent ? ' current' : ''}"
                               href="${releaseURL}/download/${p.file}"
                               title="Download ${p.label}">
                                <span class="installer-dl-icon">${p.os === 'darwin' ? '\u{F8FF}' : p.os === 'windows' ? '\u{2756}' : '\u{1F427}'}</span>
                                <span class="installer-dl-label">${p.label}</span>
                                ${isCurrent ? '<span class="installer-dl-badge">your platform</span>' : ''}
                            </a>`;
                    }).join('')}
                </div>
                <div class="setting-hint" style="margin-top:8px">
                    <a href="${releaseURL}" target="_blank" rel="noopener"
                       style="color:var(--accent)">View all releases on GitHub</a>
                </div>
            </div>

            <div class="setting-group setting-section-header">Build from Source</div>
            <div class="setting-group">
                <div class="installer-cmd-wrap">
                    <code class="installer-cmd" id="build-cmd">git clone https://github.com/${REPO}.git && cd glyph3d-js && make</code>
                    <button class="installer-copy-btn" id="build-copy" title="Copy to clipboard">&#9112;</button>
                </div>
                <div class="setting-hint">
                    Requires Go 1.21+. Produces a ~8MB self-contained binary.
                </div>
            </div>

            <div class="setting-group setting-section-header">Verify Installation</div>
            <div class="setting-group">
                <div class="installer-cmd-wrap">
                    <code class="installer-cmd" id="verify-cmd">glyph3d-cli version</code>
                    <button class="installer-copy-btn" id="verify-copy" title="Copy to clipboard">&#9112;</button>
                </div>
            </div>
        </div>
    `;
}

/**
 * Wire copy-to-clipboard buttons after panel HTML is injected.
 * @param {HTMLElement} container - The panel DOM element
 */
export function initInstallerPanel(container) {
    if (!container) return;

    // Wire all copy buttons
    container.querySelectorAll('.installer-copy-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const cmdEl = btn.previousElementSibling;
            if (!cmdEl) return;
            const text = cmdEl.textContent.trim();
            navigator.clipboard.writeText(text).then(() => {
                btn.textContent = '\u2713';
                setTimeout(() => { btn.innerHTML = '&#9112;'; }, 1500);
            }).catch(() => {
                // Fallback: select text
                const range = document.createRange();
                range.selectNodeContents(cmdEl);
                const sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(range);
            });
        });
    });
}
