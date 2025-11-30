/**
 * ShaderManager
 *
 * Handles loading and caching of GLSL shader files.
 * Provides async loading via fetch() with Promise-based API.
 */

class ShaderManager {
    constructor() {
        this.cache = new Map();
    }

    /**
     * Load a single shader file
     * @param {string} name - Shader name (e.g., 'text')
     * @param {string} type - Shader type ('vertex' or 'fragment')
     * @returns {Promise<string>} Shader source code
     */
    async loadShader(name, type) {
        const cacheKey = `${name}_${type}`;

        // Return cached version if available
        if (this.cache.has(cacheKey)) {
            console.log(`ShaderManager: Using cached ${type} shader for '${name}'`);
            return this.cache.get(cacheKey);
        }

        // Build URL for shader file (relative to this JS module)
        const filename = type === 'vertex' ? 'Vertex' : 'Fragment';
        const baseUrl = new URL('.', import.meta.url).href;
        const url = `${baseUrl}shaders/${name}${filename}.glsl`;

        console.log(`ShaderManager: Loading ${type} shader from ${url}`);

        try {
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`Failed to load shader: ${url} (${response.status} ${response.statusText})`);
            }

            const source = await response.text();

            // Cache the loaded shader
            this.cache.set(cacheKey, source);

            console.log(`ShaderManager: Successfully loaded ${type} shader for '${name}' (${source.length} chars)`);

            return source;
        } catch (error) {
            console.error(`ShaderManager: Error loading shader ${url}:`, error);
            throw error;
        }
    }

    /**
     * Load both vertex and fragment shaders for a shader program
     * @param {string} name - Shader program name (e.g., 'text')
     * @returns {Promise<{vertex: string, fragment: string}>} Both shader sources
     */
    async getShaders(name) {
        console.log(`ShaderManager: Loading shader pair '${name}'`);

        const [vertex, fragment] = await Promise.all([
            this.loadShader(name, 'vertex'),
            this.loadShader(name, 'fragment')
        ]);

        return { vertex, fragment };
    }

    /**
     * Clear the shader cache (useful for hot-reloading during development)
     */
    clearCache() {
        console.log('ShaderManager: Clearing shader cache');
        this.cache.clear();
    }

    /**
     * Get cache statistics
     * @returns {{size: number, keys: string[]}} Cache info
     */
    getCacheInfo() {
        return {
            size: this.cache.size,
            keys: Array.from(this.cache.keys())
        };
    }
}

export default ShaderManager;
