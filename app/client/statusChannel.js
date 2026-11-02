// A tiny activity channel — the live "what's happening" signal the StatusBar
// reflects. Any operation (session restore, repo load, dir open, save, …) posts a
// transient message; the bar shows it until cleared. Client-side, one per ctx, no
// relay needed — the general signal that getProgress() (GitHub-only counts) can't be.
//
// Beside the activity it carries ONE NOTICE: a short line that lives `ms` and is gone — what a
// verb run from a key said went wrong (keyboardRouter keyVerb → ctx.status.notice), since a key
// has no command bar to print its answer. A newer notice replaces the one showing; the activity
// and the notice never clear each other.

/**
 * @typedef {{text: string, kind: 'err'|'notice', ms: number, id: number}} StatusNotice
 */

/** One activity channel (see the file header). */
export function createStatusChannel() {
  let msg = null;
  const listeners = new Set();
  const emit = () => { for (const fn of listeners) { try { fn(msg); } catch (e) { console.warn('[status] listener error', e); } } };
  /** @type {StatusNotice|null} */
  let notice = null;
  let timer = null, seq = 0;
  const noticeListeners = new Set();
  const emitNotice = () => { for (const fn of noticeListeners) { try { fn(notice); } catch (e) { console.warn('[status] notice listener error', e); } } };
  return {
    /** Post the current activity message (null/'' clears). */
    set(m) { const next = m || null; if (next !== msg) { msg = next; emit(); } },
    clear() { this.set(null); },
    get() { return msg; },
    /** @param {(msg: string|null) => void} fn @returns {() => void} unsubscribe */
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** Scoped activity: set on entry, clear on exit (even on throw). */
    async during(m, fn) { this.set(m); try { return await fn(); } finally { this.clear(); } },

    /**
     * Show a notice for `ms`, replacing the one showing. Empty text is refused loud.
     * @param {string} text @param {{kind?: 'err'|'notice', ms: number}} opts
     * @returns {StatusNotice}
     */
    notice(text, { kind = 'notice', ms } = {}) {
      if (typeof text !== 'string' || !text) throw new Error(`status.notice: text must be a non-empty string (got ${JSON.stringify(text)})`);
      if (!(Number.isFinite(ms) && ms > 0)) throw new Error(`status.notice: ms must be a finite number > 0 (got ${ms})`);
      if (kind !== 'err' && kind !== 'notice') throw new Error(`status.notice: kind must be 'err' or 'notice' (got ${JSON.stringify(kind)})`);
      if (timer) clearTimeout(timer);
      const n = { text, kind, ms, id: ++seq };
      notice = n;
      timer = setTimeout(() => { if (notice === n) { notice = null; timer = null; emitNotice(); } }, ms);
      emitNotice();
      return n;
    },
    /** The notice showing now, or null. @returns {StatusNotice|null} */
    getNotice() { return notice; },
    /** @param {(n: StatusNotice|null) => void} fn @returns {() => void} unsubscribe */
    subscribeNotice(fn) { noticeListeners.add(fn); return () => noticeListeners.delete(fn); },
  };
}
