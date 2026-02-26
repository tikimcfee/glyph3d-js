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
 * @typedef {Object} Viewport
 * @property {number} fovHorizontal - Horizontal field of view in radians
 * @property {number} fovVertical - Vertical field of view in radians
 * @property {number} aspectRatio - Width / height
 * @property {number} physicalWidth - Meters visible at 1m depth
 * @property {number} physicalHeight - Meters visible at 1m depth
 * @property {[number, number]} depthRange - [minZ, maxZ] depth bounds in meters
 *
 * NOTE on depthRange:
 * This should represent the camera's stable tracking volume, NOT the current
 * hand position. If computed from live hand landmark Z values, it will
 * breathe with the hand (shrink/grow as the hand moves), causing the
 * viewport frustum to wobble.
 *
 * Preferred approach on the iOS side:
 * - Use a slow-expanding high-water-mark: track the min/max Z ever observed,
 *   only expand the range, never shrink it. This converges to the camera's
 *   effective tracking range over a few seconds of use.
 * - Or use a static/calibrated range based on ARKit's effective hand
 *   tracking distance (typically ~0.2m to ~0.8m for iPhone).
 *
 * The JS ViewportRenderer applies a high-water-mark as a stopgap, but
 * cleaner data from the source is preferred.
 */

/**
 * @typedef {Object} SceneContext
 * @property {{fx: number, fy: number, cx: number, cy: number}} intrinsics - Camera intrinsics
 * @property {[number, number]} imageResolution - [width, height] in pixels
 * @property {number[][]} cameraTransform - 4x4 column-major matrix (4 arrays of 4 floats)
 * @property {string} trackingState - 'normal', 'limited', 'notAvailable'
 * @property {number} lightIntensity - Ambient light estimate in lumens
 * @property {Viewport} viewport - Camera frustum and observed depth bounds
 */

/**
 * @typedef {Object} CameraFrame
 * @property {string} image - Base64-encoded JPEG
 * @property {number} width - Image width in pixels
 * @property {number} height - Image height in pixels
 * @property {number} timestamp - Frame timestamp
 * @property {string} [orientation] - Device orientation hint
 */

/**
 * @typedef {Object} HandFrame
 * @property {string} handedness - 'left' or 'right'
 * @property {Array<{x: number, y: number, z: number}>} landmarks - 21 joint positions
 * @property {number} timestamp - Frame timestamp in ms
 * @property {SceneContext} [scene] - Camera/scene context if available
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
