/**
 * CrossRefAnimation.js
 *
 * Visualizes the multi-agent cross-referencing process:
 *   Phase 0 — Three agent nodes appear (A, B, C)
 *   Phase 1 — Forward cross-reference: A reads B,C; B reads A,C; C reads A,B
 *   Phase 2 — Inverse cross-reference: A reads C,B; B reads C,A; C reads B,A
 *   Phase 3 — Convergence: all connections pulse green
 *   Loop
 *
 * Uses:
 *   - THREE.Mesh (IcosahedronGeometry) for agent nodes
 *   - THREE.Line for connection arrows
 *   - GlyphCollection for labels and output snippet text
 */

import * as THREE from 'three';
import { GlyphAtlas } from '../../src/index.js';
import GlyphCollection from '../../src/collections/GlyphCollection.js';

// ─── Palette ──────────────────────────────────────────────────────────────────

const COLOR = {
    bg:          0x0a0a0a,
    nodeIdle:    new THREE.Color(0x1a2a20),
    nodeActive:  new THREE.Color(0x00ff88),
    nodeRim:     new THREE.Color(0x003322),
    connInactive:new THREE.Color(0x1a1a1a),
    connActive:  new THREE.Color(0x00ff88),
    connInverse: new THREE.Color(0x88aaff),
    labelColor:  { r: 0.7,  g: 0.9,  b: 0.75 },
    outputColor: { r: 0.25, g: 0.55, b: 0.35 },
    synthColor:  { r: 0.4,  g: 0.6,  b: 1.0  },
    dimLabel:    { r: 0.18, g: 0.22, b: 0.20 },
};

// ─── Agent configuration ──────────────────────────────────────────────────────

const AGENTS = [
    {
        id: 'A',
        label: 'Algorithm',
        snippets: [
            'codepoint → UV atlas',
            'shelf-pack layout',
            'single draw call',
        ],
        synthSnippet: 'Unified: instanced\nrender + atlas pack',
    },
    {
        id: 'B',
        label: 'Interfaces',
        snippets: [
            'addText(text, pos)',
            'flush() → GPU',
            'updateColor(id)',
        ],
        synthSnippet: 'Unified: deferred\nbatch + group API',
    },
    {
        id: 'C',
        label: 'Implementation',
        snippets: [
            'InstancedBuffer\nGeometry',
            'DataTexture groups',
            'Worker offload',
        ],
        synthSnippet: 'Unified: workers\n+ DataTexture O(1)',
    },
];

// Triangle positions (XY plane, agent nodes)
function agentPositions(radius) {
    return [
        new THREE.Vector3(0,             radius,    0),   // A — top
        new THREE.Vector3(-radius * 0.866, -radius * 0.5, 0),  // B — bottom-left
        new THREE.Vector3( radius * 0.866, -radius * 0.5, 0),  // C — bottom-right
    ];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function lerp(a, b, t) { return a + (b - a) * t; }
function clamp01(t) { return Math.max(0, Math.min(1, t)); }
function easeInOut(t) { return t < 0.5 ? 2*t*t : -1+(4-2*t)*t; }
function easeOut(t) { return 1 - Math.pow(1 - t, 3); }

/**
 * Build a dashed-line geometry from srcPos to dstPos.
 * Returns a THREE.Line positioned in world space.
 */
function buildArrow(srcPos, dstPos, color, dashRatio = 0.5, segments = 24) {
    const dir = new THREE.Vector3().subVectors(dstPos, srcPos);
    const len = dir.length();
    const dashLen = len / segments;

    const positions = [];
    for (let i = 0; i < segments; i++) {
        const t0 = i / segments;
        const t1 = t0 + dashRatio / segments;
        const p0 = new THREE.Vector3().lerpVectors(srcPos, dstPos, t0);
        const p1 = new THREE.Vector3().lerpVectors(srcPos, dstPos, Math.min(t1, 1));
        positions.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));

    const mat = new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity: 0,
        linewidth: 1,
        depthWrite: false,
    });

    return new THREE.LineSegments(geo, mat);
}

/**
 * Build a small glowing sphere for a context packet.
 */
function buildPacket(color) {
    const geo = new THREE.SphereGeometry(0.08, 8, 8);
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0 });
    return new THREE.Mesh(geo, mat);
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

        // Camera — orthographic-ish perspective, centered on the triangle
        const aspect = window.innerWidth / window.innerHeight;
        this.camera = new THREE.PerspectiveCamera(42, aspect, 0.1, 1000);
        this.camera.position.set(0, 0, 22);
        this.camera.lookAt(0, 0, 0);

        // Ambient light (nodes are MeshStandardMaterial)
        const ambLight = new THREE.AmbientLight(0xffffff, 0.3);
        this.scene.add(ambLight);
        const pointLight = new THREE.PointLight(0x00ff88, 1.5, 40);
        pointLight.position.set(0, 5, 10);
        this.scene.add(pointLight);
        this._pointLight = pointLight;

        // Glyph atlas (shared)
        this.atlas = null;
        this.glyphCollection = null;

        // Scene objects
        this._nodeRadius = 6;
        this._positions = agentPositions(this._nodeRadius);
        this._nodes = [];         // { mesh, rimMesh, labelId, outputIds[], synthId }
        this._arrows = [];        // { line, src, dst, packets[] }
        this._outputPanels = [];  // { mesh, material } one per agent per round
        this._packets = [];       // all active packet meshes

        // Phase state machine
        this._phase = -1;         // current phase index
        this._phaseT = 0;         // 0→1 progress within the phase
        this._phaseStart = 0;     // performance.now() when phase began
        this._totalT = 0;         // cumulative time (seconds)

        // Per-phase timing (seconds)
        this._phaseDurations = [
            2.5,   // 0 — spawn
            3.5,   // 1 — round 0 initial outputs
            6.0,   // 2 — round 1 forward
            6.0,   // 3 — round 2 inverse
            2.5,   // 4 — convergence
            1.5,   // 5 — fade out
        ];

        // Callbacks to drive phase-specific visuals
        this._phaseCallbacks = {};

        // Output text IDs per agent (to update color in later rounds)
        this._outputTextIds = [[], [], []];  // [agentIdx][roundIdx] = textId

        // Resize
        this._onResize = this._handleResize.bind(this);
        window.addEventListener('resize', this._onResize);

        // Phase label element
        this._phaseLabelEl = document.getElementById('phase-label');
        this._phaseDots = Array.from(document.querySelectorAll('.phase-dot'));
        this._statusEl = document.getElementById('status-line');
    }

    // ─── Initialization ──────────────────────────────────────────────────────

    async init() {
        this.atlas = new GlyphAtlas('Monaco, Menlo, Consolas, monospace', 32, 1024);
        await this.atlas.generate();

        this.glyphCollection = new GlyphCollection(this.scene, this.atlas, {
            worldScale: 0.018,
            defaultColor: COLOR.labelColor,
        });

        this._buildNodes();
        this._buildConnections();
        this._buildOutputPanels();

        // Start at phase 0
        this._startPhase(0);

        // Kick off the loop
        this._rafId = requestAnimationFrame(t => this._tick(t));
    }

    // ─── Node construction ───────────────────────────────────────────────────

    _buildNodes() {
        for (let i = 0; i < 3; i++) {
            const agent = AGENTS[i];
            const pos = this._positions[i];

            // Core sphere
            const geo = new THREE.IcosahedronGeometry(0.72, 2);
            const mat = new THREE.MeshStandardMaterial({
                color: COLOR.nodeIdle.clone(),
                emissive: new THREE.Color(0x000000),
                roughness: 0.3,
                metalness: 0.6,
                transparent: true,
                opacity: 0,
            });
            const mesh = new THREE.Mesh(geo, mat);
            mesh.position.copy(pos);
            this.scene.add(mesh);

            // Rim glow (slightly larger wireframe shell)
            const rimGeo = new THREE.IcosahedronGeometry(0.86, 2);
            const rimMat = new THREE.MeshBasicMaterial({
                color: COLOR.nodeRim.clone(),
                wireframe: true,
                transparent: true,
                opacity: 0,
            });
            const rimMesh = new THREE.Mesh(rimGeo, rimMat);
            rimMesh.position.copy(pos);
            this.scene.add(rimMesh);

            // Agent ID label (large) — placed in front of sphere; starts invisible
            const labelId = this.glyphCollection.addText(
                agent.id,
                { x: pos.x - 0.18, y: pos.y - 0.18, z: 1.0 },
                { color: { r: 0.001, g: 0.001, b: 0.001 }, scale: 2.2 }
            );

            // Agent name label (small, below sphere); starts invisible
            const nameId = this.glyphCollection.addText(
                agent.label,
                { x: pos.x - agent.label.length * 0.15, y: pos.y - 1.4, z: 0.0 },
                { color: { r: 0.001, g: 0.001, b: 0.001 }, scale: 1.0 }
            );

            this._nodes.push({ mesh, rimMesh, mat, rimMat, labelId, nameId, outputIds: [], synthId: null, pos });
        }

        this.glyphCollection.flush();
    }

    // ─── Connection arrows ───────────────────────────────────────────────────

    _buildConnections() {
        // We need directed arrows between every pair (6 total, bidirectional)
        // Stored as [src, dst] index pairs for easy lookup
        const pairs = [
            [0, 1], [0, 2],
            [1, 0], [1, 2],
            [2, 0], [2, 1],
        ];

        for (const [src, dst] of pairs) {
            const srcPos = this._positions[src].clone();
            const dstPos = this._positions[dst].clone();

            // Shorten endpoints slightly so they don't overlap spheres
            const dir = new THREE.Vector3().subVectors(dstPos, srcPos).normalize();
            srcPos.addScaledVector(dir, 1.1);
            dstPos.addScaledVector(dir, -1.1);

            // Slight lateral offset for bidirectional pairs to avoid z-fighting
            const perp = new THREE.Vector3(-dir.y, dir.x, 0).multiplyScalar(0.12);
            srcPos.add(perp);
            dstPos.add(perp);

            const line = buildArrow(srcPos, dstPos, COLOR.connInactive, 0.4, 18);
            this.scene.add(line);

            // Build a few context packets along this arrow
            const packets = [];
            for (let p = 0; p < 3; p++) {
                const pkt = buildPacket(COLOR.connActive);
                this.scene.add(pkt);
                packets.push({ mesh: pkt, srcPos: srcPos.clone(), dstPos: dstPos.clone(), phase: p / 3 });
            }

            this._arrows.push({ line, mat: line.material, src, dst, srcPos: srcPos.clone(), dstPos: dstPos.clone(), packets });
        }
    }

    // ─── Output panels (small text boxes near each node) ─────────────────────

    _buildOutputPanels() {
        // Panels are plain THREE.Mesh rectangles that appear beside each node
        for (let i = 0; i < 3; i++) {
            const pos = this._positions[i];

            // Position to the right of each node (with adjustment for top node)
            let panelOffset;
            if (i === 0) {
                panelOffset = new THREE.Vector3(1.8, 0, -0.05);
            } else if (i === 1) {
                panelOffset = new THREE.Vector3(-3.8, 0.4, -0.05);
            } else {
                panelOffset = new THREE.Vector3(1.8, 0.4, -0.05);
            }

            // Round 0 panel
            const p0 = this._makePanelMesh(pos.clone().add(panelOffset), 0);
            this._outputPanels.push(p0);

            // Round 1 panel (slightly offset in Z)
            const r1Offset = panelOffset.clone().add(new THREE.Vector3(0, -1.2, 0.02));
            const p1 = this._makePanelMesh(pos.clone().add(r1Offset), 0);
            this._outputPanels.push(p1);

            // Round 2 synthesis panel
            const r2Offset = panelOffset.clone().add(new THREE.Vector3(0, -2.4, 0.04));
            const p2 = this._makePanelMesh(pos.clone().add(r2Offset), 0);
            this._outputPanels.push(p2);
        }
    }

    _makePanelMesh(center, opacity) {
        const geo = new THREE.PlaneGeometry(2.8, 0.85);
        const mat = new THREE.MeshBasicMaterial({
            color: 0x0d1a12,
            transparent: true,
            opacity,
            depthWrite: false,
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.copy(center);
        this.scene.add(mesh);

        // Border line
        const borderGeo = new THREE.EdgesGeometry(geo);
        const borderMat = new THREE.LineBasicMaterial({
            color: 0x002211,
            transparent: true,
            opacity: 0,
        });
        const border = new THREE.LineSegments(borderGeo, borderMat);
        border.position.copy(center);
        this.scene.add(border);

        return { mesh, mat, border, borderMat, center: center.clone() };
    }

    // ─── Phase state machine ─────────────────────────────────────────────────

    _startPhase(phase) {
        this._phase = phase;
        this._phaseT = 0;
        this._phaseStart = this._totalT;
        this._updateUI(phase);
    }

    _updateUI(phase) {
        const labels = [
            'INITIALIZING',
            'ROUND 0 — INITIAL OUTPUTS',
            'ROUND 1 — FORWARD CROSS-REFERENCE',
            'ROUND 2 — INVERSE CROSS-REFERENCE',
            'CONVERGENCE',
            'RESETTING',
        ];
        const statusLines = [
            'Three perspective agents online',
            'Each agent produces an initial analysis',
            'A reads B,C — B reads A,C — C reads A,B',
            'A reads C,B — B reads C,A — C reads B,A (with Round 1 context)',
            'All agents converge on shared understanding',
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

    // ─── Main render tick ────────────────────────────────────────────────────

    _tick(timestampMs) {
        if (this._disposed) return;
        this._rafId = requestAnimationFrame(t => this._tick(t));

        const dt = Math.min((timestampMs - (this._lastTimestamp || timestampMs)) / 1000, 0.05);
        this._lastTimestamp = timestampMs;
        this._totalT += dt;

        const phaseDur = this._phaseDurations[this._phase] || 2;
        this._phaseT = clamp01((this._totalT - this._phaseStart) / phaseDur);

        // Dispatch to per-phase update
        this._updatePhase(this._phase, this._phaseT, dt);

        // Flush any pending glyph collection updates (color/position animations)
        if (this.glyphCollection && this.glyphCollection.isDirty()) {
            this.glyphCollection.flush();
        }

        // Advance phase
        if (this._phaseT >= 1.0) {
            const nextPhase = (this._phase + 1) % this._phaseDurations.length;
            if (nextPhase === 0) {
                // Full loop restart
                this._resetVisualization();
            }
            this._startPhase(nextPhase);
        }

        // Gentle camera drift
        const drift = this._totalT * 0.07;
        this.camera.position.x = Math.sin(drift) * 1.2;
        this.camera.position.y = Math.cos(drift * 0.7) * 0.8;
        this.camera.lookAt(0, 0, 0);

        this.renderer.render(this.scene, this.camera);
    }

    // ─── Phase-specific updates ──────────────────────────────────────────────

    _updatePhase(phase, t, dt) {
        switch (phase) {
            case 0: this._updatePhase0Spawn(t); break;
            case 1: this._updatePhase1Round0(t); break;
            case 2: this._updatePhase1Forward(t, dt); break;
            case 3: this._updatePhase2Inverse(t, dt); break;
            case 4: this._updatePhase3Convergence(t); break;
            case 5: this._updatePhaseFadeOut(t); break;
        }
    }

    // Phase 0: Nodes fade in
    _updatePhase0Spawn(t) {
        const opacity = easeOut(t);

        for (const node of this._nodes) {
            node.mat.opacity = opacity;
            node.rimMat.opacity = opacity * 0.4;
        }

        // Fade in labels
        const c = opacity;
        for (const node of this._nodes) {
            // Big agent ID label
            this.glyphCollection.updateColor(node.labelId, {
                r: 0.0 * c,
                g: 0.9 * c,
                b: 0.55 * c,
            });
            // Name label fades in dim
            this.glyphCollection.updateColor(node.nameId, {
                r: COLOR.dimLabel.r * c,
                g: COLOR.dimLabel.g * c,
                b: COLOR.dimLabel.b * c,
            });
        }
    }

    // Phase 1: Round 0 — each node pulses and an output box appears
    _updatePhase1Round0(t) {
        for (let i = 0; i < 3; i++) {
            const node = this._nodes[i];
            // Stagger: agent i starts at t = i/4
            const stagger = i / 4;
            const localT = clamp01((t - stagger) / 0.6);
            const pulse = easeOut(localT);

            // Node glow
            const glow = pulse * 0.6;
            node.mat.emissive.setRGB(0, glow * 0.4, glow * 0.2);
            node.rimMat.color.setRGB(0, glow * 0.9, glow * 0.5);
            node.rimMat.opacity = 0.3 + pulse * 0.35;

            // Show output panel for round 0
            const panelIdx = i * 3;  // first panel per agent
            const panel = this._outputPanels[panelIdx];
            panel.mat.opacity = pulse * 0.85;
            panel.borderMat.opacity = pulse * 0.5;

            // Add output text once it's sufficiently visible (localT > 0.4)
            if (localT > 0.4 && node.outputIds.length === 0) {
                this._spawnOutputText(i, 0);
            }
        }
    }

    // Phase 2: Round 1 — forward cross-reference arrows
    _updatePhase1Forward(t, dt) {
        // Forward review order per agent:
        //   A(0) reads B(1) then C(2)  → arrows: 1→0, 2→0 (reading into A)
        //   B(1) reads A(0) then C(2)  → arrows: 0→1, 2→1
        //   C(2) reads A(0) then B(1)  → arrows: 0→2, 1→2
        //
        // Stagger agent groups 0.2s apart

        const forwardGroups = [
            { agent: 0, srcs: [1, 2] },
            { agent: 1, srcs: [0, 2] },
            { agent: 2, srcs: [0, 1] },
        ];

        for (let gi = 0; gi < 3; gi++) {
            const { agent, srcs } = forwardGroups[gi];
            const groupT = clamp01((t - gi * 0.22) / 0.65);

            for (let si = 0; si < srcs.length; si++) {
                const src = srcs[si];
                const arrowT = clamp01((groupT - si * 0.15) / 0.55);
                this._activateArrow(src, agent, arrowT, COLOR.connActive);
            }

            // Node pulse for the reading agent
            const node = this._nodes[agent];
            const pulse = Math.sin(groupT * Math.PI) * 0.5;
            node.mat.emissive.setRGB(0, pulse * 0.6, pulse * 0.3);
            node.rimMat.opacity = 0.25 + pulse * 0.4;

            // Spawn round 1 output text
            if (groupT > 0.7 && node.outputIds.length <= 1) {
                this._spawnOutputText(agent, 1);
            }
        }
    }

    // Phase 3: Round 2 — inverse cross-reference
    _updatePhase2Inverse(t, dt) {
        // Inverse order: A reads C then B, B reads C then A, C reads B then A
        const inverseGroups = [
            { agent: 0, srcs: [2, 1] },
            { agent: 1, srcs: [2, 0] },
            { agent: 2, srcs: [1, 0] },
        ];

        for (let gi = 0; gi < 3; gi++) {
            const { agent, srcs } = inverseGroups[gi];
            const groupT = clamp01((t - gi * 0.22) / 0.65);

            for (let si = 0; si < srcs.length; si++) {
                const src = srcs[si];
                const arrowT = clamp01((groupT - si * 0.15) / 0.55);
                this._activateArrow(src, agent, arrowT, COLOR.connInverse);
            }

            // Also show all round-1 outputs flowing in (extra packets with blue tint)
            // Done by brief flicker on the round-1 output panel
            const node = this._nodes[agent];
            const pulse = Math.sin(groupT * Math.PI) * 0.6;
            node.mat.emissive.setRGB(pulse * 0.15, pulse * 0.3, pulse * 0.6);
            node.rimMat.color.setRGB(pulse * 0.3, pulse * 0.5, 1.0);
            node.rimMat.opacity = 0.25 + pulse * 0.5;

            // Spawn synthesis text
            if (groupT > 0.75 && node.outputIds.length <= 2) {
                this._spawnOutputText(agent, 2);
            }
        }
    }

    // Phase 4: Convergence — all connections pulse green simultaneously
    _updatePhase3Convergence(t) {
        const pulse = Math.sin(t * Math.PI * 3) * 0.5 + 0.5;
        const intensity = easeOut(t) * pulse;

        for (const arrow of this._arrows) {
            const { line, mat } = arrow;
            mat.color.copy(COLOR.connActive);
            mat.opacity = 0.15 + intensity * 0.6;
            for (const pkt of arrow.packets) {
                // Convergence packets orbit randomly
                pkt.mesh.material.opacity = 0;
            }
        }

        for (const node of this._nodes) {
            const glow = intensity;
            node.mat.color.copy(COLOR.nodeIdle).lerp(COLOR.nodeActive, glow * 0.4);
            node.mat.emissive.setRGB(0, glow * 0.5, glow * 0.25);
            node.rimMat.color.copy(COLOR.connActive);
            node.rimMat.opacity = 0.2 + glow * 0.55;
        }

        // Light pulsing
        this._pointLight.intensity = 1.5 + pulse * 2.5;
        this._pointLight.color.setRGB(0, 1, 0.53);
    }

    // Phase 5: Fade everything out before loop restart
    _updatePhaseFadeOut(t) {
        const opacity = 1 - easeInOut(t);

        for (const node of this._nodes) {
            node.mat.opacity = opacity;
            node.rimMat.opacity = opacity * 0.4;
        }

        for (const arrow of this._arrows) {
            arrow.mat.opacity *= 0.92;
        }

        for (const panel of this._outputPanels) {
            panel.mat.opacity *= 0.92;
            panel.borderMat.opacity *= 0.92;
        }

        // Fade all labels toward transparent
        for (const node of this._nodes) {
            const c = opacity;
            this.glyphCollection.updateColor(node.labelId, {
                r: 0.0,
                g: 0.9 * c,
                b: 0.55 * c,
            });
            this.glyphCollection.updateColor(node.nameId, {
                r: COLOR.dimLabel.r * c,
                g: COLOR.dimLabel.g * c,
                b: COLOR.dimLabel.b * c,
            });
        }

        this._pointLight.intensity = lerp(1.5, 0.5, t);
        this._pointLight.color.setRGB(0, 1, 0.53);
    }

    // ─── Arrow activation ─────────────────────────────────────────────────────

    /**
     * Activate (fade in + animate packets) the arrow from src to dst.
     * @param {number} src - agent index
     * @param {number} dst - agent index
     * @param {number} t   - local 0→1 progress
     * @param {THREE.Color} color
     */
    _activateArrow(src, dst, t, color) {
        const arrow = this._arrows.find(a => a.src === src && a.dst === dst);
        if (!arrow) return;

        // Fade in the line
        arrow.mat.color.copy(color);
        arrow.mat.opacity = easeOut(t) * 0.55;

        // Animate packets along the arrow
        for (let p = 0; p < arrow.packets.length; p++) {
            const pkt = arrow.packets[p];
            const pktPhase = (pkt.phase + t * 1.2) % 1.0;
            if (pktPhase < 0.85) {
                pkt.mesh.position.lerpVectors(arrow.srcPos, arrow.dstPos, pktPhase);
                pkt.mesh.material.color.copy(color);
                pkt.mesh.material.opacity = easeOut(t) * 0.9 * Math.sin(pktPhase * Math.PI);
            } else {
                pkt.mesh.material.opacity = 0;
            }
        }
    }

    // ─── Output text spawning ─────────────────────────────────────────────────

    /**
     * Spawn a glyph text entry for agent[agentIdx]'s output at round[roundIdx].
     */
    _spawnOutputText(agentIdx, roundIdx) {
        const agent = AGENTS[agentIdx];
        const node = this._nodes[agentIdx];
        const panel = this._outputPanels[agentIdx * 3 + roundIdx];

        let text, color;
        if (roundIdx === 0) {
            text = agent.snippets[0];
            color = COLOR.outputColor;
        } else if (roundIdx === 1) {
            text = agent.snippets[1];
            color = { r: 0.3, g: 0.65, b: 0.45 };
        } else {
            text = agent.synthSnippet;
            color = COLOR.synthColor;
        }

        // Place text slightly in front of the panel
        const textPos = {
            x: panel.center.x - 1.2,
            y: panel.center.y + 0.18,
            z: panel.center.z + 0.01,
        };

        const textId = this.glyphCollection.addText(text, textPos, {
            color,
            scale: 0.75,
        });

        this.glyphCollection.flush();
        node.outputIds.push(textId);
    }

    // ─── Reset for loop ───────────────────────────────────────────────────────

    _resetVisualization() {
        // Remove spawned output texts
        for (const node of this._nodes) {
            for (const id of node.outputIds) {
                this.glyphCollection.removeText(id);
            }
            node.outputIds = [];
        }
        this.glyphCollection.flush();

        // Reset arrow opacities
        for (const arrow of this._arrows) {
            arrow.mat.opacity = 0;
            arrow.mat.color.set(COLOR.connInactive);
            for (const pkt of arrow.packets) {
                pkt.mesh.material.opacity = 0;
            }
        }

        // Reset panels
        for (const panel of this._outputPanels) {
            panel.mat.opacity = 0;
            panel.borderMat.opacity = 0;
        }

        // Reset nodes
        for (const node of this._nodes) {
            node.mat.opacity = 0;
            node.mat.emissive.setRGB(0, 0, 0);
            node.mat.color.copy(COLOR.nodeIdle);
            node.rimMat.opacity = 0;

            // Reset labels to near-invisible so phase 0 can fade them in
            this.glyphCollection.updateColor(node.labelId, { r: 0.001, g: 0.001, b: 0.001 });
            this.glyphCollection.updateColor(node.nameId, { r: 0.001, g: 0.001, b: 0.001 });
        }

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
