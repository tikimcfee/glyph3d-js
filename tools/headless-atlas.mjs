// headless-atlas.mjs — a shaper-less GlyphAtlas stand-in for bun-run checks that build
// GlyphFields (FieldLabel text, CameraDock nameplates). The field's mono fallback emits
// real positions/sizes, so layout and placement assertions hold; glyph ink is a browser
// concern. Pair with headless-canvas.mjs — the pill plate bake needs a 2d canvas.
//
//   import './headless-canvas.mjs';
//   import { HEADLESS_ATLAS } from './headless-atlas.mjs';

export const HEADLESS_ATLAS = {
    getCharSize: () => ({ width: 8, height: 16 }),
    _shaper: null,
    _slugData: null,
    _live: null,
};
