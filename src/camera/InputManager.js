/**
 * Input Manager
 *
 * Handles keyboard and mouse input events.
 * Separates input capture from camera/game logic for better reusability.
 */

class InputManager {
    constructor() {
        // Keyboard state
        this.keys = new Map();

        // Mouse state
        this.mouse = {
            locked: false,
            down: false,
            movementX: 0,
            movementY: 0
        };

        // Element for pointer lock
        this.lockElement = null;

        // Event listeners (stored for cleanup)
        this.listeners = [];
    }

    /**
     * Initialize input manager with canvas element for pointer lock
     * @param {HTMLElement} lockElement - Element to request pointer lock on (usually canvas)
     */
    init(lockElement) {
        this.lockElement = lockElement;

        // Keyboard events
        this.addListener(window, 'keydown', this.onKeyDown.bind(this));
        this.addListener(window, 'keyup', this.onKeyUp.bind(this));

        // Mouse events
        this.addListener(this.lockElement, 'mousedown', this.onMouseDown.bind(this));
        this.addListener(this.lockElement, 'mouseup', this.onMouseUp.bind(this));
        this.addListener(this.lockElement, 'mousemove', this.onMouseMove.bind(this));

        // Pointer lock events
        this.addListener(document, 'pointerlockchange', this.onPointerLockChange.bind(this));
    }

    /**
     * Add event listener and store for cleanup
     */
    addListener(element, event, handler) {
        element.addEventListener(event, handler);
        this.listeners.push({ element, event, handler });
    }

    /**
     * Keyboard event handlers
     */
    onKeyDown(event) {
        this.keys.set(event.key.toLowerCase(), true);
    }

    onKeyUp(event) {
        this.keys.set(event.key.toLowerCase(), false);
    }

    /**
     * Mouse event handlers
     */
    onMouseDown() {
        this.mouse.down = true;
        if (this.lockElement) {
            this.lockElement.requestPointerLock();
        }
    }

    onMouseUp() {
        this.mouse.down = false;
    }

    onMouseMove(event) {
        if (this.mouse.locked) {
            this.mouse.movementX = event.movementX;
            this.mouse.movementY = event.movementY;
        } else {
            this.mouse.movementX = 0;
            this.mouse.movementY = 0;
        }
    }

    onPointerLockChange() {
        this.mouse.locked = document.pointerLockElement === this.lockElement;
    }

    /**
     * Check if a key is currently pressed
     * @param {string} key - Key to check (lowercase)
     * @returns {boolean}
     */
    isKeyPressed(key) {
        return this.keys.get(key.toLowerCase()) || false;
    }

    /**
     * Get mouse movement since last frame
     * @returns {{x: number, y: number}}
     */
    getMouseMovement() {
        const movement = {
            x: this.mouse.movementX,
            y: this.mouse.movementY
        };

        // Reset movement after reading
        this.mouse.movementX = 0;
        this.mouse.movementY = 0;

        return movement;
    }

    /**
     * Check if pointer is locked
     * @returns {boolean}
     */
    isPointerLocked() {
        return this.mouse.locked;
    }

    /**
     * Cleanup all event listeners
     */
    dispose() {
        this.listeners.forEach(({ element, event, handler }) => {
            element.removeEventListener(event, handler);
        });
        this.listeners = [];
        this.keys.clear();
    }
}

export default InputManager;
