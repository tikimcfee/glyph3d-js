/**
 * DictionaryParser - Handles parsing of various dictionary formats
 *
 * Supports:
 * - JSON format (original dictionary.json)
 * - Generated trie files (LLM-generated definitions)
 */

export class DictionaryParser {
    /**
     * Parse the LLM-generated trie file format
     *
     * Format:
     *   === Word ===
     *   definition line 1
     *   definition line 2
     *   ...
     *   (blank line)
     *   === NextWord ===
     *   ...
     *
     * @param {string} text - Raw text content of a trie file
     * @returns {Map<string, string>} word → combined definitions
     */
    static parseTrieFile(text) {
        const entries = new Map();
        const lines = text.split('\n');

        let currentWord = null;
        let definitions = [];

        for (const line of lines) {
            const trimmed = line.trim();

            // Check for word header: === Word ===
            const headerMatch = trimmed.match(/^===\s*(.+?)\s*===$/);

            if (headerMatch) {
                // Save previous word if we have one
                if (currentWord && definitions.length > 0) {
                    entries.set(currentWord, definitions.join('; '));
                }

                // Start new word
                currentWord = headerMatch[1].toLowerCase();
                definitions = [];
            } else if (currentWord && trimmed.length > 0) {
                // Skip placeholder definitions
                if (trimmed === 'unknown or unclear definition') {
                    continue;
                }
                // Add definition line
                definitions.push(trimmed);
            }
        }

        // Don't forget the last word
        if (currentWord && definitions.length > 0) {
            entries.set(currentWord, definitions.join('; '));
        }

        return entries;
    }

    /**
     * Parse multiple trie files and combine into one dictionary
     *
     * @param {string[]} fileContents - Array of raw trie file contents
     * @returns {Map<string, string>} Combined dictionary
     */
    static parseTrieFiles(fileContents) {
        const combined = new Map();

        for (const content of fileContents) {
            const entries = this.parseTrieFile(content);
            for (const [word, def] of entries) {
                // If word already exists, we could merge or skip
                // For now, first definition wins
                if (!combined.has(word)) {
                    combined.set(word, def);
                }
            }
        }

        return combined;
    }

    /**
     * Parse the original JSON dictionary format
     *
     * @param {Object} jsonData - Parsed JSON object { word: definition, ... }
     * @returns {Map<string, string>} word → definition
     */
    static parseJSON(jsonData) {
        const entries = new Map();

        for (const [word, definition] of Object.entries(jsonData)) {
            const normalized = word.toLowerCase().trim();
            if (normalized.length > 0) {
                entries.set(normalized, definition);
            }
        }

        return entries;
    }

    /**
     * Convert a Map dictionary to plain object (for compatibility)
     *
     * @param {Map<string, string>} dictMap
     * @returns {Object} { word: definition, ... }
     */
    static toObject(dictMap) {
        const obj = {};
        for (const [word, def] of dictMap) {
            obj[word] = def;
        }
        return obj;
    }

    /**
     * Filter dictionary to only include words matching criteria
     *
     * @param {Map<string, string>} dictMap
     * @param {Object} options - { minLength, maxLength, asciiOnly }
     * @returns {Map<string, string>} Filtered dictionary
     */
    static filter(dictMap, options = {}) {
        const {
            minLength = 1,
            maxLength = 30,
            asciiOnly = false
        } = options;

        const filtered = new Map();
        const asciiRegex = /^[a-z]+$/;

        for (const [word, def] of dictMap) {
            if (word.length < minLength || word.length > maxLength) continue;
            if (asciiOnly && !asciiRegex.test(word)) continue;
            filtered.set(word, def);
        }

        return filtered;
    }

    /**
     * Get statistics about a dictionary
     *
     * @param {Map<string, string>} dictMap
     * @returns {Object} Stats
     */
    static getStats(dictMap) {
        let totalDefLength = 0;
        let minWordLen = Infinity;
        let maxWordLen = 0;

        for (const [word, def] of dictMap) {
            totalDefLength += def.length;
            minWordLen = Math.min(minWordLen, word.length);
            maxWordLen = Math.max(maxWordLen, word.length);
        }

        return {
            wordCount: dictMap.size,
            avgDefinitionLength: dictMap.size > 0 ? Math.round(totalDefLength / dictMap.size) : 0,
            minWordLength: minWordLen === Infinity ? 0 : minWordLen,
            maxWordLength: maxWordLen
        };
    }
}

export default DictionaryParser;
