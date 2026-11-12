import { chordLabel } from './chord.js';

const SVG = 'http://www.w3.org/2000/svg';
const ACCENT = 'rgba(138, 180, 248, 0.85)';
/** How far a selection outline sits outside its window, CSS px. */
const OUTLINE_GAP = 3;

/**
 * SelectionOverlay — the screen-space marks of a selection: the lasso as it's drawn (a thin path
 * following the pointer), an outline around each selected terminal, and one small button by the
 * selection that gathers it into a group (with a × that clears it). DOM over the canvas, placed in
 * the wall's tick from the same camera the canvas renders with.
 */
export default class SelectionOverlay {
    /**
     * @param {HTMLElement} host - the element the canvas fills
     * @param {{ onGroup: () => void, onClear: () => void }} o
     */
    constructor(host, { onGroup, onClear }) {
        this._host = host;
        this._root = document.createElement('div');
        Object.assign(this._root.style, { position: 'absolute', inset: '0', pointerEvents: 'none', overflow: 'hidden', zIndex: '5' });
        this._svg = document.createElementNS(SVG, 'svg');
        Object.assign(this._svg.style, { position: 'absolute', inset: '0', width: '100%', height: '100%' });
        this._lasso = document.createElementNS(SVG, 'polygon');
        for (const [k, v] of [['fill', 'rgba(138, 180, 248, 0.06)'], ['stroke', ACCENT], ['stroke-width', '1'], ['stroke-dasharray', '4 3']]) this._lasso.setAttribute(k, v);
        this._lasso.dataset.lasso = '';
        this._svg.appendChild(this._lasso);
        this._root.appendChild(this._svg);

        this._bar = document.createElement('div');
        this._bar.dataset.selectionBar = '';
        Object.assign(this._bar.style, {
            position: 'absolute', left: '0', top: '0', display: 'none', gap: '2px', pointerEvents: 'auto',
            background: '#0e1118', border: '1px solid #2a303c', borderRadius: '5px', padding: '2px', willChange: 'transform',
        });
        this.groupButton = this._button('', () => onGroup());
        this.groupButton.dataset.action = 'group';
        this.groupButton.title = `gather into a group (${chordLabel(['G'])})`;
        const clear = this._button('×', () => onClear());
        clear.title = 'clear the selection (click empty canvas)';
        this._root.appendChild(this._bar);
        /** @type {Map<string, HTMLDivElement>} */
        this._outlines = new Map();
        host.appendChild(this._root);
        this._lassoPts = null;
        this._barKey = '';
        this._barSize = { w: 0, h: 0 };
    }

    _button(text, run) {
        const b = document.createElement('button');
        b.textContent = text;
        Object.assign(b.style, {
            background: 'transparent', color: '#c8ced8', border: 'none', borderRadius: '3px', padding: '1px 7px',
            font: '12px ui-monospace, SFMono-Regular, Menlo, monospace', cursor: 'pointer',
        });
        b.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; e.preventDefault(); e.stopPropagation(); run(); });
        b.addEventListener('pointerenter', () => { b.style.background = 'rgba(255,255,255,0.07)'; });
        b.addEventListener('pointerleave', () => { b.style.background = 'transparent'; });
        this._bar.appendChild(b);
        return b;
    }

    /** The lasso being drawn, in client (page) coords; null when none. */
    setLasso(points) {
        this._lassoPts = points;
        if (!points) { this._lasso.setAttribute('points', ''); this._lasso.style.display = 'none'; return; }
        const r = this._host.getBoundingClientRect();
        this._lasso.setAttribute('points', points.map((p) => `${(p.x - r.left).toFixed(1)},${(p.y - r.top).toFixed(1)}`).join(' '));
        this._lasso.style.display = '';
    }

    /** Whether a lasso is on screen (the test handle). */
    get lassoShown() { return !!this._lassoPts; }

    /**
     * Per frame: outline each selected terminal and set the group button by the selection.
     * @param {{ id: string, box: { left: number, right: number, top: number, bottom: number } }[]} items - shown selected terminals' window boxes
     * @param {{ w: number, h: number }} view
     * @param {boolean} lassoing - a lasso is being drawn (the button waits)
     */
    update(items, view, lassoing) {
        const live = new Set();
        for (const { id, box } of items) {
            live.add(id);
            let el = this._outlines.get(id);
            if (!el) {
                el = document.createElement('div');
                el.dataset.selected = id;
                Object.assign(el.style, { position: 'absolute', left: '0', top: '0', border: `1px solid ${ACCENT}`, borderRadius: '3px', boxSizing: 'border-box', willChange: 'transform' });
                this._root.insertBefore(el, this._bar);
                this._outlines.set(id, el);
            }
            const l = box.left - OUTLINE_GAP, t = box.top - OUTLINE_GAP;
            const key = `${l.toFixed(1)}|${t.toFixed(1)}|${(box.right - box.left).toFixed(1)}|${(box.bottom - box.top).toFixed(1)}`;
            if (el.dataset.key !== key) {
                el.dataset.key = key;
                el.style.transform = `translate(${l}px, ${t}px)`;
                el.style.width = `${box.right - box.left + 2 * OUTLINE_GAP}px`;
                el.style.height = `${box.bottom - box.top + 2 * OUTLINE_GAP}px`;
            }
        }
        for (const [id, el] of this._outlines) if (!live.has(id)) { el.remove(); this._outlines.delete(id); }

        if (!items.length || lassoing) {
            if (this._barKey !== 'hidden') { this._barKey = 'hidden'; this._bar.style.display = 'none'; }
            return;
        }
        const right = Math.max(...items.map((i) => i.box.right)) + OUTLINE_GAP;
        const bottom = Math.max(...items.map((i) => i.box.bottom)) + OUTLINE_GAP;
        const label = `group (${items.length})`;
        if (this.groupButton.textContent !== label || this._bar.style.display === 'none') {
            // Measured only when what it says changes — not every frame.
            this.groupButton.textContent = label;
            this._bar.style.display = 'flex';
            this._barSize = { w: this._bar.offsetWidth, h: this._bar.offsetHeight };
        }
        const { w: bw, h: bh } = this._barSize;
        const x = Math.min(Math.max(4, right - bw), view.w - bw - 4);
        const y = Math.min(Math.max(4, bottom + 6), view.h - bh - 4);
        const key = `${label}|${x.toFixed(1)}|${y.toFixed(1)}`;
        if (key === this._barKey) return;
        this._barKey = key;
        this._bar.style.transform = `translate(${x}px, ${y}px)`;
    }

    dispose() { this._root.remove(); this._outlines.clear(); }
}
