/**
 * CrossRefAnimation.js  (v2 — Document Cards)
 *
 * Visualizes multi-agent cross-referencing with concrete document objects:
 *   Phase 0 — Three agent nodes spawn with workspace glows
 *   Phase 1 — Each agent produces an initial document (A1, B1, C1)
 *   Phase 2 — Forward review: documents arc-travel between agents, get absorbed
 *   Phase 3 — Inverse review: same mechanic, reversed order, blue tint
 *   Phase 4 — Convergence: final docs slide to center and merge
 *   Phase 5 — Fade out, loop
 *
 * Document lifecycle:
 *   - Created at init, set invisible
 *   - "Emerge" from agent node (scale 0 → 1, position offset)
 *   - "Travel" along QuadraticBezierCurve3 arc toward destination
 *   - "Absorb" into destination node (scale 1 → 0, fade)
 *   - "Produce" new doc at destination after absorb
 */

import * as THREE from 'three';
import { GlyphAtlas } from '../../src/index.js';
import GlyphCollection from '../../src/collections/GlyphCollection.js';

// ─── Palette ──────────────────────────────────────────────────────────────────

const COLOR = {
    bg:           0x080c0a,
    nodeIdle:     new THREE.Color(0x0d1f17),
    nodeActive:   new THREE.Color(0x00ff88),
    nodeRim:      new THREE.Color(0x003322),
    docRound0:    new THREE.Color(0x0d2218),   // initial analysis — dark green
    docRound1:    new THREE.Color(0x0d1a2a),   // forward review — dark blue-green
    docRound2:    new THREE.Color(0x1a1028),   // inverse review — dark blue
    docFinal:     new THREE.Color(0x1a2010),   // synthesis — dark teal
    docBorderR0:  new THREE.Color(0x00dd77),   // initial border — green
    docBorderR1:  new THREE.Color(0x44aaff),   // forward border — cyan-blue
    docBorderR2:  new THREE.Color(0x8866ff),   // inverse border — purple-blue
    docBorderFin: new THREE.Color(0x00ff88),   // synthesis border — bright green
    workspaceGlow:new THREE.Color(0x001a0d),
    labelColor:   { r: 0.7,  g: 0.9,  b: 0.75 },
    dimLabel:     { r: 0.18, g: 0.22, b: 0.20 },
    docLabelR0:   { r: 0.0,  g: 0.85, b: 0.5  },
    docLabelR1:   { r: 0.3,  g: 0.7,  b: 1.0  },
    docLabelR2:   { r: 0.6,  g: 0.5,  b: 1.0  },
    docLabelFin:  { r: 0.4,  g: 1.0,  b: 0.7  },
    synthPulse:   new THREE.Color(0x00ff88),
};

// Agent tint colors for workspace glow & node rim
const AGENT_COLORS = [
    new THREE.Color(0x00dd88),   // A — green
    new THREE.Color(0x4488ff),   // B — blue
    new THREE.Color(0xff8844),   // C — orange
];

// ─── Agent configuration ──────────────────────────────────────────────────────

const AGENTS = [
    {
        id: 'A',
        label: 'Algorithm',
        docLabels: ['A\u2081', 'A\u2082', 'A\u2083'],   // A₁ A₂ A₃
        snippets: [
            'codepoint\u2192UV atlas',
            'shelf-pack\nlayout',
            'Unified:\ninstanced\nrender',
        ],
    },
    {
        id: 'B',
        label: 'Interfaces',
        docLabels: ['B\u2081', 'B\u2082', 'B\u2083'],
        snippets: [
            'addText()\nflush()\u2192GPU',
            'deferred\nbatch API',
            'Unified:\ngroup API\n+ deferred',
        ],
    },
    {
        id: 'C',
        label: 'Implementation',
        docLabels: ['C\u2081', 'C\u2082', 'C\u2083'],
        snippets: [
            'Instanced\nBufferGeometry',
            'DataTexture\ngroups O(1)',
            'Unified:\nworkers +\nDataTexture',
        ],
    },
];

// Triangle positions (XY plane)
function agentPositions(radius) {
    return [
        new THREE.Vector3(0,              radius,      0),   // A — top
        new THREE.Vector3(-radius * 0.866, -radius * 0.5, 0),   // B — bottom-left
        new THREE.Vector3( radius * 0.866, -radius * 0.5, 0),   // C — bottom-right
    ];
}

/**
 * Stack cards radially outward from an agent.
 * Measures each card's bounds, lays them out with no overlap.
 */
function stackCards(cards, agentPos) {
    const dir = agentPos.clone().normalize();
    const gap = 0.4;

    // Start past the agent node
    let dist = 2.0;

    for (let i = 0; i < cards.length; i++) {
        const card = cards[i];
        // Measure at scale 1
        card.group.scale.setScalar(1);
        const box = new THREE.Box3().setFromObject(card.group);
        const size = new THREE.Vector3();
        box.getSize(size);
        const h = size.y || 1;

        dist += h / 2;
        const pos = agentPos.clone().addScaledVector(dir, dist);
        pos.z = 0.1 * (i + 1);

        card.restPos = pos.clone();
        card.group.position.copy(pos);
        card.group.scale.setScalar(0); // start hidden

        dist += h / 2 + gap;
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function lerp(a, b, t) { return a + (b - a) * t; }
function clamp01(t) { return Math.max(0, Math.min(1, t)); }
function easeInOut(t) { return t < 0.5 ? 2*t*t : -1+(4-2*t)*t; }
function easeOut(t) { return 1 - Math.pow(1 - t, 3); }
function easeIn(t) { return t * t * t; }

/**
 * Sample a QuadraticBezierCurve3 at t, writing into `out`.
 * P0 = start, P1 = control, P2 = end.
 */
function quadBezier(P0, P1, P2, t, out) {
    const mt = 1 - t;
    out.x = mt*mt*P0.x + 2*mt*t*P1.x + t*t*P2.x;
    out.y = mt*mt*P0.y + 2*mt*t*P1.y + t*t*P2.y;
    out.z = mt*mt*P0.z + 2*mt*t*P1.z + t*t*P2.z;
}

/**
 * Compute a bezier control point that arcs outward (perpendicular to midpoint).
 * @param {THREE.Vector3} from
 * @param {THREE.Vector3} to
 * @param {number} arcHeight - how far perpendicular to lift
 * @param {boolean} clockwise - which side to arc toward
 */
function bezierControl(from, to, arcHeight, clockwise) {
    const mid = new THREE.Vector3().addVectors(from, to).multiplyScalar(0.5);
    const dir = new THREE.Vector3().subVectors(to, from).normalize();
    // Perpendicular in XY plane
    const perp = clockwise
        ? new THREE.Vector3(-dir.y,  dir.x, 0)
        : new THREE.Vector3( dir.y, -dir.x, 0);
    mid.addScaledVector(perp, arcHeight);
    mid.z = 1.5;   // arc lifts slightly in Z for 3D feel
    return mid;
}

/**
 * Build a document card — box sized to fit its content.
 * @param {number} contentW - measured width of text content
 * @param {number} contentH - measured height of text content
 * @param {THREE.Color} bodyColor
 * @param {THREE.Color} borderColor
 */
function buildDocCard(contentW, contentH, bodyColor, borderColor) {
    const pad = 0.15;
    const W = contentW + pad * 2;
    const H = contentH + pad * 2;
    const D = 0.06;
    const group = new THREE.Group();

    const bodyGeo = new THREE.BoxGeometry(W, H, D);
    const bodyMat = new THREE.MeshStandardMaterial({
        color: bodyColor.clone(),
        emissive: bodyColor.clone().multiplyScalar(0.3),
        roughness: 0.6,
        metalness: 0.3,
        transparent: true,
        opacity: 0,
    });
    const bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
    group.add(bodyMesh);

    const borderGeo = new THREE.EdgesGeometry(new THREE.PlaneGeometry(W, H));
    const borderMat = new THREE.LineBasicMaterial({
        color: borderColor.clone(),
        transparent: true,
        opacity: 0,
        linewidth: 1,
    });
    const borderMesh = new THREE.LineSegments(borderGeo, borderMat);
    borderMesh.position.z = D / 2 + 0.001;
    group.add(borderMesh);

    group.visible = false;
    return { group, bodyMesh, bodyMat, borderMesh, borderMat };
}

/**
 * Build a faint arc trail line along a bezier curve.
 * Returns the THREE.Line (invisible by default).
 */
function buildArcTrail(P0, P1, P2, color) {
    const segments = 32;
    const positions = [];
    const tmp = new THREE.Vector3();
    for (let i = 0; i <= segments; i++) {
        quadBezier(P0, P1, P2, i / segments, tmp);
        positions.push(tmp.x, tmp.y, tmp.z);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const mat = new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity: 0,
        depthWrite: false,
    });
    return new THREE.Line(geo, mat);
}

/**
 * Build a flat circle glow on the ground (XY plane) for workspace.
 */
function buildWorkspaceGlow(pos, agentColor) {
    const geo = new THREE.CircleGeometry(1.6, 48);
    const mat = new THREE.MeshBasicMaterial({
        color: agentColor.clone().multiplyScalar(0.15),
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(pos.x, pos.y, -0.1);
    return { mesh, mat };
}

// ─── Main class ───────────────────────────────────────────────────────────────

export class CrossRefAnimation {
    /**
     * @param {HTMLCanvasElement} canvas
     */
    constructor(canvas) {
        this.canvas = canvas;
        this._disposed = false;

        // Three.js core
        this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.setClearColor(COLOR.bg, 1);
        this.renderer.setSize(window.innerWidth, window.innerHeight);

        this.scene = new THREE.Scene();

        const aspect = window.innerWidth / window.innerHeight;
        this.camera = new THREE.PerspectiveCamera(42, aspect, 0.1, 1000);
        this.camera.position.set(0, 0, 22);
        this.camera.lookAt(0, 0, 0);

        const ambLight = new THREE.AmbientLight(0xffffff, 0.25);
        this.scene.add(ambLight);
        const pointLight = new THREE.PointLight(0x00ff88, 1.5, 60);
        pointLight.position.set(0, 4, 10);
        this.scene.add(pointLight);
        this._pointLight = pointLight;

        // Glyph atlas
        this.atlas = null;
        this.glyphCollection = null;

        // Layout
        this._nodeRadius = 5.8;
        this._positions = agentPositions(this._nodeRadius);

        // Scene object collections
        this._nodes = [];          // { mesh, rimMesh, mat, rimMat, labelId, nameId, pos, workspace }
        this._docs = [];           // 3 agents × 3 rounds = 9 doc objects
                                   // docs[agentIdx][roundIdx] = { group, bodyMat, borderMat, labelTextId, ... }
        this._arcTrails = [];      // arc trail lines for each travel move, indexed [src][dst]
        this._synthMesh = null;    // center synthesis object

        // Animation state — sequence of "moves" to execute
        this._phase = -1;
        this._phaseT = 0;
        this._phaseStart = 0;
        this._totalT = 0;
        this._lastTimestamp = null;

        // Per-phase durations (seconds)
        //
        // Forward review parallel waves:
        //   Wave 1 (3 arcs):  0.0 – 2.0 s
        //   Gap:              2.0 – 2.5 s
        //   Wave 2 (3 arcs):  2.5 – 4.5 s
        //   Gap:              4.5 – 5.0 s
        //   Digest (all):     5.0 – 6.0 s
        //   Emerge (all):     6.0 – 7.5 s
        // Total forward: 7.5 s
        //
        // Inverse review parallel waves:
        //   Wave 1: 0.0 – 2.0 s
        //   Gap:    2.0 – 2.5 s
        //   Wave 2: 2.5 – 4.5 s
        //   Gap:    4.5 – 5.0 s
        //   Wave 3: 5.0 – 7.0 s
        //   Gap:    7.0 – 7.5 s
        //   Wave 4: 7.5 – 9.5 s
        //   Gap:    9.5 – 10.0 s
        //   Digest: 10.0 – 11.0 s
        //   Emerge: 11.0 – 12.5 s
        // Total inverse: 12.5 s
        this._phaseDurations = [
            2.5,    // 0 — spawn nodes
            3.0,    // 1 — initial output docs emerge (A1 B1 C1)
            7.5,    // 2 — forward review (2 parallel waves + digest + emerge)
            12.5,   // 3 — inverse review (4 parallel waves + digest + emerge)
            3.5,    // 4 — convergence
            2.0,    // 5 — fade out
        ];

        // Flying copies: temporary doc-card groups created at travel time
        // Each entry: { group, bodyMat, borderMat, labelMesh, t, srcAgent, dstAgent, colorMode }
        this._flyingCopies = [];

        // Track which docs are "resting" at each agent (for travel pickup)
        // _docState[agentIdx] = array of { docRef, round }
        this._docState = [[], [], []];

        // Resize
        this._onResize = this._handleResize.bind(this);
        window.addEventListener('resize', this._onResize);

        // UI refs
        this._phaseLabelEl = document.getElementById('phase-label');
        this._phaseDots = Array.from(document.querySelectorAll('.phase-dot'));
        this._statusEl = document.getElementById('status-line');
    }

    // ─── Initialization ──────────────────────────────────────────────────────

    async init() {
        this.atlas = new GlyphAtlas('Monaco, Menlo, Consolas, monospace', 28, 1024);
        await this.atlas.generate();

        this.glyphCollection = new GlyphCollection(this.scene, this.atlas, {
            worldScale: 0.018,
            defaultColor: COLOR.labelColor,
        });

        this._buildNodes();
        this._buildDocuments();
        this._buildArcTrails();
        this._buildSynthObject();

        this.glyphCollection.flush();

        this._startPhase(0);
        this._rafId = requestAnimationFrame(t => this._tick(t));
    }

    // ─── Node construction ───────────────────────────────────────────────────

    _buildNodes() {
        for (let i = 0; i < 3; i++) {
            const agent = AGENTS[i];
            const pos = this._positions[i];
            const agentColor = AGENT_COLORS[i];

            // Core sphere
            const geo = new THREE.IcosahedronGeometry(0.68, 2);
            const mat = new THREE.MeshStandardMaterial({
                color: COLOR.nodeIdle.clone(),
                emissive: new THREE.Color(0x000000),
                roughness: 0.35,
                metalness: 0.55,
                transparent: true,
                opacity: 0,
            });
            const mesh = new THREE.Mesh(geo, mat);
            mesh.position.copy(pos);
            this.scene.add(mesh);

            // Rim glow
            const rimGeo = new THREE.IcosahedronGeometry(0.84, 2);
            const rimMat = new THREE.MeshBasicMaterial({
                color: agentColor.clone().multiplyScalar(0.3),
                wireframe: true,
                transparent: true,
                opacity: 0,
            });
            const rimMesh = new THREE.Mesh(rimGeo, rimMat);
            rimMesh.position.copy(pos);
            this.scene.add(rimMesh);

            // Workspace glow circle
            const workspace = buildWorkspaceGlow(pos, agentColor);
            this.scene.add(workspace.mesh);

            // Agent ID label
            const labelId = this.glyphCollection.addText(
                agent.id,
                { x: pos.x - 0.18, y: pos.y - 0.18, z: 1.0 },
                { color: { r: 0.001, g: 0.001, b: 0.001 }, scale: 2.2 }
            );

            // Agent name label
            const nameId = this.glyphCollection.addText(
                agent.label,
                { x: pos.x - agent.label.length * 0.14, y: pos.y - 1.35, z: 0.0 },
                { color: { r: 0.001, g: 0.001, b: 0.001 }, scale: 0.95 }
            );

            this._nodes.push({ mesh, rimMesh, mat, rimMat, labelId, nameId, pos, workspace, agentColor });
        }
    }

    // ─── Document card construction ───────────────────────────────────────────

    _buildDocuments() {
        // 3 agents × 3 rounds
        // docs[agentIdx][roundIdx]
        // Round index maps directly to stack slot so cards never overlap.
        const bodyColors = [COLOR.docRound0, COLOR.docRound1, COLOR.docRound2];
        const borderColors = [COLOR.docBorderR0, COLOR.docBorderR1, COLOR.docBorderR2];
        const labelColors = [COLOR.docLabelR0, COLOR.docLabelR1, COLOR.docLabelR2];

        // Step 1: Add all text to GlyphCollection (labels + snippets)
        // We need to flush to get measured bounds before building card meshes.
        const textEntries = []; // { agentIdx, roundIdx, labelId, snippetId }
        for (let a = 0; a < 3; a++) {
            const agent = AGENTS[a];
            for (let r = 0; r < 3; r++) {
                // Place at origin temporarily — will reposition after measuring
                const labelId = this.glyphCollection.addText(
                    agent.docLabels[r],
                    { x: 0, y: 0, z: 0 },
                    { color: { r: 0.001, g: 0.001, b: 0.001 }, scale: 1.1 }
                );
                const snippetId = this.glyphCollection.addText(
                    agent.snippets[r],
                    { x: 0, y: -1.2, z: 0 }, // below the label
                    { color: { r: 0.001, g: 0.001, b: 0.001 }, scale: 0.62 }
                );
                textEntries.push({ agentIdx: a, roundIdx: r, labelId, snippetId });
            }
        }

        // Step 2: Flush so text bounds are computed
        this.glyphCollection.flush();

        // Step 3: Measure each text pair, build sized cards, stack per agent
        for (let a = 0; a < 3; a++) {
            this._docs.push([]);
            const pos = this._positions[a];
            const agentCards = [];

            for (let r = 0; r < 3; r++) {
                const entry = textEntries[a * 3 + r];
                const labelInfo = this.glyphCollection.getText(entry.labelId);
                const snippetInfo = this.glyphCollection.getText(entry.snippetId);

                // Measure text bounds
                const labelBounds = labelInfo?.getBounds?.() || { min: {x:0,y:0}, max: {x:1.5,y:0.5} };
                const snippetBounds = snippetInfo?.getBounds?.() || { min: {x:0,y:0}, max: {x:1.5,y:0.3} };

                const labelW = (labelBounds.max?.x || 1.5) - (labelBounds.min?.x || 0);
                const labelH = (labelBounds.max?.y || 0.5) - (labelBounds.min?.y || 0);
                const snippetW = (snippetBounds.max?.x || 1.5) - (snippetBounds.min?.x || 0);
                const snippetH = (snippetBounds.max?.y || 0.3) - (snippetBounds.min?.y || 0);

                const contentW = Math.max(labelW, snippetW);
                const contentH = labelH + snippetH + 0.1; // small gap between label and snippet

                // Build card sized to content
                const doc = buildDocCard(contentW, contentH, bodyColors[r], borderColors[r]);
                this.scene.add(doc.group);

                doc.labelId = entry.labelId;
                doc.snippetId = entry.snippetId;
                doc.labelColor = labelColors[r];
                doc.agentIdx = a;
                doc.roundIdx = r;
                doc.visible = false;
                doc.traveling = false;
                doc.absorbed = false;
                doc.contentW = contentW;
                doc.contentH = contentH;

                this._docs[a].push(doc);
                agentCards.push(doc);
            }

            // Stack cards using their measured sizes
            stackCards(agentCards, pos);

            // Reposition text to match card rest positions
            for (let r = 0; r < 3; r++) {
                const doc = this._docs[a][r];
                const rp = doc.restPos;
                const halfH = doc.contentH / 2;

                // Label at top of card, snippet below
                this.glyphCollection.updatePosition(doc.labelId, {
                    x: rp.x - doc.contentW / 2,
                    y: rp.y + halfH - 0.1,
                    z: rp.z + 0.1
                });
                this.glyphCollection.updatePosition(doc.snippetId, {
                    x: rp.x - doc.contentW / 2,
                    y: rp.y - halfH + 0.3,
                    z: rp.z + 0.1
                });
                doc.currentPos = rp.clone();
            }
        }

        // Final flush to apply repositioned text
        this.glyphCollection.flush();
    }

    // ─── Arc trail lines ──────────────────────────────────────────────────────

    _buildArcTrails() {
        // One arc trail per directed pair [src][dst], round 1 (green) and round 2 (blue)
        // We'll build them all but only show the relevant one when a doc travels
        this._arcTrails = {};
        const pairs = [
            [0,1],[0,2],[1,0],[1,2],[2,0],[2,1],
        ];
        for (const [src, dst] of pairs) {
            const from = this._positions[src].clone();
            const to = this._positions[dst].clone();
            const ctrl_green = bezierControl(from, to, 1.8, (src + dst) % 2 === 0);
            const ctrl_blue  = bezierControl(from, to, 2.2, (src + dst) % 2 !== 0);

            const trailGreen = buildArcTrail(from, ctrl_green, to, 0x00ff88);
            const trailBlue  = buildArcTrail(from, ctrl_blue,  to, 0x4488ff);
            this.scene.add(trailGreen);
            this.scene.add(trailBlue);

            const key = `${src}_${dst}`;
            this._arcTrails[key] = { green: trailGreen, blue: trailBlue, ctrl_green, ctrl_blue };
        }
    }

    // ─── Center synthesis object ──────────────────────────────────────────────

    _buildSynthObject() {
        const geo = new THREE.OctahedronGeometry(0.9, 1);
        const mat = new THREE.MeshStandardMaterial({
            color: new THREE.Color(0x003322),
            emissive: new THREE.Color(0x001a0d),
            roughness: 0.3,
            metalness: 0.5,
            transparent: true,
            opacity: 0,
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(0, 0, 0);
        this.scene.add(mesh);

        const rimGeo = new THREE.OctahedronGeometry(1.1, 1);
        const rimMat = new THREE.MeshBasicMaterial({
            color: 0x00ff88,
            wireframe: true,
            transparent: true,
            opacity: 0,
        });
        const rimMesh = new THREE.Mesh(rimGeo, rimMat);
        rimMesh.position.set(0, 0, 0);
        this.scene.add(rimMesh);

        this._synthMesh = { mesh, mat, rimMesh, rimMat };
    }

    // ─── Phase state machine ──────────────────────────────────────────────────

    _startPhase(phase) {
        this._phase = phase;
        this._phaseT = 0;
        this._phaseStart = this._totalT;
        this._updateUI(phase);

        // Clean up flying copies from previous phase (they are transient)
        if (this._flyingCopies) {
            for (const copy of this._flyingCopies) {
                this.scene.remove(copy.group);
                copy.group.traverse(obj => {
                    if (obj.geometry) obj.geometry.dispose();
                    if (obj.material) obj.material.dispose();
                });
            }
            this._flyingCopies = [];
        }

        // Reset arc trail opacities at phase boundary
        if (this._arcTrails) {
            for (const key in this._arcTrails) {
                const trail = this._arcTrails[key];
                trail.green.material.opacity = 0;
                trail.blue.material.opacity  = 0;
            }
        }
    }

    _updateUI(phase) {
        const labels = [
            'INITIALIZING',
            'INITIAL ANALYSIS',
            'FORWARD REVIEW',
            'INVERSE REVIEW',
            'SYNTHESIS',
            'RESETTING',
        ];
        const statusLines = [
            'Three perspective agents coming online',
            'Each agent produces an initial output document',
            'Forward pass — A reads B,C  \u2219  B reads A,C  \u2219  C reads A,B',
            'Inverse pass — A reads C,B  \u2219  B reads C,A  \u2219  C reads B,A',
            'All final documents converge at the center',
            '',
        ];

        if (this._phaseLabelEl) {
            this._phaseLabelEl.textContent = labels[phase] || '';
            this._phaseLabelEl.classList.toggle('active', phase > 0 && phase < 5);
        }
        if (this._statusEl) {
            this._statusEl.textContent = statusLines[phase] || '';
        }

        this._phaseDots.forEach((dot, i) => {
            dot.classList.remove('active', 'done');
            if (i === phase - 1) dot.classList.add('active');
            else if (i < phase - 1) dot.classList.add('done');
        });
    }

    // ─── Main render tick ─────────────────────────────────────────────────────

    _tick(timestampMs) {
        if (this._disposed) return;
        this._rafId = requestAnimationFrame(t => this._tick(t));

        const dt = Math.min((timestampMs - (this._lastTimestamp || timestampMs)) / 1000, 0.05);
        this._lastTimestamp = timestampMs;
        this._totalT += dt;

        const phaseDur = this._phaseDurations[this._phase] || 2;
        this._phaseT = clamp01((this._totalT - this._phaseStart) / phaseDur);

        this._updatePhase(this._phase, this._phaseT, dt);

        if (this.glyphCollection && this.glyphCollection.isDirty()) {
            this.glyphCollection.flush();
        }

        if (this._phaseT >= 1.0) {
            const nextPhase = (this._phase + 1) % this._phaseDurations.length;
            if (nextPhase === 0) {
                this._resetVisualization();
            }
            this._startPhase(nextPhase);
        }

        // Gentle camera drift
        const drift = this._totalT * 0.065;
        this.camera.position.x = Math.sin(drift) * 1.0;
        this.camera.position.y = Math.cos(drift * 0.6) * 0.7;
        this.camera.lookAt(0, 0, 0);

        // Gentle rotation of synth object
        if (this._synthMesh && this._synthMesh.mat.opacity > 0.01) {
            this._synthMesh.mesh.rotation.y += dt * 0.6;
            this._synthMesh.rimMesh.rotation.y -= dt * 0.4;
        }

        this.renderer.render(this.scene, this.camera);
    }

    // ─── Phase dispatch ───────────────────────────────────────────────────────

    _updatePhase(phase, t, dt) {
        switch (phase) {
            case 0: this._updateSpawn(t); break;
            case 1: this._updateInitialDocs(t); break;
            case 2: this._updateForwardReview(t); break;
            case 3: this._updateInverseReview(t); break;
            case 4: this._updateConvergence(t); break;
            case 5: this._updateFadeOut(t); break;
        }
    }

    // ─── Phase 0: Spawn nodes ─────────────────────────────────────────────────

    _updateSpawn(t) {
        for (let i = 0; i < 3; i++) {
            const node = this._nodes[i];
            const stagger = clamp01((t - i * 0.2) / 0.5);
            const nodeOp = easeOut(stagger);

            node.mat.opacity = nodeOp;
            node.rimMat.opacity = nodeOp * 0.35;
            node.workspace.mat.opacity = nodeOp * 0.6;

            const agentC = node.agentColor;
            node.rimMat.color.copy(agentC).multiplyScalar(nodeOp * 0.5);

            // Fade in labels
            this.glyphCollection.updateColor(node.labelId, {
                r: 0.0,
                g: 0.9 * nodeOp,
                b: 0.55 * nodeOp,
            });
            this.glyphCollection.updateColor(node.nameId, {
                r: COLOR.dimLabel.r * nodeOp,
                g: COLOR.dimLabel.g * nodeOp,
                b: COLOR.dimLabel.b * nodeOp,
            });
        }
    }

    // ─── Phase 1: Initial docs emerge from each agent ─────────────────────────

    _updateInitialDocs(t) {
        for (let i = 0; i < 3; i++) {
            const node = this._nodes[i];
            // Stagger: agent 0 starts first
            const stagger = i * 0.28;
            const localT = clamp01((t - stagger) / 0.6);
            const emerge = easeOut(localT);

            // Node glows as it "thinks"
            const glow = Math.sin(localT * Math.PI) * 0.5;
            node.mat.emissive.setRGB(0, glow * 0.35, glow * 0.18);
            const agentC = AGENT_COLORS[i];
            node.rimMat.color.copy(agentC).multiplyScalar(0.3 + glow * 0.6);
            node.rimMat.opacity = 0.3 + glow * 0.4;
            node.workspace.mat.opacity = 0.5 + glow * 0.3;

            // Emerge the round-0 doc
            const doc = this._docs[i][0];
            if (localT > 0.05) {
                doc.group.visible = true;
                doc.visible = true;
                const s = easeOut(clamp01((localT - 0.05) / 0.5));
                doc.group.scale.setScalar(s);
                doc.bodyMat.opacity = s * 0.88;
                doc.borderMat.opacity = s * 0.7;

                // Show doc label text
                this.glyphCollection.updateColor(doc.labelId, {
                    r: doc.labelColor.r * s,
                    g: doc.labelColor.g * s,
                    b: doc.labelColor.b * s,
                });
                this.glyphCollection.updateColor(doc.snippetId, {
                    r: doc.labelColor.r * s * 0.7,
                    g: doc.labelColor.g * s * 0.7,
                    b: doc.labelColor.b * s * 0.7,
                });
            }
        }
    }

    // ─── Phase 2: Forward review (green) ─────────────────────────────────────
    //
    // ALL agents act in parallel — each wave fires 3 arcs simultaneously:
    //
    //   Wave 1 (0.0–2.0 s):  B₁→A,  A₁→B,  A₁→C   (first read for each agent)
    //   Wave 2 (2.5–4.5 s):  C₁→A,  C₁→B,  B₁→C   (second read for each agent)
    //   Digest (5.0–6.0 s):  all three agents pulse simultaneously
    //   Emerge (6.0–7.5 s):  A₂, B₂, C₂ emerge simultaneously

    _updateForwardReview(t) {
        const phaseSec = t * this._phaseDurations[2];

        // Wave 1: each agent receives their first document simultaneously
        //   A receives B₁  (src=1, round=0, dst=0)
        //   B receives A₁  (src=0, round=0, dst=1)
        //   C receives A₁  (src=0, round=0, dst=2)
        const WAVE1_START = 0.0, WAVE1_DUR = 2.0;
        if (phaseSec >= WAVE1_START) {
            const w = clamp01((phaseSec - WAVE1_START) / WAVE1_DUR);
            this._animateCopyTravel('fwd_w1_0', 1, 0, 0, w, 'green');  // B₁→A
            this._animateCopyTravel('fwd_w1_1', 0, 0, 1, w, 'green');  // A₁→B
            this._animateCopyTravel('fwd_w1_2', 0, 0, 2, w, 'green');  // A₁→C
        }

        // Wave 2: each agent receives their second document simultaneously
        //   A receives C₁  (src=2, round=0, dst=0)
        //   B receives C₁  (src=2, round=0, dst=1)
        //   C receives B₁  (src=1, round=0, dst=2)
        const WAVE2_START = 2.5, WAVE2_DUR = 2.0;
        if (phaseSec >= WAVE2_START) {
            const w = clamp01((phaseSec - WAVE2_START) / WAVE2_DUR);
            this._animateCopyTravel('fwd_w2_0', 2, 0, 0, w, 'green');  // C₁→A
            this._animateCopyTravel('fwd_w2_1', 2, 0, 1, w, 'green');  // C₁→B
            this._animateCopyTravel('fwd_w2_2', 1, 0, 2, w, 'green');  // B₁→C
        }

        // All agents digest simultaneously: 5.0–6.0 s
        const DIGEST_START = 5.0, DIGEST_DUR = 1.0;
        if (phaseSec >= DIGEST_START && phaseSec < DIGEST_START + DIGEST_DUR + 0.1) {
            const digestT = clamp01((phaseSec - DIGEST_START) / DIGEST_DUR);
            const pulse = Math.sin(digestT * Math.PI * 2) * 0.5;
            for (let i = 0; i < 3; i++) {
                const node = this._nodes[i];
                node.mat.emissive.setRGB(0, (0.3 + pulse) * 0.5, (0.3 + pulse) * 0.25);
                node.rimMat.color.set(0x00ff88);
                node.rimMat.opacity = 0.25 + Math.abs(pulse) * 0.55;
                node.workspace.mat.opacity = 0.5 + Math.abs(pulse) * 0.35;
            }
        }

        // All agents produce round-1 docs simultaneously: 6.0–7.5 s
        const EMERGE_START = 6.0, EMERGE_DUR = 1.5;
        if (phaseSec >= EMERGE_START) {
            const emergeT = clamp01((phaseSec - EMERGE_START) / EMERGE_DUR);
            for (let i = 0; i < 3; i++) {
                this._emergeDoc(this._docs[i][1], emergeT);
            }
        }
    }

    // ─── Phase 3: Inverse review (blue) ──────────────────────────────────────
    //
    // ALL agents act in parallel — each wave fires 3 arcs simultaneously:
    //
    //   Wave 1 (0.0–2.0 s):   C₁→A,  C₁→B,  B₁→C    (first round-0 reads)
    //   Wave 2 (2.5–4.5 s):   B₁→A,  A₁→B,  A₁→C    (second round-0 reads)
    //   Wave 3 (5.0–7.0 s):   B₂→A,  A₂→B,  A₂→C    (first round-1 reads)
    //   Wave 4 (7.5–9.5 s):   C₂→A,  C₂→B,  B₂→C    (second round-1 reads)
    //   Digest (10.0–11.0 s): all three agents pulse simultaneously
    //   Emerge (11.0–12.5 s): A₃, B₃, C₃ emerge simultaneously

    _updateInverseReview(t) {
        const phaseSec = t * this._phaseDurations[3];

        const WAVE_DUR = 2.0;

        // Wave 1: first round-0 inverse reads (C₁→A, C₁→B, B₁→C)
        const W1 = 0.0;
        if (phaseSec >= W1) {
            const w = clamp01((phaseSec - W1) / WAVE_DUR);
            this._animateCopyTravel('inv_w1_0', 2, 0, 0, w, 'blue');  // C₁→A
            this._animateCopyTravel('inv_w1_1', 2, 0, 1, w, 'blue');  // C₁→B
            this._animateCopyTravel('inv_w1_2', 1, 0, 2, w, 'blue');  // B₁→C
        }

        // Wave 2: second round-0 inverse reads (B₁→A, A₁→B, A₁→C)
        const W2 = 2.5;
        if (phaseSec >= W2) {
            const w = clamp01((phaseSec - W2) / WAVE_DUR);
            this._animateCopyTravel('inv_w2_0', 1, 0, 0, w, 'blue');  // B₁→A
            this._animateCopyTravel('inv_w2_1', 0, 0, 1, w, 'blue');  // A₁→B
            this._animateCopyTravel('inv_w2_2', 0, 0, 2, w, 'blue');  // A₁→C
        }

        // Wave 3: first round-1 reads (B₂→A, A₂→B, A₂→C)
        const W3 = 5.0;
        if (phaseSec >= W3) {
            const w = clamp01((phaseSec - W3) / WAVE_DUR);
            this._animateCopyTravel('inv_w3_0', 1, 1, 0, w, 'blue');  // B₂→A
            this._animateCopyTravel('inv_w3_1', 0, 1, 1, w, 'blue');  // A₂→B
            this._animateCopyTravel('inv_w3_2', 0, 1, 2, w, 'blue');  // A₂→C
        }

        // Wave 4: second round-1 reads (C₂→A, C₂→B, B₂→C)
        const W4 = 7.5;
        if (phaseSec >= W4) {
            const w = clamp01((phaseSec - W4) / WAVE_DUR);
            this._animateCopyTravel('inv_w4_0', 2, 1, 0, w, 'blue');  // C₂→A
            this._animateCopyTravel('inv_w4_1', 2, 1, 1, w, 'blue');  // C₂→B
            this._animateCopyTravel('inv_w4_2', 1, 1, 2, w, 'blue');  // B₂→C
        }

        // All agents digest simultaneously: 10.0–11.0 s
        const DIGEST_START = 10.0, DIGEST_DUR = 1.0;
        if (phaseSec >= DIGEST_START && phaseSec < DIGEST_START + DIGEST_DUR + 0.1) {
            const digestT = clamp01((phaseSec - DIGEST_START) / DIGEST_DUR);
            const pulse = Math.sin(digestT * Math.PI * 2) * 0.5;
            for (let i = 0; i < 3; i++) {
                const node = this._nodes[i];
                node.mat.emissive.setRGB(pulse * 0.1, pulse * 0.2, pulse * 0.55);
                node.rimMat.color.set(0x4488ff);
                node.rimMat.opacity = 0.25 + Math.abs(pulse) * 0.55;
                node.workspace.mat.opacity = 0.45 + Math.abs(pulse) * 0.3;
            }
        }

        // All agents produce round-2 docs simultaneously: 11.0–12.5 s
        const EMERGE_START = 11.0, EMERGE_DUR = 1.5;
        if (phaseSec >= EMERGE_START) {
            const emergeT = clamp01((phaseSec - EMERGE_START) / EMERGE_DUR);
            for (let i = 0; i < 3; i++) {
                this._emergeDoc(this._docs[i][2], emergeT);
            }
        }
    }

    // ─── Phase 4: Convergence ─────────────────────────────────────────────────

    _updateConvergence(t) {
        const center = new THREE.Vector3(0, 0, 0);
        const pulse = Math.sin(t * Math.PI * 4) * 0.5 + 0.5;
        const intensity = easeOut(t);

        // Slide final (round-2) docs toward center
        for (let i = 0; i < 3; i++) {
            const doc = this._docs[i][2];
            if (!doc.visible) continue;

            const slideT = easeInOut(t);
            doc.group.position.lerpVectors(doc.restPos, center, slideT);
            // Scale down as they merge (last 30% of the phase)
            const mergeT = clamp01((t - 0.7) / 0.3);
            const s = 1 - easeIn(mergeT) * 0.7;
            doc.group.scale.setScalar(s);
            doc.bodyMat.opacity = (1 - mergeT) * 0.88;
            doc.borderMat.opacity = (1 - mergeT) * 0.7;

            // Labels fade
            const fc = 1 - mergeT;
            this.glyphCollection.updateColor(doc.labelId, {
                r: doc.labelColor.r * fc,
                g: doc.labelColor.g * fc,
                b: doc.labelColor.b * fc,
            });
            this.glyphCollection.updateColor(doc.snippetId, {
                r: doc.labelColor.r * fc * 0.7,
                g: doc.labelColor.g * fc * 0.7,
                b: doc.labelColor.b * fc * 0.7,
            });
        }

        // Synth object grows from center as docs merge
        const synthAppear = easeOut(clamp01((t - 0.35) / 0.6));
        this._synthMesh.mat.opacity = synthAppear * 0.9;
        this._synthMesh.rimMat.opacity = synthAppear * (0.3 + pulse * 0.5);
        this._synthMesh.mat.emissive.setRGB(0, synthAppear * 0.4, synthAppear * 0.2);
        this._synthMesh.rimMat.color.copy(COLOR.synthPulse);
        const synthScale = easeOut(synthAppear) * (1 + pulse * 0.15);
        this._synthMesh.mesh.scale.setScalar(synthScale);
        this._synthMesh.rimMesh.scale.setScalar(synthScale * 1.1);

        // Node rims glow green toward convergence
        for (const node of this._nodes) {
            node.mat.emissive.setRGB(0, intensity * 0.35, intensity * 0.18);
            node.rimMat.color.set(0x00ff88);
            node.rimMat.opacity = 0.25 + pulse * intensity * 0.4;
        }

        // Point light pulses green
        this._pointLight.intensity = 1.5 + pulse * intensity * 3.0;
        this._pointLight.color.setRGB(0, 1, 0.53);
    }

    // ─── Phase 5: Fade out ────────────────────────────────────────────────────

    _updateFadeOut(t) {
        const op = 1 - easeInOut(t);

        for (const node of this._nodes) {
            node.mat.opacity = op;
            node.rimMat.opacity = op * 0.35;
            node.workspace.mat.opacity = op * 0.5;
            this.glyphCollection.updateColor(node.labelId, {
                r: 0.0, g: 0.9 * op, b: 0.55 * op,
            });
            this.glyphCollection.updateColor(node.nameId, {
                r: COLOR.dimLabel.r * op,
                g: COLOR.dimLabel.g * op,
                b: COLOR.dimLabel.b * op,
            });
        }

        // Fade all visible docs
        for (let a = 0; a < 3; a++) {
            for (let r = 0; r < 3; r++) {
                const doc = this._docs[a][r];
                if (!doc.visible) continue;
                doc.bodyMat.opacity = op * 0.88;
                doc.borderMat.opacity = op * 0.7;
                this.glyphCollection.updateColor(doc.labelId, {
                    r: doc.labelColor.r * op,
                    g: doc.labelColor.g * op,
                    b: doc.labelColor.b * op,
                });
                this.glyphCollection.updateColor(doc.snippetId, {
                    r: doc.labelColor.r * op * 0.7,
                    g: doc.labelColor.g * op * 0.7,
                    b: doc.labelColor.b * op * 0.7,
                });
            }
        }

        // Hide all arc trails
        for (const key in this._arcTrails) {
            const trail = this._arcTrails[key];
            trail.green.material.opacity *= 0.88;
            trail.blue.material.opacity  *= 0.88;
        }

        // Fade synth
        this._synthMesh.mat.opacity *= 0.88;
        this._synthMesh.rimMat.opacity *= 0.88;

        this._pointLight.intensity = lerp(1.5, 0.3, t);
    }

    // ─── Doc animation helpers ────────────────────────────────────────────────

    /**
     * Animate a COPY of a source document traveling to a destination agent.
     * The original document stays at its rest position.
     * Creates the copy on first call (keyed by `id`), reuses on subsequent frames.
     *
     * @param {string} id - unique key for this copy (e.g. 'fwd_0_1')
     * @param {number} srcAgent - index of source agent who owns the document
     * @param {number} srcRound - round index of the source document (0=R0, 1=R1)
     * @param {number} dstAgent - destination agent index
     * @param {number} t - 0→1 animation progress
     * @param {string} colorMode - 'green' or 'blue'
     */
    _animateCopyTravel(id, srcAgent, srcRound, dstAgent, t, colorMode) {
        if (t <= 0) return;

        // Find or create the flying copy
        let copy = this._flyingCopies.find(c => c.id === id);
        if (!copy) {
            const srcDoc = this._docs[srcAgent][srcRound];
            const bodyColors = [COLOR.docRound0, COLOR.docRound1, COLOR.docRound2];
            const borderColors = [COLOR.docBorderR0, COLOR.docBorderR1, COLOR.docBorderR2];
            const { group, bodyMat, borderMat } = buildDocCard(
                srcDoc.contentW || 1.5,
                srcDoc.contentH || 0.8,
                bodyColors[srcRound],
                borderColors[srcRound]
            );
            group.position.copy(srcDoc.restPos);
            group.scale.setScalar(1);
            this.scene.add(group);
            copy = {
                id,
                group,
                bodyMat,
                borderMat,
                srcDoc,
                srcAgent,
                dstAgent,
                colorMode,
                done: false,
            };
            this._flyingCopies.push(copy);
        }

        if (copy.done) return;

        const srcDoc = copy.srcDoc;
        const srcPos = srcDoc.restPos.clone();
        const dstPos = this._positions[dstAgent].clone();
        const key = `${srcAgent}_${dstAgent}`;
        const trailInfo = this._arcTrails[key];

        let ctrl;
        if (trailInfo) {
            ctrl = colorMode === 'green' ? trailInfo.ctrl_green : trailInfo.ctrl_blue;
        } else {
            ctrl = bezierControl(srcPos, dstPos, 2.0, true);
        }

        // Show arc trail during travel
        if (trailInfo) {
            const trail = colorMode === 'green' ? trailInfo.green : trailInfo.blue;
            if (t < 0.1) {
                trail.material.opacity = Math.max(trail.material.opacity, easeOut(t / 0.1) * 0.25);
            } else if (t < 0.75) {
                trail.material.opacity = Math.max(trail.material.opacity, 0.18);
            } else {
                const fade = (1 - (t - 0.75) / 0.25) * 0.18;
                trail.material.opacity = Math.max(trail.material.opacity, fade);
            }
        }

        const tmp = new THREE.Vector3();
        copy.group.visible = true;

        if (t < 0.1) {
            // Lift phase
            copy.group.position.copy(srcPos);
            copy.group.position.z += easeOut(t / 0.1) * 0.8;
            copy.group.scale.setScalar(1);
            copy.bodyMat.opacity = 0.88;
            copy.borderMat.opacity = 0.7;
        } else if (t < 0.78) {
            // Arc travel
            const travelT = (t - 0.1) / 0.68;
            const liftedSrc = srcPos.clone();
            liftedSrc.z += 0.8;
            quadBezier(liftedSrc, ctrl, dstPos, easeInOut(travelT), tmp);
            copy.group.position.copy(tmp);
            copy.group.scale.setScalar(1);
            copy.bodyMat.opacity = 0.88;
            copy.borderMat.opacity = 0.7;
        } else {
            // Absorb into destination node
            const absorbT = (t - 0.78) / 0.22;
            const s = 1 - easeIn(absorbT);
            copy.group.position.copy(dstPos);
            copy.group.scale.setScalar(s);
            copy.bodyMat.opacity = s * 0.88;
            copy.borderMat.opacity = s * 0.7;

            if (absorbT >= 0.99) {
                copy.group.visible = false;
                copy.done = true;
                if (trailInfo) {
                    const trail = colorMode === 'green' ? trailInfo.green : trailInfo.blue;
                    trail.material.opacity = 0;
                }
            }
        }
    }

    /**
     * Animate a document traveling from its current agent toward `dstAgent`.
     * Stages:
     *   0.0–0.1  : lift up (scale stays 1, moves slightly Z+)
     *   0.1–0.75 : arc travel along bezier
     *   0.75–1.0 : absorb into destination (scale 1→0, fade)
     *
     * @param {Object} doc - document object
     * @param {number} dstAgent - destination agent index
     * @param {number} t - 0→1 animation progress
     * @param {string} colorMode - 'green' or 'blue'
     */
    _animateDocTravel(doc, dstAgent, t, colorMode) {
        if (t <= 0) return;
        if (doc.absorbed) return;

        doc.group.visible = true;
        doc.traveling = true;

        const srcPos = doc.restPos.clone();
        const dstPos = this._positions[dstAgent].clone();
        const key = `${doc.agentIdx}_${dstAgent}`;
        const trailInfo = this._arcTrails[key];

        let ctrl;
        if (trailInfo) {
            ctrl = colorMode === 'green' ? trailInfo.ctrl_green : trailInfo.ctrl_blue;
        } else {
            ctrl = bezierControl(srcPos, dstPos, 2.0, true);
        }

        // Show arc trail briefly during travel
        if (trailInfo) {
            const trail = colorMode === 'green' ? trailInfo.green : trailInfo.blue;
            // Fade trail in, hold, then fade out
            if (t < 0.1) {
                trail.material.opacity = easeOut(t / 0.1) * 0.25;
            } else if (t < 0.75) {
                trail.material.opacity = 0.18;
            } else {
                trail.material.opacity = (1 - (t - 0.75) / 0.25) * 0.18;
            }
        }

        const tmp = new THREE.Vector3();

        if (t < 0.1) {
            // Lift phase
            const liftT = t / 0.1;
            doc.group.position.copy(srcPos);
            doc.group.position.z += easeOut(liftT) * 0.8;
            doc.group.scale.setScalar(1);
            doc.bodyMat.opacity = 0.88;
            doc.borderMat.opacity = 0.7;
        } else if (t < 0.78) {
            // Arc travel
            const travelT = (t - 0.1) / 0.68;
            // Tiny lift at src, arc above, approach dst
            const liftedSrc = srcPos.clone();
            liftedSrc.z += 0.8;
            quadBezier(liftedSrc, ctrl, dstPos, easeInOut(travelT), tmp);
            doc.group.position.copy(tmp);
            // Scale stays 1 during flight
            doc.group.scale.setScalar(1);
            doc.bodyMat.opacity = 0.88;
            doc.borderMat.opacity = 0.7;

            // Show doc label during flight
            this.glyphCollection.updateColor(doc.labelId, {
                r: doc.labelColor.r,
                g: doc.labelColor.g,
                b: doc.labelColor.b,
            });
            this.glyphCollection.updateColor(doc.snippetId, {
                r: doc.labelColor.r * 0.7,
                g: doc.labelColor.g * 0.7,
                b: doc.labelColor.b * 0.7,
            });
        } else {
            // Absorb into destination node
            const absorbT = (t - 0.78) / 0.22;
            const s = 1 - easeIn(absorbT);
            doc.group.position.copy(dstPos);
            doc.group.scale.setScalar(s);
            doc.bodyMat.opacity = s * 0.88;
            doc.borderMat.opacity = s * 0.7;

            const fc = s;
            this.glyphCollection.updateColor(doc.labelId, {
                r: doc.labelColor.r * fc,
                g: doc.labelColor.g * fc,
                b: doc.labelColor.b * fc,
            });
            this.glyphCollection.updateColor(doc.snippetId, {
                r: doc.labelColor.r * fc * 0.7,
                g: doc.labelColor.g * fc * 0.7,
                b: doc.labelColor.b * fc * 0.7,
            });

            if (absorbT >= 0.99) {
                doc.group.visible = false;
                doc.visible = false;
                doc.absorbed = true;
                // Hide trail
                if (trailInfo) {
                    const trail = colorMode === 'green' ? trailInfo.green : trailInfo.blue;
                    trail.material.opacity = 0;
                }
            }
        }
    }

    /**
     * Emerge a new document at its resting position.
     * @param {Object} doc
     * @param {number} t - 0→1 emerge progress
     */
    _emergeDoc(doc, t) {
        if (doc.absorbed) return;
        const emerge = easeOut(t);
        doc.group.visible = true;
        doc.visible = true;
        doc.group.position.copy(doc.restPos);
        doc.group.scale.setScalar(emerge);
        doc.bodyMat.opacity = emerge * 0.88;
        doc.borderMat.opacity = emerge * 0.7;

        this.glyphCollection.updateColor(doc.labelId, {
            r: doc.labelColor.r * emerge,
            g: doc.labelColor.g * emerge,
            b: doc.labelColor.b * emerge,
        });
        this.glyphCollection.updateColor(doc.snippetId, {
            r: doc.labelColor.r * emerge * 0.7,
            g: doc.labelColor.g * emerge * 0.7,
            b: doc.labelColor.b * emerge * 0.7,
        });
    }

    // ─── Reset for loop ───────────────────────────────────────────────────────

    _resetVisualization() {
        // Reset all docs
        for (let a = 0; a < 3; a++) {
            for (let r = 0; r < 3; r++) {
                const doc = this._docs[a][r];
                doc.group.visible = false;
                doc.group.position.copy(doc.restPos);
                doc.group.scale.setScalar(0);
                doc.bodyMat.opacity = 0;
                doc.borderMat.opacity = 0;
                doc.visible = false;
                doc.traveling = false;
                doc.absorbed = false;

                this.glyphCollection.updateColor(doc.labelId,   { r: 0.001, g: 0.001, b: 0.001 });
                this.glyphCollection.updateColor(doc.snippetId, { r: 0.001, g: 0.001, b: 0.001 });
            }
        }

        // Destroy flying copies
        for (const copy of this._flyingCopies) {
            this.scene.remove(copy.group);
            copy.group.traverse(obj => {
                if (obj.geometry) obj.geometry.dispose();
                if (obj.material) obj.material.dispose();
            });
        }
        this._flyingCopies = [];

        // Reset arc trails
        for (const key in this._arcTrails) {
            const t = this._arcTrails[key];
            t.green.material.opacity = 0;
            t.blue.material.opacity  = 0;
        }

        // Reset nodes
        for (const node of this._nodes) {
            node.mat.opacity = 0;
            node.mat.emissive.setRGB(0, 0, 0);
            node.mat.color.copy(COLOR.nodeIdle);
            node.rimMat.opacity = 0;
            node.workspace.mat.opacity = 0;

            this.glyphCollection.updateColor(node.labelId, { r: 0.001, g: 0.001, b: 0.001 });
            this.glyphCollection.updateColor(node.nameId,  { r: 0.001, g: 0.001, b: 0.001 });
        }

        // Reset synth
        this._synthMesh.mat.opacity = 0;
        this._synthMesh.rimMat.opacity = 0;
        this._synthMesh.mesh.scale.setScalar(1);
        this._synthMesh.rimMesh.scale.setScalar(1);
        this._synthMesh.mesh.rotation.set(0, 0, 0);
        this._synthMesh.rimMesh.rotation.set(0, 0, 0);

        // Reset light
        this._pointLight.intensity = 1.5;
        this._pointLight.color.setRGB(0, 1, 0.53);
    }

    // ─── Resize ───────────────────────────────────────────────────────────────

    _handleResize() {
        const w = window.innerWidth;
        const h = window.innerHeight;
        this.renderer.setSize(w, h);
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
    }

    // ─── Disposal ─────────────────────────────────────────────────────────────

    dispose() {
        this._disposed = true;
        cancelAnimationFrame(this._rafId);
        window.removeEventListener('resize', this._onResize);
        if (this.glyphCollection) this.glyphCollection.dispose();
        this.renderer.dispose();
    }
}
