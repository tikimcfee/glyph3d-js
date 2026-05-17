/**
 * HomeShell — landing-page orchestrator for /app/home.html.
 *
 * Stands up a minimal 3D scene (no IDE chrome), boots the glyph engine
 * (atlas + HarfBuzz + Slug), wires a CommandRouter with all the built-in
 * command handlers, then mounts:
 *   - WelcomeCluster   (visitor-introspection facts, in 3D)
 *   - TryThisCluster   (a few runnable invitations, in 3D)
 *   - HomeCommandBar   (bottom-third command surface, DOM overlay)
 *
 * The full IDE (GitHubRepoViewer + IDEShell) is left untouched. This is
 * a separate entry point — its own boot, its own DOM, its own scene.
 *
 * Some built-in commands assume IDE-shell context (registry, layoutManager,
 * cameraController, etc.) and will fail when invoked here. That's fine for
 * now — the bar surfaces the error, the visitor sees a real response, and
 * the commands that DO work (help, status, camera.animate, tour, ping)
 * are the ones the home page is built around.
 */

import * as THREE from 'three';
import { GlyphAtlas, HarfBuzzShaper, SlugEncoder, collectUniqueGlyphIds } from '../src/index.js';
import SceneRegistry from '../src/services/SceneRegistry.js';
import CommandRouter from '../src/services/orchestration/CommandRouter.js';
import WebSocketBridge from '../src/services/orchestration/WebSocketBridge.js';
import { registerAllCommands } from './commands/handlers/index.js';

import { gatherVisitorFacts } from './home/VisitorIntrospect.js';
import WelcomeCluster from './home/WelcomeCluster.js';
import TryThisCluster from './home/TryThisCluster.js';
import HomeCommandBar from './home/HomeCommandBar.js';
import { runDemo, DEMO_SCRIPTS } from './home/DemoRunner.js';
import ReferenceSpace from './home/ReferenceSpace.js';
import { Center, HStack, Spacer, Anchor, frameNodes } from './home/layout/index.js';
import { registerDemos } from './home/demos/index.js';
import { SceneContext } from '../src/services/SceneContext.js';
import { ViewerCameraController } from '../src/services/camera/ViewerCameraController.js';

const ATLAS_FONT      = 'Cousine, Monaco, Menlo, Courier New, monospace';
const ATLAS_FONT_SIZE = 48;
const ATLAS_SIZE      = 2048;

export class HomeShell {
    /**
     * @param {{ canvas: HTMLCanvasElement }} deps
     */
    constructor({ canvas }) {
        if (!canvas) throw new Error('HomeShell: canvas required');
        this.canvas = canvas;

        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.atlas = null;
        this.shaper = null;

        this.router = null;
        this.context = null;
        this.bridge = null;

        this.welcome = null;
        this.tryThis = null;
        this.bar = null;
        this.referenceSpace = null;
        this.layoutRoot = null;
        this.sceneContext = null;
        this.cameraController = null;

        this._rafId = null;
        this._resizeObs = null;
        this._activeDemo = null;
    }

    async init() {
        await this._initThree();
        await this._initGlyphEngine();
        this._initRouter();

        // Reference space first — it's the room the content lives in.
        // Adding it before the layout root keeps depth-sorting predictable
        // (background geometry first, content on top).
        this.referenceSpace = new ReferenceSpace({ scene: this.scene });
        this.scene.add(this.referenceSpace);

        // Visitor facts → clusters → composed layout.
        const facts = gatherVisitorFacts();
        this.welcome = new WelcomeCluster({ scene: this.scene, atlas: this.atlas, facts });
        this.tryThis = new TryThisCluster({ scene: this.scene, atlas: this.atlas });

        // The whole page is: center an HStack of [welcome, gap, tryThis]
        // at the world origin. The camera looks at (0,0,0), so "centered
        // in the world" = "centered on screen".
        this.layoutRoot = Center(
            HStack({ gap: 36, align: Anchor.TOP_CENTER }, [
                this.welcome.grid,
                this.tryThis.grid,
            ]),
        );
        this.scene.add(this.layoutRoot);
        this.layoutRoot.layout();

        // Frame the camera to fit whatever the layout produced. This
        // replaces the hard-coded camera.position.set(0,0,200) — any
        // composition of any size is centered + scaled to fit. Padding
        // gives a bit of margin so glyphs don't crowd the frame edges.
        this._reframe();

        // Camera controls: reuse the IDE's ViewerCameraController so the
        // home page has the SAME translation-first navigation feel
        // (click-drag pans, scroll zooms, WASD translates) and the SAME
        // trackpad/wheel detection + tuned sensitivities that took the
        // IDE serious effort to get right. SceneContext gives it the
        // refs it expects.
        this.sceneContext = new SceneContext({
            THREE,
            scene:    this.scene,
            camera:   this.camera,
            renderer: this.renderer,
            canvas:   this.canvas,
            atlas:    this.atlas,
            getGrids: () => [],   // no registry-backed grids on home; demos manage their own
        });
        this.cameraController = new ViewerCameraController(this.sceneContext);
        this.cameraController.setupEventListeners();

        // Command bar last — it overlays the canvas as a DOM surface.
        this.bar = new HomeCommandBar({ router: this.router });
        this.bar.mount(document.body);
        this.bar.appendOutput(
            'glyph engine ready. type a command, or try one to the side.',
            'info'
        );
        this.bar.appendOutput(
            '   drag to pan · scroll to zoom · WASD to fly',
            'info'
        );
        // Don't auto-focus — let the visitor look at the cluster first.
        // They can click into the bar when they're ready.

        // Connect to the WS relay as DISPLAY. This is the live-dev channel:
        //   - the agent / a human can send commands via `glyph3d-cli <cmd>`
        //     and they execute through the same CommandRouter the bar uses.
        //   - console.log/warn/error + uncaught errors are forwarded so the
        //     server log shows what the browser sees, in real time.
        this._installLogForwarders();

        // Tell the bootstrap livereload watcher in home.html to release
        // the DISPLAY slot — the relay only allows one. Then connect.
        window.dispatchEvent(new Event('home:bridge-ready'));

        this.bridge = new WebSocketBridge(this.router, {
            autoConnect: true,
            showStatus: false,  // home page is its own visual; no status badge
        });
        this.context.wsbridge = this.bridge;

        // Livereload: when glyph3d-cli's watcher sees a file change in src/
        // or app/, the relay sends an fs/didChange notification. Without
        // this handler the bridge connects but the browser never reloads —
        // editing then re-screenshotting reads stale pixels forever.
        this.bridge.setRpcNotificationHandler((method, params) => {
            if (method === 'fs/didChange' && params?.event === 'change') {
                console.log(`[livereload] ${params.path} changed, reloading…`);
                location.reload();
            }
        });

        // Home-specific commands need bridge + clusters + bar to exist,
        // so they register LAST. tour/ping use bar for step narration;
        // demos snapshot bridge + scene/atlas/camera at registration time.
        this._registerHomeCommands();

        // Boot marker — delayed so the WebSocketBridge has time to register
        // as display (the log forwarder no-ops until bridge.connected).
        setTimeout(() => {
            console.log(`[home] ready — ${this.scene.children.length} cluster(s) in scene`);
        }, 1500);

        this._startRenderLoop();
        this._wireResize();
    }

    /**
     * Patch console + uncaught-error handlers to forward to the relay via
     * WebSocketBridge once it connects. Cribbed from the equivalent in
     * app/commands/index.js, with two additions:
     *   - window.onerror (uncaught synchronous errors)
     *   - unhandledrejection (uncaught promise rejections)
     * Both are common-case failure surfaces for live dev that plain
     * console.* doesn't catch on its own.
     *
     * Forwarders are no-ops until `this.bridge.connected` flips true, then
     * fire-and-forget. Original console output is preserved either way.
     * @private
     */
    _installLogForwarders() {
        if (HomeShell._forwardersInstalled) return;  // module-level guard
        HomeShell._forwardersInstalled = true;
        const MAX_LEN = 400;
        const send = (level, text) => {
            const b = this.bridge;
            if (!b || !b.connected || typeof b.ws?.send !== 'function') return;
            if (text.length > MAX_LEN) text = text.slice(0, MAX_LEN) + '…';
            try {
                b.ws.send(JSON.stringify({ event: 'browser.log', level, text }));
            } catch {}
        };
        for (const level of ['log', 'warn', 'error']) {
            const orig = console[level].bind(console);
            console[level] = (...args) => {
                orig(...args);
                let text;
                try {
                    text = args.map(a => {
                        if (typeof a === 'string') return a;
                        if (a instanceof Error) {
                            return a.stack ? `${a.message}\n${a.stack}` : a.message || String(a);
                        }
                        try { return JSON.stringify(a); } catch { return String(a); }
                    }).join(' ');
                } catch {
                    text = String(args[0] ?? '');
                }
                send(level, text);
            };
        }
        window.addEventListener('error', (e) => {
            const msg = e.error?.stack || e.message || String(e);
            send('error', `[uncaught] ${msg}`);
        });
        window.addEventListener('unhandledrejection', (e) => {
            const r = e.reason;
            const msg = r?.stack || r?.message || String(r);
            send('error', `[unhandled-rejection] ${msg}`);
        });
    }

    // ─────────────────────────────────────────────────────────────────
    // THREE
    // ─────────────────────────────────────────────────────────────────

    async _initThree() {
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x050608);

        const { w, h } = this._viewportSize();
        this.camera = new THREE.PerspectiveCamera(70, w / h, 0.1, 10000);
        // Closer than the IDE's default (500) — the home page only has the
        // welcome + try-this clusters; we want them to feel like the focus,
        // not lost in negative space.
        this.camera.position.set(0, 0, 200);

        this.renderer = new THREE.WebGLRenderer({
            canvas: this.canvas,
            antialias: true,
            // preserveDrawingBuffer: true is required for `screenshot` to
            // capture non-empty pixels via canvas.toDataURL(). Without it,
            // the GL spec lets the browser clear the buffer between frames
            // and the readback comes out black. Costs a second framebuffer.
            preserveDrawingBuffer: true,
        });
        this.renderer.setSize(w, h, false);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    }

    _viewportSize() {
        // The canvas fills the window — no IDE chrome to deduct.
        return { w: window.innerWidth, h: window.innerHeight };
    }

    // ─────────────────────────────────────────────────────────────────
    // Glyph engine boot (atlas + HarfBuzz + Slug)
    //
    // This mirrors GitHubRepoViewer.init() — same primitives, same order,
    // minus the progress UI and the IDE chrome. If the sequence drifts in
    // the production viewer, this is the place to bring it back in sync.
    // ─────────────────────────────────────────────────────────────────

    async _initGlyphEngine() {
        this.atlas = new GlyphAtlas(ATLAS_FONT, ATLAS_FONT_SIZE, ATLAS_SIZE);
        await this.atlas.generate();

        // Load font, init HarfBuzz, prime shape cache.
        const fontUrl = new URL('../src/fonts/Cousine-Regular.ttf', import.meta.url).href;
        const fontResp = await fetch(fontUrl);
        const fontBuffer = await fontResp.arrayBuffer();

        this.shaper = new HarfBuzzShaper();
        await this.shaper.init(fontBuffer);

        const { default: MonospaceShapeCache } =
            await import('../src/shaping/MonospaceShapeCache.js');

        let cacheProbe = '';
        for (let cp = 0x20; cp <= 0x7E; cp++) cacheProbe += String.fromCodePoint(cp);
        for (let cp = 0xA0; cp <= 0xFF; cp++) cacheProbe += String.fromCodePoint(cp);
        for (let cp = 0x2500; cp <= 0x257F; cp++) cacheProbe += String.fromCodePoint(cp);

        const shapeCache = new MonospaceShapeCache(this.shaper);
        shapeCache.prime(cacheProbe);

        // Workers need the shaper + cache too.
        const { getWorkerBridge } = await import('../src/workers/WorkerBridge.js');
        getWorkerBridge().setShaper(this.shaper, shapeCache);

        // Encode glyph outlines → GPU textures.
        const probeText = Array.from({ length: 95 }, (_, i) =>
            String.fromCharCode(32 + i)).join('');
        const { shapeText: shapeTextFn } =
            await import('../src/shaping/shapeText.js');
        const shaped = shapeTextFn(shapeCache, probeText);
        const glyphIds = collectUniqueGlyphIds(shaped.lines);

        const encoder = new SlugEncoder(this.shaper);
        const slugResult = encoder.encode(glyphIds);

        // CodeGrid instances auto-discover these off the atlas.
        this.atlas._slugData = slugResult;
        this.atlas._shaper = this.shaper;
    }

    // ─────────────────────────────────────────────────────────────────
    // Command router
    // ─────────────────────────────────────────────────────────────────

    _initRouter() {
        const registry = new SceneRegistry();

        // Minimal context — what HomeShell can honestly provide. Commands
        // that need IDE-only fields (layoutManager, cameraController,
        // fileStateManager, etc.) will fail at execution time with a
        // readable error in the bar. That's an acceptable tradeoff:
        // surfacing real errors is more honest than registering shims
        // that pretend things exist.
        this.context = {
            scene: this.scene,
            camera: this.camera,
            renderer: this.renderer,
            atlas: this.atlas,
            registry,
            getGrids: () => registry.toArray('grid'),
            // Animation cancellation slot used by camera.animate.
            _cancelCameraAnimation: null,
            // Stub the agent grid map so `status` doesn't NPE.
            _agentGrids: new Map(),
        };

        this.router = new CommandRouter(this.context);

        try {
            registerAllCommands(this.router);
        } catch (err) {
            // Registration shouldn't depend on context — but if any module
            // does something funny we'd rather surface it than crash boot.
            console.warn('[home] some commands failed to register:', err);
        }
    }

    /**
     * Register home-page-specific commands on top of the built-in set.
     * These wrap demo scripts so the visitor's "tour" keyword just works.
     */
    _registerHomeCommands() {
        this.router.register('tour', async () => {
            // Cancel any in-flight demo so re-typing 'tour' restarts cleanly.
            this._activeDemo?.cancel();
            this._activeDemo = runDemo(this.router, DEMO_SCRIPTS.tour, {
                onStep: (_i, step) => {
                    if (step.label) this.bar?.appendOutput(`  • ${step.label}`, 'info');
                },
            });
            try {
                await this._activeDemo.done;
                return { text: 'tour complete.' };
            } catch (e) {
                if (e?.cancelled) return { text: 'tour cancelled.' };
                throw e;
            } finally {
                this._activeDemo = null;
            }
        }, { description: 'Take a guided camera tour around the welcome cluster.' });

        this.router.register('ping', async () => {
            this._activeDemo?.cancel();
            this._activeDemo = runDemo(this.router, DEMO_SCRIPTS.ping);
            try { await this._activeDemo.done; } finally { this._activeDemo = null; }
            return { text: 'pong.' };
        }, { description: 'Health check — runs the smallest demo script.' });

        // Engine-showcase demos — each is a self-contained answer to
        // "what does the engine actually do?" Visitors pick by name; the
        // runner cancels any in-flight demo when a new one starts.
        this.demoRunner = registerDemos(this.router, {
            welcome:          this.welcome,
            tryThis:          this.tryThis,
            layoutRoot:       this.layoutRoot,
            scene:            this.scene,
            atlas:            this.atlas,
            camera:           this.camera,
            bridge:           this.bridge,
            cameraController: this.cameraController,
            bar:              this.bar,
            reframe:          () => this._reframe(),
        });
    }

    // ─────────────────────────────────────────────────────────────────
    // Render loop + resize
    // ─────────────────────────────────────────────────────────────────

    _startRenderLoop() {
        // Compositor refresh trick: Firefox throttles rAF on unfocused
        // tabs AND caches frames when DOM hasn't visibly changed — which
        // breaks BiDi captureScreenshot during live dev (every snapshot
        // returns the same cached frame). Bumping a CSS custom property
        // each tick is the cheapest way to mark the page as "dirty" so
        // the compositor always serves fresh pixels. Invisible to humans,
        // ~free in cost.
        let n = 0;
        let lastT = performance.now();
        const root = document.documentElement;
        const tick = () => {
            this._rafId = requestAnimationFrame(tick);
            const now = performance.now();
            const dt = (now - lastT) / 1000;
            lastT = now;
            // Camera controller drives position/rotation from accumulated
            // input state; must run BEFORE render so this frame reflects
            // the latest pan/zoom.
            this.cameraController?.update(dt);
            this.renderer.render(this.scene, this.camera);
            root.style.setProperty('--frame-tick', String(n++));
        };
        this._rafId = requestAnimationFrame(tick);
    }

    _wireResize() {
        const handler = () => {
            const { w, h } = this._viewportSize();
            this.renderer.setSize(w, h, false);
            this.camera.aspect = w / h;
            this.camera.updateProjectionMatrix();
            this.layoutRoot?.layout();
            this._reframe();
        };
        window.addEventListener('resize', handler);
        this._resizeHandler = handler;
    }

    /**
     * Re-frame the camera to fit whatever's currently in the layout root.
     * Called on init, on resize, and after any demo that mutates layout.
     *
     * `bottomReserve: 0.45` tells frameBox to pretend the box is 45%
     * taller than it really is, then aim below center — so the actual
     * content occupies the upper portion of the canvas and the bottom
     * (which is overlaid by the DOM command bar) reads as floor/sky.
     */
    _reframe() {
        if (!this.camera || !this.layoutRoot) return;
        const result = frameNodes(this.camera, [this.layoutRoot], {
            padding: 1.20,
            bottomReserve: 0.85,
        });
        // Aim the controller's focus pivot at the framed center so
        // zoom/orbit anchors on real content instead of a stale point.
        if (result && this.cameraController?.input?.focus?.pivot) {
            this.cameraController.input.focus.pivot.copy(result.target);
        }
    }

    // ─────────────────────────────────────────────────────────────────
    // Teardown (mostly for hot-reload / future tests)
    // ─────────────────────────────────────────────────────────────────

    dispose() {
        if (this._rafId) cancelAnimationFrame(this._rafId);
        if (this._resizeHandler) window.removeEventListener('resize', this._resizeHandler);
        this._activeDemo?.cancel();
        this.bar?.dispose();
        this.welcome?.dispose();
        this.tryThis?.dispose();
        this.renderer?.dispose();
    }
}
