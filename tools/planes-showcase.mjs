#!/usr/bin/env bun
/**
 * tools/planes-showcase.mjs — One-command walkthrough of the `planes` branch over the command bus.
 *
 * Steps through the live desks (reading, depth-probe + parallax fan, an agent team desk + channel,
 * and the gomux hub), reporting each feature's live bus state and restoring the starting plane desk
 * when finished.
 *
 * Usage:
 *   bun tools/planes-showcase.mjs [--port 8080] [--dwell 1200] [--no-camera]
 */

import { dialRelay } from './lib/relay.mjs';

function parseArgs(argv) {
    let port = 8080;
    let dwellMs = 1200;
    let noCamera = false;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--port' && argv[i + 1]) {
            port = Number(argv[++i]) || 8080;
        } else if (a === '--dwell' && argv[i + 1]) {
            dwellMs = Math.max(0, Number(argv[++i]) || 0);
        } else if (a === '--no-camera' || a === '--read-only') {
            noCamera = true;
        }
    }
    return { port, dwellMs, noCamera };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
    const { port, dwellMs, noCamera } = parseArgs(process.argv.slice(2));
    const relay = await dialRelay(port);

    try {
        console.log(`=== Planes Showcase (ws://localhost:${port}${noCamera ? ', read-only' : ''}) ===\n`);

        const initPlane = await relay.request('plane.state');
        const initialTarget = initPlane.data?.target ?? null;

        const carrelRes = await relay.request('carrel.list');
        const carrels = carrelRes.data?.carrels ?? [];
        console.log(`[1/6] Desks (${carrels.length} total):`);
        for (const c of carrels.slice(0, 8)) {
            console.log(`  - ${c.name} (${c.members?.length ?? 0} member(s))${c.active ? ' [active]' : ''}`);
        }

        const surfacesRes = await relay.request('agent.surfaces');
        console.log(`\n[2/6] Agent-owned surfaces:\n  ${(surfacesRes.text || '').replace(/\n/g, '\n  ')}`);

        const channelRes = await relay.request('team.channel');
        console.log(`\n[3/6] Team channels:\n  ${channelRes.text}`);

        const layersRes = await relay.request('layer.list');
        console.log(`\n[4/6] Depth-as-time layer stacks:\n  ${layersRes.text}`);

        const pointsRes = await relay.request('point.list');
        const waitingRes = await relay.request('agent.waiting');
        console.log(`\n[5/6] Deixis & waiting state:\n  ${pointsRes.text}\n  ${waitingRes.text}`);

        if (noCamera) {
            console.log(`\n[6/6] Current plane state:\n  ${initPlane.text}`);
            console.log('\n=== Showcase complete (read-only) ===');
            return;
        }

        // Pick up to 3 representative desks to visit before returning to initialTarget.
        const byName = new Map(carrels.map((c) => [c.name, c]));
        const stops = [];
        if (byName.has('reading')) stops.push({ name: 'reading', note: 'Pin-board reading desk (1:1 device-pixel text columns)' });
        if (byName.has('depth-probe')) stops.push({ name: 'depth-probe', note: 'Depth-as-time desk (layer stack + parallax fan)', fan: true });
        const teamDesk = carrels.find((c) => c.name.startsWith('gomux/') && (c.members?.length ?? 0) >= 2);
        if (teamDesk) stops.push({ name: teamDesk.name, note: 'Agent team plane desk (scroll book + live screen + owned surfaces)' });

        console.log(`\n[6/6] Stepping through ${stops.length} desk(s) (dwell=${dwellMs}ms):`);
        for (const stop of stops) {
            const enter = await relay.request(`carrel.enter ${stop.name}`);
            const st = await relay.request('plane.state');
            console.log(`  -> ${stop.name}: ${stop.note}`);
            console.log(`     ${enter.text}`);
            console.log(`     ${st.text}`);
            await sleep(dwellMs);

            if (stop.fan) {
                const fanOn = await relay.request('plane.fov 18');
                console.log(`     [fan] ${fanOn.text}`);
                await sleep(Math.min(dwellMs, 900));
                const fanOff = await relay.request('plane.fov default');
                console.log(`     [fan] ${fanOff.text}`);
            }
        }

        // Restore the starting plane target if there was one.
        if (initialTarget) {
            if (initialTarget.startsWith('carrel:')) {
                await relay.request(`carrel.enter ${initialTarget.slice(7)}`);
            } else {
                await relay.request(`plane.enter ${initialTarget}`);
            }
            console.log(`\nRestored starting view: ${initialTarget}`);
        } else if (stops.length > 0) {
            await relay.request('carrel.leave');
            console.log('\nRestored open-world view.');
        }

        console.log('\n=== Showcase complete ===');
    } finally {
        relay.close();
    }
}

main().catch((err) => {
    console.error(`ERR: ${err?.message || err}`);
    process.exit(1);
});
