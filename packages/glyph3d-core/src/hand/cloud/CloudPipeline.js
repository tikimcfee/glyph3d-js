/**
 * CloudPipeline — the page's side of cloudWorker: one hand-cloud tracker in a module worker,
 * fed every crop as it arrives. Latest wins INSIDE the worker: while it is busy, a newer crop
 * for the same hand replaces the one waiting there (a stale crop is worth nothing at 30 Hz),
 * and how many were replaced is counted — the tracker falling behind, in the open. The page
 * never holds a crop back waiting for a result, so a busy page frame can't idle the worker.
 *
 * Also drives the worker's simulated source (HandSim + DepthSim), whose frames come back
 * through `onSimFrame` for the page to inject into its SourceStream — so simulated crops ride
 * the same path a phone's do.
 *
 * No DOM beyond `Worker`. A worker that can't be spawned is an error, loudly: there is no
 * silent main-thread fallback.
 */

export default class CloudPipeline {
    /**
     * @param {{onResult?: (r: Object) => void, onSimFrame?: (payload: Object) => void, onError?: (e: Object) => void}} [hooks]
     */
    constructor({ onResult = null, onSimFrame = null, onError = null } = {}) {
        this.onResult = onResult;
        this.onSimFrame = onSimFrame;
        this.onError = onError || ((e) => console.error(`[hand-cloud] worker ${e.where}: ${e.message}`, e.stack || ''));
        this.worker = new Worker(new URL('./cloudWorker.js', import.meta.url), { type: 'module' });
        this.worker.onmessage = (ev) => this._onMessage(ev.data);
        this.worker.onerror = (ev) => this.onError({ where: 'worker', message: ev?.message ?? String(ev), stack: null });
        this._seq = 0;
        this._rt = [];
        this._wk = [];
        this._qd = [];
        /** seq → {job, sentAt}: posted, not yet answered. */
        this._sent = new Map();
        this.stats = { submitted: 0, tracked: 0, replaced: 0, failed: 0, lastError: null, roundTripMs: null, lastAt: null };
    }

    /** Round trip and in-worker time over the last ≤120 results: median and p90, ms. */
    timing() {
        const q = (a, p) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? Math.round(s[Math.floor(p * (s.length - 1))] * 10) / 10 : null; };
        return {
            n: this._rt.length,
            roundTrip: { p50: q(this._rt, 0.5), p90: q(this._rt, 0.9) },
            worker: { p50: q(this._wk, 0.5), p90: q(this._wk, 0.9) },
            queued: { p50: q(this._qd, 0.5), p90: q(this._qd, 0.9) },
        };
    }

    /** Every crop posted has been answered (tracked, replaced or failed). */
    get idle() { return !this._sent.size; }

    /** Tracker knobs (merged in the worker; take hold next frame). @param {Object} opts */
    setOpts(opts) { this.worker.postMessage({ type: 'opts', opts }); }

    /** Forget the tracker's temporal state. */
    reset() { this.worker.postMessage({ type: 'reset' }); }

    /**
     * Post one hand's crop to the worker (now — the worker keeps only the newest per hand).
     * @param {{cloud: Object, hand: Object|null, bones: Object|null, ceiling: number|null, t: number, handedness: string, view: boolean}} job
     */
    submit(job) {
        this.stats.submitted++;
        const seq = ++this._seq;
        this._sent.set(seq, { job, sentAt: performance.now() });
        this.worker.postMessage({ type: 'track', seq, ...job });
    }

    /** @private */
    _settleReplaced(seqs) {
        for (const s of seqs || []) if (this._sent.delete(s)) this.stats.replaced++;
    }

    /** Drive the worker's simulated source. @param {Object} msg - {cmd, mode, rate, seed, sim, depth, yawDeg, tiltDeg} */
    sim(msg) { this.worker.postMessage({ type: 'sim', ...msg }); }

    /** @private */
    _onMessage(m) {
        if (m.type === 'result') {
            this._settleReplaced(m.replaced);
            const f = this._sent.get(m.seq);
            this._sent.delete(m.seq);
            if (!f) return;
            this.stats.tracked++;
            this.stats.roundTripMs = performance.now() - f.sentAt;
            // Where the round trip goes: waiting in the worker, tracking, or the trip back.
            this._rt.push(this.stats.roundTripMs); this._wk.push(m.workerMs ?? NaN); this._qd.push(m.queuedMs ?? NaN);
            if (this._rt.length > 120) { this._rt.shift(); this._wk.shift(); this._qd.shift(); }
            this.stats.lastAt = performance.now();
            this.onResult?.({ ...m, job: f.job });
        } else if (m.type === 'simFrame') this.onSimFrame?.(m.payload);
        else if (m.type === 'error') {
            this.onError(m);
            if (m.where === 'track') {
                this._settleReplaced(m.replaced);
                this._sent.delete(m.seq);
                this.stats.failed++;
                this.stats.lastError = m.message;
            }
        }
    }

    dispose() {
        this.worker.terminate();
        this._sent.clear();
    }
}
