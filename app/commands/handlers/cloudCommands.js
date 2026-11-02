/**
 * cloud.* commands — the LiDAR hand tracker (ctx.handCloud) on the bus. It runs on every hand a
 * device sends with a depth crop; these verbs read what each stage concluded, show it in the
 * scene, and dial it.
 *
 *   cloud.status                          per hand: crop, per-stage ms, segmentation counts, palm
 *                                         plane, tips, pinch cues, fit; the pipeline's rate
 *   cloud.view on|off                     the in-scene stage view (points by class, tips, skeletons)
 *   cloud.layer [<layer> on|off]          toggle one view layer (no args: list them)
 *   cloud.color class|geo|depth           what colours the hand's points
 *   cloud.set <knob> <value>              one tracker knob (Settings ▸ Hand cloud has them all)
 *   cloud.get [knob]                      the tracker knobs, or one
 *   cloud.simulate on [mode] | mode <m> | bump [yawDeg] [tiltDeg] | off
 *                                         a simulated phone streaming depth crops (HandSim + DepthSim)
 *   cloud.reset                           forget the tracker's temporal state
 */

import { HAND_CLOUD_DEFAULTS, CLOUD_LAYERS } from '@glyph3d/core/hand/cloud/index.js';
import { SIM_MODES } from '@glyph3d/core/hand';
import { setSetting } from '../../client/settings.js';

/** @param {import('../../client/CommandProvider.jsx').AppContext} ctx */
const cloud = (ctx) => ctx.handCloud || null;
const NOT_READY = { text: 'ERR: hand cloud tracker not ready (no sensor plane)', data: null };

/** The status as text. */
function describe(st) {
    const lines = [
        `hand cloud — ${st.enabled ? 'on' : 'off'} · source ${st.source || 'none'}${st.simulating ? ` (simulated: ${st.simulating})` : ''}`
        + ` · frames seen ${st.frames.seen}${st.lastSeen ? ` (from ${st.lastSeen})` : ''}: no hand ${st.frames.empty}, hands without a crop ${st.frames.without}, with one ${st.frames.withCloud}`,
        `pipeline: tracked ${st.pipeline.tracked}/${st.pipeline.submitted} (replaced while busy ${st.pipeline.replaced}, FAILED ${st.pipeline.failed}) · round trip p50/p90 ${st.pipeline.timing.roundTrip.p50 ?? '—'}/${st.pipeline.timing.roundTrip.p90 ?? '—'} ms, waiting in the worker ${st.pipeline.timing.queued.p50 ?? '—'}/${st.pipeline.timing.queued.p90 ?? '—'} ms, tracking ${st.pipeline.timing.worker.p50 ?? '—'}/${st.pipeline.timing.worker.p90 ?? '—'} ms`
        + (st.pipeline.lastError ? `\n  last failure: ${st.pipeline.lastError}` : ''),
        `view ${st.view.visible ? `on (the hand: ${st.view.drawing === 'display' ? "the model's stabilized hand" : st.view.drawing === 'raw' ? 'the raw fit — no stabilized hand' : 'none'})` : 'off'} · colour by ${st.view.colorBy} · layers ${Object.entries(st.view.layers).filter(([, v]) => v).map(([k]) => k).join(' ')}`,
    ];
    const hands = Object.entries(st.hands);
    if (!hands.length) {
        lines.push(!st.frames.seen ? 'no hand-device frames have reached the tracker'
            : st.frames.without && !st.frames.withCloud ? 'hands arrive WITHOUT depth crops — the device sends no hands[i].cloud'
                : !st.frames.withCloud ? 'frames arrive, but no hand is in view yet' : 'no crop tracked yet');
    }
    for (const [h, s] of hands) {
        if (!s || !s.crop) { lines.push(`${h}: no result`); continue; }
        lines.push(`${h} hand — crop ${s.crop[2]}×${s.crop[3]} at (${s.crop[0]}, ${s.crop[1]}) · ${s.ms.total} ms (decode ${s.ms.decode} · segment ${s.ms.segment} · palm ${s.ms.palm} · tips ${s.ms.tips} · hole ${s.ms.hole} · fit ${s.ms.fit}) · bones ${s.bones} · ${s.ageMs} ms ago`);
        if (s.edge?.atEdge || s.edge?.jointsOut) {
            lines.push(`  ⚠ ${s.edge.atEdge ? `HAND AT THE EDGE of the depth view (${s.edge.handPx} px on its border)` : 'hand inside the view'}`
                + `${s.edge.jointsOut ? ` · ${s.edge.jointsOut} joints OUT OF VIEW${s.edge.tipsOut.length ? ` (tips ${s.edge.tipsOut.join(', ')})` : ''} — guessed, not measured` : ''}`);
        }
        const g = s.segment;
        lines.push(`  segment: hand ${g.hand} · arm ${g.arm} (cut by ${g.armFrom || 'nothing'}) · flying ${g.fly} · other ${g.other} · bg ${g.bg} · no depth ${g.none} · ${g.components} blobs, seeded by ${g.seededBy}`);
        const p = s.palm;
        lines.push(p.ok === false ? `  palm: — (${p.why})`
            : `  palm: ${p.inliers}/${p.region} inliers · rms ${p.rmsMm} mm · inscribed r ${p.radiusMm} mm · yaw ${p.yaw}° pitch ${p.pitch}° roll ${p.roll}° (axis from ${p.axisFrom})`);
        lines.push(`  tips: ${s.tips.map((t) => `${t.joint ?? '?'}${t.clipped ? '(edge)' : ''}@${t.geoMm}mm`).join(' ') || '—'}`);
        const k = s.pinch || {};
        lines.push(`  pinch: ${k.closed ? 'CLOSED' : 'open'} · hole ${k.hole ? `yes ${(k.holeArea * 1e4).toFixed(2)} cm²` : 'no'} · tips ${k.tipDist == null ? '—' : `${(k.tipDist * 1000).toFixed(1)} mm`}`);
        const f = s.fit;
        lines.push(f.ok === false ? `  fit: — (${f.why})`
            : `  fit: rms ${f.rmsMm} mm (running median ${f.medianRmsMm ?? '—'}; ${f.reinits} re-inits so far) over ${f.used} points (${f.outliers} outliers) · from ${f.initFrom} · joints ${Object.entries(f.sources).map(([a, n]) => `${a} ${n}`).join(', ')}`);
    }
    return lines.join('\n');
}

/** A knob value from text, typed by its default. */
function parseKnob(key, raw) {
    const d = HAND_CLOUD_DEFAULTS[key];
    if (Array.isArray(d)) return String(raw).split(',').map(Number);
    if (typeof d === 'boolean') { if (raw === 'true' || raw === 'on') return true; if (raw === 'false' || raw === 'off') return false; return raw; }
    return Number(raw);
}

/** @param {import('../../client/CommandProvider.jsx').AppRouter} router */
export default function registerCloudCommands(router) {
    router.register('cloud.status', (_args, ctx) => {
        const c = cloud(ctx);
        if (!c) return NOT_READY;
        const st = c.status();
        return { text: describe(st), data: st };
    }, {
        description: 'The LiDAR hand tracker: what each stage concluded per hand (segment, palm, tips, pinch, fit), its cost, the pipeline',
        returns: '{ enabled, source, simulating, frames, pipeline, view, primary, hands:{<h>:{crop, ms, segment, palm, tips, pinch, fit}} }',
    });

    router.register('cloud.view', (args, ctx) => {
        const c = cloud(ctx);
        if (!c) return NOT_READY;
        if (args[0] !== 'on' && args[0] !== 'off') return { text: 'ERR: usage: cloud.view on|off', data: null };
        // A setting, so the view stays as left across reloads.
        setSetting(ctx, 'hand.cloudView.visible', args[0] === 'on');
        return { text: `OK: hand cloud view ${args[0]}`, data: { view: args[0] === 'on' } };
    }, { description: 'Show or hide the hand cloud picture-in-picture (top-left: points by stage, tips, fitted vs Vision skeleton, palm, the sensor\'s view; red frame = hand at the edge)', usage: 'on|off' });

    router.register('cloud.layer', (args, ctx) => {
        const c = cloud(ctx);
        if (!c) return NOT_READY;
        const [layer, v] = args;
        if (!layer) return { text: CLOUD_LAYERS.map((l) => `${c.view.show[l] ? '●' : '○'} ${l}`).join('\n'), data: { ...c.view.show } };
        if (!CLOUD_LAYERS.includes(layer) || (v !== 'on' && v !== 'off')) return { text: `ERR: usage: cloud.layer <${CLOUD_LAYERS.join('|')}> on|off`, data: null };
        c.view.setLayer(layer, v === 'on');
        return { text: `OK: layer ${layer} ${v}`, data: { [layer]: v === 'on' } };
    }, { description: 'Toggle one layer of the hand cloud view; no args lists them', usage: `[<${CLOUD_LAYERS.join('|')}> on|off]` });

    router.register('cloud.color', (args, ctx) => {
        const c = cloud(ctx);
        if (!c) return NOT_READY;
        const m = args[0];
        if (!['class', 'geo', 'depth'].includes(m)) return { text: 'ERR: usage: cloud.color class|geo|depth', data: null };
        c.view.place.colorBy = m;
        c.view.refresh();
        return { text: `OK: hand points coloured by ${m}`, data: { colorBy: m } };
    }, { description: 'Colour the hand cloud by class, by geodesic distance from the palm, or by depth', usage: 'class|geo|depth' });

    router.register('cloud.set', (args, ctx) => {
        const c = cloud(ctx);
        if (!c) return NOT_READY;
        const [key, raw] = args;
        if (!key || raw == null) return { text: `ERR: usage: cloud.set <knob> <value> (knobs: ${Object.keys(HAND_CLOUD_DEFAULTS).join(' ')})`, data: null };
        try { c.set(key, parseKnob(key, raw)); } catch (e) { return { text: `ERR: ${e.message}`, data: null }; }
        return { text: `OK: ${key} = ${JSON.stringify(c.opts[key])}`, data: { [key]: c.opts[key] } };
    }, { description: 'Set one hand cloud tracker knob (takes hold next frame)', usage: '<knob> <value>' });

    router.register('cloud.get', (args, ctx) => {
        const c = cloud(ctx);
        if (!c) return NOT_READY;
        const key = args[0];
        if (key && !(key in c.opts)) return { text: `ERR: unknown knob '${key}'`, data: null };
        const data = key ? { [key]: c.opts[key] } : { ...c.opts };
        return {
            text: Object.entries(data).map(([k, v]) => `${k} = ${JSON.stringify(v)}${JSON.stringify(v) !== JSON.stringify(HAND_CLOUD_DEFAULTS[k]) ? `  (default ${JSON.stringify(HAND_CLOUD_DEFAULTS[k])})` : ''}`).join('\n'),
            data,
        };
    }, { description: 'Read the hand cloud tracker knobs (or one), marking what differs from the default', usage: '[knob]' });

    router.register('cloud.simulate', (args, ctx) => {
        const c = cloud(ctx);
        if (!c) return NOT_READY;
        const [cmd = 'on', arg] = args;
        const usage = `ERR: usage: cloud.simulate on [${SIM_MODES.join('|')}] | mode <mode> | bump [yawDeg] [tiltDeg] | off`;
        if (cmd === 'off') { c.simulate(null); return { text: 'OK: simulated depth source off', data: { simulating: false } }; }
        if (cmd === 'bump') {
            if (!c.simulating) return { text: 'ERR: not simulating — cloud.simulate on first', data: null };
            const yawDeg = Number(args[1] ?? 10), tiltDeg = Number(args[2] ?? 3);
            if (!Number.isFinite(yawDeg) || !Number.isFinite(tiltDeg)) return { text: usage, data: null };
            c.bump(yawDeg, tiltDeg);
            return { text: `OK: the simulated phone moved (yaw ${yawDeg}°, tilt ${tiltDeg}°)`, data: { yawDeg, tiltDeg } };
        }
        if (cmd !== 'on' && cmd !== 'mode') return { text: usage, data: null };
        const mode = cmd === 'mode' ? arg : (arg || 'wander');
        if (!SIM_MODES.includes(mode)) return { text: usage, data: null };
        if (cmd === 'mode' && !c.simulating) return { text: 'ERR: not simulating — cloud.simulate on first', data: null };
        c.simulate(mode);
        return { text: `OK: simulating a phone streaming depth crops — mode ${mode} (cloud.simulate off to stop)`, data: { simulating: mode } };
    }, {
        description: 'A simulated face-down phone streaming hand-wire v2 frames WITH depth crops (HandSim + DepthSim, in the tracker worker), injected like a device',
        usage: `on [${SIM_MODES.join('|')}] | mode <mode> | bump [yawDeg] [tiltDeg] | off`,
    });

    router.register('cloud.reset', (_args, ctx) => {
        const c = cloud(ctx);
        if (!c) return NOT_READY;
        c.reset();
        return { text: 'OK: hand cloud tracker restarts from Vision on the next frame', data: null };
    }, { description: "Forget the hand cloud tracker's temporal state (the next frame starts from Vision)" });
}
