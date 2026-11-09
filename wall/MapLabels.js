import { placeLabels } from './labelPlacement.js';

const FONT = '12px ui-monospace, SFMono-Regular, Menlo, monospace';
const PAD_X = 6;
const LABEL_H = 18;
const STYLE = {
    idle: { color: '#c4ccd8', background: 'rgba(24, 29, 39, 0.94)', border: '#323b4c', line: 'rgba(140, 155, 180, 0.65)' },
    focused: { color: '#8ef0b8', background: 'rgba(16, 44, 31, 0.95)', border: '#2f7a52', line: 'rgba(110, 231, 160, 0.8)' },
};

/**
 * MapLabels — the DOM layer for map-style terminal names: one constant-size label per terminal
 * that's too small on screen for its title bar, placed by labelPlacement so no two overlap, with
 * a trace line to its terminal's border when the label isn't touching it. A press on a label
 * goes to the wall's pointer (a click frames the terminal, a drag moves it). Positions are written in the same frame the canvas renders (the wall's
 * tick), from the same camera — no lag, no deadband.
 */
export default class MapLabels {
    /**
     * @param {HTMLElement} host - the element the canvas fills
     * @param {(id: string, e: PointerEvent) => void} onPress - a pointer pressed a label
     */
    constructor(host, onPress) {
        this._onPress = onPress;
        this._root = document.createElement('div');
        Object.assign(this._root.style, { position: 'absolute', inset: '0', pointerEvents: 'none', overflow: 'hidden', zIndex: '4' });
        this._svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        Object.assign(this._svg.style, { position: 'absolute', inset: '0', width: '100%', height: '100%' });
        this._root.appendChild(this._svg);
        host.appendChild(this._root);
        /** @type {Map<string, { el: HTMLDivElement, line: SVGLineElement, dot: SVGCircleElement, key: string }>} */
        this._nodes = new Map();
        this._prev = new Map();     // id → candidate held last frame (placement hysteresis)
        this._widths = new Map();   // name → measured text width
        this._ctx = document.createElement('canvas').getContext('2d');
        this._ctx.font = FONT;
    }

    _width(name) {
        let w = this._widths.get(name);
        if (w == null) { w = Math.ceil(this._ctx.measureText(name).width) + 2 * PAD_X + 2; this._widths.set(name, w); }
        return w;
    }

    _node(id) {
        let n = this._nodes.get(id);
        if (n) return n;
        const el = document.createElement('div');
        Object.assign(el.style, {
            position: 'absolute', left: '0', top: '0', height: `${LABEL_H}px`, lineHeight: `${LABEL_H - 2}px`,
            padding: `0 ${PAD_X}px`, font: FONT, whiteSpace: 'nowrap', borderRadius: '4px', borderWidth: '1px',
            borderStyle: 'solid', pointerEvents: 'auto', cursor: 'pointer', boxSizing: 'border-box', willChange: 'transform',
        });
        el.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); this._onPress(id, e); });
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('stroke-width', '1');
        const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        dot.setAttribute('r', '2');
        this._svg.append(line, dot);
        this._root.appendChild(el);
        n = { el, line, dot, key: '' };
        this._nodes.set(id, n);
        return n;
    }

    /**
     * Place and draw this frame's labels.
     * @param {{ id: string, name: string, focused: boolean, target: import('./labelPlacement.js').Box }[]} items - priority order
     * @param {{ w: number, h: number }} view - CSS px
     * @param {import('./labelPlacement.js').Box[]} obstacles - every on-screen terminal's rect (labels avoid covering them when they can)
     */
    update(items, view, obstacles) {
        const placed = placeLabels(items.map((it) => ({ id: it.id, target: it.target, w: this._width(it.name), h: LABEL_H })), view, this._prev, obstacles);
        const live = new Set();
        for (const it of items) {
            const p = placed.get(it.id);
            const n = this._node(it.id);
            live.add(it.id);
            if (!p) { this._prev.delete(it.id); this._apply(n, 'hidden', () => { n.el.style.display = 'none'; n.line.style.display = 'none'; n.dot.style.display = 'none'; }); continue; }
            this._prev.set(it.id, p.cand);
            const s = it.focused ? STYLE.focused : STYLE.idle;
            const L = p.leader;
            const key = `${it.name}|${it.focused}|${p.box.left.toFixed(1)},${p.box.top.toFixed(1)}|${L ? `${L.x1.toFixed(1)},${L.y1.toFixed(1)},${L.x2.toFixed(1)},${L.y2.toFixed(1)}` : '-'}`;
            this._apply(n, key, () => {
                const el = n.el;
                el.style.display = 'block';
                if (el.textContent !== it.name) el.textContent = it.name;
                el.style.color = s.color; el.style.background = s.background; el.style.borderColor = s.border;
                el.style.transform = `translate(${p.box.left}px, ${p.box.top}px)`;
                if (L) {
                    for (const [k, v] of [['x1', L.x1], ['y1', L.y1], ['x2', L.x2], ['y2', L.y2]]) n.line.setAttribute(k, v);
                    n.line.setAttribute('stroke', s.line);
                    n.dot.setAttribute('cx', L.x2); n.dot.setAttribute('cy', L.y2); n.dot.setAttribute('fill', s.line);
                    n.line.style.display = ''; n.dot.style.display = '';
                } else {
                    n.line.style.display = 'none'; n.dot.style.display = 'none';
                }
            });
        }
        for (const [id, n] of this._nodes) {
            if (live.has(id)) continue;
            n.el.remove(); n.line.remove(); n.dot.remove();
            this._nodes.delete(id); this._prev.delete(id);
        }
    }

    /** Write a node only when what it shows changed. */
    _apply(n, key, write) {
        if (n.key === key) return;
        n.key = key;
        write();
    }

    /** Ids currently shown, with their boxes — the test handle. */
    shown() {
        const out = [];
        for (const [id, n] of this._nodes) if (n.el.style.display !== 'none') out.push({ id, text: n.el.textContent, leader: n.line.style.display !== 'none', rect: n.el.getBoundingClientRect() });
        return out;
    }

    dispose() { this._root.remove(); this._nodes.clear(); }
}
