/**
 * FPS Counter Utility
 *
 * Tracks frame timing and updates FPS display.
 * Separated from main application logic for reusability and testing.
 */

class FPSCounter {
    /**
     * Create a new FPS counter
     * @param {HTMLElement} displayElement - DOM element to update with FPS text
     * @param {number} updateInterval - Number of frames between updates (default: 60)
     */
    constructor(displayElement, updateInterval = 60) {
        this.element = displayElement;
        this.updateInterval = updateInterval;

        this.frames = 0;
        this.lastTime = performance.now();
        this.fps = 0;
    }

    /**
     * Update FPS tracking and display
     * Should be called once per frame in the animation loop
     * @param {number} deltaTime - Time since last frame in seconds
     */
    update(deltaTime) {
        this.frames++;

        if (this.frames % this.updateInterval === 0) {
            this.fps = Math.round(1 / deltaTime);
            this.updateDisplay();
        }
    }

    /**
     * Update the DOM element with current FPS
     */
    updateDisplay() {
        if (this.element) {
            this.element.textContent = `FPS: ${this.fps}`;
        }
    }

    /**
     * Get current FPS value
     * @returns {number} Current FPS
     */
    getFPS() {
        return this.fps;
    }

    /**
     * Reset FPS counter
     */
    reset() {
        this.frames = 0;
        this.lastTime = performance.now();
        this.fps = 0;
    }
}

export default FPSCounter;
