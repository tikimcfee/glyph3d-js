/**
 * Camera Controller
 *
 * Handles physics-based camera movement and rotation.
 * Separates camera control logic from input handling and scene management.
 */

import * as THREE from 'three';

class CameraController {
    /**
     * Create a new camera controller
     * @param {THREE.PerspectiveCamera} camera - Three.js camera to control
     * @param {InputManager} inputManager - Input manager for reading input state
     * @param {Object} config - Configuration object with camera settings
     */
    constructor(camera, inputManager, config) {
        this.camera = camera;
        this.input = inputManager;
        this.config = config;

        // Physics state
        this.velocity = { x: 0, y: 0, z: 0 };
        this.rotation = { x: 0, y: 0 };
    }

    /**
     * Update camera position and rotation based on input
     * @param {number} deltaTime - Time since last frame in seconds
     */
    update(deltaTime) {
        this.updateVelocity(deltaTime);
        this.updatePosition(deltaTime);
        this.updateRotation();
    }

    /**
     * Update velocity based on input and physics
     * @param {number} deltaTime - Time since last frame in seconds
     */
    updateVelocity(deltaTime) {
        const speed = this.config.CAMERA_SPEED;
        const acceleration = this.config.CAMERA_ACCELERATION;

        // Calculate desired velocity from input
        let desiredVel = { x: 0, y: 0, z: 0 };

        // WASD movement (W forward, S back, A left, D right)
        if (this.input.isKeyPressed('w')) desiredVel.z += 1;
        if (this.input.isKeyPressed('s')) desiredVel.z -= 1;
        if (this.input.isKeyPressed('a')) desiredVel.x -= 1;
        if (this.input.isKeyPressed('d')) desiredVel.x += 1;

        // Q/E for up/down
        if (this.input.isKeyPressed('q')) desiredVel.y += 1;
        if (this.input.isKeyPressed('e')) desiredVel.y -= 1;

        // Normalize and scale to desired speed
        const length = Math.sqrt(
            desiredVel.x ** 2 +
            desiredVel.y ** 2 +
            desiredVel.z ** 2
        );

        if (length > 0) {
            desiredVel.x = (desiredVel.x / length) * speed;
            desiredVel.y = (desiredVel.y / length) * speed;
            desiredVel.z = (desiredVel.z / length) * speed;
        }

        // Apply acceleration (smooth movement)
        this.velocity.x += (desiredVel.x - this.velocity.x) * acceleration * deltaTime;
        this.velocity.y += (desiredVel.y - this.velocity.y) * acceleration * deltaTime;
        this.velocity.z += (desiredVel.z - this.velocity.z) * acceleration * deltaTime;
    }

    /**
     * Update camera position based on velocity
     * @param {number} deltaTime - Time since last frame in seconds
     */
    updatePosition(deltaTime) {
        // Get camera direction vectors
        const forward = new THREE.Vector3(0, 0, -1);
        const right = new THREE.Vector3(1, 0, 0);

        // Transform by camera rotation
        forward.applyQuaternion(this.camera.quaternion);
        right.applyQuaternion(this.camera.quaternion);

        // Apply velocity in camera-relative directions
        this.camera.position.add(forward.multiplyScalar(this.velocity.z * deltaTime));
        this.camera.position.add(right.multiplyScalar(this.velocity.x * deltaTime));
        this.camera.position.y += this.velocity.y * deltaTime;
    }

    /**
     * Update camera rotation based on mouse movement
     */
    updateRotation() {
        if (!this.input.isPointerLocked()) {
            return;
        }

        const movement = this.input.getMouseMovement();
        const sensitivity = this.config.CAMERA_SENSITIVITY;

        // Update rotation based on mouse movement
        this.rotation.y -= movement.x * sensitivity;
        this.rotation.x -= movement.y * sensitivity;

        // Clamp vertical rotation to prevent camera flip
        this.rotation.x = Math.max(
            this.config.CAMERA_ROTATION_X_MIN,
            Math.min(this.config.CAMERA_ROTATION_X_MAX, this.rotation.x)
        );

        // Apply rotation to camera
        this.camera.rotation.order = 'YXZ';
        this.camera.rotation.y = this.rotation.y;
        this.camera.rotation.x = this.rotation.x;
    }

    /**
     * Get current velocity
     * @returns {{x: number, y: number, z: number}}
     */
    getVelocity() {
        return { ...this.velocity };
    }

    /**
     * Get current rotation
     * @returns {{x: number, y: number}}
     */
    getRotation() {
        return { ...this.rotation };
    }

    /**
     * Reset camera controller state
     */
    reset() {
        this.velocity = { x: 0, y: 0, z: 0 };
        this.rotation = { x: 0, y: 0 };
    }
}

export default CameraController;
