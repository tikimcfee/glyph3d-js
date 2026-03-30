/**
 * CommandBar -- unified input surface for the IDE shell.
 *
 * Modes:
 *   :CMD     -- executes via CommandRouter (same syntax as glyph-cli)
 *   >termId  -- keystrokes routed to targeted TerminalGrid via terminal.input
 *
 * Integration points:
 *   - CommandRouter.execute() for command dispatch
 *   - TUIFocusManager focus events for auto-targeting terminals
 *   - CameraController.enabled for focus gating
 *   - Mounted inline in #editor-column (before #panel-resize)
 *
 * Works even when WebSocket is disconnected -- local commands execute directly.
 */
import { primaryMod } from '../../github-viewer/platform.js';

import { encodeBase64 } from '../../github-viewer/websocket/commands/encoding.js';

const MODES = { COMMAND: 'command', TERMINAL: 'terminal' };

export default class CommandBar {
    /**
     * @param {Object} deps
     * @param {import('../websocket/CommandRouter.js').default} deps.router
     * @param {Object} [deps.cameraController] - disabled when bar is focused
     * @param {Object} [deps.context] - command context bag (has .terminals, .registry)
     */
    constructor({ router, cameraController, context }) {
        this._router = router;
        this._cameraCtrl = cameraController;
        this._ctx = context || router.context;

        // State
        this._mode = MODES.COMMAND;
        this._targetTerminalId = null;
        this._active = false;

        // History
        this._history = [];
        this._historyIndex = -1;
        this._currentInput = '';  // stash for in-progress input on ArrowUp

        // DOM
        this._el = null;
        this._input = null;
        this._badge = null;
        this._outputEl = null;
        this._buildDOM();
        this._injectStyles();

        // Event bindings
        this._onInputKeyDown = this._handleInputKeyDown.bind(this);
        this._onInputFocus = () => this._setActive(true);
        this._onInputBlur = () => this._setActive(false);
        this._onGlobalKeyDown = this._handleGlobalKeyDown.bind(this);

        this._input.addEventListener('keydown', this._onInputKeyDown);
        this._input.addEventListener('focus', this._onInputFocus);
        this._input.addEventListener('blur', this._onInputBlur);
        document.addEventListener('keydown', this._onGlobalKeyDown);
    }

    // ================================================================
    // DOM Construction
    // ================================================================

    _buildDOM() {
        this._el = document.createElement('div');
        this._el.id = 'command-bar';

        this._badge = document.createElement('span');
        this._badge.className = 'cmd-badge cmd-mode';
        this._badge.textContent = ':CMD';

        this._input = document.createElement('input');
        this._input.className = 'cmd-input';
        this._input.type = 'text';
        this._input.spellcheck = false;
        this._input.autocomplete = 'off';
        this._input.placeholder = 'Type a command (e.g. help, grid.list, terminal.list)...';

        this._outputEl = document.createElement('div');
        this._outputEl.className = 'cmd-output';

        this._el.appendChild(this._badge);
        this._el.appendChild(this._input);
        this._el.appendChild(this._outputEl);
    }

    _injectStyles() {
        if (document.getElementById('command-bar-styles')) return;
        const style = document.createElement('style');
        style.id = 'command-bar-styles';
        style.textContent = `
            #command-bar {
                display: flex;
                align-items: center;
                height: 28px;
                min-height: 28px;
                background: var(--bg-panel, #141420);
                border-top: 1px solid var(--border-color, #2a2a3a);
                padding: 0 8px;
                gap: 6px;
                position: relative;
                flex-shrink: 0;
            }
            #command-bar.active {
                border-top-color: var(--accent, #00ff88);
            }
            .cmd-badge {
                font-size: 10px;
                font-weight: 600;
                font-family: var(--font-mono, monospace);
                padding: 1px 6px;
                border-radius: 3px;
                white-space: nowrap;
                flex-shrink: 0;
                user-select: none;
            }
            .cmd-badge.cmd-mode {
                background: #1a3a2a;
                color: var(--accent, #00ff88);
                border: 1px solid var(--accent-dim, #00cc66);
            }
            .cmd-badge.term-mode {
                background: #1a2a3a;
                color: #569cd6;
                border: 1px solid #4080b0;
            }
            .cmd-input {
                flex: 1;
                background: transparent;
                border: none;
                outline: none;
                color: var(--text-primary, #cccccc);
                font-family: var(--font-mono, monospace);
                font-size: var(--font-size-base, 12px);
                caret-color: var(--accent, #00ff88);
                min-width: 0;
            }
            .cmd-input::placeholder {
                color: var(--text-secondary, #666688);
                font-size: var(--font-size-sm, 11px);
            }
            .cmd-output {
                position: absolute;
                bottom: 100%;
                left: 0;
                right: 0;
                background: var(--bg-panel, #141420);
                border-top: 1px solid var(--border-color, #2a2a3a);
                padding: 4px 8px;
                font-family: var(--font-mono, monospace);
                font-size: var(--font-size-sm, 11px);
                color: var(--text-secondary, #666688);
                max-height: 120px;
                overflow-y: auto;
                white-space: pre-wrap;
                display: none;
            }
            .cmd-output.visible {
                display: block;
            }
        `;
        document.head.appendChild(style);
    }

    // ================================================================
    // Lifecycle
    // ================================================================

    /**
     * Mount the command bar into a container element.
     * Inserts before #panel-resize if found, otherwise appends.
     * @param {HTMLElement} container
     */
    mount(container) {
        const panelResize = container.querySelector('#panel-resize');
        if (panelResize) {
            container.insertBefore(this._el, panelResize);
        } else {
            container.appendChild(this._el);
        }
    }

    dispose() {
        this._input.removeEventListener('keydown', this._onInputKeyDown);
        this._input.removeEventListener('focus', this._onInputFocus);
        this._input.removeEventListener('blur', this._onInputBlur);
        document.removeEventListener('keydown', this._onGlobalKeyDown);
        this._el.remove();
    }

    // ================================================================
    // Focus & Active State
    // ================================================================

    _setActive(active) {
        this._active = active;
        this._el.classList.toggle('active', active);

        // Gate camera controls
        if (this._cameraCtrl) {
            if (active) {
                this._cameraCtrl._cmdBarPrevEnabled = this._cameraCtrl.enabled;
                this._cameraCtrl.enabled = false;
            } else {
                if (this._cameraCtrl._cmdBarPrevEnabled !== undefined) {
                    this._cameraCtrl.enabled = this._cameraCtrl._cmdBarPrevEnabled;
                    delete this._cameraCtrl._cmdBarPrevEnabled;
                }
            }
        }
    }

    /** Programmatic focus */
    focus() { this._input.focus(); }

    /** Programmatic blur */
    blur() { this._input.blur(); }

    // ================================================================
    // Mode Switching & Terminal Targeting
    // ================================================================

    /**
     * Switch to terminal target mode.
     * Called by TUIFocusManager integration or Shift+Click.
     * @param {string} terminalId
     */
    setTarget(terminalId) {
        // Unhighlight previous target
        if (this._targetTerminalId && this._targetTerminalId !== terminalId) {
            this._unhighlightTerminal(this._targetTerminalId);
        }

        this._mode = MODES.TERMINAL;
        this._targetTerminalId = terminalId;

        this._badge.textContent = `>${terminalId}`;
        this._badge.className = 'cmd-badge term-mode';
        this._input.placeholder = `Typing to terminal "${terminalId}" -- Escape to exit`;

        this._highlightTerminal(terminalId);
    }

    /**
     * Clear terminal target, return to CMD mode.
     */
    clearTarget() {
        if (this._targetTerminalId) {
            this._unhighlightTerminal(this._targetTerminalId);
        }
        this._mode = MODES.COMMAND;
        this._targetTerminalId = null;

        this._badge.textContent = ':CMD';
        this._badge.className = 'cmd-badge cmd-mode';
        this._input.placeholder = 'Type a command (e.g. help, grid.list, terminal.list)...';
    }

    _highlightTerminal(id) {
        const grid = this._ctx.terminals?.get(id);
        if (!grid?._background) return;
        if (grid._background._cmdBarOrigColor !== undefined) return; // already highlighted
        grid._background._cmdBarOrigColor = grid._background.material.color.getHex();
        grid._background._cmdBarOrigOpacity = grid._background.material.opacity;
        grid._background.material.color.set(0x569cd6);
        grid._background.material.opacity = 0.95;
    }

    _unhighlightTerminal(id) {
        const grid = this._ctx.terminals?.get(id);
        if (!grid?._background) return;
        if (grid._background._cmdBarOrigColor !== undefined) {
            grid._background.material.color.set(grid._background._cmdBarOrigColor);
            grid._background.material.opacity = grid._background._cmdBarOrigOpacity;
            delete grid._background._cmdBarOrigColor;
            delete grid._background._cmdBarOrigOpacity;
        }
    }

    // ================================================================
    // Keyboard Handling
    // ================================================================

    /** Global shortcut: Ctrl+` or Cmd+` to toggle focus */
    _handleGlobalKeyDown(e) {
        if (primaryMod(e) && e.key === '`') {
            e.preventDefault();
            if (this._active) {
                this._input.blur();
            } else {
                this.focus();
            }
        }
    }

    /** Input-local keydown when the bar is focused */
    _handleInputKeyDown(e) {
        // Stop propagation for all keystrokes while focused to prevent
        // camera controller / ShortcutManager from acting on them.
        e.stopPropagation();

        if (e.key === 'Escape') {
            e.preventDefault();
            if (this._mode === MODES.TERMINAL) {
                // Stage 1: terminal mode -> command mode
                this.clearTarget();
            } else {
                // Stage 2: command mode -> blur (dismiss output too)
                this._hideOutput();
                this._input.blur();
            }
            return;
        }

        if (e.key === 'Enter') {
            const value = this._input.value;
            if (!value) return;
            e.preventDefault();

            if (this._mode === MODES.COMMAND) {
                this._executeCommand(value);
            } else {
                this._sendToTerminal(value);
            }

            this._input.value = '';
            return;
        }

        // Tab completion in CMD mode
        if (e.key === 'Tab' && this._mode === MODES.COMMAND) {
            e.preventDefault();
            this._tabComplete();
            return;
        }

        // History navigation in command mode
        if (this._mode === MODES.COMMAND) {
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (this._history.length === 0) return;
                // Stash current input before entering history
                if (this._historyIndex === -1) {
                    this._currentInput = this._input.value;
                }
                if (this._historyIndex < this._history.length - 1) {
                    this._historyIndex++;
                    this._input.value = this._history[this._history.length - 1 - this._historyIndex];
                }
                return;
            }
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                if (this._historyIndex > 0) {
                    this._historyIndex--;
                    this._input.value = this._history[this._history.length - 1 - this._historyIndex];
                } else if (this._historyIndex === 0) {
                    this._historyIndex = -1;
                    this._input.value = this._currentInput;
                }
                return;
            }
        }
    }

    // ================================================================
    // Command Execution
    // ================================================================

    async _executeCommand(input) {
        this._history.push(input);
        this._historyIndex = -1;
        this._currentInput = '';

        try {
            const result = await this._router.execute(input);
            this._showOutput(result.text || 'OK');
        } catch (err) {
            this._showOutput(`ERR: ${err.message}`);
        }
    }

    async _sendToTerminal(text) {
        const id = this._targetTerminalId;
        const grid = this._ctx.terminals?.get(id);
        if (!grid) {
            this._showOutput(`ERR: terminal '${id}' no longer exists`);
            this.clearTarget();
            return;
        }

        // Route through the command system: base64-encode the text,
        // then execute terminal.input. This ensures logging, middleware,
        // and onInput callback dispatch all fire correctly.
        const b64 = encodeBase64(text);
        try {
            const result = await this._router.execute(`terminal.input ${id} ${b64}`);
            this._showOutput(result.text || 'OK');
        } catch (err) {
            this._showOutput(`ERR: ${err.message}`);
        }
    }

    // ================================================================
    // Tab Completion
    // ================================================================

    _tabComplete() {
        const input = this._input.value.trim();
        if (!input) return;

        const commands = this._router.listCommands();
        const matches = commands.filter(c => c.name.startsWith(input.toLowerCase()));

        if (matches.length === 0) {
            this._showOutput('No matching commands');
        } else if (matches.length === 1) {
            this._input.value = matches[0].name + ' ';
            this._hideOutput();
        } else {
            // Show all matches
            const text = matches.map(c => {
                const desc = c.description ? ` -- ${c.description}` : '';
                return `  ${c.name}${desc}`;
            }).join('\n');
            this._showOutput(text);

            // Auto-complete common prefix
            const prefix = this._commonPrefix(matches.map(c => c.name));
            if (prefix.length > input.length) {
                this._input.value = prefix;
            }
        }
    }

    _commonPrefix(strings) {
        if (strings.length === 0) return '';
        let prefix = strings[0];
        for (let i = 1; i < strings.length; i++) {
            while (!strings[i].startsWith(prefix)) {
                prefix = prefix.slice(0, -1);
            }
        }
        return prefix;
    }

    // ================================================================
    // Output
    // ================================================================

    _showOutput(text) {
        this._outputEl.textContent = text;
        this._outputEl.classList.add('visible');
    }

    _hideOutput() {
        this._outputEl.classList.remove('visible');
    }
}
