/**
 * Frame commands: frame.capture — pull the OS screen-share frame buffer into the
 * scene as a FrameGrid (the "frame buffer is the atlas" path).
 *
 * The command is the verb of record (CLI/agent-discoverable), but getDisplayMedia
 * requires a real user gesture, so the actual permission prompt only fires when the
 * command is dispatched from an in-page click (e.g. the ButtonBar "capture" button).
 * A relayed/headless invocation will reach the getDisplayMedia call but the browser
 * will reject it without a gesture — that's expected and acknowledged.
 */

import * as THREE from 'three';
import FrameGrid from '@glyph3d/core/collections/FrameGrid.js';

/** Default cell budget when dims aren't given — see FrameGrid.deriveGrid. Cell count is
 *  scatter granularity, not image detail, so this is a perf/taste ceiling. */
const DEFAULT_CELL_BUDGET = 4096;

/** Parse an explicit "COLSxROWS" dims arg (e.g. "16x9"); null if absent/unparseable
 *  (the capture path then derives a grid from the real frame size). */
function parseDims(arg) {
    if (typeof arg !== 'string') return null;
    const m = arg.match(/^(\d+)\s*[xX]\s*(\d+)$/);
    if (!m) return null;
    return { cols: Math.max(1, +m[1]), rows: Math.max(1, +m[2]) };
}

/**
 * Create a live four-quadrant test-card MediaStream on an offscreen canvas
 * (`canvas.captureStream(fps)`) through the exact same `<video>` -> `VideoTexture` ->
 * `FrameGrid` -> `InstancedField` path as `frame.capture`.
 *
 * Quadrants:
 *   - Top-left:     red   (#ff0000, rgb(255, 0, 0))
 *   - Top-right:    green (#00ff00, rgb(0, 255, 0))
 *   - Bottom-left:  blue  (#0000ff, rgb(0, 0, 255))
 *   - Bottom-right: white (#ffffff, rgb(255, 255, 255))
 * Plus a 1-px checker strip along the horizontal midline (`y = halfH - 2 .. halfH + 2`)
 * whose phase toggles each tick so `captureStream()` continuously emits frames while the
 * quadrant centres `(0.25, 0.25)`, `(0.75, 0.25)`, `(0.25, 0.75)`, `(0.75, 0.75)` stay
 * pure R / G / B / W.
 *
 * @param {{ width?: number, height?: number, fps?: number }} [opts]
 * @returns {{ stream: MediaStream, stop: () => void, width: number, height: number }}
 */
function createTestCardStream({ width = 320, height = 240, fps = 30 } = {}) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext('2d');
    const halfW = width >> 1;
    const halfH = height >> 1;
    const stripH = 4;
    const checker = g.createImageData(width, stripH);
    let frame = 0;
    let timer = null;

    const draw = () => {
        // Four quadrants: TL red, TR green, BL blue, BR white
        g.fillStyle = '#ff0000';
        g.fillRect(0, 0, halfW, halfH);
        g.fillStyle = '#00ff00';
        g.fillRect(halfW, 0, width - halfW, halfH);
        g.fillStyle = '#0000ff';
        g.fillRect(0, halfH, halfW, height - halfH);
        g.fillStyle = '#ffffff';
        g.fillRect(halfW, halfH, width - halfW, height - halfH);

        // 1-px checker strip across the midline (phase flips per frame so the stream advances)
        const d = checker.data;
        for (let y = 0; y < stripH; y++) {
            for (let x = 0; x < width; x++) {
                const v = ((x + y + frame) & 1) ? 255 : 0;
                const o = (y * width + x) * 4;
                d[o] = v;
                d[o + 1] = v;
                d[o + 2] = v;
                d[o + 3] = 255;
            }
        }
        g.putImageData(checker, 0, halfH - (stripH >> 1));
        frame++;
    };
    draw();
    timer = setInterval(draw, Math.max(16, Math.round(1000 / fps)));
    const stream = canvas.captureStream(fps);
    const stop = () => {
        if (timer) {
            clearInterval(timer);
            timer = null;
        }
        for (const t of stream.getTracks()) t.stop();
    };
    return { stream, stop, width, height };
}

/**
 * Shared handler body for `frame.capture` and `frame.pattern`: attaches a `MediaStream`
 * to a hidden `<video>`, wraps it in a `THREE.VideoTexture`, and mounts a `FrameGrid`.
 */
async function mountStreamFrame(ctx, { stream, stopSource = null, fallbackW = 0, fallbackH = 0, explicitDims = null, name }) {
    // Drive a VideoTexture off a hidden <video>. getSettings() gives the real
    // capture dimensions up front, so the grid's aspect is right on frame one.
    const video = document.createElement('video');
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    video.srcObject = stream;
    // Attach offscreen (NOT display:none — that pauses playback in some browsers,
    // the classic "black panel" cause). 1px, transparent, out of the way keeps it
    // decoding. Removed again in FrameGrid.dispose().
    video.style.cssText = 'position:fixed;left:-2px;top:-2px;width:1px;height:1px;opacity:0;pointer-events:none;';
    document.body.appendChild(video);
    try { await video.play(); } catch { /* autoplay of a muted stream is allowed; ignore */ }

    const settings = stream.getVideoTracks()[0]?.getSettings?.() || {};
    const srcW = settings.width || video.videoWidth || fallbackW;
    const srcH = settings.height || video.videoHeight || fallbackH;
    const aspect = (srcW && srcH) ? srcW / srcH : (16 / 9);

    // Cell grid: honor an explicit COLSxROWS, else derive one proportional to the
    // real capture size, bounded by the cell budget (always within the buffer).
    const { cols, rows } = explicitDims
        || FrameGrid.deriveGrid(srcW, srcH, { budget: DEFAULT_CELL_BUDGET });

    const texture = new THREE.VideoTexture(video);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    texture.colorSpace = THREE.NoColorSpace;

    const grid = new FrameGrid(ctx.scene, ctx.atlas, { name, cols, rows, aspect });

    // Place it upright in front of the camera, facing the viewer.
    const cam = ctx.camera;
    if (cam) {
        const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
        grid.position.copy(cam.position).addScaledVector(forward, 30);
        grid.quaternion.copy(cam.quaternion);
    }

    grid.setFrameSource({ texture, stream, video, stop: stopSource });

    // Registered as type 'frame' so grid/surface consumers (virtualizer, camera
    // framing, edit/keystroke routing) skip it — it's a display surface, not an
    // editable code grid. Deliberately NOT made the 'primary' attention target.
    const registryId = ctx.addGrid(grid, { id: name, type: 'frame' });

    // If the user stops sharing from the browser's own UI, remove the grid so the
    // scene and the capture lifecycle stay in sync.
    const endTrack = stream.getVideoTracks()[0];
    if (endTrack) {
        endTrack.addEventListener('ended', () => {
            try { ctx.removeGrid(registryId); } catch { /* already gone */ }
        }, { once: true });
    }

    return {
        text: `OK: capturing screen → "${registryId}" (${cols}x${rows} cells, aspect ${aspect.toFixed(2)})`,
        data: { registryId, cols, rows, cells: grid.getCellCount(), aspect },
    };
}

/**
 * Detect image format token from raw payload magic bytes on the 0x03 binary plane.
 * @param {Uint8Array} bytes
 * @returns {'png'|'webp'|'jpeg'}
 */
function detectImageFormat(bytes) {
    if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
        return 'png';
    }
    if (bytes.length >= 4 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
        return 'webp';
    }
    return 'jpeg';
}

/** Decode base64 string into Uint8Array. */
function decodeBase64Bytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

/**
 * Parse `desktop.start <name> [WxH] [--browser <url>] [--chromium <bin>]` args.
 * @param {string[]} args
 * @returns {{ name: string, width: number, height: number, url: string, chromium: string } | { error: string }}
 */
function parseDesktopStartArgs(args) {
    let name = '';
    let width = 1280;
    let height = 720;
    let url = 'about:blank';
    let chromium = '';

    for (let i = 0; i < args.length; i++) {
        const tok = String(args[i] ?? '').trim();
        if (!tok) continue;
        if (tok === '--browser' || tok === '--url') {
            if (i + 1 >= args.length) return { error: `ERR: desktop.start: ${tok} requires a URL` };
            url = String(args[++i] ?? '').trim() || 'about:blank';
            continue;
        }
        if (tok === '--chromium') {
            if (i + 1 >= args.length) return { error: 'ERR: desktop.start: --chromium requires a path' };
            chromium = String(args[++i] ?? '').trim();
            continue;
        }
        if (tok.startsWith('--')) {
            return { error: `ERR: desktop.start: unknown flag ${tok}` };
        }
        const dims = parseDims(tok);
        if (dims && name) {
            width = dims.cols;
            height = dims.rows;
        } else if (!name) {
            name = tok;
        } else {
            return { error: `ERR: desktop.start: unexpected argument "${tok}" (usage: desktop.start <name> [WxH] [--browser <url>])` };
        }
    }
    if (!name) {
        return { error: 'ERR: usage: desktop.start <name> [WxH] [--browser <url>]' };
    }
    return { name, width, height, url, chromium };
}

/**
 * Ensure a `1×1` 1:1 `FrameGrid` exists in `ctx.registry` for a relay-owned desktop
 * or binary `0x03` source stream. Restorable across reloads with no user gesture.
 */
function ensureDesktopFrameGrid(ctx, id, width, height, meta = {}) {
    if (!ctx?.scene || !ctx?.registry) return null;
    const existing = ctx.registry.get(id);
    if (
        existing?.grid &&
        (existing.grid.isFrameGrid || existing.type === 'frame' || typeof existing.grid.setFrameTexture === 'function')
    ) {
        const grid = existing.grid;
        existing.meta = existing.meta || {};
        existing.meta.desktop = { ...(existing.meta.desktop || {}), name: id, width, height, ...meta };
        if (width > 0 && height > 0) {
            const nextAspect = width / height;
            if (Math.abs((grid.aspect || 1) - nextAspect) > 1e-4) {
                grid.setAspect?.(nextAspect);
            }
            const prevW = grid._sourceSize?.width || 0;
            const prevH = grid._sourceSize?.height || 0;
            if (prevW !== width || prevH !== height) {
                grid._sourceSize = { width, height };
                grid._emitResize?.(grid.cols, grid.rows);
            }
        }
        return grid;
    }

    const aspect = (width > 0 && height > 0) ? (width / height) : (16 / 9);
    const grid = new FrameGrid(ctx.scene, ctx.atlas, { name: id, cols: 1, rows: 1, aspect });
    grid.setOneToOne(true);
    if (width > 0 && height > 0) {
        grid._sourceSize = { width, height };
    }

    const savedPos = ctx.workspace?.getSurface?.(id)?.view?.position;
    if (savedPos && Number.isFinite(savedPos.x) && Number.isFinite(savedPos.y) && Number.isFinite(savedPos.z)) {
        grid.position.set(savedPos.x, savedPos.y, savedPos.z);
    } else if (ctx.camera) {
        const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(ctx.camera.quaternion);
        grid.position.copy(ctx.camera.position).addScaledVector(forward, 30);
        grid.quaternion.copy(ctx.camera.quaternion);
    }

    ctx.addGrid(grid, {
        id,
        type: 'frame',
        meta: {
            desktop: { name: id, width, height, ...meta },
            stills: [],
        },
    });
    return grid;
}

/**
 * Swap a newly decoded texture onto `grid`, disposing the previous owned byte texture
 * (and closing its ImageBitmap) so streaming 0x03 frames never leak GPU/CPU memory.
 */
function applyDecodedFrameTexture(grid, texture, width, height) {
    const prev = grid._ownedByteTexture;
    const hadFrames = (grid._frames || 0) > 0;
    grid._ownedByteTexture = texture;
    if (width > 0 && height > 0) {
        const nextAspect = width / height;
        if (Math.abs((grid.aspect || 1) - nextAspect) > 1e-4) {
            grid.setAspect?.(nextAspect);
        }
    }
    grid.setFrameTexture(texture);
    if (hadFrames) {
        grid.noteFrame({ width, height });
    }
    if (prev && prev !== texture) {
        try { prev.image?.close?.(); } catch { /* ignore */ }
        try { prev.dispose?.(); } catch { /* ignore */ }
    }
}

/**
 * @param {import('../../client/CommandProvider.jsx').AppRouter} router
 */
export default function registerFrameCommands(router) {
    /** Per-desktop monotonic decode sequence + first-frame waiters. */
    const decodeSeq = new Map();
    const stoppedDesktops = new Set();
    const frameWaiters = new Map();

    const notifyFrameReady = (id) => {
        const list = frameWaiters.get(id);
        if (!list) return;
        frameWaiters.delete(id);
        for (const resolve of list) resolve(true);
    };

    const waitForFirstFrame = (id, timeoutMs = 2500) => new Promise((resolve) => {
        const g = router.context?.registry?.get(id)?.grid;
        if (g?.hasTexture) {
            resolve(true);
            return;
        }
        const timer = setTimeout(() => {
            const arr = frameWaiters.get(id);
            if (arr) {
                const idx = arr.indexOf(done);
                if (idx >= 0) arr.splice(idx, 1);
            }
            resolve(false);
        }, timeoutMs);
        const done = (ok) => {
            clearTimeout(timer);
            resolve(ok);
        };
        let arr = frameWaiters.get(id);
        if (!arr) frameWaiters.set(id, (arr = []));
        arr.push(done);
    });

    const ingestBinaryFrame = async (id, bytes, width, height) => {
        if (!id || !bytes?.length || stoppedDesktops.has(id)) return;
        const ctx = router.context;
        if (!ctx?.scene || !ctx?.registry) return;
        const seq = (decodeSeq.get(id) || 0) + 1;
        decodeSeq.set(id, seq);

        const grid = ensureDesktopFrameGrid(ctx, id, width, height);
        if (!grid) return;

        let decoded;
        try {
            decoded = await FrameGrid.textureFromImageBytes(bytes, detectImageFormat(bytes));
        } catch (err) {
            console.warn(`[desktop] failed to decode 0x03 frame for "${id}":`, err?.message || err);
            return;
        }

        // Drop stale out-of-order decodes or frames for a stopped desktop.
        if (decodeSeq.get(id) !== seq || stoppedDesktops.has(id) || ctx.registry?.get(id)?.grid !== grid) {
            try { decoded.texture.image?.close?.(); } catch { /* ignore */ }
            decoded.texture.dispose();
            return;
        }

        applyDecodedFrameTexture(grid, decoded.texture, decoded.width || width, decoded.height || height);
        notifyFrameReady(id);
    };

    const bindBridge = (bridge) => {
        if (!bridge || bridge._desktopPlaneBound) return;
        bridge._desktopPlaneBound = true;

        // Binary source plane (0x03): [0x03][idLen][id][w:u16 BE][h:u16 BE][jpeg/png bytes]
        bridge.onBinaryFrame(0x03, (id, bytes, width, height) => {
            ingestBinaryFrame(id, bytes, width, height);
        });

        const syncDesktops = async () => {
            try {
                const res = await bridge.rpcRequest('desktop/list', {}, 3000);
                for (const d of res?.desktops || []) {
                    if (!d?.name || stoppedDesktops.has(d.name)) continue;
                    const grid = ensureDesktopFrameGrid(router.context, d.name, d.width, d.height, d);
                    if (grid && !grid.hasTexture) {
                        const still = await bridge.rpcRequest('desktop/still', { name: d.name }, 5000);
                        if (still?.pngBase64 && !grid.hasTexture) {
                            await ingestBinaryFrame(
                                d.name,
                                decodeBase64Bytes(still.pngBase64),
                                still.width || d.width,
                                still.height || d.height,
                            );
                        }
                    }
                }
            } catch {
                // Relay may not have any desktops or may be a minimal test double.
            }
        };

        // On connect / reload: pull active relay-owned desktops so their FrameGrids
        // materialize immediately with no user gesture.
        bridge.onConnectionChange?.((connected) => {
            if (connected) syncDesktops();
        });
        if (bridge.connected) {
            syncDesktops();
        }
    };

    if (router.bridge) bindBridge(router.bridge);
    (router._bridgeListeners ??= []).push(bindBridge);
    router.use?.((_name, _args, ctx) => {
        const b = ctx?.wsbridge || router.bridge;
        if (b) bindBridge(b);
    });
    router.register('frame.capture', async (args, ctx) => {
        const explicitDims = parseDims(args[0]);
        const name = (explicitDims ? args[1] : args[0]) || `screen-${Date.now()}`;

        const md = (typeof navigator !== 'undefined') && navigator.mediaDevices;
        if (!md || typeof md.getDisplayMedia !== 'function') {
            return { text: 'ERR: getDisplayMedia not available in this environment', data: null };
        }
        // Must run inside the click gesture — await directly, no pre-work.
        let stream;
        try {
            stream = await md.getDisplayMedia({ video: true, audio: false });
        } catch (err) {
            return { text: `ERR: screen capture denied or failed: ${err?.message || err}`, data: null };
        }

        return mountStreamFrame(ctx, { stream, explicitDims, name });
    }, { description: 'Capture the OS screen share into a FrameGrid', usage: '[COLSxROWS] [name]' });

    router.register('frame.pattern', async (args, ctx) => {
        if (typeof document === 'undefined') {
            return { text: 'ERR: frame.pattern requires a browser document', data: null };
        }
        const explicitDims = parseDims(args[0]);
        const name = (explicitDims ? args[1] : args[0]) || `pattern-${Date.now()}`;
        const tp = createTestCardStream();
        return mountStreamFrame(ctx, {
            stream: tp.stream,
            stopSource: tp.stop,
            fallbackW: tp.width,
            fallbackH: tp.height,
            explicitDims,
            name,
        });
    }, { description: 'Stream a 4-quadrant (R/G/B/W + 1px checker) canvas test card into a FrameGrid', usage: '[COLSxROWS] [name]' });

    router.register('frame.regrid', (args, ctx) => {
        const id   = args[0];
        const dims = parseDims(args[1]);
        if (!id || !dims) {
            return { text: 'ERR: usage: frame.regrid <id> <COLSxROWS>', data: null };
        }
        const grid = ctx.registry?.get(id)?.grid;
        if (!grid || typeof grid.setGrid !== 'function') {
            return { text: `ERR: no FrameGrid "${id}"`, data: null };
        }
        // Live re-dice: same texture, finer/coarser independently-movable cells.
        grid.setGrid(dims.cols, dims.rows);
        return {
            text: `OK: re-diced "${id}" → ${grid.cols}x${grid.rows} (${grid.getCellCount()} cells)`,
            data: { id, cols: grid.cols, rows: grid.rows, cells: grid.getCellCount() },
        };
    }, { description: 'Re-dice a FrameGrid into a new cell grid (live)', usage: '<id> <COLSxROWS>' });

    // ── Observability + lifecycle: CLI/bus control of capture state, mirroring the
    //    terminal.* roster verbs. These ride only the registry (no interaction/scale
    //    layer), so they're independent of the chrome/dock work. The richer per-capture
    //    intent (source label, place, resume) lands with the state-model work.

    /** Summarize one FrameGrid for list/info output. */
    const frameSummary = (id, grid) => {
        const status = grid.getStreamStatus?.() || null;
        return {
            id,
            cols: grid.cols,
            rows: grid.rows,
            cells: grid.getCellCount?.() ?? grid.cols * grid.rows,
            aspect: +(grid.aspect ?? 0).toFixed(3),
            ...(status ? {
                live: status.live,
                stalled: status.stalled,
                fps: status.fps,
                frames: status.frames,
                lastFrameAgeMs: status.lastFrameAgeMs,
                size: status.size,
                latencyMs: status.latencyMs,
            } : {}),
        };
    };

    /** Format one stream status record as a human-readable line. */
    const formatStatusLine = (s) => {
        const state = s.live ? (s.stalled ? 'STALLED' : 'live') : 'stopped';
        const dims = (s.size?.width && s.size?.height) ? `${s.size.width}x${s.size.height}` : '0x0';
        const age = s.lastFrameAgeMs != null ? `${s.lastFrameAgeMs}ms` : '—';
        const latVal = s.latencyMs?.captureToPresent ?? s.latencyMs?.processing ?? null;
        const lat = latVal != null ? `${latVal}ms` : '—';
        return `${s.id}  ${state}  ${dims}  ${Number(s.fps || 0).toFixed(1)} fps  ${s.frames} frames  age ${age}  latency ${lat}  grid ${s.grid.cols}x${s.grid.rows}`;
    };

    router.register('frame.list', (args, ctx) => {
        const entries = ctx.registry?.findByType?.('frame') ?? [];
        const frames = entries.map((e) => frameSummary(ctx.registry.getIdByGrid(e.grid), e.grid));
        const text = frames.length
            ? frames.map((f) => `${f.id}  ${f.cols}x${f.rows} (${f.cells} cells, aspect ${f.aspect})`).join('\n')
            : '(no captures)';
        return { text, data: { frames, count: frames.length } };
    }, { description: 'List active screen captures (FrameGrids)', usage: '' });

    router.register('frame.info', (args, ctx) => {
        const id = args[0];
        const grid = id && ctx.registry?.get(id)?.grid;
        if (!grid || typeof grid.getCellCount !== 'function') {
            return { text: `ERR: no FrameGrid "${id}"`, data: null };
        }
        const info = frameSummary(id, grid);
        return { text: `${info.id}: ${info.cols}x${info.rows}, ${info.cells} cells, aspect ${info.aspect}`, data: info };
    }, { description: 'Show one capture’s grid + dims', usage: '<id>' });

    router.register('frame.status', (args, ctx) => {
        const id = args[0];
        if (id) {
            const grid = ctx.registry?.get(id)?.grid;
            if (!grid || typeof grid.getStreamStatus !== 'function') {
                return { text: `ERR: no FrameGrid "${id}"`, data: null };
            }
            const status = { ...grid.getStreamStatus(), id };
            return { text: formatStatusLine(status), data: status };
        }
        const entries = ctx.registry?.findByType?.('frame') ?? [];
        const streams = entries
            .filter((e) => typeof e.grid?.getStreamStatus === 'function')
            .map((e) => {
                const fid = ctx.registry.getIdByGrid(e.grid);
                return { ...e.grid.getStreamStatus(), id: fid };
            });
        const text = streams.length
            ? streams.map(formatStatusLine).join('\n')
            : '(no captures)';
        return { text, data: { streams, count: streams.length } };
    }, { description: 'Report stream liveness (fps, last-frame age, size, latency) for one or all captures', usage: '[id]' });

    router.register('frame.kill', (args, ctx) => {
        const id = args[0];
        if (!id) return { text: 'ERR: usage: frame.kill <id>', data: null };
        const entry = ctx.registry?.get(id);
        if (!entry || entry.type !== 'frame') {
            return { text: `ERR: no FrameGrid "${id}"`, data: null };
        }
        // Generic teardown — removeGrid disposes the grid, which stops the MediaStream
        // (so the OS "sharing" indicator clears) and detaches the offscreen <video>.
        ctx.removeGrid(id);
        return { text: `OK: killed capture "${id}"`, data: { id } };
    }, { description: 'Stop a screen capture and remove it', usage: '<id>' });

    // ── Agent-owned desktops (DESIGN.md §3.10, Slice 5) ──────────────────────────
    // Relay-owned headless Chromium producers driven over CDP, streaming frames on
    // the relay's 0x03 binary source plane into a 1:1 FrameGrid.

    router.register('desktop.start', async (args, ctx) => {
        const bridge = ctx.wsbridge || router.bridge;
        if (bridge) bindBridge(bridge);
        const parsed = parseDesktopStartArgs(args);
        if ('error' in parsed) {
            return { text: parsed.error, data: null };
        }
        if (!bridge?.connected) {
            return { text: 'ERR: desktop.start requires a connected relay', data: null };
        }

        const { name, width, height, url, chromium } = parsed;
        stoppedDesktops.delete(name);
        ensureDesktopFrameGrid(ctx, name, width, height, { url });

        let sum;
        try {
            sum = await bridge.rpcRequest('desktop/start', { name, width, height, url, chromium }, 20000);
        } catch (err) {
            // If producer startup failed and no texture ever landed, remove the empty placeholder grid.
            const g = ctx.registry?.get(name)?.grid;
            if (g && !g.hasTexture) {
                try { ctx.removeGrid(name); } catch { /* ignore */ }
            }
            return { text: `ERR: ${err?.message || err}`, data: null };
        }

        const grid = ensureDesktopFrameGrid(ctx, sum.name, sum.width, sum.height, sum);
        await waitForFirstFrame(sum.name, 2500);
        if (grid && !grid.hasTexture) {
            try {
                const still = await bridge.rpcRequest('desktop/still', { name: sum.name }, 5000);
                if (still?.pngBase64 && !grid.hasTexture) {
                    await ingestBinaryFrame(
                        sum.name,
                        decodeBase64Bytes(still.pngBase64),
                        still.width || sum.width,
                        still.height || sum.height,
                    );
                }
            } catch { /* ignore */ }
        }

        return {
            text: `OK: desktop "${sum.name}" started (${sum.width}x${sum.height}, pid ${sum.pid}, ${sum.url})`,
            data: {
                ...sum,
                registryId: sum.name,
                cols: grid?.cols ?? 1,
                rows: grid?.rows ?? 1,
                naturalPx: grid?.naturalPx?.() ?? { w: sum.width, h: sum.height },
                oneToOne: grid?.oneToOne ?? true,
            },
        };
    }, { description: 'Start a relay-owned headless Chromium desktop streaming on the 0x03 binary plane into a 1:1 FrameGrid', usage: '<name> [WxH] [--browser <url>] [--chromium <bin>]' });

    router.register('desktop.stop', async (args, ctx) => {
        const name = String(args[0] ?? '').trim();
        if (!name) return { text: 'ERR: usage: desktop.stop <name>', data: null };
        const bridge = ctx.wsbridge || router.bridge;
        if (bridge) bindBridge(bridge);

        stoppedDesktops.add(name);
        let sum = null;
        let rpcErr = null;
        if (bridge?.connected) {
            try {
                sum = await bridge.rpcRequest('desktop/stop', { name }, 5000);
            } catch (err) {
                rpcErr = err;
            }
        }
        const entry = ctx.registry?.get(name);
        if (entry?.type === 'frame') {
            if (entry.grid?._ownedByteTexture) {
                try { entry.grid._ownedByteTexture.image?.close?.(); } catch { /* ignore */ }
            }
            ctx.removeGrid(name);
        } else if (rpcErr) {
            return { text: `ERR: ${rpcErr?.message || rpcErr}`, data: null };
        } else if (!sum) {
            return { text: `ERR: desktop.stop: no desktop "${name}"`, data: null };
        }
        return {
            text: `OK: desktop "${name}" stopped`,
            data: sum || { name },
        };
    }, { description: 'Stop a relay-owned desktop producer and remove its FrameGrid', usage: '<name>' });

    router.register('desktop.list', async (_args, ctx) => {
        const bridge = ctx.wsbridge || router.bridge;
        if (bridge) bindBridge(bridge);
        if (!bridge?.connected) {
            return { text: 'ERR: desktop.list requires a connected relay', data: null };
        }
        let res;
        try {
            res = await bridge.rpcRequest('desktop/list', {}, 5000);
        } catch (err) {
            return { text: `ERR: ${err?.message || err}`, data: null };
        }
        const rawList = Array.isArray(res?.desktops) ? res.desktops : [];
        const desktops = [];
        for (const d of rawList) {
            let grid = ctx.registry?.get(d.name)?.grid;
            if (!stoppedDesktops.has(d.name)) {
                grid = ensureDesktopFrameGrid(ctx, d.name, d.width, d.height, d);
                if (grid && !grid.hasTexture) {
                    try {
                        const still = await bridge.rpcRequest('desktop/still', { name: d.name }, 5000);
                        if (still?.pngBase64 && !grid.hasTexture) {
                            await ingestBinaryFrame(
                                d.name,
                                decodeBase64Bytes(still.pngBase64),
                                still.width || d.width,
                                still.height || d.height,
                            );
                        }
                    } catch { /* ignore */ }
                }
            }
            const entry = ctx.registry?.get(d.name);
            desktops.push({
                ...d,
                inScene: !!grid,
                naturalPx: grid?.naturalPx?.() ?? { w: d.width, h: d.height },
                oneToOne: grid?.oneToOne ?? false,
                stillsSaved: entry?.meta?.stills?.length ?? d.stills ?? 0,
            });
        }
        const text = desktops.length
            ? desktops.map((d) => `${d.name}  ${d.width}x${d.height}  pid=${d.pid}  frames=${d.frames} stills=${d.stills} dropped=${d.dropped}  url=${d.url}`).join('\n')
            : '(no desktops)';
        return { text, data: { desktops, count: desktops.length } };
    }, { description: 'List active relay-owned desktops', usage: '' });

    router.register('desktop.still', async (args, ctx) => {
        const name = String(args[0] ?? '').trim();
        if (!name) return { text: 'ERR: usage: desktop.still <name>', data: null };
        const bridge = ctx.wsbridge || router.bridge;
        if (bridge) bindBridge(bridge);
        if (!bridge?.connected) {
            return { text: 'ERR: desktop.still requires a connected relay', data: null };
        }

        let res;
        try {
            res = await bridge.rpcRequest('desktop/still', { name }, 10000);
        } catch (err) {
            return { text: `ERR: ${err?.message || err}`, data: null };
        }

        const grid = ensureDesktopFrameGrid(ctx, res.name, res.width, res.height);
        if (grid && res.pngBase64) {
            const seq = (decodeSeq.get(res.name) || 0) + 1;
            decodeSeq.set(res.name, seq);
            const bytes = decodeBase64Bytes(res.pngBase64);
            const decoded = await FrameGrid.textureFromImageBytes(bytes, 'png');
            if (decodeSeq.get(res.name) === seq && ctx.registry?.get(res.name)?.grid === grid) {
                applyDecodedFrameTexture(grid, decoded.texture, decoded.width || res.width, decoded.height || res.height);
            } else {
                try { decoded.texture.image?.close?.(); } catch { /* ignore */ }
                decoded.texture.dispose();
            }
            const entry = ctx.registry?.get(res.name);
            if (entry) {
                entry.meta = entry.meta || {};
                entry.meta.stills = entry.meta.stills || [];
                entry.meta.stills.push({
                    ts: Date.now(),
                    width: res.width,
                    height: res.height,
                    bytes: res.bytes,
                    stills: res.stills,
                    pngBase64: res.pngBase64,
                });
            }
            grid._lastStill = res.pngBase64;
        }

        return {
            text: `OK: desktop "${res.name}" still #${res.stills} (${res.width}x${res.height} PNG, ${res.bytes} bytes)`,
            data: res,
        };
    }, { description: 'Capture a lossless PNG still of a relay-owned desktop via CDP Page.captureScreenshot', usage: '<name>' });
}
