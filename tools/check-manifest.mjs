/**
 * check-manifest.mjs — every check the repo has, declared once: what it runs, when it runs,
 * what it needs, what it compares and what it cannot see. `bun tools/check.mjs` executes it;
 * `bun tools/check.mjs --list` prints it.
 *
 * An entry:
 *   name     unique; a positional argument to check.mjs selects it alone
 *   cmd      argv, run from the repo root. Placeholders the runner fills from what it started:
 *            {url} the app's Vite, {wallUrl} the wall's Vite, {relay} a private relay's port,
 *            {root} that relay's scratch root, {dir} the fixture source dir inside it
 *   env      extra environment, same placeholders
 *   tier     inner   fast headless — after each change (a few seconds at -j)
 *            full    the rest of the headless checks (code form, vendored inputs); a `full` run is
 *                    inner + full
 *            browser needs a browser on the app's Vite (and maybe a private relay)
 *            gpu     needs a real GPU: pixel compares, the wall end to end, GPU timing
 *            parked  run only when asked (`--tier parked`): kept so they aren't lost
 *   scope    what a change has to touch for this check to matter (SCOPES below)
 *   needs    vite | wall-vite | relay | browser | gpu | tmux | network — the runner provides
 *            vite / wall-vite / relay itself, and SKIPS a check (with a NOTE naming what is
 *            missing) when it can't
 *   apart    tokens; two checks sharing one never run at once. '*' runs alone, after the rest
 *   compare  what the check holds against what
 *   blind    what it cannot see — where a green run proves nothing
 *   known    a RED the repo carries on purpose: {reason, signature: [RegExp…]}. The run stays green
 *            only while the failure matches every signature (a different failure is RED), and an
 *            unexpected pass is RED too, until the entry is removed
 *   report   (output) => NOTE text: a report-only check. It gates nothing; its exit code is
 *            ignored, but a report that can't be parsed is a FAIL (the tool broke)
 *   timeoutMs  default 120 s headless, 300 s browser, 600 s gpu
 *
 * Coverage: every tools/*.test.mjs, tools/*-check.mjs, tools/*.itest.mjs and tools/wall-*.mjs
 * must appear in some entry's cmd, or the run is RED before anything starts.
 * Floors (tools/check-floors.json): an unscoped run of a tier fails when fewer checks RAN than
 * its floor; `--ratchet` raises a floor to what ran, never lowers it.
 */

/** @type {Record<string, string>} */
export const SCOPES = {
    render: 'anything that moves a pixel: glyph fields, the slot buffer, batching, culling, far-LOD, picking, the flat root, atlas/slug',
    layout: 'the fold (LayoutDescription / LayoutGenerator), arrangers, the content tree, box packing, bounds',
    books: 'Book (deck, controls, page text), agent and delta books',
    agents: 'agent sessions and events, visibility, the gomuxai hub, desks and their tuning, the tool registry',
    desk: 'carrels, the camera dock, panes, holding, docked-tile labels',
    camera: 'ViewerCameraController: fly math, proximity, soft bounds, focus, placement',
    persist: 'SessionStore, WorkspaceModel, the saved-state round trips',
    terminal: 'TerminalGrid, the emulator, paste, the terminal wire format',
    shell: 'the command router, the palette, file kinds, log plumbing, search, the 2-D shell',
    relay: 'the JS half of the relay wires: the RPC binary plane, terminal frames, the sensor plane',
    wall: 'the wall (wall/): its geometry, labels, and the wall end to end',
    form: 'code form: JSDoc types, layering, saved ast-grep rules, knip',
    corpus: 'vendored inputs: tree-sitter grammars',
    hand: 'hand tracking (parked)',
};

export const TIERS = ['inner', 'full', 'browser', 'gpu', 'parked'];

/** A headless node/bun check: `bun tools/<file>`. */
const h = (file, scope, compare, blind, extra = {}) => ({
    name: file.replace(/\.test\.mjs$/, '').replace(/\.itest\.mjs$/, '-itest').replace(/\.mjs$/, ''),
    cmd: ['bun', `tools/${file}`], tier: 'inner', scope, compare, blind, ...extra,
});
/** A bun:test file: `bun test tools/<file>`. */
const bt = (file, scope, compare, blind) => ({ ...h(file, scope, compare, blind), cmd: ['bun', 'test', `tools/${file}`] });
/** A GPU check on the app's Vite and a private relay serving the fixture. */
const g = (file, compare, blind, { args = [] } = {}) => ({
    name: file.replace(/\.mjs$/, ''),
    cmd: ['bun', `tools/${file}`, '--url', '{url}', '--relay', '{relay}', '--dir', '{dir}', ...args],
    tier: 'gpu', scope: ['render'], needs: ['vite', 'relay', 'browser', 'gpu'], apart: ['display'],
    compare, blind,
});

/** @type {Array<object>} */
export const CHECKS = [
    // ── render ───────────────────────────────────────────────────────────────────────────────
    h('instanced-slot-buffer.test.mjs', ['render', 'layout'],
        'InstancedSlotBuffer stride/lanes against slot.rs (32 bytes, 8 lanes), colour packing, slot round trips, LayoutGenerator wrapping, z-steps and draw order, an InstancedField end to end',
        'the shader reading the lanes — CPU writes and reads only'),
    h('group-table.test.mjs', ['render'],
        'a field allocates the group rows it uses and grows in place (rows bit-exact, a new texture, uniforms re-pointed); placeholder textures shared',
        'the GPU sampling the grown texture — the uniforms are checked, not a draw'),
    h('group-reuse.test.mjs', ['render'], 'group-texel id lifecycle: reuse, reset, the dead group', 'GPU reads of the rows'),
    h('glyph-batch.test.mjs', ['render'],
        'GlyphBatch: enrolment, ranges in their own group rows, THE POSE (batched glyph == its mesh.localToWorld), hidden/off-frustum to alpha 0, repack only on change, refusals draw themselves',
        'pixels — no GL context (glyph-batch-check compares frames)'),
    h('glyph-batch-upload.test.mjs', ['render'],
        "the arena group table's GPU copy (modelled as three's WebGLTextures applies uploads) equals the CPU table after every refresh; nothing uploads at rest",
        "three's real upload path; the model of it is the test's"),
    h('glyph-far-lod.test.mjs', ['render'],
        'GlyphFarLod near/far exactly at the threshold (perspective + ortho, nearest depth), the backdrop quad over the laid-out box, the tint, opt-outs, a grow, dispose',
        'what the backdrop looks like on screen (far-lod-check)'),
    h('panel-batch.test.mjs', ['render'],
        'PanelBatch: enrolment refusals, instances carry uniforms + eye-relative matrices, buckets by render state, translucent sort as three sorts, box fills/outlines, a grow',
        'pixels (panel-batch-check)'),
    h('panel-batch-shown.test.mjs', ['render'],
        'the per-frame walk visits only shown panels; after every change the outcome equals a fresh batch (teeth: a never-rebuilding list fails)',
        'pixels; cost is counted in visits, not timed'),
    h('panel-batch-skip.test.mjs', ['render'],
        'only what changed is rewritten/uploaded: buckets equal a fresh batch and a model of the GPU copy equals the CPU arrays; nothing uploads at rest',
        "three's real upload path; the model of it is the test's"),
    h('flat-root.test.mjs', ['render'],
        "the flat render list yields three's projectObject render items and lights (replicated walk) after every change; rebuild counts (0 at rest)",
        'pixels (flat-root-check); the replicated projectObject is the oracle, not three itself'),
    h('pick-flat-root.test.mjs', ['render'],
        "each pick channel's flat list yields the items three's walk would, with the pick material; rebuilds only on its own layer",
        'GPU pick readback (pick-flat-root-check)'),
    h('picking-system-webgl.test.mjs', ['render'],
        'PickingSystem bookkeeping, material creation and one pick against a mock WebGLRenderer',
        'a real GPU readback — the renderer is a mock'),
    h('scene-transforms.test.mjs', ['render'],
        "after the pruned walk every world matrix equals three's forced walk bit for bit, across every pose write; at rest it visits the root and stops",
        'objects that change their matrix behind the tracked vectors in ways the module header lists as unseen'),
    h('scene-bounds.test.mjs', ['render', 'layout'], 'worldBounds unions the world AABBs into the reused target', 'what a caller does with the box'),
    h('bounds-measurable.test.mjs', ['render', 'layout'],
        "BoundedObject3D.getBounds = local box × matrixWorld as three last left it — content lands at once, transforms after the matrix pass, no hidden walk",
        'callers that read bounds before the matrix pass'),
    h('framed-glyphfield.test.mjs', ['render'],
        'FramedGlyphField reproduces the per-grid behaviour it lifted: scale model, renderer slot, picking channels, panel slots, border delegators, teardown',
        'per-class divergences left in the subclasses (setBackgroundStyle)'),
    h('field-label.test.mjs', ['render'],
        "FieldLabel's synchronous measure, anchor transform, plate styling, Tab3D states, Book tab diffing",
        'pixels'),
    h('emoji-render.test.mjs', ['render'],
        'the emoji path: shader uniforms/varyings, InstancedField with the emoji + slug atlases, LayoutGenerator mapping, CodeGrid with an emoji fixture',
        'the rendered emoji (no GPU)'),
    h('slug-atlas-dispose.test.mjs', ['render'], 'a growth disposes the previous curve/map texture pair exactly once, never the live one', 'GPU memory itself (webgl-memory in frame-profile sees bytes)'),
    h('slug-atlas-emoji.test.mjs', ['render'], 'emoji slots skip curve-atlas growth but get their glyph-map entry; outline slots grow both', 'the slug shader'),
    h('codegrid-instanced.test.mjs', ['render', 'layout'],
        'CodeGrid on InstancedField: load, coordinate queries both ways, label, highlight, edits, windowing, picking wiring',
        'pixels'),
    h('syntax-coloring-align.test.mjs', ['render'],
        "syntax palette colours land on the right slots across lines, newlines and multibyte codepoints",
        'grammar correctness (verify-tree-sitter)'),
    h('syntax-palette.test.mjs', ['render'],
        "the worker colourize job's palette, expanded, equals the retired main-thread painter byte for byte (multibyte, surrogate pairs)",
        'whether the old painter was right — it is the oracle'),
    h('embed-clean.test.mjs', ['render', 'shell'],
        'clean package exports, headless embedding, line-ending normalisation, disposal of scene/parent groups',
        'a real bundler consuming the package'),
    h('memory-exports.test.mjs', ['render'], 'the memory module: exports, constants, hex dump, colours, cell spans', 'its rendering'),
    h('grid-helpers.test.mjs', ['render', 'layout'], 'codepoint/UTF-16 cursor helpers, edits, cursor motion, windowing', 'the grid they drive'),

    // ── layout ───────────────────────────────────────────────────────────────────────────────
    h('layout-mirror.test.mjs', ['layout'],
        "positionAt, evaluateFold and the closed-form extent agree on chosen fixtures (evaluateFold is the oracle)",
        'shapes nobody chose (layout-fuzz hunts them)'),
    h('layout-generator-fold.test.mjs', ['layout', 'render'],
        'the slots LayoutGenerator writes sit exactly where LayoutDescription.positionAt says, under every preset; extent finite and holding the glyphs; tab stops',
        'the GPU drawing the slots'),
    h('layout-fuzz.test.mjs', ['layout'],
        'randomized parity (200 seeds): fold mirror vs evaluateFold, and the extent containing every placed glyph, across scroll/param walks',
        'seeds it did not draw; widen with --seeds'),
    h('layout.test.mjs', ['layout'], 'flowBoxes / squareWrap box packing', 'the schemes built on them'),
    h('arrangers.test.mjs', ['layout'],
        'structure.grid / structure.strata on the CPU slot path: rigid block moves, no overlap, bounds/cull box = the arranged extent, caret follows, no compounding, reset',
        'pixels'),
    h('contenttree.test.mjs', ['layout'], "ContentTree's directory recursion: descents, load order, branches, path collisions", 'rendering of the tree'),
    h('stacks.itest.mjs', ['layout'], 'VStack/HStack/ZStack layout math', 'rendering'),
    h('arrows-check.mjs', ['layout'], 'ContentTreeArrows ownership lines + the serpentine tiers and packed rake they ride on', 'line pixels'),

    // ── books / agents ───────────────────────────────────────────────────────────────────────
    h('book-deck.test.mjs', ['books'], "Book's deck law: reading deck recedes, turned block at the back, a turn is a CUT, slide bounded", 'how it looks mid-turn'),
    h('book-controls.test.mjs', ['books'], 'the wheel detent, wheel → verb mapping, the book in focus, the book keys, agent timeline tabs', 'real input devices'),
    h('book-page-text.test.mjs', ['books', 'agents'], 'page text sizing/breaking by the one rule (fitTextStack), deck defaults vs per-book overrides', 'how the text reads'),
    h('book-pin.test.mjs', ['books', 'desk'], 'pinned books keep their live position and stay off the floor rest; moveVerbFor per surface', 'drag gestures themselves'),
    h('book-resolve.test.mjs', ['books', 'agents'], 'AgentBooks.resolveLane resolves every address form by lookup; unknown refs are null', 'verbs that bypass the resolver'),
    h('agent-action-page.test.mjs', ['books', 'agents'], 'an agent sheet\'s verso/recto: headline split, fitTextStack, wrapText keeps every character', 'pixels'),
    h('agent-book-history.test.mjs', ['books', 'agents'], 'the sliding window over a synthetic 100-turn stream: byte offsets, prefetch, slides, read failures', 'a real relay read'),
    h('agent-book-labels.test.mjs', ['books', 'agents'], 'agent nameplates: hue, status readout, multi-line bake, container fit and wrap', 'pixels'),
    h('agent-events.test.mjs', ['agents', 'books'],
        "agent books fed by gomuxai's conformance corpus: the reader under any chunking, one sheet per event, prompts of every origin, in-place updates",
        'transcripts outside the corpus; needs a gomuxai checkout (GOMUXAI_DIR) and FAILS without one, by design',
        {
            known: {
                reason: 'one prompt event of the corpus has no sheet (31/33) — red on the-backport too; not yet fixed',
                signature: [/every prompt event is a sheet \(31\/33\)/, /agent-events: \d+ passed, 1 failed/],
            },
        }),
    h('session-books.test.mjs', ['agents', 'books'],
        'agent books over a fake relay event wire: tail read → hydrate → follow, live lines, in-place updates, ended → re-follow, paging back, orphans',
        "the real relay and gomuxai (the bridge is a fake that plays them)"),
    h('agent-visibility.test.mjs', ['agents'], 'hidden agents: nothing opens before the saved set is known; hide/show/group/clear; restore order', 'the Agents panel UI'),
    h('desk-tuning.test.mjs', ['agents', 'desk', 'persist'], 'per-instance knobs: born-with defaults, own values win and survive owner pushes, reload round trip', 'the HUD sections that edit them'),
    h('delta-books.test.mjs', ['books'], 'DeltaBooks: resolveSet by lookup, setFile idempotent, follow-the-change, applyChangeset drops departed files', 'git itself'),
    h('delta-source.test.mjs', ['books'], 'the delta algebra: unified-diff split, aligned texts, base reconstruction from hunks', 'diffs from tools other than git/jsdiff'),
    h('toolRegistry.test.mjs', ['agents'], "tool-call presentation: per-action highlight mapping, kind buckets, hues", "what a call did (gomuxai's half)"),

    // ── desk / camera / persist ──────────────────────────────────────────────────────────────
    h('carrel.test.mjs', ['desk'], 'the Carrel: ownership law, ring/grid geometry, doorway, borrowed members, handoffs', 'pixels'),
    h('holding.test.mjs', ['desk'], 'Holding: the one holdable resolver, residence vs vehicle, borrow/return/lift handoffs', 'the verbs\' UI paths'),
    h('dock-labels.test.mjs', ['desk'], 'Label3D + dock tile nameplates: hue, hidden while framed, rebake on resize, teardown', 'the baked texture\'s look'),
    h('dock-layout-prune.test.mjs', ['desk', 'persist'], 'pruneDockLayout removes unknown panels from the map and the grid tree', 'dockview itself'),
    h('dock-border-check.mjs', ['desk'], 'docked windows get distinct identity hues on their borders, cleared on release', 'the border pixels'),
    h('dock-dismiss-check.mjs', ['desk'], 'closing a docked window cascades to the dock: entry dropped, orphan lifted, re-pack', 'close paths not routed through the registry'),
    h('dock-ghost-check.mjs', ['desk'], 'framing a docked tile reserves its slot with a ghost; return drops straight back', 'the ghost\'s look'),
    h('dock-refresh-check.mjs', ['desk'], 'CameraDock reacts idempotently to a docked tile changing size/zoom', 'live grip drags'),
    h('dock-persist-check.mjs', ['desk', 'persist'], "SessionStore's dock3d capture/restore round trip with mocks", 'a real reload'),
    h('pane-compose-check.mjs', ['desk'], 'PaneTree → world rect → placement: one leaf = the single pin, splits tile', 'pixels'),
    h('panetree-check.mjs', ['desk'], 'PaneTree leaves tile the rect exactly, split/close/resize/neighbour rules', 'its compositor'),
    h('place-in-view-check.mjs', ['camera', 'desk'], 'placeInView is gated on placeability, not on terminal type', 'the camera'),
    h('registry-hold-check.mjs', ['shell'], 'SceneRegistry.holdChanges: one fire per type at the outermost close', 'listeners\' own work'),
    h('registry-pickable.itest.mjs', ['shell', 'render'], 'the incremental pickable index on SceneRegistry', 'the hover wire reading it'),
    h('camera.test.mjs', ['camera'], 'easeOutCubic + tweenPose', 'the camera object'),
    h('camera-proximity.test.mjs', ['camera'], 'look-distance scan, the WASD speed valley, pan distance, keyboard damping', 'real input'),
    h('camera-focus-jump.test.mjs', ['camera'], 'jump-to-grid fixes: registry order, empty-file bounds, seed extent, FileRow line count, camera.focus waits for load', 'the flight itself'),
    h('camera-billboard-check.mjs', ['camera'], 'focus squares the camera to the object\'s own front face for any orientation', 'pixels'),
    h('camera-focus-docked-check.mjs', ['camera', 'desk'], 'camera.focus on a docked tile never moves the world camera', 'other restore-time verbs'),
    h('soft-bounds.test.mjs', ['camera'], 'the soft-bounds leash: free inside, spring when idle, hard cap, deadband, extent floor', 'real flight'),
    h('canvas-size-guard.test.mjs', ['camera', 'render'], 'the canvas sizing invariant at each landing point (the HiDPI squaring bug)', 'a real dpr>1 display'),
    h('carrel-persist-check.mjs', ['persist', 'desk'], 'carrel residence capture/restore through view.carrel, member order kept', 'a real reload'),
    h('codegrid-view-persist-check.mjs', ['persist'], 'a code grid\'s viewport restores as direct state (applyView), not verb replay', 'a real reload'),
    h('component-schema-check.mjs', ['persist'], 'every view key belongs to a declared component; capture byte-identical', 'semantic correctness of the components'),
    h('grid-move-persist-check.mjs', ['persist'], 'every window-moving verb records its destination in the WorkspaceModel', 'verbs added later that move windows'),
    h('session-schema-tolerance-check.mjs', ['persist', 'agents'], 'restore is forward-additive; saved agent books reopen through the one path; clear empties', 'blobs from versions not fixtured'),
    h('term-geom-persist-check.mjs', ['persist', 'terminal'], 'terminal geometry round trips through the surface table, applied in any order', 'the PTY'),

    // ── terminal / relay wires ───────────────────────────────────────────────────────────────
    h('terminal-depth.test.mjs', ['terminal'], 'scrollback-into-depth: scroll detection, row capture, fade, synced into a real slot buffer', 'tmux\'s real repaint stream'),
    h('terminal-text-path.test.mjs', ['terminal'], 'only changes: a random walk of screens against a reference model, exact written slots + upload ranges, zero allocation per update, parse → update → render order', 'xterm\'s internals moving (the emulator throws at construction)'),
    h('terminal-paste.test.mjs', ['terminal'], 'keyEncoding declines the paste chord; TerminalGrid.paste frames one bracketed burst', 'the browser clipboard'),
    h('terminal-emulator-resize-check.mjs', ['terminal'], 'TerminalEmulator under a write+resize storm: coalesced, uncorrupted, correct final screen', 'a real PTY'),
    h('terminal-dock-sync-check.mjs', ['terminal', 'desk'], 'the Terminals-panel activation guard is timing-proof', 'dockview\'s real event timing'),
    h('terminal-spawn-dock-check.mjs', ['terminal', 'desk'], 'terminal.spawn awaits its own terminal, then docks + focuses it', 'the relay'),
    h('terminal-frame-format-check.mjs', ['terminal', 'relay'], 'the OUTPUT frame wire format the Go adapter and the JS bridge share, byte for byte', 'the Go side (it is mirrored, not run)'),
    h('bridge-binary.test.mjs', ['relay'], 'the RPC binary result plane: frame parse, header + payload, pending resolution', 'the Go encoder'),
    h('source-stream.test.mjs', ['relay'], 'the sensor plane\'s browser half: frame decoders, presence, multi-device isolation, liveness', 'a real device'),

    // ── shell ────────────────────────────────────────────────────────────────────────────────
    h('command-resolve.test.mjs', ['shell'], 'CommandRouter name resolution precedence', 'verbs\' behaviour'),
    h('palette-rank.test.mjs', ['shell'], 'palette scoring: dot-free verb spelling, exact pin, boosts', 'taste'),
    h('rank-check.mjs', ['shell'], 'the palette\'s verb-ranking intent on short queries', 'taste'),
    h('log-storm-brake.test.mjs', ['shell'], 'the console storm brake: per-signature, heartbeat, info never braked', 'the relay log store'),
    h('search-session.test.mjs', ['shell'], 'SearchSession: cancelled runs stop writing, refinements don\'t blend, clear leaves nothing', 'the relay search'),
    h('file-uri.test.mjs', ['shell'], 'the one file:// codec, round trip', 'LSP-side decoding'),
    h('filekind.itest.mjs', ['shell'], 'the file-type classifier: extensions, magic, UTF-8 probe', 'rendering'),
    h('openall.itest.mjs', ['shell'], 'all-files mode gates: partitionDirEntries and the filter bypass', 'rendering'),
    h('panel-material-check.mjs', ['render'], 'the window panel material constructs and restyles without a GPU', 'border pixels (a fragment shader)'),

    // ── wall ─────────────────────────────────────────────────────────────────────────────────
    bt('wall-layout.test.mjs', ['wall'], "the wall's pure geometry: flow placement, framing, border grabs, cycling, border-drag resize", 'pixels and input'),
    bt('wall-labels.test.mjs', ['wall'], 'map-style label placement: no overlaps, preferred side, sticky, strict-then-relaxed, leader lines', 'pixels'),
    bt('wall-store.test.mjs', ['wall'], "the wall's per-relay names and spots: scoped keys, pruned against the live set, kill forgets", 'localStorage in a real browser'),
    bt('terminal-readopt.test.mjs', ['terminal'], 'a terminal.create for a grid already shown re-adopts it: owner, input route, repaint go to the sender', 'a live relay restart (wall-e2e covers it)'),

    // ── form / corpus ────────────────────────────────────────────────────────────────────────
    {
        name: 'layering', cmd: ['node_modules/.bin/depcruise', '--config', '.dependency-cruiser.cjs', 'packages', 'app', 'wall'],
        tier: 'inner', scope: ['form'],
        compare: "the static import graph against CLAUDE.md's layering (.dependency-cruiser.cjs): core imports no app/wall/r3f/react, workers no three, wall no app, no cycles in core",
        blind: 'dynamic import() of computed strings, workers spawned by URL, globals (DOM use without an import), JSDoc import() types',
    },
    {
        name: 'type-imports', cmd: ['bun', 'tools/type-imports-check.mjs'], tier: 'full', scope: ['form'],
        compare: 'tsc over jsconfig.json: every JSDoc type import resolves (none silently any)',
        blind: 'type errors in general — checkJs is off; only the import seam is judged',
    },
    {
        name: 'sg-rules', cmd: ['node_modules/.bin/ast-grep', 'scan', '-c', 'tools/sg/sgconfig.yml', 'packages', 'app', 'wall'],
        tier: 'full', scope: ['form'],
        compare: 'the saved ast-grep rules (tools/sg/rules): red on an error-severity hit; hints are printed for review',
        blind: 'anything a rule does not spell out structurally',
    },
    {
        name: 'knip', cmd: ['node_modules/.bin/knip', '--no-progress', '--reporter', 'json'], tier: 'full', scope: ['form'],
        compare: 'REPORT ONLY: unused files/exports/dependencies (knip.jsonc)',
        blind: "core's exports map publishes ./* so core-internal unused exports are invisible; dynamic imports",
        report: (out) => {
            const { issues } = JSON.parse(out);
            const n = {};
            for (const f of issues) for (const [k, v] of Object.entries(f)) if (Array.isArray(v) && v.length) n[k] = (n[k] || 0) + v.length;
            return Object.entries(n).map(([k, v]) => `${v} ${k}`).join(', ') + ' (bunx knip lists them)';
        },
    },
    h('verify-tree-sitter.mjs', ['corpus', 'render'], 'each vendored grammar loads, its highlight query compiles, a sample parses with captures', 'highlight quality', { tier: 'full' }),

    // ── browser ──────────────────────────────────────────────────────────────────────────────
    {
        name: 'smoke', cmd: ['bun', 'tools/smoke.mjs', '--url', '{url}'], tier: 'browser', scope: ['shell', 'render'],
        needs: ['vite', 'browser'], apart: ['display'],
        compare: 'the IDE boots in a real browser with no JS/console errors (client-only)',
        blind: 'anything after boot; GPU-init noise is bucketed, not failed',
    },
    {
        name: 'itests', cmd: ['bun', 'tools/itest.mjs', '--url', '{url}'], tier: 'browser', scope: ['shell', 'render'],
        needs: ['vite', 'browser', 'network'], apart: ['display'],
        compare: 'tools/itests/*.itest.mjs against the live app, each page backstopped by the error tracker',
        blind: 'loads files from GitHub (repo.load) — a network failure reads as a red test',
        known: {
            reason: "semantic.itest probes EVERY package.json the repo load brought in, and only the one it opened builds structure (app/package.json etc.: 0 nodes) — found red by this runner's first browser run (2026-11-12), not yet fixed",
            signature: [/✗ semantic: app\/package\.json: structure built on first query/, /\b1\/\d+ FAILED/],
        },
    },
    {
        name: 'frame-capture-check', cmd: ['bun', 'tools/frame-capture-check.mjs', '--url', '{url}'], tier: 'browser', scope: ['render'],
        needs: ['vite', 'browser'], apart: ['display'],
        compare: 'frame.capture on a fake media stream runs and renders without throwing (state dump + /tmp screenshot)',
        blind: 'whether the capture LOOKS right — it asserts nothing about pixels',
    },
    {
        name: 'loadstorm-check', cmd: ['bun', 'tools/loadstorm-check.mjs', '--url', '{url}'], env: { STORM_RELAY: '{relay}' },
        tier: 'browser', scope: ['layout', 'shell'], needs: ['vite', 'relay', 'browser'], apart: ['display'],
        compare: 'a launch-shaped burst of openDir loads: one trace per source, each ends, ONE relayout per openDir, stage coverage',
        blind: 'the milliseconds (printed, not judged)',
    },

    // ── gpu ──────────────────────────────────────────────────────────────────────────────────
    g('flat-root-check.mjs', 'the flat render list draws the same frame as three\'s walk, byte for byte, at several poses; a half list must differ', 'poses not sampled'),
    g('pick-flat-root-check.mjs', 'pick results list vs full scene over pointer sweeps — identical; removing a hit mesh changes them', 'pointer positions not swept'),
    g('panel-batch-check.mjs', 'the batched frame vs every panel drawing itself, per pose', 'poses not sampled'),
    // Labels (book tabs, nameplates) and far files appear in the library layout.
    {
        ...g('glyph-batch-check.mjs', 'the batched frame vs every label drawing itself (3×3-blurred, past 24/255), per pose, in the library layout', 'sub-threshold edge differences, by design', { args: ['--cmd', 'layout.scheme library'] }),
        known: {
            reason: 'red at a169ed1 and 5774779 (before the render port) as on wall today: at the ×0.5 and ×0.05 poses the batched-vs-shifted diff of small labels edges past the 1% limit (1.01% / 1.44% on a 44-file fixture) — the threshold against tiny labels, not a batching regression; open',
            signature: [/✗ fit-all × 0\.(5|05) distance/],
        },
    },
    g('far-lod-check.mjs', 'far files show as their backdrop (≥5% light lift) and nothing outside the far rects moves, in the library layout', 'how the transition band looks (reported, not judged)', { args: ['--cmd', 'layout.scheme library'] }),
    g('glyph-cull-truth.mjs', "every live quad lies inside its mesh's stated bounding box across a dir load, the presets, an arranged grid and a terminal", 'fields moved through the group table (labels) — they opt out of culling'),
    {
        name: 'wall-e2e', cmd: ['bun', 'tools/wall-e2e.mjs', '--url', '{wallUrl}', '--relay', '{port}'], tier: 'gpu', scope: ['wall', 'terminal'],
        needs: ['wall-vite', 'own-relay', 'browser', 'gpu', 'tmux'], apart: ['display'],
        compare: 'the wall end to end in a real-GPU browser: spawn, typing, cycling, resize, drag, names, scrollback, zoom, map labels, the core terminal verbs',
        blind: 'feel (latency, smoothness); real keyboards and trackpads',
    },
    {
        name: 'wall-gpu-attribution', cmd: ['bun', 'tools/wall-gpu-attribution.mjs', '--url', '{wallUrl}', '--relay', '{port}'], tier: 'gpu', scope: ['wall', 'render'],
        needs: ['wall-vite', 'own-relay', 'browser', 'gpu', 'tmux'], apart: ['*'], timeoutMs: 900_000,
        compare: 'INSTRUMENT: times the wall\'s main pass per layer with GPU timer queries; green = it measured',
        blind: 'judges no number',
    },
    {
        name: 'wall-text-perf', cmd: ['bun', 'tools/wall-text-perf.mjs', '--url', '{wallUrl}', '--relay', '{port}'], tier: 'gpu', scope: ['wall', 'terminal'],
        needs: ['wall-vite', 'own-relay', 'browser', 'gpu', 'tmux'], apart: ['*'], timeoutMs: 900_000,
        compare: 'INSTRUMENT: the terminal text path timed stage by stage (direct and tmux floods); green = it measured',
        blind: 'judges no number',
    },

    // ── parked: hand tracking (not being worked on; kept so they aren't lost) ───────────────────
    ...[
        ['hand-cloud.test.mjs', 'the LiDAR hand tracker against known truth (joint error, cost) — 53 s of the headless suite'],
        ['hand-cloud-pipeline.test.mjs', "the tracker's page side: CloudPipeline spawning the real worker"],
        ['hand-model.test.mjs', 'the live hand model converges to truth from a cold start'],
        ['hand-calib-app.test.mjs', "the app's live hand model controller (HandCalib)"],
        ['hand-presence.test.mjs', 'SourceStream → HandRenderer'],
        ['hand-replay.test.mjs', 'a recording round trip through the live hand pipeline'],
    ].map(([file, compare]) => h(file, ['hand'], compare, 'a real hand and phone', { tier: 'parked' })),
    {
        name: 'hand-source-check', cmd: ['bun', 'tools/hand-source-check.mjs', '--relay', '{relay}'], tier: 'parked', scope: ['hand', 'relay'],
        needs: ['relay'], compare: 'the sensor plane end to end: a real relay, a fake device, decoded frames', blind: 'a real device',
    },
];
