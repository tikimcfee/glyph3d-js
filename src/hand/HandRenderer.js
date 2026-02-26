/**
 * Hand Renderer
 *
 * Renders a wireframe hand skeleton in Three.js from HandFrame data.
 * Uses LineSegments for bones and Points for joints.
 * Designed to be attached to a camera so the hand stays in view.
 */

import * as THREE from 'three';
import { SKELETON_CONNECTIONS, JOINT_COUNT } from './HandData.js';

class HandRenderer {
    /**
     * @param {Object} options
     * @param {number} options.lineColor - Hex color for skeleton lines
     * @param {number} options.jointColor - Hex color for joint points
     * @param {number} options.jointSize - Point size for joints
     * @param {number} options.spread - How wide the hand maps in camera space
     * @param {number} options.depth - Base distance in front of camera (negative = in front)
     * @param {number} options.scale - Overall scale factor
     */
    constructor(options = {}) {
        this.lineColor = options.lineColor || 0x00ff88;
        this.jointColor = options.jointColor || 0x00ffcc;
        this.jointSize = options.jointSize || 0.015;
        this.spread = options.spread || 0.4;
        this.depth = options.depth || -0.8;
        this.scale = options.scale || 0.5;

        this.group = new THREE.Group();
        this.hands = new Map(); // handedness -> { group, lines, joints }

        // Pre-build right hand (most common)
        this._buildHand('right');
    }

    /**
     * Build geometry for one hand
     * @param {string} handedness
     */
    _buildHand(handedness) {
        const handGroup = new THREE.Group();

        // Line segments for skeleton bones
        const segmentCount = SKELETON_CONNECTIONS.length;
        const linePositions = new Float32Array(segmentCount * 2 * 3);
        const lineGeometry = new THREE.BufferGeometry();
        lineGeometry.setAttribute('position', new THREE.BufferAttribute(linePositions, 3));

        const lineMaterial = new THREE.LineBasicMaterial({
            color: this.lineColor,
            transparent: true,
            opacity: 0.85,
        });
        const lines = new THREE.LineSegments(lineGeometry, lineMaterial);
        handGroup.add(lines);

        // Points for joints
        const jointPositions = new Float32Array(JOINT_COUNT * 3);
        const jointGeometry = new THREE.BufferGeometry();
        jointGeometry.setAttribute('position', new THREE.BufferAttribute(jointPositions, 3));

        const jointMaterial = new THREE.PointsMaterial({
            color: this.jointColor,
            size: this.jointSize,
            sizeAttenuation: true,
        });
        const joints = new THREE.Points(jointGeometry, jointMaterial);
        handGroup.add(joints);

        handGroup.visible = false;
        this.group.add(handGroup);

        this.hands.set(handedness, { group: handGroup, lines, joints });
    }

    /**
     * Attach the hand renderer as a child of the camera.
     * This makes the hand move with the camera automatically.
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
     * Update hand rendering from a HandFrame.
     * @param {HandFrame|null} frame - Hand data, or null to hide
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

        // Map normalized landmarks to camera-local 3D coordinates
        const mapped = this._mapLandmarks(landmarks);

        // Update joint positions
        const jointArr = hand.joints.geometry.attributes.position.array;
        for (let i = 0; i < JOINT_COUNT; i++) {
            jointArr[i * 3] = mapped[i].x;
            jointArr[i * 3 + 1] = mapped[i].y;
            jointArr[i * 3 + 2] = mapped[i].z;
        }
        hand.joints.geometry.attributes.position.needsUpdate = true;

        // Update line segment positions
        const lineArr = hand.lines.geometry.attributes.position.array;
        for (let i = 0; i < SKELETON_CONNECTIONS.length; i++) {
            const [a, b] = SKELETON_CONNECTIONS[i];
            const off = i * 6;
            lineArr[off] = mapped[a].x;
            lineArr[off + 1] = mapped[a].y;
            lineArr[off + 2] = mapped[a].z;
            lineArr[off + 3] = mapped[b].x;
            lineArr[off + 4] = mapped[b].y;
            lineArr[off + 5] = mapped[b].z;
        }
        hand.lines.geometry.attributes.position.needsUpdate = true;
    }

    /**
     * Map landmarks to camera-local 3D space.
     * Sources provide first-person-corrected data with z > 0 meaning
     * "reaching deeper into the scene."
     * @param {Array<{x,y,z}>} landmarks
     * @returns {Array<{x,y,z}>}
     */
    _mapLandmarks(landmarks) {
        const { spread, depth, scale } = this;

        return landmarks.map(lm => ({
            x: (lm.x - 0.5) * spread * scale,
            y: (0.5 - lm.y) * spread * scale,
            // depth is negative (in front of camera). Subtract z to go deeper.
            z: depth - (lm.z || 0) * scale,
        }));
    }

    /**
     * Set line color (e.g., change color on pinch)
     * @param {number} color - Hex color
     */
    setColor(color) {
        this.hands.forEach(hand => {
            hand.lines.material.color.set(color);
        });
    }

    /**
     * Set joint color
     * @param {number} color - Hex color
     */
    setJointColor(color) {
        this.hands.forEach(hand => {
            hand.joints.material.color.set(color);
        });
    }

    /**
     * Cleanup GPU resources
     */
    dispose() {
        this.hands.forEach(hand => {
            hand.lines.geometry.dispose();
            hand.lines.material.dispose();
            hand.joints.geometry.dispose();
            hand.joints.material.dispose();
        });
        this.detach();
    }
}

export default HandRenderer;
