/**
 * HomeCommandBar — bottom-third command surface for the home page.
 *
 * Distinct from app/components/CommandBar.js (the 28px strip used inside
 * the production IDE). This one is a generous surface designed to BE the
 * page's interactive ground, not a footer under an editor.
 *
 * Visual model: terminal-flavored, not chat-app-flavored. Restrained color,
 * monospace, decisive feedback. Inspired by:
 *   - Claude.ai / ChatGPT composer  — growing textarea, Enter-submits,
 *                                     Shift+Enter newline
 *   - t3.chat                        — minimalism, keyboard-first
 *   - tmux command-prompt            — terminal feel, no chat-bubble UI
 *
 * Public API:
 *   const bar = new HomeCommandBar({ router })
 *   bar.mount(container)
 *   bar.dispose()
 *   bar.focus() / bar.blur()
 *   bar.setText(value, { focus, execute })
 *   bar.appendOutput(text, kind?)    // kind ∈ 'info'|'echo'|'response'|'error'
 *   bar.appendBlock(node)             // for richer output (a DOM node)
 */

const STYLE_ID = 'home-command-bar-styles';

export default class HomeCommandBar {
    /**
     * @param {Object} deps
     * @param {{ execute: Function }} deps.router  CommandRouter instance
     * @param {string} [deps.placeholder]
     */
    constructor({ router, placeholder } = {}) {
        if (!router || typeof router.execute !== 'function') {
            throw new Error('HomeCommandBar: router with .execute() is required');
        }
        this._router = router;
        this._placeholder = placeholder
            || 'Type a command, or just look around. (try: tour, help)';

        this._history = [];
        this._historyIdx = -1;
        this._stashedDraft = '';

        this._el = null;
        this._outputEl = null;
        this._inputEl = null;
        this._onKey = this._onKey.bind(this);
        this._onInput = this._onInput.bind(this);

        this._buildDOM();
        this._injectStyles();
    }

    // ─────────────────────────────────────────────────────────────────
    // DOM
    // ─────────────────────────────────────────────────────────────────

    _buildDOM() {
        this._el = document.createElement('section');
        this._el.id = 'home-command-bar';
        this._el.setAttribute('aria-label', 'Command surface');

        this._outputEl = document.createElement('div');
        this._outputEl.className = 'hcb-output';

        const inputWrap = document.createElement('div');
        inputWrap.className = 'hcb-input-wrap';

        const prompt = document.createElement('span');
        prompt.className = 'hcb-prompt';
        prompt.textContent = '›';

        this._inputEl = document.createElement('textarea');
        this._inputEl.className = 'hcb-input';
        this._inputEl.rows = 1;
        this._inputEl.spellcheck = false;
        this._inputEl.autocomplete = 'off';
        this._inputEl.autocapitalize = 'off';
        this._inputEl.placeholder = this._placeholder;

        inputWrap.appendChild(prompt);
        inputWrap.appendChild(this._inputEl);

        this._el.appendChild(this._outputEl);
        this._el.appendChild(inputWrap);

        this._inputEl.addEventListener('keydown', this._onKey);
        this._inputEl.addEventListener('input', this._onInput);
    }

    _injectStyles() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            #home-command-bar {
                position: fixed;
                left: 0; right: 0; bottom: 0;
                /* Bottom third of the viewport — clamped so it stays
                   readable on tall monitors and doesn't feel cramped on
                   short ones. */
                height: clamp(220px, 33vh, 420px);
                display: flex;
                flex-direction: column;
                background: linear-gradient(
                    to top,
                    rgba(8, 10, 16, 0.92) 0%,
                    rgba(8, 10, 16, 0.78) 70%,
                    rgba(8, 10, 16, 0.0)  100%
                );
                color: #d8d8e0;
                font-family: ui-monospace, "JetBrains Mono", "Fira Code",
                             Menlo, Consolas, monospace;
                font-size: 13px;
                line-height: 1.55;
                padding: 14px 22px 18px 22px;
                z-index: 10;
                pointer-events: auto;
                box-sizing: border-box;
            }
            .hcb-output {
                flex: 1;
                overflow-y: auto;
                overflow-x: hidden;
                padding-right: 6px;
                /* Hold output close to the input so new lines feel "near
                   the user's hand," not at the top of the panel. */
                display: flex;
                flex-direction: column;
                justify-content: flex-end;
                gap: 6px;
                min-height: 0;
            }
            .hcb-output::-webkit-scrollbar { width: 6px; }
            .hcb-output::-webkit-scrollbar-thumb {
                background: rgba(255,255,255,0.08);
                border-radius: 3px;
            }
            .hcb-line { white-space: pre-wrap; word-break: break-word; }
            .hcb-line.echo     { color: #7ad7a0; }   /* user input echo */
            .hcb-line.echo::before  { content: '› '; color: #4a8a64; }
            .hcb-line.response { color: #c8c8d0; }
            .hcb-line.info     { color: #8a8aa0; font-style: italic; }
            .hcb-line.error    { color: #ff8a8a; }
            .hcb-line.error::before { content: '! '; color: #cc4040; }

            .hcb-input-wrap {
                display: flex;
                align-items: flex-start;
                gap: 8px;
                margin-top: 10px;
                padding-top: 10px;
                border-top: 1px solid rgba(255,255,255,0.08);
            }
            .hcb-prompt {
                color: #7ad7a0;
                font-weight: 600;
                padding-top: 1px;
                user-select: none;
            }
            .hcb-input {
                flex: 1;
                background: transparent;
                border: none;
                outline: none;
                resize: none;
                color: #f0f0f5;
                font: inherit;
                caret-color: #7ad7a0;
                /* Grows up to ~6 lines, then scrolls — mirrors the
                   Claude/ChatGPT composer pattern. */
                max-height: 9.3em;
                overflow-y: auto;
                padding: 0;
                margin: 0;
                line-height: 1.55;
            }
            .hcb-input::placeholder {
                color: #5a5a70;
            }
        `;
        document.head.appendChild(style);
    }

    // ─────────────────────────────────────────────────────────────────
    // Lifecycle
    // ─────────────────────────────────────────────────────────────────

    /** @param {HTMLElement} container */
    mount(container) {
        (container || document.body).appendChild(this._el);
    }

    dispose() {
        this._inputEl.removeEventListener('keydown', this._onKey);
        this._inputEl.removeEventListener('input', this._onInput);
        this._el.remove();
    }

    focus() { this._inputEl.focus(); }
    blur()  { this._inputEl.blur(); }

    /**
     * Pre-fill the input. Used by TryThisCluster invitations that want the
     * visitor to see the command in the bar before they hit Enter (more
     * teaching than just executing for them).
     * @param {string} value
     * @param {{ focus?: boolean, execute?: boolean }} [opts]
     */
    setText(value, { focus = true, execute = false } = {}) {
        this._inputEl.value = value;
        this._autosize();
        if (focus) this._inputEl.focus();
        if (execute) this._submit();
    }

    // ─────────────────────────────────────────────────────────────────
    // Output
    // ─────────────────────────────────────────────────────────────────

    /**
     * Append a line to the output history.
     * @param {string} text
     * @param {'info'|'echo'|'response'|'error'} [kind='response']
     */
    appendOutput(text, kind = 'response') {
        const line = document.createElement('div');
        line.className = `hcb-line ${kind}`;
        line.textContent = text;
        this._outputEl.appendChild(line);
        this._scrollToBottom();
    }

    /**
     * Append an arbitrary DOM node (richer output: tables, multi-line blocks
     * with internal structure). The node receives no class — caller styles it.
     * @param {Node} node
     */
    appendBlock(node) {
        this._outputEl.appendChild(node);
        this._scrollToBottom();
    }

    clearOutput() {
        while (this._outputEl.firstChild) this._outputEl.removeChild(this._outputEl.firstChild);
    }

    _scrollToBottom() {
        // requestAnimationFrame so layout has settled before we scroll —
        // otherwise long output appended in a tight loop scrolls to a
        // stale height.
        requestAnimationFrame(() => {
            this._outputEl.scrollTop = this._outputEl.scrollHeight;
        });
    }

    // ─────────────────────────────────────────────────────────────────
    // Input handling
    // ─────────────────────────────────────────────────────────────────

    _onKey(e) {
        // Enter submits; Shift+Enter inserts newline. Same as Claude/ChatGPT.
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            this._submit();
            return;
        }

        // History: ArrowUp/Down only when cursor is at top/bottom of the
        // textarea, so multiline editing keeps working normally.
        if (e.key === 'ArrowUp' && this._atLineStart()) {
            if (this._history.length === 0) return;
            e.preventDefault();
            if (this._historyIdx === -1) this._stashedDraft = this._inputEl.value;
            if (this._historyIdx < this._history.length - 1) {
                this._historyIdx++;
                this._inputEl.value = this._history[this._history.length - 1 - this._historyIdx];
                this._autosize();
                this._moveCursorToEnd();
            }
            return;
        }
        if (e.key === 'ArrowDown' && this._atLineEnd()) {
            if (this._historyIdx < 0) return;
            e.preventDefault();
            if (this._historyIdx > 0) {
                this._historyIdx--;
                this._inputEl.value = this._history[this._history.length - 1 - this._historyIdx];
            } else {
                this._historyIdx = -1;
                this._inputEl.value = this._stashedDraft;
            }
            this._autosize();
            this._moveCursorToEnd();
            return;
        }
    }

    _onInput() {
        this._autosize();
    }

    /**
     * Textarea auto-grow: reset height, then set to scrollHeight clamped
     * by max-height (CSS). Inexpensive on every keystroke.
     */
    _autosize() {
        this._inputEl.style.height = 'auto';
        this._inputEl.style.height = this._inputEl.scrollHeight + 'px';
    }

    _atLineStart() {
        const i = this._inputEl.selectionStart;
        return i === 0 || this._inputEl.value.lastIndexOf('\n', i - 1) === -1;
    }
    _atLineEnd() {
        const v = this._inputEl.value;
        const i = this._inputEl.selectionStart;
        return i === v.length || v.indexOf('\n', i) === -1;
    }
    _moveCursorToEnd() {
        const len = this._inputEl.value.length;
        this._inputEl.setSelectionRange(len, len);
    }

    // ─────────────────────────────────────────────────────────────────
    // Submission
    // ─────────────────────────────────────────────────────────────────

    async _submit() {
        const raw = this._inputEl.value.trim();
        if (!raw) return;

        this._inputEl.value = '';
        this._autosize();
        this._history.push(raw);
        this._historyIdx = -1;
        this._stashedDraft = '';

        this.appendOutput(raw, 'echo');

        try {
            const result = await this._router.execute(raw);
            const text = (result && typeof result.text === 'string') ? result.text : 'OK';
            this.appendOutput(text, 'response');
        } catch (err) {
            this.appendOutput(err?.message || String(err), 'error');
        }
    }
}
