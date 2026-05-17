/**
 * VisitorIntrospect — gather client-side facts about the current browser session.
 *
 * Pure module. Zero network calls. Nothing is logged, nothing is sent.
 * Everything here comes from APIs the browser already exposes synchronously
 * to any page — we're just rendering the handshake back to the visitor.
 *
 * Returns a structured object; renderers read what they need and ignore
 * what's missing. Any field can be null (privacy-restricted browser,
 * unsupported API, etc) — never throw on absence.
 */

/**
 * @typedef {Object} VisitorFacts
 * @property {{ name: string|null, version: string|null }} browser
 * @property {{ name: string|null, version: string|null }} os
 * @property {{
 *   viewport: { w: number, h: number },
 *   screen:   { w: number, h: number },
 *   dpr: number,
 *   colorScheme: 'dark'|'light'|null,
 *   reducedMotion: boolean
 * }} display
 * @property {{ vendor: string|null, renderer: string|null }} gpu
 * @property {{ cores: number|null, memoryGB: number|null, touchPoints: number }} hardware
 * @property {{ language: string, timezone: string|null, now: string }} locale
 * @property {{ effectiveType: string|null }} network
 * @property {{ loadMs: number|null, referrer: string|null }} page
 */

/** @returns {VisitorFacts} */
export function gatherVisitorFacts() {
    return {
        browser: detectBrowser(),
        os: detectOS(),
        display: detectDisplay(),
        gpu: detectGPU(),
        hardware: detectHardware(),
        locale: detectLocale(),
        network: detectNetwork(),
        page: detectPage(),
    };
}

// ─────────────────────────────────────────────────────────────────────────

function detectBrowser() {
    const uad = navigator.userAgentData;
    if (uad?.brands?.length) {
        // userAgentData lists multiple brand-version pairs; the "real" brand
        // is the one that isn't "Not.A/Brand" or "Chromium" (when a wrapper
        // browser also identifies itself). Pick the most specific.
        const brands = uad.brands.filter(b => !/not[._ -]a[._ -]brand/i.test(b.brand));
        const preferred = brands.find(b => !/chromium/i.test(b.brand)) || brands[0];
        if (preferred) return { name: preferred.brand, version: preferred.version };
    }
    // Fallback: parse userAgent. Coarse but works everywhere.
    const ua = navigator.userAgent || '';
    const patterns = [
        { name: 'Firefox', re: /Firefox\/([\d.]+)/ },
        { name: 'Edge',    re: /Edg\/([\d.]+)/ },
        { name: 'Chrome',  re: /Chrome\/([\d.]+)/ },
        { name: 'Safari',  re: /Version\/([\d.]+).*Safari/ },
    ];
    for (const { name, re } of patterns) {
        const m = ua.match(re);
        if (m) return { name, version: m[1] };
    }
    return { name: null, version: null };
}

function detectOS() {
    const uad = navigator.userAgentData;
    if (uad?.platform) return { name: uad.platform, version: null };

    const ua = navigator.userAgent || '';
    if (/Windows NT 10/.test(ua))    return { name: 'Windows', version: '10/11' };
    if (/Windows NT (\d+\.\d+)/.test(ua)) return { name: 'Windows', version: RegExp.$1 };
    if (/Mac OS X ([\d_.]+)/.test(ua))    return { name: 'macOS',   version: RegExp.$1.replace(/_/g, '.') };
    if (/Android ([\d.]+)/.test(ua))      return { name: 'Android', version: RegExp.$1 };
    if (/iPhone OS ([\d_]+)/.test(ua))    return { name: 'iOS',     version: RegExp.$1.replace(/_/g, '.') };
    if (/Linux/.test(ua))                 return { name: 'Linux',   version: null };
    return { name: null, version: null };
}

function detectDisplay() {
    return {
        viewport: { w: window.innerWidth, h: window.innerHeight },
        screen:   { w: window.screen?.width || 0, h: window.screen?.height || 0 },
        dpr: window.devicePixelRatio || 1,
        colorScheme: window.matchMedia?.('(prefers-color-scheme: dark)')?.matches ? 'dark'
                   : window.matchMedia?.('(prefers-color-scheme: light)')?.matches ? 'light'
                   : null,
        reducedMotion: !!window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches,
    };
}

function detectGPU() {
    // WEBGL_debug_renderer_info is the only way to read GPU strings from JS.
    // It's privacy-gated in some browsers (returns "Apple GPU" or generic
    // names). Use a throwaway canvas — never reuse the renderer's context.
    try {
        const c = document.createElement('canvas');
        const gl = c.getContext('webgl2') || c.getContext('webgl');
        if (!gl) return { vendor: null, renderer: null };
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        if (!ext) {
            // Some browsers expose unmasked strings without the extension.
            return {
                vendor: gl.getParameter(gl.VENDOR) || null,
                renderer: gl.getParameter(gl.RENDERER) || null,
            };
        }
        return {
            vendor:   gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) || null,
            renderer: gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || null,
        };
    } catch {
        return { vendor: null, renderer: null };
    }
}

function detectHardware() {
    return {
        cores: navigator.hardwareConcurrency || null,
        memoryGB: navigator.deviceMemory || null,  // Chrome only
        touchPoints: navigator.maxTouchPoints || 0,
    };
}

function detectLocale() {
    let timezone = null;
    try { timezone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch {}
    const now = new Date();
    const timeStr = now.toLocaleTimeString(undefined, {
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
    return {
        language: navigator.language || 'unknown',
        timezone,
        now: timeStr,
    };
}

function detectNetwork() {
    // navigator.connection is Chromium-only. Firefox and Safari return undefined.
    const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    return {
        effectiveType: c?.effectiveType || null,
    };
}

function detectPage() {
    let loadMs = null;
    try {
        const navEntry = performance.getEntriesByType('navigation')?.[0];
        if (navEntry) {
            // domContentLoadedEventEnd is "DOM is interactive + scripts ran";
            // good proxy for "how long until the page felt alive."
            loadMs = Math.round(navEntry.domContentLoadedEventEnd);
        }
    } catch {}
    return {
        loadMs,
        referrer: document.referrer || null,
    };
}
