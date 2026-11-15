/**
 * families.js — the fonts this package ships, as the chain every app boots (bootGlyphEngine's
 * `fonts`): the FAMILIES a field can draw its text in, each with its four faces, and the
 * fallbacks every family routes after its own font.
 *
 *   Cousine            regular · bold · italic · bold-italic, a file each (Apache 2.0, v1.21).
 *   Monaspace Neon     GitHub Next's Monaspace (SIL OFL 1.1, v1.400), its neo-grotesque and its
 *   Monaspace Argon    humanist sans: ONE variable file per family, as released (glyf outlines;
 *                      axes wght 200–800, wdth 100–125, slnt −11–0). Its four faces are
 *                      instances of that file — regular `wght 400`, bold `wght 700`, italic
 *                      `slnt −11`, bold-italic both — set through HarfBuzz. (The release's
 *                      static files are CFF, whose cubic outlines the Slug encoder does not
 *                      take, or hinted "frozen" TTFs: four files and twice the bytes per family.)
 *                      Xenon, Radon and Krypton are one more `monaspace(…)` line and their file
 *                      each ("Variable Fonts/Monaspace <Name>/Monaspace <Name> Var.ttf").
 *   fallbacks          MesloLGS NF Mono (Nerd Font icons, powerline), then DejaVu Sans (broad
 *                      Unicode) — upright only.
 *
 * DEFAULT_FONT_FAMILY is the chain's default: the cell every label, code grid and book is laid
 * out on. A terminal names its own (TerminalGrid `fontFamily`, live: `setFontFamily` — each app's
 * settings choose what its terminals are born in), so the families can be compared side by side
 * on one atlas.
 *
 * Each file's url is `new URL(file, import.meta.url)` — the form Vite (dev and build), Bun and
 * browsers all resolve, so the IDE, the wall, the headless bakes and the tests share this list.
 * Licenses sit beside the files (*-LICENSE.txt).
 */

/**
 * A Monaspace family's four faces, as instances of its one variable file: the weights (the wght
 * axis, 200–800) of its regular and its bold, and its italic's slant (the slnt axis, degrees).
 * `lineGap`: whether the family's cell takes in the font's own line gap (200 units of 2000 —
 * 9 % taller lines, the leading Monaspace is drawn for); off, its cell is ascender to descender,
 * as every other font's here.
 */
const MONASPACE = Object.freeze({ regular: 400, bold: 700, slant: -11, lineGap: false });

/**
 * @param {string} family  the family's id
 * @param {string} name    its name
 * @param {string} url     its variable file
 * @returns {import('../shaping/FontChain.js').FontSpec}
 */
function monaspace(family, name, url) {
    const { regular, bold, slant, lineGap } = MONASPACE;
    return {
        family, name, url, lineGap,
        variations: { wght: regular, slnt: 0 },
        faces: {
            bold: { variations: { wght: bold, slnt: 0 } },
            italic: { variations: { wght: regular, slnt: slant } },
            boldItalic: { variations: { wght: bold, slnt: slant } },
        },
    };
}

/**
 * The families, by id, in the order a settings list shows them. `label` is what a person reads.
 * @type {Readonly<Record<string, { label: string, font: import('../shaping/FontChain.js').FontSpec }>>}
 */
export const FONT_FAMILIES = Object.freeze({
    cousine: {
        label: 'Cousine',
        font: {
            family: 'cousine', name: 'Cousine',
            url: new URL('./Cousine-Regular.ttf', import.meta.url).href,
            faces: {
                bold: { url: new URL('./Cousine-Bold.ttf', import.meta.url).href },
                italic: { url: new URL('./Cousine-Italic.ttf', import.meta.url).href },
                boldItalic: { url: new URL('./Cousine-BoldItalic.ttf', import.meta.url).href },
            },
        },
    },
    'monaspace-neon': {
        label: 'Monaspace Neon',
        font: monaspace('monaspace-neon', 'Monaspace Neon', new URL('./MonaspaceNeonVar.ttf', import.meta.url).href),
    },
    'monaspace-argon': {
        label: 'Monaspace Argon',
        font: monaspace('monaspace-argon', 'Monaspace Argon', new URL('./MonaspaceArgonVar.ttf', import.meta.url).href),
    },
});

/** The families' ids, in order — a settings enum's options. */
export const FONT_FAMILY_IDS = Object.freeze(Object.keys(FONT_FAMILIES));

/** The chain's default family: the cell labels, code grids and books are laid out on. */
export const DEFAULT_FONT_FAMILY = 'cousine';

/** The fonts every family falls back to, in order. @type {ReadonlyArray<import('../shaping/FontChain.js').FontSpec>} */
export const FALLBACK_FONTS = Object.freeze([
    { name: 'MesloLGS NF Mono', url: new URL('./MesloLGS-NF-Mono.ttf', import.meta.url).href },
    { name: 'DejaVu Sans', url: new URL('./DejaVuSans.ttf', import.meta.url).href },
]);

/**
 * The font chain: the default family's font first (it is the chain's primary), then the
 * fallbacks, then every other family's font — so the fallbacks' indices don't move as families
 * come and go.
 * @returns {import('../shaping/FontChain.js').FontSpec[]}
 */
export function fontChain() {
    return [
        FONT_FAMILIES[DEFAULT_FONT_FAMILY].font,
        ...FALLBACK_FONTS,
        ...FONT_FAMILY_IDS.filter((id) => id !== DEFAULT_FONT_FAMILY).map((id) => FONT_FAMILIES[id].font),
    ];
}
