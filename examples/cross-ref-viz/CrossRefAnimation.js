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

// Document resting offsets from agent node (where a doc parks after emerging)
function docRestOffset(agentIdx) {
    // A: right, B: left, C: right — keep cards out of the triangle interior
    const offsets = [
        new THREE.Vector3( 2.2, 0.3, 0),    // A — right
        new THREE.Vector3(-2.2, 0.3, 0),    // B — left
        new THREE.Vector3( 2.2,-0.3, 0),    // C — right
    ];
    return offsets[agentIdx];
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
 * Build a document card mesh — thin box with an edge border.
 * Returns { group, bodyMesh, bodyMat, borderMesh, borderMat }
 */
function buildDocCard(bodyColor, borderColor) {
    const W = 1.6, H = 1.0, D = 0.06;
    const group = new THREE.Group();

    // Body
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

    // Border (edges of front face only — approximate with EdgesGeometry on a plane)
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
        this._phaseDurations = [
            2.5,   // 0 — spawn nodes
            3.0,   // 1 — initial output docs emerge (A1 B1 C1)
            9.0,   // 2 — forward review (green arcs, A reads B,C; etc.)
            9.0,   // 3 — inverse review (blue arcs, reversed order)
            3.5,   // 4 — convergence
            2.0,   // 5 — fade out
        ];

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
        const bodyColors = [COLOR.docRound0, COLOR.docRound1, COLOR.docRound2];
        const borderColors = [COLOR.docBorderR0, COLOR.docBorderR1, COLOR.docBorderR2];

        for (let a = 0; a < 3; a++) {
            this._docs.push([]);
            const agent = AGENTS[a];
            const pos = this._positions[a];
            const restOffset = docRestOffset(a);

            for (let r = 0; r < 3; r++) {
                const doc = buildDocCard(bodyColors[r], borderColors[r]);
                const restPos = pos.clone().add(restOffset);
                // Stack docs vertically by round
                restPos.y += (1 - r) * 0.2;
                restPos.z = 0.05 * (r + 1);
                doc.group.position.copy(restPos);
                doc.group.scale.setScalar(0);
                this.scene.add(doc.group);

                // Tiny label on the doc ("A₁", "B₂", etc.)
                const labelText = agent.docLabels[r];
                // Position relative to doc rest position
                const labelPos = {
                    x: restPos.x - 0.32,
                    y: restPos.y + 0.18,
                    z: restPos.z + 0.1,
                };
                const labelColors = [COLOR.docLabelR0, COLOR.docLabelR1, COLOR.docLabelR2];
                const labelId = this.glyphCollection.addText(
                    labelText,
                    labelPos,
                    { color: { r: 0.001, g: 0.001, b: 0.001 }, scale: 1.1 }
                );

                // Content text (snippet) on the doc
                const snippetPos = {
                    x: restPos.x - 0.72,
                    y: restPos.y + 0.02,
                    z: restPos.z + 0.1,
                };
                const snippetId = this.glyphCollection.addText(
                    agent.snippets[r],
                    snippetPos,
                    { color: { r: 0.001, g: 0.001, b: 0.001 }, scale: 0.62 }
                );

                doc.labelId = labelId;
                doc.snippetId = snippetId;
                doc.labelColor = labelColors[r];
                doc.restPos = restPos.clone();
                doc.agentIdx = a;
                doc.roundIdx = r;
                doc.currentPos = restPos.clone();
                doc.visible = false;
                doc.traveling = false;
                doc.absorbed = false;

                this._docs[a].push(doc);
            }
        }
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
    // Order: A reads B,C → B reads A,C → C reads A,B
    // Each agent's "turn" is staggered. Within a turn, first doc travels then second.
    // After absorb, new doc (round 1) emerges.

    _updateForwardReview(t) {
        // 3 agents, each takes ~0.3 of the total phase, staggered by 0.28
        // Within each agent slot:
        //   0.00–0.35 : first source doc travels & absorbs
        //   0.30–0.65 : second source doc travels & absorbs
        //   0.60–0.90 : new doc emerges from receiver

        const forwardGroups = [
            { agent: 0, srcs: [1, 2] },
            { agent: 1, srcs: [0, 2] },
            { agent: 2, srcs: [0, 1] },
        ];

        for (let gi = 0; gi < 3; gi++) {
            const { agent, srcs } = forwardGroups[gi];
            const slotStart = gi * 0.30;
            const slotDur = 0.65;
            const slotT = clamp01((t - slotStart) / slotDur);

            // Travel first source
            const trav0 = clamp01(slotT / 0.45);
            this._animateDocTravel(this._docs[srcs[0]][0], agent, trav0, 'green');

            // Travel second source (starts when first is ~60% done)
            const trav1Start = 0.3;
            const trav1 = clamp01((slotT - trav1Start) / 0.45);
            this._animateDocTravel(this._docs[srcs[1]][0], agent, trav1, 'green');

            // Node "digesting" pulse while absorbing
            const digestT = clamp01((slotT - 0.2) / 0.5);
            const pulse = Math.sin(digestT * Math.PI * 2) * 0.5;
            const node = this._nodes[agent];
            node.mat.emissive.setRGB(0, (0.3 + pulse) * 0.5, (0.3 + pulse) * 0.25);
            node.rimMat.color.set(0x00ff88);
            node.rimMat.opacity = 0.25 + Math.abs(pulse) * 0.55;
            node.workspace.mat.opacity = 0.5 + Math.abs(pulse) * 0.35;

            // Emerge round-1 doc once both docs are mostly absorbed
            if (slotT > 0.62) {
                const emergeT = clamp01((slotT - 0.62) / 0.35);
                this._emergeDoc(this._docs[agent][1], emergeT);
            }
        }
    }

    // ─── Phase 3: Inverse review (blue) ──────────────────────────────────────
    //
    // Uses round-1 docs as source, reversed reading order.
    // A reads C first then B, B reads C first then A, C reads B first then A.

    _updateInverseReview(t) {
        const inverseGroups = [
            { agent: 0, srcs: [2, 1] },
            { agent: 1, srcs: [2, 0] },
            { agent: 2, srcs: [1, 0] },
        ];

        for (let gi = 0; gi < 3; gi++) {
            const { agent, srcs } = inverseGroups[gi];
            const slotStart = gi * 0.30;
            const slotDur = 0.65;
            const slotT = clamp01((t - slotStart) / slotDur);

            // Use round-1 docs (already at rest positions after forward phase)
            const trav0 = clamp01(slotT / 0.45);
            this._animateDocTravel(this._docs[srcs[0]][1], agent, trav0, 'blue');

            const trav1Start = 0.3;
            const trav1 = clamp01((slotT - trav1Start) / 0.45);
            this._animateDocTravel(this._docs[srcs[1]][1], agent, trav1, 'blue');

            // Node "digesting" with blue tint
            const digestT = clamp01((slotT - 0.2) / 0.5);
            const pulse = Math.sin(digestT * Math.PI * 2) * 0.5;
            const node = this._nodes[agent];
            node.mat.emissive.setRGB(pulse * 0.1, pulse * 0.2, pulse * 0.55);
            node.rimMat.color.set(0x4488ff);
            node.rimMat.opacity = 0.25 + Math.abs(pulse) * 0.55;
            node.workspace.mat.opacity = 0.45 + Math.abs(pulse) * 0.3;

            // Emerge round-2 (final) doc
            if (slotT > 0.62) {
                const emergeT = clamp01((slotT - 0.62) / 0.35);
                this._emergeDoc(this._docs[agent][2], emergeT);
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
