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
 * @property {Array<{x: number, y: number, z: number}>} landmarks - 21 joint positions,
 *   image space: normalized u, v and depth (v1; still sent by v2 devices)
 * @property {Array<{x: number, y: number, z: number}|null>|null} points - v2: 21 joints in
 *   METERS in the device's PHONE frame (+y toward its top edge, +z out of its back, +x = y × z);
 *   null for a joint not seen this frame; the whole field null from a v1 device
 * @property {number[]|null} confidence - v2: per-joint 0..1; null from a v1 device
 * @property {Array<{x: number, y: number, z: number}|null>|null} rays - v2: the unit direction
 *   from the optical centre (the PHONE frame's origin) to each joint seen in 2-D, depth or not;
 *   a joint with a ray and a null point was detected but has no usable depth
 * @property {Object|null} cloud - v2: the phone's raw per-hand depth crop (hand/cloud/depthWire.js), undecoded
 * @property {number} timestamp - Frame timestamp (the device's clock)
 * @property {SceneContext} [scene] - Camera/scene context if available
 */

/**
 * What a v2 device says about itself on every frame — hand or not.
 * @typedef {Object} DeviceState
 * @property {number} v - Wire version
 * @property {'faceDown'|'faceUp'|'upright'|'unknown'} mount - How the phone lies, from gravity
 * @property {[number, number, number]|null} gravity - Unit vector, PHONE frame
 * @property {[number, number, number, number]|null} attitude - CoreMotion quaternion [x, y, z, w]
 * @property {[number, number, number]|null} userAcceleration - m/s², gravity removed, PHONE frame
 *   (the latest 100 Hz CoreMotion sample — a point sample, not a peak)
 * @property {number|null} ceiling - Meters along +z to the static scene outside the hands
 * @property {number} timestamp - Capture time, seconds, device monotonic clock
 * @property {number|null} sentAt - Send time on the same clock (capture → send = sentAt − timestamp)
 */

const MOUNTS = new Set(['faceDown', 'faceUp', 'upright', 'unknown']);

/** A finite [x, y, z] tuple, or null. */
const vec3OrNull = (a) => (Array.isArray(a) && a.length >= 3 && a.slice(0, 3).every(Number.isFinite)
    ? [a[0], a[1], a[2]] : null);

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

/**
 * Decode a device `handFrame` payload into canonical HandFrames.
 *
 * This is the wire contract with the capture device (MotionSource on iOS today):
 * landmarks arrive as `[x, y, z]` tuples, and the ARKit `scene` block rides along
 * on the same message. Decoding is a pure function of the payload so it can be
 * unit-tested without a socket and reused by any transport — the network side
 * owns delivery, this owns meaning.
 *
 * `scene` is optional per-message: a device may send it once and omit it after,
 * so callers pass the last-known scene as `carriedScene` to keep every frame
 * self-contained for downstream consumers.
 *
 * v2 (hand-wire v2, the face-down phone) adds metric `points` + `confidence` per hand and a
 * `device` block on every frame — `hands: []` frames included, so presence, mount and ceiling
 * are known before a hand shows up. A v1 payload decodes with `points`/`confidence` null and
 * `device` null.
 *
 * @param {Object} payload - The device message (must be type `handFrame`)
 * @param {SceneContext|null} [carriedScene] - Last-known scene, used when the payload omits one
 * @returns {{frames: HandFrame[], scene: SceneContext|null, device: DeviceState|null}|null} null if not a hand frame
 */
export function decodeHandFrame(payload, carriedScene = null) {
    if (!payload || payload.type !== 'handFrame' || !Array.isArray(payload.hands)) return null;

    const scene = payload.scene || carriedScene || null;
    const timestamp = typeof payload.timestamp === 'number' ? payload.timestamp : 0;

    const frames = payload.hands.map((hand) => {
        const raw = Array.isArray(hand?.landmarks) ? hand.landmarks : [];
        const landmarks = raw.map((lm) => (
            Array.isArray(lm)
                ? { x: lm[0] || 0, y: lm[1] || 0, z: lm[2] || 0 }
                : { x: lm?.x || 0, y: lm?.y || 0, z: lm?.z || 0 }
        ));
        // A null joint stays null — "not seen" is a measurement, never a zero.
        const points = Array.isArray(hand?.points)
            ? hand.points.map((p) => {
                const v = vec3OrNull(p);
                return v ? { x: v[0], y: v[1], z: v[2] } : null;
            })
            : null;
        const confidence = Array.isArray(hand?.confidence)
            ? hand.confidence.map((c) => (Number.isFinite(c) ? c : 0))
            : null;
        const rays = Array.isArray(hand?.rays)
            ? hand.rays.map((r) => {
                const v = vec3OrNull(r);
                const l = v ? Math.hypot(v[0], v[1], v[2]) : 0;
                return l > 0 ? { x: v[0] / l, y: v[1] / l, z: v[2] / l } : null;
            })
            : null;
        // The phone's raw per-hand depth crop rides along undecoded; the cloud tracker (hand/cloud/)
        // decodes it lazily — nothing else reads it.
        const frame = { handedness: hand?.handedness || 'right', landmarks, points, confidence, rays, cloud: hand?.cloud ?? null, timestamp };
        if (scene) frame.scene = scene;
        return frame;
    });

    let device = null;
    if (payload.v >= 2) {
        const att = payload.device?.attitude;
        device = {
            v: payload.v,
            mount: MOUNTS.has(payload.mount) ? payload.mount : 'unknown',
            gravity: vec3OrNull(payload.device?.gravity),
            attitude: Array.isArray(att) && att.length >= 4 && att.slice(0, 4).every(Number.isFinite)
                ? [att[0], att[1], att[2], att[3]] : null,
            userAcceleration: vec3OrNull(payload.device?.userAcceleration),
            ceiling: Number.isFinite(payload.ceiling) ? payload.ceiling : null,
            timestamp,
            sentAt: Number.isFinite(payload.sentAt) ? payload.sentAt : null,
        };
    }

    return { frames, scene, device };
}

/**
 * Decode a device `cameraFrame` payload — the low-rate JPEG preview that rides
 * the same stream as hand data.
 *
 * @param {Object} payload
 * @returns {CameraFrame|null} null if not a camera frame
 */
export function decodeCameraFrame(payload) {
    if (!payload || payload.type !== 'cameraFrame' || !payload.image) return null;
    return {
        image: payload.image,
        width: payload.width || 0,
        height: payload.height || 0,
        timestamp: typeof payload.timestamp === 'number' ? payload.timestamp : 0,
        orientation: payload.orientation || null,
    };
}
