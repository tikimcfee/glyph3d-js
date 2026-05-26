// app/commands/handlers/tourCommands.js

/**
 * Tour command namespace: tour.*
 *
 * Provides a step-based code tour system that resolves file references against
 * loaded CodeGrids, applies highlights and connection lines, and animates the camera.
 *
 * Commands:
 *   tour.load <base64-json>        Load tour from base64-encoded JSON
 *   tour.load.text <base64-text>   Parse raw text with parseAuto, wrap as single-step tour
 *   tour.next                      Advance to next step
 *   tour.prev                      Go to previous step
 *   tour.goto <step-index>         Jump to a specific step (0-based)
 *   tour.clear                     Clear the active tour and all its annotations
 *   tour.status                    Show current tour state
 */

import ConnectionRenderer from '@glyph3d/core/annotations/ConnectionRenderer.js';
import { parseAuto } from '@glyph3d/core/parsing/index.js';
import TourSequencer from '@glyph3d/core/services/tour/TourSequencer.js';
import { decodeBase64 } from '@glyph3d/core/utils/encoding.js';
import { getWorldBounds, resolveAnchor, animateCamera, frameBounds } from './spatialHelpers.js';

/**
 * Lazily initialize TourSequencer and ConnectionRenderer on the context bag.
 * ConnectionRenderer is a shared GPU resource: one instance per scene.
 * @param {Object} ctx - command context bag
 * @returns {TourSequencer}
 */
function getSequencer(ctx) {
    if (!ctx.connectionRenderer) {
        ctx.connectionRenderer = new ConnectionRenderer(ctx.scene);
    }
    if (!ctx._tourSequencer) {
        ctx._tourSequencer = new TourSequencer(ctx, {
            getWorldBounds, resolveAnchor, animateCamera, frameBounds,
        });
    }
    return ctx._tourSequencer;
}

/**
 * Strip non-serializable fields (CodeGrid instances, THREE objects) from a
 * TourStep so it can be safely JSON.stringify'd for WebSocket responses.
 */
function serializeStep(step) {
    return {
        id: step.id,
        title: step.title,
        description: step.description,
        refCount: step.refs?.length ?? 0,
        resolvedCount: step.refs?.filter(r => r.grid)?.length ?? 0,
        annotationCount: step.annotations?.length ?? 0,
        connectionCount: step.connections?.length ?? 0,
    };
}

/**
 * @param {import('../CommandRouter.js').default} router
 */
export default function registerTourCommands(router) {

    // ================================================================
    //  tour.load <base64-json>
    // ================================================================

    router.register('tour.load', (args, ctx) => {
        if (args.length < 1) {
            return { text: 'ERR: usage: tour.load <base64-json>', data: null };
        }

        let decoded;
        try { decoded = decodeBase64(args[0]); } catch {
            return { text: 'ERR: invalid base64 input', data: null };
        }

        let data;
        try {
            data = JSON.parse(decoded);
        } catch {
            // Not valid JSON — fall back to parseAuto text parsing
            const parseResult = parseAuto(decoded);
            const fileRefs = parseResult.refs.filter(pr => pr.ref.filePath);
            if (fileRefs.length === 0) {
                return { text: 'ERR: no file references found in text', data: null };
            }
            data = {
                id: 'auto-parsed',
                title: 'Auto-parsed references',
                steps: [{
                    title: 'Parsed references',
                    description: `${fileRefs.length} file reference(s) from input text`,
                    refs: fileRefs,
                }],
            };
        }

        // Normalize JSON refs: bare FileRef objects (with filePath at top level)
        // get wrapped into ParsedRef shape so TourResolver.resolveAll() works.
        if (data.steps) {
            for (const step of data.steps) {
                if (!step.refs) continue;
                step.refs = step.refs.map(r => {
                    if (r.ref) return r; // already a ParsedRef wrapper
                    // Bare FileRef — wrap it
                    return { ref: r, kind: 'file-ref', rawText: '', sourceLineIndex: 0, meta: null };
                });
            }
        }

        const seq = getSequencer(ctx);
        const result = seq.load(data);
        const warns = result.unresolved.length > 0
            ? ` (unresolved: ${result.unresolved.join(', ')})`
            : '';

        return {
            text: `OK: loaded tour with ${result.stepCount} steps${warns}`,
            data: result,
        };
    }, {
        description: 'Load a tour from base64-encoded JSON (falls back to parseAuto for non-JSON)',
        usage: '<base64-json>',
    });

    // ================================================================
    //  tour.load.text <base64-text>
    //  Explicit raw-text path: always runs parseAuto, always wraps in single-step tour.
    // ================================================================

    router.register('tour.load.text', (args, ctx) => {
        if (args.length < 1) {
            return { text: 'ERR: usage: tour.load.text <base64-text>', data: null };
        }

        let decoded;
        try { decoded = decodeBase64(args[0]); } catch {
            return { text: 'ERR: invalid base64 input', data: null };
        }

        const parseResult = parseAuto(decoded);
        const fileRefs = parseResult.refs.filter(pr => pr.ref.filePath);

        if (fileRefs.length === 0) {
            return { text: 'ERR: no file references found in text', data: null };
        }

        const data = {
            id: 'text-parsed',
            title: 'Text-parsed references',
            steps: [{
                title: 'Parsed references',
                description: `${fileRefs.length} file reference(s) from input text`,
                refs: fileRefs,
            }],
        };

        const seq = getSequencer(ctx);
        const result = seq.load(data);
        const warns = result.unresolved.length > 0
            ? ` (unresolved: ${result.unresolved.join(', ')})`
            : '';

        return {
            text: `OK: loaded text tour with ${result.stepCount} steps, ${fileRefs.length} refs${warns}`,
            data: result,
        };
    }, {
        description: 'Parse raw text for file references and load as single-step tour',
        usage: '<base64-text>',
    });

    // ================================================================
    //  tour.next
    // ================================================================

    router.register('tour.next', async (args, ctx) => {
        const seq = getSequencer(ctx);
        if (seq.state === 'idle') {
            return { text: 'ERR: no tour loaded', data: null };
        }
        try {
            const step = await seq.next();
            return {
                text: `OK: step ${seq.stepIndex + 1}/${seq.steps.length}: ${step.title}`,
                data: { index: seq.stepIndex, step: serializeStep(step) },
            };
        } catch (e) {
            return { text: `ERR: ${e.message}`, data: null };
        }
    }, { description: 'Advance to next tour step' });

    // ================================================================
    //  tour.prev
    // ================================================================

    router.register('tour.prev', async (args, ctx) => {
        const seq = getSequencer(ctx);
        if (seq.state === 'idle') {
            return { text: 'ERR: no tour loaded', data: null };
        }
        try {
            const step = await seq.prev();
            return {
                text: `OK: step ${seq.stepIndex + 1}/${seq.steps.length}: ${step.title}`,
                data: { index: seq.stepIndex, step: serializeStep(step) },
            };
        } catch (e) {
            return { text: `ERR: ${e.message}`, data: null };
        }
    }, { description: 'Go to previous tour step' });

    // ================================================================
    //  tour.goto <step-index>
    // ================================================================

    router.register('tour.goto', async (args, ctx) => {
        if (args.length < 1) {
            return { text: 'ERR: usage: tour.goto <step-index>', data: null };
        }
        const index = parseInt(args[0]);
        if (isNaN(index)) {
            return { text: 'ERR: step index must be a number', data: null };
        }

        const seq = getSequencer(ctx);
        if (seq.state === 'idle') {
            return { text: 'ERR: no tour loaded', data: null };
        }
        try {
            const step = await seq.goto(index);
            return {
                text: `OK: step ${index + 1}/${seq.steps.length}: ${step.title}`,
                data: { index, step: serializeStep(step) },
            };
        } catch (e) {
            return { text: `ERR: ${e.message}`, data: null };
        }
    }, {
        description: 'Jump to a specific tour step',
        usage: '<step-index>',
    });

    // ================================================================
    //  tour.clear
    // ================================================================

    router.register('tour.clear', (args, ctx) => {
        const seq = getSequencer(ctx);
        seq.clear();
        return { text: 'OK: tour cleared', data: null };
    }, { description: 'Clear the active tour and all its annotations' });

    // ================================================================
    //  tour.status
    // ================================================================

    router.register('tour.status', (args, ctx) => {
        const seq = getSequencer(ctx);
        return {
            text: seq.state === 'idle'
                ? 'OK: no tour loaded'
                : `OK: state=${seq.state}, step=${seq.stepIndex + 1}/${seq.steps.length}`,
            data: {
                state: seq.state,
                stepIndex: seq.stepIndex,
                stepCount: seq.steps.length,
                tourId: seq.tourData?.id || null,
            },
        };
    }, { description: 'Show current tour state' });

    // ================================================================
    //  tour.show <base64-text>
    //  One-shot: parse → resolve → highlight all → connect → frame camera.
    //  No steps, no sequencing. Just illuminate and let the user explore.
    // ================================================================

    router.register('tour.show', async (args, ctx) => {
        if (args.length < 1) {
            return { text: 'ERR: usage: tour.show <base64-text-or-json>', data: null };
        }

        let decoded;
        try { decoded = decodeBase64(args[0]); } catch {
            return { text: 'ERR: invalid base64 input', data: null };
        }

        // Parse: auto-detect format
        const parseResult = parseAuto(decoded);
        const fileRefs = parseResult.refs.filter(pr => pr.ref.filePath);
        if (fileRefs.length === 0) {
            return { text: 'ERR: no file references found in text', data: null };
        }

        // Wrap as single-step tour, load, and immediately activate
        const data = {
            id: 'show',
            title: 'show',
            steps: [{
                title: 'show',
                refs: fileRefs,
            }],
        };

        const seq = getSequencer(ctx);
        const result = seq.load(data);
        const step = await seq.goto(0);

        const resolved = step.refs.filter(r => r.grid).length;
        const warns = result.unresolved.length > 0
            ? ` (unresolved: ${result.unresolved.join(', ')})`
            : '';

        return {
            text: `OK: showing ${resolved}/${fileRefs.length} refs, ${step.connections.length} connections${warns}`,
            data: {
                totalRefs: fileRefs.length,
                resolved,
                connections: step.connections.length,
                unresolved: result.unresolved,
            },
        };
    }, {
        description: 'Parse text, highlight all referenced files, draw connections, frame camera',
        usage: '<base64-text>',
    });
}
