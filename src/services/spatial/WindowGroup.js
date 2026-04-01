/**
 * WindowGroup -- logical grouping of windows with layout modes.
 *
 * Does NOT own the windows -- stores ordered array of registry IDs.
 * Layout functions are module-private pure functions that compute
 * target positions from member info arrays.
 *
 * Bounds always use Box3 min/max (never .width/.height).
 */

import * as THREE from 'three';

// ──────────────────────────────────────────────────────────────
//  Layout Functions (pure, module-private)
// ──────────────────────────────────────────────────────────────

/**
 * Extract width/height from a Box3 using min/max.
 * @param {THREE.Box3} box
 * @returns {{ width: number, height: number }}
 */
function boundsFromBox3(box) {
    return {
        width:  box.max.x - box.min.x,
        height: box.max.y - box.min.y,
    };
}

/**
 * @typedef {Object} MemberInfo
 * @property {string} id - registry ID
 * @property {THREE.Object3D} grid - the Object3D
 * @property {THREE.Box3|null} bounds - world-space bounds
 */

/**
 * @typedef {Object} TargetPosition
 * @property {string} id - registry ID
 * @property {{ x: number, y: number, z: number }} position
 */

/**
 * Stack layout: all windows stacked at the anchor with slight Z offsets.
 * Creates a card-stack appearance where each successive member is offset
 * slightly in Z and diagonally so the title bars peek out.
 *
 * @param {MemberInfo[]} members
 * @param {{ x: number, y: number, z: number }} anchor
 * @param {Object} [config]
 * @param {number} [config.zStep=2] - Z offset per card
 * @param {number} [config.peekX=3] - X peek per card
 * @param {number} [config.peekY=-3] - Y peek per card
 * @returns {TargetPosition[]}
 */
function stackLayout(members, anchor, config = {}) {
    const zStep = config.zStep ?? 1.5;
    const peekX = config.peekX ?? 1.5;
    const peekY = config.peekY ?? -1.5;

    return members.map((m, i) => ({
        id: m.id,
        position: {
            x: anchor.x + i * peekX,
            y: anchor.y + i * peekY,
            z: anchor.z + i * zStep,
        },
    }));
}

/**
 * Splay layout: fan windows outward from the anchor.
 * Each window is offset along the X axis with optional angular rotation
 * (rotation not applied here -- just positional fan).
 *
 * @param {MemberInfo[]} members
 * @param {{ x: number, y: number, z: number }} anchor
 * @param {Object} [config]
 * @param {number} [config.spacing=20] - X spacing between windows
 * @returns {TargetPosition[]}
 */
function splayLayout(members, anchor, config = {}) {
    const spacing = config.spacing ?? 20;
    const totalWidth = (members.length - 1) * spacing;
    const startX = anchor.x - totalWidth / 2;

    return members.map((m, i) => ({
        id: m.id,
        position: {
            x: startX + i * spacing,
            y: anchor.y,
            z: anchor.z,
        },
    }));
}

/**
 * Horizontal layout: grids side-by-side in a row, spaced by actual widths.
 *
 * @param {MemberInfo[]} members
 * @param {{ x: number, y: number, z: number }} anchor
 * @param {Object} [config]
 * @param {number} [config.gap=10] - gap between grids
 * @returns {TargetPosition[]}
 */
function horizontalLayout(members, anchor, config = {}) {
    const gap = config.gap ?? 10;
    const targets = [];
    let cursorX = anchor.x;

    for (const m of members) {
        targets.push({
            id: m.id,
            position: { x: cursorX, y: anchor.y, z: anchor.z },
        });
        if (m.bounds && !m.bounds.isEmpty()) {
            cursorX += boundsFromBox3(m.bounds).width + gap;
        } else {
            cursorX += 50 + gap;
        }
    }
    return targets;
}

/**
 * Vertical layout: grids top-to-bottom, spaced by actual heights.
 *
 * @param {MemberInfo[]} members
 * @param {{ x: number, y: number, z: number }} anchor
 * @param {Object} [config]
 * @param {number} [config.gap=8] - gap between grids
 * @returns {TargetPosition[]}
 */
function verticalLayout(members, anchor, config = {}) {
    const gap = config.gap ?? 8;
    const targets = [];
    let cursorY = anchor.y;

    for (const m of members) {
        targets.push({
            id: m.id,
            position: { x: anchor.x, y: cursorY, z: anchor.z },
        });
        if (m.bounds && !m.bounds.isEmpty()) {
            cursorY -= boundsFromBox3(m.bounds).height + gap;
        } else {
            cursorY -= 30 + gap;
        }
    }
    return targets;
}

/**
 * Free layout: no position changes -- each window stays where it is.
 *
 * @param {MemberInfo[]} members
 * @returns {TargetPosition[]}
 */
function freeLayout(members) {
    return members.map(m => ({
        id: m.id,
        position: {
            x: m.grid.position.x,
            y: m.grid.position.y,
            z: m.grid.position.z,
        },
    }));
}

const LAYOUT_FNS = {
    stack:      stackLayout,
    splay:      splayLayout,
    horizontal: horizontalLayout,
    vertical:   verticalLayout,
    free:       freeLayout,
};

// ──────────────────────────────────────────────────────────────
//  WindowGroup Class
// ──────────────────────────────────────────────────────────────

export class WindowGroup {
    /**
     * @param {string} id - group name
     * @param {SpatialAnimator} animator
     */
    constructor(id, animator) {
        this.id = id;
        this._animator = animator;

        /** @type {string[]} ordered registry IDs */
        this.memberIds = [];

        /** @type {'stack'|'splay'|'free'|'horizontal'|'vertical'} */
        this.mode = 'free';

        /** @type {{ x: number, y: number, z: number }} */
        this.anchor = { x: 0, y: 0, z: 0 };

        /** @type {Object} layout config overrides */
        this.config = {};

        /** Pre-allocated Box3 for getBounds() */
        this._boundsBox = new THREE.Box3();
    }

    /**
     * Add a member ID if not already present.
     * @param {string} registryId
     */
    add(registryId) {
        if (this.memberIds.includes(registryId)) return;
        this.memberIds.push(registryId);
    }

    /**
     * Remove a member ID.
     * @param {string} registryId
     */
    remove(registryId) {
        const idx = this.memberIds.indexOf(registryId);
        if (idx !== -1) this.memberIds.splice(idx, 1);
    }

    /**
     * Check if this group contains a member.
     * @param {string} registryId
     * @returns {boolean}
     */
    has(registryId) {
        return this.memberIds.includes(registryId);
    }

    /** @returns {number} */
    get size() { return this.memberIds.length; }

    /**
     * Compute layout targets for the current mode and animate members.
     *
     * @param {Function} gridLookup - (registryId) => Object3D|null
     * @param {Object} [config] - layout config overrides
     * @param {number} [duration=0.3] - animation duration in seconds
     * @returns {TargetPosition[]}
     */
    computeLayout(gridLookup, config = {}, duration = 0.3, { preserveAnchor = false } = {}) {
        const memberInfos = this._resolveMemberInfos(gridLookup);
        if (memberInfos.length === 0) return [];

        // Update anchor to the centroid — skip when a new member is joining
        // so existing members stay in place and the newcomer flows in.
        if (this.mode !== 'free' && !preserveAnchor) {
            this._updateAnchor(memberInfos);
        }

        const mergedConfig = { ...this.config, ...config };
        const layoutFn = LAYOUT_FNS[this.mode] || freeLayout;
        const targets = layoutFn(memberInfos, this.anchor, mergedConfig);

        // Animate each member to its target position
        if (this._animator && this.mode !== 'free') {
            const batch = targets.map(t => {
                const grid = gridLookup(t.id);
                if (!grid) return null;
                return { object: grid, property: 'position', target: t.position, opts: { duration } };
            }).filter(Boolean);
            this._animator.animateBatch(batch);
        }

        return targets;
    }

    /**
     * Compute the union bounding box of all members.
     * Uses the pre-allocated _boundsBox for zero-allocation.
     *
     * @param {Function} gridLookup - (registryId) => Object3D|null
     * @returns {THREE.Box3}
     */
    getBounds(gridLookup) {
        this._boundsBox.makeEmpty();
        for (const id of this.memberIds) {
            const grid = gridLookup(id);
            if (!grid) continue;
            const bounds = grid.getBounds?.();
            if (bounds && !bounds.isEmpty()) {
                this._boundsBox.union(bounds);
            }
        }
        return this._boundsBox;
    }

    // -- Private --

    /**
     * Resolve member IDs to MemberInfo objects.
     * @private
     */
    _resolveMemberInfos(gridLookup) {
        const infos = [];
        for (const id of this.memberIds) {
            const grid = gridLookup(id);
            if (!grid) continue;
            const bounds = grid.getBounds?.() ?? null;
            infos.push({ id, grid, bounds });
        }
        return infos;
    }

    /**
     * Update anchor to the centroid of current member positions.
     * @private
     */
    _updateAnchor(memberInfos) {
        if (memberInfos.length === 0) return;
        let sx = 0, sy = 0, sz = 0;
        for (const m of memberInfos) {
            sx += m.grid.position.x;
            sy += m.grid.position.y;
            sz += m.grid.position.z;
        }
        this.anchor.x = sx / memberInfos.length;
        this.anchor.y = sy / memberInfos.length;
        this.anchor.z = sz / memberInfos.length;
    }
}

export default WindowGroup;
