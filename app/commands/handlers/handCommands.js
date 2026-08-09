/**
 * hand.* commands — the sensor plane's verb surface.
 *
 * Capture devices (an iPhone running MotionSource today) connect to the relay with
 * a `SOURCE hand` handshake and push landmark frames; SourceStream decodes them and
 * HandPresence draws one skeleton per device.
 *
 * These verbs are the observability and placement side. Placement lives on the bus
 * rather than in constructor options because "where do the hands sit relative to the
 * camera" is a thing you tune by feel, with the hands in front of you — a rebuild
 * per adjustment makes that impossible.
 *
 * Diagnosis is the other half. When nothing appears the question is always which
 * link is broken, and the three answers look different here:
 *   - no devices listed          → the phone isn't reaching the relay
 *   - listed but frames stuck at 0 → registered, capture not sending
 *   - frames climbing, no drawing  → renderer or placement
 */

import * as THREE from 'three';

/** Range of a component across landmarks, for spotting a wrong coordinate space. */
function range(points, key) {
    if (!points?.length) return null;
    let min = Infinity, max = -Infinity;
    for (const p of points) {
        const v = Array.isArray(p) ? p[{ x: 0, y: 1, z: 2 }[key]] : p[key];
        if (typeof v !== 'number' || !Number.isFinite(v)) continue;
        if (v < min) min = v;
        if (v > max) max = v;
    }
    if (min === Infinity) return null;
    return [Number(min.toFixed(4)), Number(max.toFixed(4))];
}

const r3 = (n) => Number(n.toFixed(3));

/** Format one source as a status line. */
function describe(state, rendered) {
    const age = state.lastFrameAt ? Math.round(performance.now() - state.lastFrameAt) : null;
    const parts = [
        state.id,
        `kind=${state.kind}`,
        `frames=${state.frames}`,
        state.fps ? `${state.fps.toFixed(1)}fps` : 'fps=—',
        age === null ? 'no frames yet' : `last=${age}ms ago`,
    ];
    if (state.kind === 'hand') parts.push(rendered ? 'drawing' : 'not drawn');
    return parts.join('  ');
}

export default function registerHandCommands(router) {
    router.register('hand.list', (_args, ctx) => {
        const stream = ctx.sourceStream;
        if (!stream) return { text: 'ERR: source stream not ready', data: null };

        const sources = stream.list();
        if (!sources.length) {
            return {
                text: 'no capture devices connected — point the device at this relay and connect',
                data: [],
            };
        }
        const drawn = new Set(ctx.handPresence?.ids() || []);
        const data = sources.map((s) => ({
            id: s.id,
            kind: s.kind,
            frames: s.frames,
            fps: s.fps,
            lastFrameAt: s.lastFrameAt,
            stalled: stream.isStalled(s.id),
            rendered: drawn.has(s.id),
        }));
        return {
            text: sources.map((s) => describe(s, drawn.has(s.id))).join('\n'),
            data,
        };
    }, {
        description: 'Connected capture devices with frame counts, rate, and whether each is being drawn',
        returns: '[{ id, kind, frames, fps, lastFrameAt, stalled, rendered }]',
    });

    router.register('hand.status', (_args, ctx) => {
        const stream = ctx.sourceStream;
        const presence = ctx.handPresence;
        if (!stream) return { text: 'ERR: source stream not ready', data: null };

        const sources = stream.list();
        const hands = sources.filter((s) => s.kind === 'hand');
        const stalled = hands.filter((s) => stream.isStalled(s.id));
        const scene = stream.latestScene();
        const data = {
            devices: sources.length,
            handDevices: hands.length,
            stalled: stalled.map((s) => s.id),
            rendering: presence?.ids() || [],
            visible: presence?.visible ?? false,
            placement: presence ? { ...presence.rendererOptions } : null,
            // ARKit context, when the device sends it — tracking quality is the
            // difference between "no hands" and "hands the device can't see".
            tracking: scene?.trackingState || null,
            viewport: scene?.viewport || null,
        };

        let text;
        if (!sources.length) text = 'no capture devices connected';
        else if (!hands.length) text = `${sources.length} device(s), none streaming hands`;
        else if (stalled.length === hands.length) text = `${hands.length} hand device(s), all stalled — connected but not sending`;
        else text = `${hands.length} hand device(s), ${data.rendering.length} drawing, hands ${data.visible ? 'visible' : 'hidden'}${data.tracking ? ` — tracking ${data.tracking}` : ''}`;

        return { text, data };
    }, {
        description: 'Sensor-plane health: device counts, stalls, tracking state, placement',
        returns: '{ devices, handDevices, stalled, rendering, visible, placement, tracking, viewport }',
    });

    router.register('hand.debug', (args, ctx) => {
        const stream = ctx.sourceStream;
        const presence = ctx.handPresence;
        if (!stream || !presence) return { text: 'ERR: sensor plane not ready', data: null };

        const id = args[0] || presence.ids()[0];
        if (!id) return { text: 'no hand device attached — try `hand.simulate on`', data: null };

        const state = stream.get(id);
        const renderer = presence.renderers.get(id);
        if (!renderer) return { text: `ERR: no renderer for '${id}'`, data: null };

        const frames = stream.latestHands(id);
        const frame = frames[0] || null;
        const lm = frame?.landmarks || [];

        // Where the geometry actually lands in the world, measured rather than
        // assumed — this is what separates "not drawing" from "drawing too small"
        // or "drawing behind the camera".
        const box = new THREE.Box3().setFromObject(renderer.group);
        const empty = box.isEmpty();
        const size = empty ? null : box.getSize(new THREE.Vector3());
        const center = empty ? null : box.getCenter(new THREE.Vector3());

        const camera = ctx.camera;
        const worldScale = renderer.group.getWorldScale(new THREE.Vector3());

        // Rough on-screen size: how many pixels tall the hand's bounding box is.
        // A number in the single digits means it IS rendering and you can't see it.
        let screenPx = null;
        if (!empty && camera?.isPerspectiveCamera) {
            const dist = camera.getWorldPosition(new THREE.Vector3()).distanceTo(center);
            const vFov = (camera.fov * Math.PI) / 180;
            const visibleH = 2 * Math.tan(vFov / 2) * Math.max(dist, 1e-6);
            const canvasH = ctx.renderer?.domElement?.clientHeight || 1000;
            screenPx = Math.round((size.y / visibleH) * canvasH);
        }

        const jointPx = screenPx != null && !empty && size.y > 0
            ? Number(((renderer.jointSize * worldScale.y * 2) / size.y * screenPx).toFixed(2))
            : null;

        const data = {
            id,
            frames: state?.frames ?? 0,
            fps: state?.fps ?? 0,
            stalled: stream.isStalled(id),
            landmarkCount: lm.length,
            // Raw ranges reveal a coordinate-space mismatch instantly: x/y should
            // be 0..1 normalized, z metres of depth from the device.
            raw: { x: range(lm, 'x'), y: range(lm, 'y'), z: range(lm, 'z') },
            mapped: renderer._lastMapped
                ? { x: range(renderer._lastMapped, 'x'), y: range(renderer._lastMapped, 'y'), z: range(renderer._lastMapped, 'z') }
                : null,
            placement: { spread: renderer.spread, depth: renderer.depth, scale: renderer.scale },
            worldScale: r3(worldScale.x),
            groupVisible: renderer.group.visible,
            // The invisible-hand trap: geometry parented to a camera that isn't in
            // the scene graph updates forever and never draws. Both must hold.
            onRig: renderer.group.parent === presence.rig,
            rigInScene: !!presence.rig.parent,
            handsBuilt: [...renderer.hands.keys()],
            geometry: empty ? null : {
                sizeWorld: [r3(size.x), r3(size.y), r3(size.z)],
                centerWorld: [r3(center.x), r3(center.y), r3(center.z)],
                approxScreenHeightPx: screenPx,
                approxJointDiameterPx: jointPx,
            },
        };

        const lines = [
            `${id}  frames=${data.frames} ${data.fps ? `${data.fps.toFixed(1)}fps` : 'fps=—'}${data.stalled ? ' STALLED' : ''}`,
            `landmarks=${data.landmarkCount}  raw x=${JSON.stringify(data.raw.x)} y=${JSON.stringify(data.raw.y)} z=${JSON.stringify(data.raw.z)}`,
            data.mapped ? `mapped   x=${JSON.stringify(data.mapped.x)} y=${JSON.stringify(data.mapped.y)} z=${JSON.stringify(data.mapped.z)}` : 'mapped   (no frame reached the renderer)',
            `placement spread=${data.placement.spread} depth=${data.placement.depth} scale=${data.placement.scale} → worldScale=${data.worldScale}`,
            `visible=${data.groupVisible} onRig=${data.onRig} rigInScene=${data.rigInScene} hands=[${data.handsBuilt}]`,
            data.geometry
                ? `geometry size=${JSON.stringify(data.geometry.sizeWorld)} center=${JSON.stringify(data.geometry.centerWorld)} ≈${data.geometry.approxScreenHeightPx}px tall, joints ≈${data.geometry.approxJointDiameterPx}px`
                : 'geometry EMPTY — no mesh has been positioned',
        ];
        return { text: lines.join('\n'), data };
    }, {
        description: 'Why are the hands not visible: landmark ranges, mapped coords, world size, on-screen pixels',
        returns: '{ id, frames, raw, mapped, placement, geometry }',
    });

    router.register('hand.simulate', (args, ctx) => {
        const stream = ctx.sourceStream;
        if (!stream) return { text: 'ERR: source stream not ready', data: null };

        const on = (args[0] || 'on') !== 'off';
        const ID = 'src-sim-hand';

        if (!on) {
            if (ctx._handSimTimer) { clearInterval(ctx._handSimTimer); ctx._handSimTimer = null; }
            stream.detachLocal(ID);
            return { text: 'OK: simulated hand off', data: { simulating: false } };
        }
        if (ctx._handSimTimer) return { text: 'OK: already simulating', data: { simulating: true } };

        stream.attachLocal(ID, 'hand');
        // A slowly waving open hand in the device's own coordinate space: x/y
        // normalized 0..1, z metres of depth. Renders the same path a phone does,
        // so if this draws and the phone doesn't, the fault is upstream of here.
        const t0 = performance.now();
        ctx._handSimTimer = setInterval(() => {
            const t = (performance.now() - t0) / 1000;
            const sway = Math.sin(t) * 0.08;
            const landmarks = [];
            for (let f = 0; f < 5; f++) {
                for (let j = 0; j < 4; j++) {
                    landmarks.push([
                        0.5 + (f - 2) * 0.06 + sway * (j + 1) * 0.3,
                        0.75 - j * 0.09 - (f === 0 ? 0.05 : 0),
                        0.45 + Math.sin(t + f) * 0.02,
                    ]);
                }
            }
            // Wrist last, then rotate into MediaPipe order (wrist first).
            landmarks.unshift([0.5 + sway * 0.2, 0.85, 0.45]);
            stream.injectFrame(ID, {
                type: 'handFrame',
                timestamp: t,
                hands: [{ handedness: 'right', landmarks: landmarks.slice(0, 21) }],
            });
        }, 33);

        return { text: 'OK: simulating a hand (hand.simulate off to stop)', data: { simulating: true } };
    }, {
        description: 'Inject a synthetic hand with no device attached — bisects network faults from rendering faults',
        returns: '{ simulating }',
    });

    router.register('hand.show', (_args, ctx) => {
        const presence = ctx.handPresence;
        if (!presence) return { text: 'ERR: hand presence not ready', data: null };
        presence.setVisible(true);
        return { text: `OK: hands visible (${presence.ids().length} device(s))`, data: { visible: true } };
    }, { description: 'Show rendered hands', returns: '{ visible }' });

    router.register('hand.hide', (_args, ctx) => {
        const presence = ctx.handPresence;
        if (!presence) return { text: 'ERR: hand presence not ready', data: null };
        presence.setVisible(false);
        return { text: 'OK: hands hidden', data: { visible: false } };
    }, { description: 'Hide rendered hands without disconnecting the device', returns: '{ visible }' });

    router.register('hand.place', (args, ctx) => {
        const presence = ctx.handPresence;
        if (!presence) return { text: 'ERR: hand presence not ready', data: null };

        const [key, raw] = args;
        const allowed = ['spread', 'depth', 'scale', 'jointSize', 'boneRadius'];
        if (!key || !allowed.includes(key)) {
            return { text: `ERR: hand.place <${allowed.join('|')}> <value>`, data: null };
        }
        const value = Number(raw);
        if (!Number.isFinite(value)) {
            return { text: `ERR: hand.place ${key} needs a number, got '${raw}'`, data: null };
        }
        presence.setPlacement(key, value);
        return {
            text: `OK: ${key} = ${value}`,
            data: { ...presence.rendererOptions },
        };
    }, {
        description: 'Tune hands live: spread (width), depth (negative = in front), scale, jointSize, boneRadius',
        returns: '{ spread, depth, scale, jointSize, boneRadius }',
    });
}
