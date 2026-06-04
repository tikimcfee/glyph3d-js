// A tiny activity channel — the live "what's happening" signal the StatusBar
// reflects. Any operation (session restore, repo load, dir open, save, …) posts a
// transient message; the bar shows it until cleared. Client-side, one per ctx, no
// relay needed — the general signal that getProgress() (GitHub-only counts) can't be.

export function createStatusChannel() {
  let msg = null;
  const listeners = new Set();
  const emit = () => { for (const fn of listeners) { try { fn(msg); } catch (e) { console.warn('[status] listener error', e); } } };
  return {
    /** Post the current activity message (null/'' clears). */
    set(m) { const next = m || null; if (next !== msg) { msg = next; emit(); } },
    clear() { this.set(null); },
    get() { return msg; },
    /** @param {(msg: string|null) => void} fn @returns {() => void} unsubscribe */
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** Scoped activity: set on entry, clear on exit (even on throw). */
    async during(m, fn) { this.set(m); try { return await fn(); } finally { this.clear(); } },
  };
}
