/**
 * syntaxTheme.js — tree-sitter capture scope → glyph color ({r,g,b}, 0–1).
 *
 * A restrained palette (quiet-craft): desaturated, low-contrast, easy on a dark
 * field. Scopes resolve by longest-prefix — "keyword.control" falls back to
 * "keyword" when there's no exact entry. Uncaptured glyphs get FOREGROUND so the
 * file reads as one cohesive surface rather than colored tokens floating on the
 * builder's default green.
 */

/** Base text color applied to every glyph before captures paint over it. */
export const FOREGROUND = { r: 0.82, g: 0.85, b: 0.88 };

/** @type {Record<string, {r:number,g:number,b:number}>} */
export const DEFAULT_SYNTAX_THEME = {
    comment:            { r: 0.42, g: 0.47, b: 0.44 },
    string:             { r: 0.60, g: 0.78, b: 0.56 },
    number:             { r: 0.86, g: 0.74, b: 0.52 },
    constant:           { r: 0.86, g: 0.74, b: 0.52 },
    'constant.builtin': { r: 0.80, g: 0.62, b: 0.86 },
    keyword:            { r: 0.78, g: 0.58, b: 0.86 },
    function:           { r: 0.52, g: 0.74, b: 0.92 },
    type:               { r: 0.50, g: 0.80, b: 0.78 },
    'type.builtin':     { r: 0.50, g: 0.80, b: 0.78 },
    property:           { r: 0.74, g: 0.82, b: 0.90 },
    variable:           FOREGROUND,
    'variable.builtin': { r: 0.80, g: 0.62, b: 0.86 },
    operator:           { r: 0.70, g: 0.72, b: 0.75 },
    punctuation:        { r: 0.55, g: 0.58, b: 0.62 },
};

/**
 * Resolve a capture scope to a color, falling back along dotted prefixes.
 * Returns null when nothing matches (caller leaves the glyph at FOREGROUND).
 * @param {string} scope
 * @param {Record<string,{r:number,g:number,b:number}>} [theme]
 * @returns {{r:number,g:number,b:number}|null}
 */
export function resolveScopeColor(scope, theme = DEFAULT_SYNTAX_THEME) {
    if (!scope) return null;
    let s = scope;
    while (s) {
        const c = theme[s];
        if (c) return c;
        const i = s.lastIndexOf('.');
        if (i < 0) return null;
        s = s.slice(0, i);
    }
    return null;
}
