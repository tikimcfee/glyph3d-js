/**
 * gestureResolver — the responder chain: what does this gesture MEAN right now?
 *
 * resolve(gesture, env) walks the InteractionContext nodes innermost-out; each
 * node KIND has a policy whose handler either claims the gesture (does the work,
 * returns true) or declines (returns false → the gesture bubbles outward). A
 * gesture nobody claims lands in the ROOT tier — the context-free meanings.
 * UIKit's responder chain / DOM event bubbling, over our state nodes.
 *
 * Statechart PATTERN, not a statechart owner: policies emit verbs onto the
 * command bus (env.exec) and never mutate state directly, so the bus stays the
 * single transition log and context.info stays truthful. The context nodes are
 * the derived projection (InteractionContext); this layer only decides which
 * verbs a gesture fires.
 *
 * Deliberately the THINNEST mechanism that expresses the chain: a policy is a
 * plain function `(gesture, node, env) → claimed?`. No rule DSL, no matchers —
 * each policy reads like the inline code it replaced and can collapse back into
 * one in minutes if the abstraction stops paying.
 *
 * gesture = { type: 'click' | 'dblclick', target: registryEntry | null }
 *   target is a CO-EQUAL input to context: the keyboard goes to the locked
 *   context, but the pointer can address anything in the field. A node's policy
 *   typically claims only gestures targeting ITS entity and declines the rest —
 *   the decline IS "retarget as fresh focus", formalized (root handles it).
 *
 * env = { exec, attention, placeCaretFromPointer }
 *   exec: (cmd) => router.execute(cmd) — verbs only, never direct mutation.
 *
 * NOT in the chain (the always tier lives in its own components, on purpose):
 * camera orbit/pan drag, wheel-scroll-by-hover, Ctrl-drag move, grip resize.
 * Modal-izing those would recreate "where did my WASD go" at scale.
 */

/** Re-affirm primary; camera flight belongs to a focus CHANGE only. */
function flyIfChanged(env, id) {
    const prev = env.attention.get('primary')?.id;
    env.exec(`attention.set primary ${id}`);
    if (id !== prev) env.exec(`camera.focus ${id}`);
}

const POLICIES = {
    // The doc being edited: clicks inside it move the caret and never drop edit.
    edit: {
        click(g, node, env) {
            if (g.target?.id !== node.id) return false; // a different target → bubble (fresh focus)
            // A 'sticky edit' user policy (config plane) would claim the foreign-target
            // case above instead of declining — the one-line seam for that snowflake.
            flyIfChanged(env, node.id);
            env.exec(`attention.set key ${node.id}`);
            env.placeCaretFromPointer(g.target);
            return true;
        },
        dblclick(g, node, env) {
            if (g.target?.id !== node.id) return false;
            env.exec(`attention.set primary ${node.id}`);
            env.placeCaretFromPointer(g.target);
            return true;
        },
    },

    // A non-edit keyboard hold (terminal): clicking it re-affirms the capture.
    key: {
        click(g, node, env) {
            if (g.target?.id !== node.id) return false;
            flyIfChanged(env, node.id);
            env.exec(`attention.set key ${node.id}`);
            return true;
        },
    },

    // Plain focus: re-clicking the focused entity re-affirms without flying
    // (same id → no flight) and keeps the keyboard free.
    focus: {
        click(g, node, env) {
            if (g.target?.id !== node.id) return false;
            flyIfChanged(env, node.id);
            env.exec('attention.set key none');
            return true;
        },
    },
};

// Context-free meanings — what a gesture does when no locked state claims it.
const ROOT = {
    click(g, env) {
        if (!g.target) { env.exec('attention.set key none'); return true; } // empty space frees the keyboard
        flyIfChanged(env, g.target.id);
        // Terminals take keyboard focus on click (type immediately); grids get
        // visual focus only — entering edit is the deliberate dblclick gesture.
        env.exec(g.target.type === 'terminal'
            ? `attention.set key ${g.target.id}`
            : 'attention.set key none');
        return true;
    },
    dblclick(g, env) {
        if (g.target?.type !== 'grid') return false; // terminals: single click already captured
        env.exec(`attention.set primary ${g.target.id}`);
        env.placeCaretFromPointer(g.target).then((placed) => {
            if (!placed) env.exec(`edit.start ${g.target.id}`); // panel-not-glyph → EOF caret
        });
        return true;
    },
};

/**
 * Walk the chain: innermost node → outward → root tier.
 * @param {{type: string, target: object|null}} gesture
 * @param {{exec: Function, attention: object, context: object, placeCaretFromPointer: Function}} env
 * @returns {boolean} whether anything claimed the gesture
 */
export function resolveGesture(gesture, env) {
    const nodes = env.context?.nodes() ?? [];
    for (let i = nodes.length - 1; i >= 0; i--) {
        const handler = POLICIES[nodes[i].kind]?.[gesture.type];
        if (handler && handler(gesture, nodes[i], env)) return true;
    }
    return ROOT[gesture.type]?.(gesture, env) ?? false;
}
