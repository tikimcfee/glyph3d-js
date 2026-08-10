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

        // "drawing" must mean pixels are possible: a hand inside the near plane
        // renders nothing while every flag reads healthy (the invisible-hand trap
        // this whole subsystem was debugged for). Check and SAY it.
        const camera = ctx.camera;
        const clipped = [];
        if (presence && camera) {
            const camPos = camera.getWorldPosition(new THREE.Vector3());
            for (const rid of presence.ids()) {
                const box = new THREE.Box3().setFromObject(presence.renderers.get(rid).group);
                if (!box.isEmpty() && box.distanceToPoint(camPos) < (camera.near ?? 0)) clipped.push(rid);
            }
        }

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
            nearClipped: clipped,
        };

        let text;
        if (!sources.length) text = 'no capture devices connected';
        else if (!hands.length) text = `${sources.length} device(s), none streaming hands`;
        else if (stalled.length === hands.length) text = `${hands.length} hand device(s), all stalled — connected but not sending`;
        else text = `${hands.length} hand device(s), ${data.rendering.length} drawing, hands ${data.visible ? 'visible' : 'hidden'}${data.tracking ? ` — tracking ${data.tracking}` : ''}`;
        if (clipped.length) {
            text += `\n⚠ NEAR-CLIPPED: [${clipped}] inside camera.near=${camera?.near} — drawing into the void. Lower hand.place depth (more negative) or the camera.nearPlane setting.`;
        }

        return { text, data };
    }, {
        description: 'Sensor-plane health: device counts, stalls, tracking state, placement, near-clip check',
        returns: '{ devices, handDevices, stalled, rendering, visible, placement, tracking, viewport, nearClipped }',
    });

    router.register('hand.debug', (args, ctx) => {
        const stream = ctx.sourceStream;
        const presence = ctx.handPresence;
        if (!stream || !presence) return { text: 'ERR: sensor plane not ready', data: null };

        // `hand.debug probe [rig|group|hand]` — parent an unlit cube at one level of
        // the hand's transform chain. Walks the bisection: rig draws → group? →
        // handGroup? The first level whose cube vanishes is the broken link.
        if (args[0] === 'probe') {
            const level = args[1] || 'rig';
            const colors = { rig: 0xff00ff, group: 0x00ffff, hand: 0xffff00 };
            const r0 = presence.renderers.get(presence.ids()[0]);
            const parent = level === 'rig' ? presence.rig
                : level === 'group' ? r0?.group
                : r0?.hands.get(r0.hands.keys().next().value)?.group;
            if (!parent || !(level in colors)) return { text: `ERR: no '${level}' to probe`, data: null };
            const probe = new THREE.Mesh(
                new THREE.BoxGeometry(0.5, 0.5, 0.5),
                new THREE.MeshBasicMaterial({ color: colors[level] }),
            );
            // `probe <level> cull` keeps the frustum gate ON — the A/B control.
            // A cube that submits only with the gate off is being culled on
            // garbage render-time matrixWorld/boundingSphere.
            const culled = args[2] === 'cull';
            probe.name = `hand-debug-probe-${level}${culled ? '-cull' : ''}`;
            probe.position.set(0, 0, level === 'rig' ? -5 : 0);
            // Draw-submission witness: increments only when the renderer actually
            // submits this mesh — separates "not traversed" from "no fragments".
            probe.userData.drawn = 0;
            probe.onAfterRender = () => { probe.userData.drawn++; };
            probe.frustumCulled = culled;
            parent.add(probe);
            return { text: `${level} probe cube added (magenta=rig cyan=group yellow=hand; reload to clear)`, data: null };
        }

        // `hand.debug down` — walk the scene TOP-DOWN via children[] arrays, the way
        // rendering does. Parent pointers can claim membership the children arrays
        // deny; this reports the graph the renderer actually sees.
        if (args[0] === 'down') {
            const rigs = [];
            ctx.scene.traverse((n) => { if (n.name === 'hand-rig') rigs.push(n); });
            const r0 = presence.renderers.get(presence.ids()[0]);
            let groupReached = false;
            if (r0) ctx.scene.traverse((n) => { if (n === r0.group) groupReached = true; });
            const data = {
                rigCount: rigs.length,
                rigIsCtxRig: rigs.map((r) => r === presence.rig),
                rigChildren: rigs.map((r) => r.children.map((c) => c.name || c.type)),
                ctxRigInSceneChildren: ctx.scene.children.includes(presence.rig),
                groupParentIsCtxRig: r0 ? r0.group.parent === presence.rig : null,
                rigChildrenIncludesGroup: r0 ? presence.rig.children.includes(r0.group) : null,
                groupReachedByTraverse: groupReached,
            };
            return { text: JSON.stringify(data, null, 1), data };
        }

        // `hand.debug drawn` — read back the probe cubes' draw-submission counts,
        // plus RAW matrixWorld translations (no updateWorldMatrix — reading through
        // Box3/getWorldPosition heals the very staleness being hunted).
        if (args[0] === 'drawn') {
            const out = {};
            ctx.scene.traverse((n) => {
                if (n.name?.startsWith('hand-debug-probe')) out[n.name] = n.userData.drawn ?? null;
            });
            const r0 = presence.renderers.get(presence.ids()[0]);
            const t = (m) => [m.elements[12], m.elements[13], m.elements[14]].map(r3);
            const raw = {
                sceneMatrixWorldAutoUpdate: ctx.scene.matrixWorldAutoUpdate,
                rigMatrixWorld: t(presence.rig.matrixWorld),
                rigLocalPos: presence.rig.position.toArray().map(r3),
                groupMatrixWorld: r0 ? t(r0.group.matrixWorld) : null,
                groupLocalPos: r0 ? r0.group.position.toArray().map(r3) : null,
                groupMatrixLocal: r0 ? t(r0.group.matrix) : null,
                groupMatrixAutoUpdate: r0 ? r0.group.matrixAutoUpdate : null,
                groupMatrixWorldAutoUpdate: r0 ? r0.group.matrixWorldAutoUpdate : null,
            };
            // Replicate the renderer's cull test with live numbers: same Frustum
            // math, ctx camera, passive matrix reads. A verdict that disagrees
            // with the renderer's observed behavior indicts the camera identity.
            const frustum = new THREE.Frustum();
            const proj = new THREE.Matrix4().multiplyMatrices(
                ctx.camera.projectionMatrix, ctx.camera.matrixWorldInverse);
            frustum.setFromProjectionMatrix(proj);
            const cull = {};
            ctx.scene.traverse((n) => {
                if (!n.name?.startsWith('hand-debug-probe')) return;
                if (!n.geometry.boundingSphere) n.geometry.computeBoundingSphere();
                const s = n.geometry.boundingSphere.clone().applyMatrix4(n.matrixWorld);
                cull[n.name] = {
                    passes: frustum.intersectsSphere(s),
                    center: s.center.toArray().map(r3), radius: r3(s.radius),
                };
            });
            raw.cull = cull;
            raw.ctxCameraWorld = t(ctx.camera.matrixWorld);
            raw.ctxCameraNearFar = [ctx.camera.near, ctx.camera.far];
            return { text: JSON.stringify({ out, raw }, null, 1), data: { out, raw } };
        }

        // `hand.debug chain` — the full ancestry of the first hand's group, leaf to
        // root, with every flag the renderer honors. The scene-identity check at
        // the root is the point: a chain can be perfectly healthy inside a graph
        // that is not the one being rendered.
        if (args[0] === 'chain') {
            const r0 = presence.renderers.get(presence.ids()[0]);
            const leaf = r0?.hands.get(r0.hands.keys().next().value)?.group || r0?.group || presence.rig;
            const chain = [];
            for (let n = leaf; n; n = n.parent) {
                chain.push({
                    type: n.type, name: n.name || null,
                    visible: n.visible, layers: n.layers.mask,
                    renderOrder: n.renderOrder, frustumCulled: n.frustumCulled,
                    matrixAutoUpdate: n.matrixAutoUpdate,
                    scale: n.scale.toArray().map(r3),
                    position: n.position.toArray().map(r3),
                    childCount: n.children.length,
                });
            }
            const root = (() => { let n = leaf; while (n.parent) n = n.parent; return n; })();
            const data = { chain, rootIsCtxScene: root === ctx.scene, rootType: root.type };
            return { text: JSON.stringify(data, null, 1), data };
        }

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

        // The near-clip trap: the near plane is a live setting, and a hand inside
        // it is culled/clipped while every scene-graph probe reads healthy. This
        // is the check that separates "drawing" from "drawing into the void".
        let nearClip = null;
        if (!empty && camera) {
            const camPos = camera.getWorldPosition(new THREE.Vector3());
            const nearestDist = box.distanceToPoint(camPos);
            nearClip = {
                cameraNear: camera.near ?? null,
                handNearestDist: r3(nearestDist),
                clipped: nearestDist < (camera.near ?? 0),
            };
        }

        // Per-mesh truth per hand — the flags the render loop actually honors.
        const meshState = {};
        for (const [handedness, h] of renderer.hands) {
            meshState[handedness] = {
                handGroupVisible: h.group.visible,
                jointsVisible: h.joints.filter(j => j.visible).length,
                bonesVisible: h.bones.filter(b => b.visible).length,
                materialType: h.jointMaterial.type,
                joint0World: h.joints[0].getWorldPosition(new THREE.Vector3()).toArray().map(r3),
            };
        }

        const data = {
            id,
            frames: state?.frames ?? 0,
            mesh: meshState,
            fps: state?.fps ?? 0,
            stalled: stream.isStalled(id),
            landmarkCount: lm.length,
            // Raw ranges reveal a coordinate-space mismatch instantly: x/y should
            // be 0..1 normalized, z metres of depth from the device.
            raw: { x: range(lm, 'x'), y: range(lm, 'y'), z: range(lm, 'z') },
            mapped: renderer._lastMapped
                ? { x: range(renderer._lastMapped, 'x'), y: range(renderer._lastMapped, 'y'), z: range(renderer._lastMapped, 'z') }
                : null,
            placement: {
                spread: renderer.spread, depth: renderer.depth,
                scale: renderer.scale, yaw: renderer.yaw,
            },
            worldScale: r3(worldScale.x),
            groupVisible: renderer.group.visible,
            // The invisible-hand trap: geometry parented to a camera that isn't in
            // the scene graph updates forever and never draws. Both must hold.
            onRig: renderer.group.parent === presence.rig,
            rigInScene: !!presence.rig.parent,
            handsBuilt: [...renderer.hands.keys()],
            nearClip,
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
            `placement spread=${data.placement.spread} depth=${data.placement.depth} scale=${data.placement.scale} yaw=${data.placement.yaw}° → worldScale=${data.worldScale}`,
            `visible=${data.groupVisible} onRig=${data.onRig} rigInScene=${data.rigInScene} hands=[${data.handsBuilt}]`,
            data.geometry
                ? `geometry size=${JSON.stringify(data.geometry.sizeWorld)} center=${JSON.stringify(data.geometry.centerWorld)} ≈${data.geometry.approxScreenHeightPx}px tall, joints ≈${data.geometry.approxJointDiameterPx}px`
                : 'geometry EMPTY — no mesh has been positioned',
        ];
        if (nearClip?.clipped) {
            lines.push(`⚠ NEAR-CLIPPED: hand is ${nearClip.handNearestDist} from the camera, inside camera.near=${nearClip.cameraNear} — invisible. Lower hand.place depth (more negative) or the camera.nearPlane setting.`);
        }
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
        const allowed = ['spread', 'depth', 'scale', 'yaw', 'jointSize', 'boneRadius'];
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
        description: 'Tune hands live: spread, depth (near-plane multiples; negative = in front, must exceed -1 to clear the plane), scale, yaw (degrees; 180 = palms away), jointSize, boneRadius',
        returns: '{ spread, depth, scale, yaw, jointSize, boneRadius }',
    });
}
