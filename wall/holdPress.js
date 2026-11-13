/**
 * holdPress — a button that acts only when HELD: a press fills a ring around it over the hold time,
 * and the action runs when the ring closes; letting go (or sliding off) before then cancels, and the
 * ring runs back. The wall's close buttons (title bar, sidebar) and the held close chord (X) share it.
 */

const SVG = 'http://www.w3.org/2000/svg';
/** The ring's radius in its 20×20 box, and so its length. */
const R = 8.5;
const LEN = 2 * Math.PI * R;

/**
 * Give `el` a progress ring (an absolutely placed SVG filling it) and return the hold controller.
 * The pointer drives it by itself; `start()` / `cancel()` let a held key drive the same ring.
 * @param {HTMLElement} el
 * @param {{ ms: () => number, onDone: () => void, color?: string }} o - ms is read at each press
 * @returns {{ start: () => void, cancel: () => void, holding: () => boolean, dispose: () => void }}
 */
export function holdPress(el, { ms, onDone, color = '#e5534b' }) {
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 20 20');
    Object.assign(svg.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none', transform: 'rotate(-90deg)' });
    const ring = document.createElementNS(SVG, 'circle');
    for (const [k, v] of [['cx', 10], ['cy', 10], ['r', R], ['fill', 'none'], ['stroke', color], ['stroke-width', 1.6]]) ring.setAttribute(k, String(v));
    ring.style.strokeDasharray = `${LEN}`;
    ring.style.strokeDashoffset = `${LEN}`;
    svg.appendChild(ring);
    if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
    el.appendChild(svg);

    let timer = null;
    const holding = () => timer != null;
    const start = () => {
        if (timer != null) return;
        const t = Math.max(0, ms());
        ring.style.transition = `stroke-dashoffset ${t}ms linear`;
        ring.style.strokeDashoffset = '0';
        el.dataset.holding = '1';
        timer = setTimeout(() => { timer = null; reset(); onDone(); }, t);
    };
    const reset = () => {
        ring.style.transition = 'stroke-dashoffset 120ms ease-out';
        ring.style.strokeDashoffset = `${LEN}`;
        delete el.dataset.holding;
    };
    const cancel = () => {
        if (timer == null) return;
        clearTimeout(timer);
        timer = null;
        reset();
    };
    const down = (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        start();
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointerup', cancel);
    el.addEventListener('pointerleave', cancel);
    el.addEventListener('pointercancel', cancel);
    return {
        start, cancel, holding,
        dispose() {
            cancel();
            el.removeEventListener('pointerdown', down);
            el.removeEventListener('pointerup', cancel);
            el.removeEventListener('pointerleave', cancel);
            el.removeEventListener('pointercancel', cancel);
            svg.remove();
        },
    };
}
