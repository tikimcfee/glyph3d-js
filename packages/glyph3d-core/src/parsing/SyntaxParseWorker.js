/**
 * SyntaxParseWorker — the colorize job off the main thread. One message shape:
 * { jobId, text, descriptor } in → { jobId, ok, palette, packed, parseMs } out,
 * typed arrays TRANSFERRED. The job body is syntaxPaletteJob — the same module
 * the main-thread fallback runs, so worker and fallback cannot drift.
 *
 * Each worker owns its own tree-sitter wasm heap (runtime + the grammars it has
 * seen) — the reason SyntaxParsePool caps lower than the generic pool max.
 */

import { runSyntaxPaletteJob } from './syntaxPaletteJob.js';

self.onmessage = async (e) => {
    const { jobId, text, descriptor } = e.data || {};
    try {
        const { palette, packed, parseMs } = await runSyntaxPaletteJob(text, descriptor);
        self.postMessage({ jobId, ok: true, palette, packed, parseMs }, [palette.buffer, packed.buffer]);
    } catch (err) {
        self.postMessage({ jobId, ok: false, error: String(err?.message ?? err) });
    }
};
