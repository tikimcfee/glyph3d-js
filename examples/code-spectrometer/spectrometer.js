/**
 * spectrometer.js — Display orchestration
 *
 * Pure functions that join analyzer picks back to a word set
 * for rendering. No state, no classes. Just transforms:
 *
 *   picks + words → merged results (with intensities)
 *   picks → fingerprint string
 *   picks + words → summary object
 *
 * The spectrometer doesn't analyze. It presents.
 */

/**
 * Merge analyzer picks into the full word set for display.
 * Every word gets a result entry — active ones get scores/intensity,
 * inactive ones get zeros. The HUD renders from this.
 *
 * @param {Array<{name, score, evidence}>} picks - from an analyzer
 * @param {Array} words - the full word set (elements)
 * @returns {Array<{word, score, intensity, tier, evidence}>}
 */
export function mergePicks(picks, words) {
    const pickMap = new Map(picks.map(p => [p.name, p]));
    const maxScore = picks.length > 0
        ? Math.max(...picks.map(p => p.score))
        : 1;
    const logMax = Math.log(1 + maxScore);

    return words.map(word => {
        const pick = pickMap.get(word.name);
        const score = pick?.score || 0;
        const intensity = score > 0 ? Math.log(1 + score) / logMax : 0;

        let tier = 'inactive';
        if (intensity > 0.8)      tier = 'dominant';
        else if (intensity > 0.5) tier = 'high';
        else if (intensity > 0.25) tier = 'medium';
        else if (intensity > 0)   tier = 'low';

        return {
            word,
            score,
            intensity,
            tier,
            evidence: pick?.evidence || [],
        };
    });
}

/**
 * Generate a compact fingerprint string from picks.
 * Like a chemical formula: Fn15 Cs12 Ar8 ...
 *
 * @param {Array<{name, score}>} picks - from an analyzer
 * @param {Array} words - word set (for symbol lookup)
 * @param {number} max - max elements in fingerprint
 * @returns {string}
 */
export function fingerprint(picks, words, max = 12) {
    const symbolMap = new Map(words.map(w => [w.name, w.symbol]));

    return picks
        .slice(0, max)
        .map(p => `${symbolMap.get(p.name) || '??'}${p.score}`)
        .join(' ');
}

/**
 * Generate a summary of the analysis.
 *
 * @param {Array<{name, score, evidence}>} picks - from an analyzer
 * @param {Array} words - word set
 * @param {number} totalTokens - optional token count from tokenizer
 * @returns {object}
 */
export function summarize(picks, words, totalTokens = 0) {
    const symbolMap = new Map(words.map(w => [w.name, w]));

    const top10 = picks.slice(0, 10).map(p => {
        const w = symbolMap.get(p.name);
        return `${w?.symbol || '??'} ${p.name}: ${p.score} (${p.evidence.join(', ')})`;
    });

    return {
        totalTokens,
        matchedPicks: picks.length,
        totalWords: words.length,
        top10,
        picks,
    };
}
