/**
 * AgentPrompt — a floating input field bound to one agent.
 *
 * This is the canvas-side controller input: an editable CodeGrid used as a prompt line
 * rather than as a document. It carries no transport of its own — it takes text, and on
 * submit hands it to `onSubmit`. Whoever builds it decides where that goes (for Multica,
 * a chat message; for anything else, whatever verb fits). That keeps the primitive
 * reusable and keeps core free of any binding's specifics.
 *
 * Why an editable field rather than a TerminalGrid: our terminals are tmux-backed
 * through the relay, which is exactly right for a shell and exactly wrong here — there
 * is no process on the other end, just an HTTP call. A CodeGrid already has the caret,
 * the edit ops, and the glyph substrate; the only thing it lacks is submit-on-Enter,
 * which is this class.
 *
 * Typing arrives through the keyboard responder chain's entity-typing tier: register the
 * prompt with `type: 'prompt'` and give it the `key` attention slot, and keystrokes land
 * on the edit ops below. Enter submits; Shift+Enter inserts a real newline, so a
 * multi-line message is still possible.
 *
 * The prompt keeps a small history — submitted lines are recallable with up/down, which
 * is the one affordance that makes a field like this usable for repeated work.
 */

import CodeGrid from './CodeGrid.js';

export const AGENT_PROMPT_DEFAULTS = {
    placeholder: '…',           // shown when the buffer is empty, so the field is visible at rest
    maxHistory: 50,             // recallable submissions
    backgroundColor: 0x141428,  // distinct from a book page — this is chrome, not content
    backgroundOpacity: 0.94,
    showFilename: true,
};

export default class AgentPrompt {
    /**
     * @param {Object} ctx host context — needs `scene` and `atlas`
     * @param {Object} opts
     * @param {string} opts.id registry id for this prompt (also the attention key target)
     * @param {string} opts.agentId the agent this prompt talks to
     * @param {string} [opts.label] display name shown on the field
     * @param {(text: string, prompt: AgentPrompt) => (void|Promise<void>)} opts.onSubmit
     * @param {Object} [opts.config] overrides for AGENT_PROMPT_DEFAULTS
     * @param {(ctx: Object, gridOpts: Object) => Object} [opts.createGrid] builds the
     *   backing surface. Defaults to a CodeGrid; overridden by tests, which have no
     *   WebGPU device and no atlas, and by any host that wants a different surface.
     */
    constructor(ctx, { id, agentId, label, onSubmit, config, createGrid } = {}) {
        if (!id) throw new Error('AgentPrompt: id is required');
        if (typeof onSubmit !== 'function') throw new Error('AgentPrompt: onSubmit is required');

        this.cfg = { ...AGENT_PROMPT_DEFAULTS, ...(config || {}) };
        this.id = id;
        this.agentId = agentId ?? null;
        this.label = label || agentId || id;
        this.onSubmit = onSubmit;

        /** Submitted lines, newest last. */
        this.history = [];
        /** Where up/down recall currently sits; null = editing a fresh line. */
        this._historyIndex = null;
        /** Held while a submit is in flight, so Enter can't double-send. */
        this.sending = false;

        const build = createGrid || ((c, o) => new CodeGrid(c.scene, c.atlas, o));
        this.grid = build(ctx, {
            name: `prompt:${this.label}`,
            showFilename: this.cfg.showFilename,
            showBackground: true,
            backgroundColor: this.cfg.backgroundColor,
            backgroundOpacity: this.cfg.backgroundOpacity,
        });
        this.ready = this.grid.loadFile(`▸ ${this.label}`, '').then(() => {
            this.grid.enterEdit?.();
            return this;
        });
    }

    /** The Object3D to place in the scene. */
    get object3d() { return this.grid; }

    /** Current buffer contents. */
    get text() { return (this.grid.lines || []).join('\n'); }

    // -- editing ------------------------------------------------------------

    /** @param {string} ch */
    insert(ch) { this._touch(); this.grid.editInsert(ch); }
    deleteBackward() { this._touch(); this.grid.editDeleteBackward(); }
    deleteForward() { this._touch(); this.grid.editDeleteForward(); }
    /** @param {number} dx @param {number} dy */
    moveCursor(dx, dy) { this.grid.editMoveCursor(dx, dy); }
    home() { this.grid.editHome(); }
    end() { this.grid.editEnd(); }
    /** Shift+Enter — a real newline inside the message. */
    newline() { this._touch(); this.grid.editSplitLine(); }

    /**
     * Send the buffer and clear it. Empty (or whitespace-only) input is ignored rather
     * than sent, and a submit already in flight is dropped — a held Enter must not fan
     * out into duplicate messages to an agent.
     * @returns {Promise<boolean>} whether anything was sent
     */
    async submit() {
        if (this.sending) return false;
        const text = this.text.trim();
        if (!text) return false;

        this.sending = true;
        try {
            await this.onSubmit(text, this);
            this.history.push(text);
            if (this.history.length > this.cfg.maxHistory) this.history.shift();
            this._historyIndex = null;
            await this.setText('');
            return true;
        } finally {
            // Cleared even when onSubmit throws: a wedged field that silently eats every
            // later keystroke is worse than a failed send the caller already reported.
            this.sending = false;
        }
    }

    /**
     * Recall a previous submission. -1 walks back through history, +1 forward; walking
     * past the newest entry returns to the empty line being composed.
     * @param {number} dir
     */
    async recall(dir) {
        if (!this.history.length) return;
        const last = this.history.length - 1;
        let next;
        if (this._historyIndex === null) {
            next = dir < 0 ? last : null;
        } else {
            next = this._historyIndex + (dir < 0 ? -1 : 1);
            if (next < 0) next = 0;
            if (next > last) next = null;
        }
        this._historyIndex = next;
        await this.setText(next === null ? '' : this.history[next]);
    }

    /**
     * Replace the buffer. Reloads the grid rather than diffing — a prompt line is short,
     * and the edit path's cursor preservation is for documents.
     * @param {string} text
     */
    async setText(text) {
        await this.grid.loadFile(`▸ ${this.label}`, text);
        this.grid.enterEdit?.();
        this.grid.editEnd?.();
    }

    /** @param {{x: number, y: number, z: number}} pos */
    setPosition({ x, y, z }) { this.grid.position.set(x, y, z); }

    dispose() {
        this.grid.exitEdit?.();
        this.grid.dispose?.();
    }

    /** Any manual edit abandons history recall — you're composing again. @private */
    _touch() { this._historyIndex = null; }
}
