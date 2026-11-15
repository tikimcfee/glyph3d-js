// headless-atlas.mjs — a shaper-less GlyphAtlas stand-in for bun-run checks that build
// GlyphFields (FieldLabel text, CameraDock nameplates). The field's mono fallback emits
// real positions/sizes, so layout and placement assertions hold; glyph ink is a browser
// concern. Pair with headless-canvas.mjs — the pill plate bake needs a 2d canvas.
//
//   import './headless-canvas.mjs';
//   import { HEADLESS_ATLAS } from './headless-atlas.mjs';

// A terminal asks its atlas for a font family (GlyphAtlas.fontFamily): here every id is the one
// stand-in family — the atlas's cell, and a shape cache whose glyph id is the cell's content.
const CHAR_SIZE = { width: 8, height: 16 };
const glyph = (cp) => ({ g: cp, ax: CHAR_SIZE.width });
const families = new Map();

export const HEADLESS_ATLAS = {
    getCharSize: () => CHAR_SIZE,
    fontFamily: (id = null) => {
        let family = families.get(id);
        if (!family) {
            family = { id, index: 0, charSize: CHAR_SIZE, lineMetrics: { underlineY: 0.12, strikeY: 0.42, thickness: 0.05 }, shapeCache: { lookup: glyph, lookupFace: glyph } };
            families.set(id, family);
        }
        return family;
    },
    _shaper: null,
    _slugData: null,
    _live: null,
};
