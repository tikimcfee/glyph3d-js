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
        this._spread = o.spread;
        this._depth  = o.depth;
        this._scale  = o.scale;

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
     * Apply spread/depth/scale to the group transform.
     * This positions and scales the hand as a whole without
     * distorting the raw landmark proportions.
     * @private
     */
    _applyGroupTransform() {
        this.group.position.set(0, 0, this._depth);
        const s = this._spread * this._scale;
        this.group.scale.set(s, s, s);
    }

    /** @type {number} */
    get spread() { return this._spread; }
    set spread(v) { this._spread = v; this._applyGroupTransform(); }

    /** @type {number} */
    get depth() { return this._depth; }
    set depth(v) { this._depth = v; this._applyGroupTransform(); }

    /** @type {number} */
    get scale() { return this._scale; }
    set scale(v) { this._scale = v; this._applyGroupTransform(); }

    /**
     * Attach as a child of the camera
     * @param {THREE.Camera} camera
     */
    attachToCamera(camera) {
        camera.add(this.group);
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
        if (!landmarks || landmarks.length < JOINT_COUNT) return;

        const mapped = this._mapLandmarks(landmarks);

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
    _mapLandmarks(landmarks) {
        return landmarks.map(lm => ({
            x: lm.x - 0.5,
            y: 0.5 - lm.y,
            z: -(lm.z || 0),
        }));
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
