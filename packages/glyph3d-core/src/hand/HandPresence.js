/**
 * HandPresence
 *
 * Turns attached sensor devices into visible hands: one HandRenderer per source,
 * created when a device attaches and torn down when it leaves. The multi-source
 * relay makes "two phones streaming at once" ordinary, so hands are keyed by
 * source id rather than assuming a single global hand.
 *
 * The pull seam. SourceStream receives frames at the device's rate; this samples
 * `latestHands()` once per rendered frame. Pushing straight from the network
 * callback into the scene graph would tie render work to network timing and do
 * redundant work whenever a device outruns the display — a 60fps device on a
 * 30fps display would build twice the geometry it can show.
 *
 * Placement: hands are first-person input, so they must stay in view rather than
 * being left behind in world space. The obvious way to get that — parenting to the
 * camera — silently renders NOTHING: `renderer.render(scene, camera)` traverses
 * only the scene, and nothing puts the camera in the scene graph, so camera
 * children update every frame and are never drawn.
 *
 * So hands hang off a RIG: an Object3D that lives in the scene and is parked on the
 * camera's world transform each frame. Rig-local space is camera-local space, which
 * keeps HandRenderer's placement semantics intact (`depth` negative = in front of
 * the viewer) while staying inside the render traversal. This mirrors CameraDock,
 * which is camera-locked the same way and for the same reason.
 */

import * as THREE from 'three';
import HandRenderer from './HandRenderer.js';

class HandPresence {
    /**
     * @param {Object} opts
     * @param {import('../services/orchestration/SourceStream.js').default} opts.stream
     * @param {import('three').Camera} opts.camera - Camera the rig tracks
     * @param {import('three').Object3D} opts.scene - Where the rig lives
     * @param {Object} [opts.rendererOptions] - Passed to each HandRenderer
     */
    constructor({ stream, camera, scene, rendererOptions = {} } = {}) {
        if (!stream) throw new Error('HandPresence requires a SourceStream');
        if (!camera) throw new Error('HandPresence requires a camera');
        if (!scene) throw new Error('HandPresence requires a scene — hands parented to a camera never render');

        this.stream = stream;
        this.camera = camera;
        this.scene = scene;
        this.rendererOptions = rendererOptions;
        this.visible = true;

        // The camera-follow rig. matrixAutoUpdate stays on: we write world-space
        // position/quaternion into it each frame and let Three compose as usual.
        this.rig = new THREE.Group();
        this.rig.name = 'hand-rig';
        scene.add(this.rig);

        /** @type {Map<string, HandRenderer>} keyed by source id */
        this.renderers = new Map();

        // onPresence replays already-attached devices, so a phone that connected
        // before this object existed still gets a renderer.
        this._unsubscribe = stream.onPresence((event, state) => {
            if (event === 'attached') this._add(state);
            else this._remove(state.id);
        });
    }

    /**
     * Sample every device's latest pose. Call once per rendered frame.
     *
     * A device that has gone quiet keeps its last pose rather than snapping to
     * nothing: hand tracking legitimately drops out for a frame or two, and
     * blinking on every gap reads as broken rather than as honest.
     */
    update(camera = this.camera) {
        if (!this.visible) return;

        // Park the rig on the camera so rig-local space IS camera space. Done
        // every frame rather than on a change event: the camera is driven by
        // controllers, animations, and commands, with no single mutation hook.
        if (camera) {
            camera.updateMatrixWorld();
            camera.getWorldPosition(this.rig.position);
            camera.getWorldQuaternion(this.rig.quaternion);
        }

        for (const [id, renderer] of this.renderers) {
            const frames = this.stream.latestHands(id);
            if (!frames.length) continue;
            for (const frame of frames) renderer.updateFromFrame(frame);
        }
    }

    /** Show or hide every hand without tearing down device state. */
    setVisible(visible) {
        this.visible = !!visible;
        for (const renderer of this.renderers.values()) {
            renderer.group.visible = this.visible;
        }
    }

    /**
     * Apply a placement or sizing parameter to all current and future renderers.
     * Stored on rendererOptions too, so a device that attaches later inherits
     * tuning already done rather than appearing at the old settings.
     * @param {'spread'|'depth'|'scale'|'jointSize'|'boneRadius'} key
     * @param {number} value
     */
    setPlacement(key, value) {
        this.rendererOptions[key] = value;
        for (const renderer of this.renderers.values()) renderer[key] = value;
    }

    /** @returns {string[]} source ids with a live renderer */
    ids() { return [...this.renderers.keys()]; }

    /** @private */
    _add(state) {
        // Only hand devices get a skeleton; a camera-preview source shares the
        // stream but has nothing to draw here.
        if (state.kind !== 'hand' || this.renderers.has(state.id)) return;
        const renderer = new HandRenderer(this.rendererOptions);
        renderer.attachTo(this.rig);
        renderer.group.visible = this.visible;
        this.renderers.set(state.id, renderer);
        console.log(`[hand] rendering ${state.id}`);
    }

    /** @private */
    _remove(id) {
        const renderer = this.renderers.get(id);
        if (!renderer) return;
        renderer.detach();
        renderer.dispose();
        this.renderers.delete(id);
        console.log(`[hand] stopped rendering ${id}`);
    }

    dispose() {
        if (this._unsubscribe) this._unsubscribe();
        this._unsubscribe = null;
        for (const id of [...this.renderers.keys()]) this._remove(id);
        this.rig.parent?.remove(this.rig);
    }
}

export default HandPresence;
