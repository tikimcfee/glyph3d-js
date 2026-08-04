/**
 * SessionParseWorker — off-thread transcript codec. One job message in
 * ({ jobId, harness, bytes:{buffer,byteOffset,byteLength}, cwd, cap } — the
 * buffer is TRANSFERRED, so a 45MB transcript crosses by reference, never by
 * copy), one result message out ({ type:'RESULT', jobId, events, total, cwd,
 * meta, firstTs, lastTs }) or ({ type:'ERROR', jobId, message }).
 *
 * The parse itself lives in sessionParseJob (pure) — this file is only the
 * postMessage plumbing. The worker is a SINGLETON (SessionParsePool): jobs
 * queue FIFO on its port; the point is keeping megabyte JSON.parse work off
 * the main thread, not parallelism across books.
 */

import { runSessionParseJob } from './sessionParseJob.js';

self.onmessage = (e) => {
    const { jobId, bytes, ...rest } = e.data || {};
    try {
        const view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const result = runSessionParseJob({ bytes: view, ...rest });
        self.postMessage({ type: 'RESULT', jobId, ...result });
    } catch (err) {
        self.postMessage({ type: 'ERROR', jobId, message: String(err?.message || err) });
    }
};
