// headless-canvas.mjs — a minimal 2d-canvas stand-in for bun-run checks that construct
// canvas-baked components (Label3D / Button3D pills bake their face via CanvasTexture at
// construction). Import this BEFORE making any of those objects:
//
//   import './headless-canvas.mjs';
//
// measureText returns a width proportional to text length so aspect-derived geometry
// still tracks label length; every other 2d call is a no-op.

globalThis.document = {
    createElement: (tag) => {
        if (tag !== 'canvas') throw new Error(`stub only does canvas, got ${tag}`);
        return {
            width: 0, height: 0,
            getContext: () => ({
                font: '', textAlign: '', textBaseline: '', fillStyle: '', strokeStyle: '', lineWidth: 0,
                measureText: (t) => ({ width: (t || ' ').length * 22 }),
                clearRect() {}, beginPath() {}, moveTo() {}, arcTo() {}, closePath() {},
                fill() {}, stroke() {}, fillText() {},
            }),
        };
    },
};
