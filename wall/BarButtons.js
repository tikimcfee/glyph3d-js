import { holdPress } from './holdPress.js';

const STYLE = {
    color: '#9aa3b2', hover: '#e6e9ef', active: '#8ef0b8',
    background: 'transparent', hoverBackground: 'rgba(255,255,255,0.07)', activeBackground: 'rgba(110, 231, 160, 0.14)',
};

/**
 * BarButtons — the small cluster on the hovered terminal's title bar: agent view (toggle its transcript
 * stream), hide (an instant click) and close (held: the ring fills over the wall's closeHoldMs and the
 * terminal is killed when it closes; let go early and nothing happens). DOM over the canvas, placed in
 * the same frame the canvas renders (the wall's tick), at the bar's right end — the bar keeps that room
 * clear of its name (WallNames.BAR_BUTTON_ROOM). All buttons run wall verbs; the held close chord
 * (WallKeys) drives the same ring through holdKey / releaseKey.
 */
export default class BarButtons {
    /**
     * @param {HTMLElement} host - the element the canvas fills
     * @param {{ onAgent?: (id: string) => void, isAgentOpen?: (id: string) => boolean,
     *           onHide: (id: string) => void, onClose: (id: string) => void,
     *           holdMs: () => number, minPx: () => number }} o
     *   holdMs: the close hold, read at each press; minPx: the shortest bar (CSS px) that shows the cluster
     */
    constructor(host, { onAgent, isAgentOpen, onHide, onClose, holdMs, minPx }) {
        this._minPx = minPx;
        this._isAgentOpen = isAgentOpen ?? (() => false);
        this._agentHovered = false;
        this._root = document.createElement('div');
        this._root.dataset.barButtons = '';
        Object.assign(this._root.style, {
            position: 'absolute', left: '0', top: '0', display: 'none', gap: '2px', alignItems: 'center',
            zIndex: '6', willChange: 'transform',
        });
        /** The terminal the cluster is on. @type {string|null} */
        this.id = null;
        this.agent = this._button('≡', 'agent view (live transcript events alongside this terminal)');
        this.agent.dataset.action = 'agent';
        this.agent.addEventListener('pointerenter', () => { this._agentHovered = true; this._paintAgent(); });
        this.agent.addEventListener('pointerleave', () => { this._agentHovered = false; this._paintAgent(); });
        this.agent.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            e.preventDefault(); e.stopPropagation();
            if (this.id && onAgent) onAgent(this.id);
        });
        this.hide = this._button('–', 'hide (it keeps running; the sidebar and the palette bring it back)');
        this.hide.dataset.action = 'hide';
        this.hide.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            e.preventDefault(); e.stopPropagation();
            if (this.id) onHide(this.id);
        });
        this.close = this._button('×', 'hold to close (kills the shell)');
        this.close.dataset.action = 'close';
        this._hold = holdPress(this.close, { ms: holdMs, onDone: () => { if (this._holdId) onClose(this._holdId); this._holdId = null; } });
        this.close.addEventListener('pointerdown', () => { this._holdId = this.id; }, true);
        /** The terminal a close hold is running for (the cluster stays on it while held). */
        this._holdId = null;
        host.appendChild(this._root);
        this._key = '';
    }

    _button(text, title) {
        const b = document.createElement('button');
        b.textContent = text;
        b.title = title;
        Object.assign(b.style, {
            width: '18px', height: '18px', padding: '0', border: 'none', borderRadius: '4px', font: '13px/18px ui-monospace, monospace',
            color: STYLE.color, background: STYLE.background, cursor: 'pointer', position: 'relative', textAlign: 'center',
        });
        b.addEventListener('pointerenter', () => { b.style.color = STYLE.hover; b.style.background = STYLE.hoverBackground; });
        b.addEventListener('pointerleave', () => { b.style.color = STYLE.color; b.style.background = STYLE.background; });
        this._root.appendChild(b);
        return b;
    }

    /** The terminal a running close hold is for — the cluster stays on it until the hold ends. */
    get holdTarget() { return this._hold.holding() ? this._holdId : null; }

    _paintAgent() {
        const on = !!(this.id && this._isAgentOpen(this.id));
        this.agent.style.color = on ? STYLE.active : (this._agentHovered ? STYLE.hover : STYLE.color);
        this.agent.style.background = on ? STYLE.activeBackground : (this._agentHovered ? STYLE.hoverBackground : STYLE.background);
    }

    /**
     * Per frame: sit on `id`'s bar, or hide. (The wall passes holdTarget while a hold runs.)
     * @param {string|null} id
     * @param {{ left: number, right: number, top: number }|null} bar - the bar's screen box (canvas-relative CSS px)
     * @param {number} barPx - the bar's height on screen
     */
    update(id, bar, barPx) {
        const size = Math.max(8, Math.min(18, barPx - 4));
        const show = !!(id && bar && barPx >= this._minPx());
        if (!show) {
            if (this._key !== 'hidden') { this._key = 'hidden'; this._root.style.display = 'none'; this.id = null; }
            return;
        }
        this.id = id;
        const agentOn = this._isAgentOpen(id) ? 1 : 0;
        const x = bar.right - 3 - 3 * size - 4, y = bar.top + (barPx - size) / 2;
        const key = `${id}|${x.toFixed(1)}|${y.toFixed(1)}|${size}|${agentOn}`;
        if (key === this._key) return;
        this._key = key;
        this._root.style.display = 'flex';
        this._root.dataset.id = id;
        this._root.style.transform = `translate(${x}px, ${y}px)`;
        for (const b of [this.agent, this.hide, this.close]) { b.style.width = `${size}px`; b.style.height = `${size}px`; b.style.lineHeight = `${size}px`; }
        this._paintAgent();
    }

    /** The close chord (X) went down on `id`: run the same hold. */
    holdKey(id) { this._holdId = id; this._hold.start(); }

    /** The close chord was let go: cancel a hold still running. */
    releaseKey() { this._hold.cancel(); }

    dispose() { this._hold.dispose(); this._root.remove(); }
}
