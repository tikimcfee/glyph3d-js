/**
 * analyzers.js — Functional analyzer backends
 *
 * The contract:
 *   analyze(code, words) → picks
 *
 *   code:  string of source text
 *   words: array of elements (the vocabulary to pick from)
 *   picks: array of { name, score, evidence }
 *
 * An analyzer is just an object with:
 *   { name, isSync, analyze }
 *   plus whatever config/lifecycle it needs (init, dispose, etc.)
 *
 * No base class. No inheritance. Just data in, data out.
 */

import { buildTriggerIndex, BLOCKS } from './taxonomy.js';

// ─── Shared: tokenizer ──────────────────────────────────────────

/**
 * Tokenize source code into individual tokens.
 * Handles camelCase, snake_case, kebab-case, dot.notation.
 * Exported so anyone can use it — it's just a function.
 */
export function tokenize(code) {
    const tokens = [];
    const raw = code.split(/[\s{}()\[\];,<>!=+\-*\/%&|^~?:@#"'`\\]+/);

    for (const segment of raw) {
        if (!segment || segment.length < 2) continue;

        // Split camelCase: "myFunction" → ["my", "Function"]
        const camelParts = segment.split(/(?=[A-Z])/);

        // Split snake_case and dot.notation
        for (const part of camelParts) {
            const subParts = part.split(/[._-]+/);
            for (const sub of subParts) {
                if (sub && sub.length >= 2) {
                    tokens.push(sub);
                }
            }
        }
    }
    return tokens;
}


// ═══════════════════════════════════════════════════════════════════
// Naive analyzer — token matching against trigger patterns
// ═══════════════════════════════════════════════════════════════════

export function createNaiveAnalyzer() {
    return {
        name: 'naive',
        isSync: true,

        /**
         * @param {string} code - source text
         * @param {Array} words - elements to pick from
         * @returns {Array<{name, score, evidence}>}
         */
        analyze(code, words) {
            const index = buildTriggerIndex(words);
            const tokens = tokenize(code);
            const hits = new Map(); // name → { score, evidence }

            for (const token of tokens) {
                const lower = token.toLowerCase();
                const matches = index.get(lower);
                if (!matches) continue;

                for (const element of matches) {
                    let hit = hits.get(element.name);
                    if (!hit) {
                        hit = { name: element.name, score: 0, evidence: [] };
                        hits.set(element.name, hit);
                    }
                    hit.score++;
                    if (hit.evidence.length < 5 && !hit.evidence.includes(token)) {
                        hit.evidence.push(token);
                    }
                }
            }

            // Return only non-zero picks, sorted by score
            return Array.from(hits.values())
                .filter(h => h.score > 0)
                .sort((a, b) => b.score - a.score);
        },
    };
}


// ═══════════════════════════════════════════════════════════════════
// LLM analyzer — queries a local model with the word vocabulary
// ═══════════════════════════════════════════════════════════════════

const LLM_ENDPOINTS = {
    ollama: {
        name: 'Ollama',
        url: 'http://localhost:11434/api/generate',
        healthUrl: 'http://localhost:11434/api/tags',
        type: 'ollama',
    },
    lmstudio: {
        name: 'LM Studio',
        url: 'http://localhost:1234/v1/chat/completions',
        healthUrl: 'http://localhost:1234/v1/models',
        type: 'openai',
    },
};

/**
 * Build the classification prompt.
 * words come IN as a parameter — the model sees whatever vocabulary you hand it.
 */
function buildPrompt(code, words) {
    // Group word names by block for readability
    const byBlock = {};
    for (const w of words) {
        if (!byBlock[w.block]) byBlock[w.block] = [];
        byBlock[w.block].push(w);
    }

    let vocab = '';
    for (const [blockName, elements] of Object.entries(byBlock)) {
        const blockInfo = BLOCKS[blockName];
        vocab += `\n${blockInfo?.name || blockName} (${blockInfo?.description || ''}):\n`;
        vocab += elements.map(e => `  ${e.symbol}: ${e.name}`).join('\n');
        vocab += '\n';
    }

    return `You are a code concept classifier. Analyze the following code snippet and classify it using ONLY the concept vocabulary below.

VOCABULARY (symbol: name):
${vocab}

RULES:
1. Return ONLY a JSON object mapping concept names to relevance scores (1-10)
2. Only include concepts that genuinely apply to this code
3. Score meaning: 1-3 = minor presence, 4-6 = significant, 7-10 = dominant theme
4. Be precise — don't include concepts just because a keyword appears
5. Consider what the code DOES, not just what tokens appear

CODE:
\`\`\`
${code}
\`\`\`

Respond with ONLY valid JSON, no markdown, no explanation:`;
}

/**
 * Parse the LLM's response into picks.
 * Robust: handles markdown fences, stray text, partial JSON.
 * The words array is used for fuzzy name/symbol matching.
 */
function parseResponse(raw, words) {
    const picks = [];

    // Strip markdown fences
    let cleaned = raw.trim();
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, '');
    cleaned = cleaned.replace(/\n?```\s*$/i, '');
    cleaned = cleaned.trim();

    // Find JSON object
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return picks;

    try {
        const parsed = JSON.parse(jsonMatch[0]);

        // Build lookup tables from the PASSED-IN words
        const nameSet = new Set(words.map(e => e.name.toLowerCase()));
        const symbolToName = new Map(words.map(e => [e.symbol.toLowerCase(), e.name]));

        for (const [key, value] of Object.entries(parsed)) {
            const score = typeof value === 'number' ? Math.round(value) : parseInt(value, 10);
            if (isNaN(score) || score <= 0) continue;

            const lower = key.toLowerCase();
            let name = null;

            // Exact name match
            if (nameSet.has(lower)) {
                name = lower;
            }
            // Symbol match
            else if (symbolToName.has(lower)) {
                name = symbolToName.get(lower);
            }

            if (name) {
                picks.push({ name, score: Math.min(score, 10), evidence: ['(llm)'] });
            }
        }
    } catch (err) {
        console.warn('LLM response parse failed:', err.message);
    }

    return picks.sort((a, b) => b.score - a.score);
}


export function createLLMAnalyzer(options = {}) {
    // ─── Closure state (not class state) ────────────────
    let endpointKey = options.endpoint || 'ollama';
    let endpoint = { ...LLM_ENDPOINTS[endpointKey] };
    let model = options.model || '';
    let availableModels = [];
    let connected = false;
    let lastError = null;
    let abortController = null;

    // Cache: hash → picks
    const cache = new Map();
    const cacheMax = 50;

    // Stats
    let requestCount = 0;
    let avgLatency = 0;

    // ─── Internals ──────────────────────────────────────
    function hashCode(str) {
        let h = 0;
        for (let i = 0; i < str.length; i++) {
            h = ((h << 5) - h) + str.charCodeAt(i);
            h |= 0;
        }
        return h;
    }

    async function queryOllama(prompt, signal) {
        const res = await fetch(endpoint.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal,
            body: JSON.stringify({
                model,
                prompt,
                stream: false,
                options: { temperature: 0.1, num_predict: 512, top_p: 0.9 },
            }),
        });
        if (!res.ok) throw new Error(`Ollama ${res.status}`);
        const data = await res.json();
        return data.response || '';
    }

    async function queryOpenAI(prompt, signal) {
        const res = await fetch(endpoint.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal,
            body: JSON.stringify({
                model,
                messages: [
                    { role: 'system', content: 'You are a precise code analyzer. Respond only with valid JSON.' },
                    { role: 'user', content: prompt },
                ],
                temperature: 0.1,
                max_tokens: 512,
            }),
        });
        if (!res.ok) throw new Error(`LM Studio ${res.status}`);
        const data = await res.json();
        return data.choices?.[0]?.message?.content || '';
    }

    // ─── The analyzer object ────────────────────────────
    return {
        name: 'llm',
        isSync: false,

        // Expose state as getters (no hidden _ fields — just closure reads)
        get connected() { return connected; },
        get lastError() { return lastError; },
        get model() { return model; },
        get availableModels() { return availableModels; },
        get stats() {
            return {
                requests: requestCount,
                avgLatency: Math.round(avgLatency),
                cacheSize: cache.size,
                model,
                endpoint: endpoint.name,
            };
        },

        /**
         * Connect to the endpoint and discover models
         */
        async init() {
            lastError = null;
            try {
                const health = await fetch(endpoint.healthUrl, {
                    signal: AbortSignal.timeout(3000),
                });
                if (!health.ok) throw new Error(`${endpoint.name} returned ${health.status}`);
                const data = await health.json();

                if (endpoint.type === 'ollama' && data.models) {
                    availableModels = data.models.map(m => m.name);
                } else if (endpoint.type === 'openai' && data.data) {
                    availableModels = data.data.map(m => m.id);
                }

                if (!model && availableModels.length > 0) {
                    model = availableModels[0];
                }

                connected = true;
                console.log(`LLM: connected to ${endpoint.name}, model: ${model}`);
                return true;
            } catch (err) {
                lastError = err.message;
                connected = false;
                console.warn(`LLM: cannot reach ${endpoint.name}: ${err.message}`);
                return false;
            }
        },

        /**
         * Analyze code using the local LLM.
         * @param {string} code - source text
         * @param {Array} words - elements to pick from
         * @returns {Promise<Array<{name, score, evidence}>>}
         */
        async analyze(code, words) {
            if (!connected) throw new Error('LLM not connected');

            // Cache check (keyed on code + word set length for simplicity)
            const key = hashCode(code + words.length);
            if (cache.has(key)) return cache.get(key);

            // Abort previous in-flight
            if (abortController) abortController.abort();
            abortController = new AbortController();

            const t0 = performance.now();
            const prompt = buildPrompt(code, words);

            const raw = endpoint.type === 'ollama'
                ? await queryOllama(prompt, abortController.signal)
                : await queryOpenAI(prompt, abortController.signal);

            const elapsed = performance.now() - t0;
            requestCount++;
            avgLatency = avgLatency === 0 ? elapsed : avgLatency * 0.8 + elapsed * 0.2;

            const picks = parseResponse(raw, words);

            // Cache
            cache.set(key, picks);
            if (cache.size > cacheMax) {
                cache.delete(cache.keys().next().value);
            }

            return picks;
        },

        setEndpoint(key) {
            endpointKey = key;
            endpoint = { ...LLM_ENDPOINTS[key] || LLM_ENDPOINTS.ollama };
            connected = false;
            cache.clear();
            return this.init();
        },

        setModel(m) {
            model = m;
            cache.clear();
        },

        clearCache() { cache.clear(); },

        dispose() {
            if (abortController) abortController.abort();
            cache.clear();
            connected = false;
        },
    };
}

export { LLM_ENDPOINTS };
