/**
 * Hand Data Model
 *
 * Shared data types and constants for hand tracking.
 * Defines the canonical 21-joint format that all hand sources produce
 * and all consumers (renderer, gesture detector) expect.
 *
 * This is the contract between capture (webcam/iPhone/mock) and rendering.
 * Both MediaPipe and ARKit can map to this model.
 */

// 21-landmark hand model (MediaPipe standard)
export const Joint = {
    WRIST: 0,
    THUMB_CMC: 1,
    THUMB_MCP: 2,
    THUMB_IP: 3,
    THUMB_TIP: 4,
    INDEX_MCP: 5,
    INDEX_PIP: 6,
    INDEX_DIP: 7,
    INDEX_TIP: 8,
    MIDDLE_MCP: 9,
    MIDDLE_PIP: 10,
    MIDDLE_DIP: 11,
    MIDDLE_TIP: 12,
    RING_MCP: 13,
    RING_PIP: 14,
    RING_DIP: 15,
    RING_TIP: 16,
    PINKY_MCP: 17,
    PINKY_PIP: 18,
    PINKY_DIP: 19,
    PINKY_TIP: 20,
};

export const JOINT_COUNT = 21;

/**
 * Skeleton connections for wireframe rendering.
 * Each pair is [startJointIndex, endJointIndex].
 */
export const SKELETON_CONNECTIONS = [
    // Thumb
    [Joint.WRIST, Joint.THUMB_CMC],
    [Joint.THUMB_CMC, Joint.THUMB_MCP],
    [Joint.THUMB_MCP, Joint.THUMB_IP],
    [Joint.THUMB_IP, Joint.THUMB_TIP],
    // Index
    [Joint.WRIST, Joint.INDEX_MCP],
    [Joint.INDEX_MCP, Joint.INDEX_PIP],
    [Joint.INDEX_PIP, Joint.INDEX_DIP],
    [Joint.INDEX_DIP, Joint.INDEX_TIP],
    // Middle
    [Joint.WRIST, Joint.MIDDLE_MCP],
    [Joint.MIDDLE_MCP, Joint.MIDDLE_PIP],
    [Joint.MIDDLE_PIP, Joint.MIDDLE_DIP],
    [Joint.MIDDLE_DIP, Joint.MIDDLE_TIP],
    // Ring
    [Joint.WRIST, Joint.RING_MCP],
    [Joint.RING_MCP, Joint.RING_PIP],
    [Joint.RING_PIP, Joint.RING_DIP],
    [Joint.RING_DIP, Joint.RING_TIP],
    // Pinky
    [Joint.WRIST, Joint.PINKY_MCP],
    [Joint.PINKY_MCP, Joint.PINKY_PIP],
    [Joint.PINKY_PIP, Joint.PINKY_DIP],
    [Joint.PINKY_DIP, Joint.PINKY_TIP],
    // Palm cross-connections
    [Joint.INDEX_MCP, Joint.MIDDLE_MCP],
    [Joint.MIDDLE_MCP, Joint.RING_MCP],
    [Joint.RING_MCP, Joint.PINKY_MCP],
];

/**
 * Finger groupings for gesture analysis.
 * Each array lists joints from base to tip.
 */
export const Finger = {
    THUMB: [Joint.THUMB_CMC, Joint.THUMB_MCP, Joint.THUMB_IP, Joint.THUMB_TIP],
    INDEX: [Joint.INDEX_MCP, Joint.INDEX_PIP, Joint.INDEX_DIP, Joint.INDEX_TIP],
    MIDDLE: [Joint.MIDDLE_MCP, Joint.MIDDLE_PIP, Joint.MIDDLE_DIP, Joint.MIDDLE_TIP],
    RING: [Joint.RING_MCP, Joint.RING_PIP, Joint.RING_DIP, Joint.RING_TIP],
    PINKY: [Joint.PINKY_MCP, Joint.PINKY_PIP, Joint.PINKY_DIP, Joint.PINKY_TIP],
};

/**
 * @typedef {Object} HandFrame
 * @property {string} handedness - 'left' or 'right'
 * @property {Array<{x: number, y: number, z: number}>} landmarks - 21 joint positions (normalized 0-1)
 * @property {number} timestamp - Frame timestamp in ms
 */

/**
 * Create an empty hand frame with zeroed landmarks
 * @param {string} handedness
 * @returns {HandFrame}
 */
export function createEmptyFrame(handedness = 'right') {
    const landmarks = [];
    for (let i = 0; i < JOINT_COUNT; i++) {
        landmarks.push({ x: 0, y: 0, z: 0 });
    }
    return { handedness, landmarks, timestamp: 0 };
}

/**
 * Euclidean distance between two landmark points
 * @param {{x: number, y: number, z: number}} a
 * @param {{x: number, y: number, z: number}} b
 * @returns {number}
 */
export function landmarkDistance(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
