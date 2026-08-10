/**
 * Hand Renderer
 *
 * Renders a 3D hand skeleton in Three.js from HandFrame data.
 * Uses shaded cylinders for bones and spheres for joints,
 * giving depth cues through lighting and perspective.
 * Designed to be attached to a camera so the hand stays in view.
 */

import * as THREE from 'three';
import { Joint, SKELETON_CONNECTIONS, JOINT_COUNT } from './HandData.js';
import { HAND_RENDERER_DEFAULTS as DEFAULTS } from './defaults.js';
import { RENDER_ORDER } from '../core/renderOrder.js';

// Shared geometries — created once, reused across all hands
const BONE_GEOMETRY = new THREE.CylinderGeometry(1, 1, 1, 6, 1);
// Shift cylinder so base is at origin, extends along +Y
BONE_GEOMETRY.translate(0, 0.5, 0);

const JOINT_GEOMETRY = new THREE.IcosahedronGeometry(1, 1);

// Palm surface: 6 vertices forming the palm outline,
// triangulated as a fan from the wrist.
const PALM_JOINTS = [
    Joint.WRIST,       // 0 — fan origin
    Joint.THUMB_CMC,   // 1
    Joint.INDEX_MCP,   // 2
    Joint.MIDDLE_MCP,  // 3
    Joint.RING_MCP,    // 4
    Joint.PINKY_MCP,   // 5
];

const PALM_INDICES = new Uint16Array([
    0, 1, 2,   // wrist → thumb CMC → index MCP
    0, 2, 3,   // wrist → index MCP → middle MCP
    0, 3, 4,   // wrist → middle MCP → ring MCP
    0, 4, 5,   // wrist → ring MCP → pinky MCP
]);

// Reusable math objects to avoid per-frame allocations
const _vecA = new THREE.Vector3();
const _vecB = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _quat = new THREE.Quaternion();

class HandRenderer {
    /**
     * @param {Object} options
     * @param {number} options.lineColor - Hex color for bones
     * @param {number} options.jointColor - Hex color for joints
     * @param {number} options.jointSize - Radius for joint spheres
     * @param {number} options.boneRadius - Radius for bone cylinders
     * @param {number} options.spread - How wide the hand maps in camera space
     * @param {number} options.depth - Base distance in front of camera
     * @param {number} options.scale - Overall scale factor
     */
    constructor(options = {}) {
        const o = { ...DEFAULTS, ...options };
        this.lineColor  = o.lineColor;
        this.jointColor = o.jointColor;
        this.jointSize  = o.jointSize;
        this.boneRadius = o.boneRadius;

        // Placement params — applied to the group transform, NOT per-landmark.
        // This preserves the hand's raw proportions in all axes.
        this._spread   = o.spread;
        this._depth    = o.depth;
        this._scale    = o.scale;
        this._yaw      = o.yaw;
        this._coverage = o.coverage;

        // Visible frustum half-extents at `depth`, in rig-local units — fed per
        // frame by HandPresence (fov/aspect are live). The wrist anchor maps the
        // device's 0..1 tracking range onto this rect × coverage, so the hand
        // traverses the canvas regardless of its own size. Null until a camera
        // owner feeds it; the fallback keeps headless/demo use sane.
        this.viewExtent = null;

        this.group = new THREE.Group();
        this._applyGroupTransform();
        this.hands = new Map();

        // Add a light rig as part of the hand group so it moves with the camera.
        // Hemisphere light gives soft top/bottom differentiation.
        const hemi = new THREE.HemisphereLight(0xffffff, 0x444466, 1.2);
        this.group.add(hemi);
        // Point light near the camera position for specular highlights
        const point = new THREE.PointLight(0xffffff, 0.6, 5);
        point.position.set(0, 0.1, 0);
        this.group.add(point);

        this._buildHand('right');
    }

    /**
     * Build bone and joint meshes for one hand
     * @param {string} handedness
     */
    _buildHand(handedness) {
        const handGroup = new THREE.Group();

        // Bone material — slightly emissive for glow, metallic for depth cues
        const boneMaterial = new THREE.MeshStandardMaterial({
            color: this.lineColor,
            emissive: this.lineColor,
            emissiveIntensity: 0.2,
            roughness: 0.5,
            metalness: 0.4,
        });

        // Joint material — brighter, more emissive
        const jointMaterial = new THREE.MeshStandardMaterial({
            color: this.jointColor,
            emissive: this.jointColor,
            emissiveIntensity: 0.3,
            roughness: 0.3,
            metalness: 0.5,
        });

        // Palm surface — triangle fan from wrist through MCP joints.
        // Renders as an occluding surface behind the finger bones.
        const palmMaterial = new THREE.MeshStandardMaterial({
            color: this.lineColor,
            emissive: this.lineColor,
            emissiveIntensity: 0.15,
            roughness: 0.6,
            metalness: 0.3,
            side: THREE.DoubleSide,
            // Polygon offset pushes palm slightly toward camera,
            // winning depth test over bones/joints at shared vertices
            polygonOffset: true,
            polygonOffsetFactor: -1,
            polygonOffsetUnits: -1,
        });

        const palmPositions = new Float32Array(PALM_JOINTS.length * 3);
        const palmGeometry = new THREE.BufferGeometry();
        palmGeometry.setAttribute('position', new THREE.BufferAttribute(palmPositions, 3));
        palmGeometry.setIndex(new THREE.BufferAttribute(PALM_INDICES, 1));

        const palmMesh = new THREE.Mesh(palmGeometry, palmMaterial);
        palmMesh.visible = false;
        handGroup.add(palmMesh);

        // Create a cylinder mesh for each bone connection
        const bones = [];
        for (let i = 0; i < SKELETON_CONNECTIONS.length; i++) {
            const mesh = new THREE.Mesh(BONE_GEOMETRY, boneMaterial);
            mesh.visible = false;
            mesh.renderOrder = RENDER_ORDER.HAND_BONE;
            handGroup.add(mesh);
            bones.push(mesh);
        }

        // Create a sphere mesh for each joint
        const joints = [];
        for (let i = 0; i < JOINT_COUNT; i++) {
            const mesh = new THREE.Mesh(JOINT_GEOMETRY, jointMaterial);
            mesh.visible = false;
            mesh.renderOrder = RENDER_ORDER.HAND_JOINT;
            handGroup.add(mesh);
            joints.push(mesh);
        }

        handGroup.visible = false;
        this.group.add(handGroup);

        this.hands.set(handedness, {
            group: handGroup,
            bones,
            joints,
            palm: palmMesh,
            palmGeometry,
            boneMaterial,
            jointMaterial,
            palmMaterial,
        });
    }

    /**
     * Place the group on the depth plane. Yaw and size apply PER HAND in
     * `updateFromFrame` — each hand turns and scales about its own anchor, so
     * traversal across the canvas never mirrors or displaces through a shared
     * group rotation.
     * @private
     */
    _applyGroupTransform() {
        this.group.position.set(0, 0, this._depth);
    }

    /** @type {number} */
    get spread() { return this._spread; }
    set spread(v) { this._spread = v; }

    /** Yaw about the hand's own Y axis, in DEGREES. @type {number} */
    get yaw() { return this._yaw; }
    set yaw(v) { this._yaw = v; }

    /** @type {number} */
    get depth() { return this._depth; }
    set depth(v) { this._depth = v; this._applyGroupTransform(); }

    /** @type {number} */
    get scale() { return this._scale; }
    set scale(v) { this._scale = v; }

    /** Fraction of the visible canvas the wrist anchor traverses. @type {number} */
    get coverage() { return this._coverage; }
    set coverage(v) { this._coverage = v; }

    /**
     * Parent the hand under `parent`, whose space is treated as camera-local:
     * `depth` places the hand along -Z from the parent's origin.
     *
     * NOT the camera itself. `renderer.render(scene, camera)` only traverses the
     * SCENE, so anything parented to a camera that isn't in the scene graph
     * updates every frame and is never drawn — invisible with no error. Pass a
     * rig that lives in the scene and follows the camera (see HandPresence).
     *
     * @param {THREE.Object3D} parent
     */
    attachTo(parent) {
        parent.add(this.group);
    }

    /**
     * Remove from parent
     */
    detach() {
        if (this.group.parent) {
            this.group.parent.remove(this.group);
        }
    }

    /**
     * Update hand from a HandFrame
     * @param {HandFrame|null} frame
     */
    updateFromFrame(frame) {
        if (!frame) {
            this.hands.forEach(h => (h.group.visible = false));
            return;
        }

        const handedness = frame.handedness || 'right';
        if (!this.hands.has(handedness)) {
            this._buildHand(handedness);
        }

        const hand = this.hands.get(handedness);
        hand.group.visible = true;

        const landmarks = frame.landmarks;
        if (!landmarks || landmarks.length < JOINT_COUNT) {
            // Silent-drop guard. A short frame renders nothing at all, which looks
            // identical to "no device connected" — the single most confusing
            // failure in this pipeline. Warn once per renderer rather than per
            // frame, since a mismatched source would storm at 30fps.
            if (!this._warnedShortFrame) {
                this._warnedShortFrame = true;
                console.warn(`[hand] frames carry ${landmarks?.length ?? 0} landmarks, need ${JOINT_COUNT} — nothing will draw`);
            }
            return;
        }

        this._lastFrame = frame;

        // Anchor and shape are separate: the WRIST maps the device's 0..1
        // tracking range onto the visible canvas rect at `depth` (× coverage),
        // while the skeleton is wrist-relative and sized by spread × scale.
        // Traversal reaches entities anywhere on screen; hand size stays a
        // taste dial that no longer shrinks the reachable region with it.
        const wrist = landmarks[Joint.WRIST] || landmarks[0];
        if (!wrist || (wrist.x === 0 && wrist.y === 0 && wrist.z === 0)) {
            // No wrist, no anchor — an untracked wrist would slam the hand into
            // a corner. Hiding reads as "lost tracking", which is the truth.
            hand.group.visible = false;
            return;
        }
        const { anchor, shape } = this._splitLandmarks(landmarks, wrist);
        const mapped = shape;
        this._lastMapped = mapped;
        this._lastAnchor = anchor;

        const ext = this.viewExtent || { halfW: 0.5, halfH: 0.5 };
        hand.group.position.set(
            anchor.x * 2 * ext.halfW * this._coverage,
            anchor.y * 2 * ext.halfH * this._coverage,
            0,
        );
        // Yaw is a ROTATION, never a mirror: the skeleton keeps its chirality, we
        // just view it from the other side. At 180° the palms face away from the
        // viewer — the hands read as your own, reaching into the scene, rather
        // than as someone else's hands facing you. Applied about the hand's own
        // anchor, so it never displaces the hand across the canvas.
        hand.group.rotation.y = (this._yaw * Math.PI) / 180;
        hand.group.scale.setScalar(this._spread * this._scale);

        // Build validity mask — landmark at default (0,0,0) means untracked
        const valid = new Uint8Array(JOINT_COUNT);
        for (let i = 0; i < JOINT_COUNT; i++) {
            const lm = landmarks[i];
            valid[i] = (lm.x !== 0 || lm.y !== 0 || lm.z !== 0) ? 1 : 0;
        }

        // Update palm — only show if all palm joints are valid
        let palmValid = true;
        const palmArr = hand.palmGeometry.attributes.position.array;
        for (let i = 0; i < PALM_JOINTS.length; i++) {
            const ji = PALM_JOINTS[i];
            if (!valid[ji]) { palmValid = false; break; }
            palmArr[i * 3] = mapped[ji].x;
            palmArr[i * 3 + 1] = mapped[ji].y;
            palmArr[i * 3 + 2] = mapped[ji].z;
        }
        hand.palm.visible = palmValid;
        if (palmValid) {
            hand.palmGeometry.attributes.position.needsUpdate = true;
            hand.palmGeometry.computeVertexNormals();
        }

        // Update joint spheres — skip untracked
        for (let i = 0; i < JOINT_COUNT; i++) {
            const joint = hand.joints[i];
            if (!valid[i]) { joint.visible = false; continue; }
            joint.visible = true;
            joint.position.set(mapped[i].x, mapped[i].y, mapped[i].z);
            joint.scale.setScalar(this.jointSize);
        }

        // Update bone cylinders — skip if either endpoint is untracked
        for (let i = 0; i < SKELETON_CONNECTIONS.length; i++) {
            const [a, b] = SKELETON_CONNECTIONS[i];
            const bone = hand.bones[i];

            if (!valid[a] || !valid[b]) { bone.visible = false; continue; }
            bone.visible = true;

            _vecA.set(mapped[a].x, mapped[a].y, mapped[a].z);
            _vecB.set(mapped[b].x, mapped[b].y, mapped[b].z);

            _dir.subVectors(_vecB, _vecA);
            const length = _dir.length();

            if (length < 0.0001) {
                bone.visible = false;
                continue;
            }

            // Position at start point (geometry is translated so base is at origin)
            bone.position.copy(_vecA);

            // Scale: radius on X/Z, length on Y
            bone.scale.set(this.boneRadius, length, this.boneRadius);

            // Orient cylinder from default Y-up to bone direction
            _dir.normalize();
            _quat.setFromUnitVectors(_up, _dir);
            bone.quaternion.copy(_quat);
        }
    }

    /**
     * Map landmarks to local hand space.
     * Centers x/y around origin and flips y for Three.js convention.
     * No spread/depth/scale — those are on the group transform,
     * preserving the hand's raw proportions uniformly.
     * @param {Array<{x,y,z}>} landmarks
     * @returns {Array<{x,y,z}>}
     */
    _splitLandmarks(landmarks, wrist) {
        // Anchor: wrist in centered normalized device coords, ±0.5 at the
        // tracking edges. Y flips (device y grows downward); z stays in the
        // shape so depth wiggle scales with the hand, not the canvas.
        const anchor = {
            x: wrist.x - 0.5,
            y: 0.5 - wrist.y,
            z: 0,
        };
        // Shape: wrist-relative skeleton, raw proportions preserved.
        const shape = landmarks.map(lm => ({
            x: lm.x - wrist.x,
            y: wrist.y - lm.y,
            z: -(lm.z || 0),
        }));
        return { anchor, shape };
    }

    /**
     * Set bone color
     * @param {number} color
     */
    setColor(color) {
        this.hands.forEach(hand => {
            hand.boneMaterial.color.set(color);
            hand.boneMaterial.emissive.set(color);
            hand.palmMaterial.color.set(color);
            hand.palmMaterial.emissive.set(color);
        });
    }

    /**
     * Set joint color
     * @param {number} color
     */
    setJointColor(color) {
        this.hands.forEach(hand => {
            hand.jointMaterial.color.set(color);
            hand.jointMaterial.emissive.set(color);
        });
    }

    /**
     * Cleanup GPU resources
     */
    dispose() {
        this.hands.forEach(hand => {
            hand.boneMaterial.dispose();
            hand.jointMaterial.dispose();
            hand.palmMaterial.dispose();
            hand.palmGeometry.dispose();
        });
        this.detach();
    }
}

export default HandRenderer;
