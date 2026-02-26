/**
 * Shared Rendering Constants
 *
 * Single source of truth for rendering dimensions and debug settings.
 * This prevents size inconsistencies between different rendering components.
 *
 * CRITICAL: All rendering components should use these values, not local definitions!
 */

// Character dimensions in world units (FALLBACK VALUES)
// NOTE: GlyphRendererV15 now derives dimensions dynamically from atlas metrics.
// These are only used as fallback when atlas metrics aren't available.
export const CHAR_DIMENSIONS = {
    width: 0.6,    // Fallback character width
    height: 1.0,   // Fallback character height
    spacing: 1.0   // Character spacing multiplier
};

// Terminal layout
export const TERMINAL_LAYOUT = {
    maxCols: 120,  // Maximum columns per terminal
    maxRows: 40,   // Maximum rows per terminal
    gridSpacing: 10 // Space between terminal cards
};

// Debug settings (use these instead of separate debug paths!)
export const DEBUG_SETTINGS = {
    // Visual overlays (don't change rendering path)
    showBounds: false,      // Draw red borders around characters
    showUVGrid: false,      // Show UV coordinate grid
    tintColor: null,        // {r, g, b} to tint all text, null for normal

    // Logging levels
    logInstancing: true,    // Log instancing setup (currently debugging)
    logPerformance: false,  // Log render timings
    logFirstInstance: true, // Log first instance data for verification

    // Get from environment
    enabled: typeof process !== 'undefined' && process.env?.DEBUG_RENDERING === 'true'
};

// Performance thresholds
export const PERF_THRESHOLDS = {
    maxInstancesPerMesh: 10000,  // Split if more instances needed
    targetFPS: 60,
    warnRenderTime: 16.67,  // ms (1 frame at 60fps)
    defaultMaxGroups: 64    // Initial group DataTexture height
};

/**
 * Helper to get consistent character size
 * @param {number} scale - Optional scale factor
 * @returns {Object} {width, height}
 */
export function getCharSize(scale = 1.0) {
    return {
        width: CHAR_DIMENSIONS.width * scale,
        height: CHAR_DIMENSIONS.height * scale
    };
}

/**
 * Helper to check if debug logging is enabled
 * @param {string} category - Debug category (e.g., 'instancing', 'performance')
 * @returns {boolean}
 */
export function shouldDebugLog(category) {
    if (!DEBUG_SETTINGS.enabled) return false;

    switch(category) {
        case 'instancing': return DEBUG_SETTINGS.logInstancing;
        case 'performance': return DEBUG_SETTINGS.logPerformance;
        case 'firstInstance': return DEBUG_SETTINGS.logFirstInstance;
        default: return false;
    }
}

// Export as default object for easy importing
export default {
    CHAR_DIMENSIONS,
    TERMINAL_LAYOUT,
    DEBUG_SETTINGS,
    PERF_THRESHOLDS,
    getCharSize,
    shouldDebugLog
};