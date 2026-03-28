/**
 * Shared semantic color constants for annotation and layout commands.
 * Structural colors only -- phase-specific colors live in their respective modules.
 *
 * All values are {r, g, b} in 0-1 range, matching the DataTexture group color format.
 * IDENTITY (white) is the default multiplier -- it produces no visible tint.
 */

export const COLORS = {
    /** No tint -- identity multiplier for DataTexture group color */
    IDENTITY:    { r: 1.0, g: 1.0, b: 1.0 },

    /** Bright cyan for highlighted grids */
    HIGHLIGHT:   { r: 0.2, g: 1.0, b: 1.0 },

    /** Low-intensity gray for dimmed/background grids */
    DIMMED:      { r: 0.3, g: 0.3, b: 0.3 },

    /** Amber for annotation text */
    ANNOTATION:  { r: 1.0, g: 0.85, b: 0.3 },

    /** Red for error indicators */
    ERROR:       { r: 1.0, g: 0.3, b: 0.3 },
};
