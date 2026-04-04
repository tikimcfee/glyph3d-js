/**
 * Shared Constants — debug settings, performance thresholds, terminal layout.
 *
 * Character dimensions are NOT defined here — they are derived from GlyphAtlas
 * metrics at runtime. All layout code should use atlas-derived metrics via
 * GlyphCollection._getMetrics() or CodeGrid.metrics.
 */

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
    defaultMaxGroups: 4    // Initial group DataTexture height (grows on demand)
};

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
    TERMINAL_LAYOUT,
    DEBUG_SETTINGS,
    PERF_THRESHOLDS,
    shouldDebugLog
};