/**
 * DictionaryLoaderWorker - Web Worker for concurrent dictionary fetching and parsing
 *
 * Messages:
 *   { type: 'loadGenerated', manifestUrl, baseUrl }
 *   { type: 'loadJSON', url }
 *
 * Responses:
 *   { type: 'progress', loaded, total }
 *   { type: 'done', dictionary, stats }
 *   { type: 'error', message }
 */

// Inline the parsing logic (workers can't import modules easily without bundlers)
const DictionaryParser = {
    /**
     * Parse a single trie file
     */
    parseTrieFile(text) {
        const entries = new Map();
        const lines = text.split('\n');

        let currentWord = null;
        let definitions = [];

        for (const line of lines) {
            const trimmed = line.trim();
            const headerMatch = trimmed.match(/^===\s*(.+?)\s*===$/);

            if (headerMatch) {
                if (currentWord && definitions.length > 0) {
                    entries.set(currentWord, definitions.join('; '));
                }
                currentWord = headerMatch[1].toLowerCase();
                definitions = [];
            } else if (currentWord && trimmed.length > 0) {
                if (trimmed === 'unknown or unclear definition') {
                    continue;
                }
                definitions.push(trimmed);
            }
        }

        if (currentWord && definitions.length > 0) {
            entries.set(currentWord, definitions.join('; '));
        }

        return entries;
    },

    /**
     * Filter dictionary
     */
    filter(dictMap, options = {}) {
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
    },

    /**
     * Get stats
     */
    getStats(dictMap) {
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
    },

    /**
     * Convert Map to plain object
     */
    toObject(dictMap) {
        const obj = {};
        for (const [word, def] of dictMap) {
            obj[word] = def;
        }
        return obj;
    }
};

/**
 * Load and parse the generated LLM dictionary
 */
async function loadGenerated(manifestUrl, baseUrl) {
    // Fetch manifest
    const manifestResp = await fetch(manifestUrl);
    if (!manifestResp.ok) {
        throw new Error('Failed to load manifest.json');
    }

    const manifest = await manifestResp.json();
    const total = manifest.count;

    postMessage({ type: 'progress', loaded: 0, total, phase: 'fetching' });

    // Fetch all files concurrently in batches
    const BATCH_SIZE = 50;
    const combined = new Map();
    let loaded = 0;

    for (let i = 0; i < manifest.files.length; i += BATCH_SIZE) {
        const batch = manifest.files.slice(i, i + BATCH_SIZE);

        const results = await Promise.all(
            batch.map(async (filename) => {
                try {
                    const resp = await fetch(`${baseUrl}${filename}`);
                    if (resp.ok) {
                        return await resp.text();
                    }
                } catch (e) {
                    // Skip failed files
                }
                return null;
            })
        );

        // Parse each result and merge into combined map
        for (const text of results) {
            if (text) {
                const entries = DictionaryParser.parseTrieFile(text);
                for (const [word, def] of entries) {
                    if (!combined.has(word)) {
                        combined.set(word, def);
                    }
                }
                loaded++;
            }
        }

        postMessage({ type: 'progress', loaded, total, phase: 'fetching' });
    }

    postMessage({ type: 'progress', loaded, total, phase: 'filtering' });

    // Filter to ASCII-only
    const filtered = DictionaryParser.filter(combined, { asciiOnly: true, minLength: 2 });
    const stats = DictionaryParser.getStats(filtered);
    const dictionary = DictionaryParser.toObject(filtered);

    return { dictionary, stats };
}

/**
 * Load JSON dictionary
 */
async function loadJSON(url) {
    postMessage({ type: 'progress', loaded: 0, total: 1, phase: 'fetching' });

    const resp = await fetch(url);
    if (!resp.ok) {
        throw new Error(`Failed to load ${url}`);
    }

    const data = await resp.json();
    postMessage({ type: 'progress', loaded: 1, total: 1, phase: 'parsing' });

    // Normalize
    const dictMap = new Map();
    for (const [word, def] of Object.entries(data)) {
        const normalized = word.toLowerCase().trim();
        if (normalized.length > 0) {
            dictMap.set(normalized, def);
        }
    }

    const stats = DictionaryParser.getStats(dictMap);
    const dictionary = DictionaryParser.toObject(dictMap);

    return { dictionary, stats };
}

/**
 * Load and parse coordinates.csv for embedding positions
 */
async function loadCoordinates(url) {
    const resp = await fetch(url);
    if (!resp.ok) {
        throw new Error(`Failed to load coordinates: ${url}`);
    }

    const text = await resp.text();
    const lines = text.split('\n');
    const coords = {};

    // Skip header line
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        // Parse CSV: word,x,y,z
        const commaIdx1 = line.indexOf(',');
        if (commaIdx1 === -1) continue;

        const word = line.slice(0, commaIdx1).toLowerCase();
        const rest = line.slice(commaIdx1 + 1).split(',');

        if (rest.length >= 3) {
            const x = parseFloat(rest[0]);
            const y = parseFloat(rest[1]);
            const z = parseFloat(rest[2]);

            if (!isNaN(x) && !isNaN(y) && !isNaN(z)) {
                coords[word] = { x, y, z };
            }
        }
    }

    return coords;
}

// Message handler
self.onmessage = async (e) => {
    const { type } = e.data;

    try {
        let result;

        if (type === 'loadGenerated') {
            const { manifestUrl, baseUrl, coordinatesUrl } = e.data;

            // Load dictionary and coordinates in parallel
            const [dictResult, coordinates] = await Promise.all([
                loadGenerated(manifestUrl, baseUrl),
                coordinatesUrl ? loadCoordinates(coordinatesUrl) : null
            ]);

            result = { ...dictResult, coordinates };
        } else if (type === 'loadJSON') {
            const { url, coordinatesUrl } = e.data;

            const [dictResult, coordinates] = await Promise.all([
                loadJSON(url),
                coordinatesUrl ? loadCoordinates(coordinatesUrl) : null
            ]);

            result = { ...dictResult, coordinates };
        } else {
            throw new Error(`Unknown message type: ${type}`);
        }

        postMessage({ type: 'done', ...result });

    } catch (err) {
        postMessage({ type: 'error', message: err.message });
    }
};
