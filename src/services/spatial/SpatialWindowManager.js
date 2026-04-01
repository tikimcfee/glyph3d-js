/**
 * SpatialWindowManager -- group orchestrator for spatial window management.
 *
 * Connects to SceneRegistry (change listener for reconciliation),
 * SelectionManager (Z-pop propagation to group siblings),
 * FileStateManager (groupId property), and CodeColorManager (group-tint
 * color layer at priority 5).
 *
 * Single mutation path: WindowGroup + _gridToGroup + userData._windowGroup
 * + FileStateManager all in sync on every add/remove/dissolve.
 */

import { WindowGroup } from './WindowGroup.js';
import { Z_POP_AMOUNT } from '../interaction/SelectionManager.js';

// 8-color low-saturation palette for group tints
const GROUP_PALETTE = [
    { r: 0.25, g: 0.45, b: 0.65 },   // steel blue
    { r: 0.55, g: 0.35, b: 0.55 },   // muted purple
    { r: 0.35, g: 0.55, b: 0.45 },   // sage green
    { r: 0.60, g: 0.50, b: 0.30 },   // warm tan
    { r: 0.45, g: 0.55, b: 0.60 },   // slate teal
    { r: 0.55, g: 0.40, b: 0.40 },   // dusty rose
    { r: 0.40, g: 0.50, b: 0.35 },   // olive
    { r: 0.50, g: 0.45, b: 0.55 },   // lavender grey
];

/**
 * Deterministic color index from a group name string.
 * @param {string} name
 * @returns {number}
 */
function nameHash(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
    }
    return Math.abs(hash) % GROUP_PALETTE.length;
}

export class SpatialWindowManager {
    /**
     * @param {Object} opts
     * @param {SceneRegistry} opts.registry
     * @param {SelectionManager} opts.selectionManager
     * @param {FileStateManager} opts.fileStateManager
     * @param {CodeColorManager} opts.codeColorManager
     * @param {SpatialAnimator} opts.animator
     */
    constructor({ registry, selectionManager, fileStateManager, codeColorManager, animator }) {
        this._registry = registry;
        this._selectionManager = selectionManager;
        this._fileStateManager = fileStateManager;
        this._codeColorManager = codeColorManager;
        this._animator = animator;

        /** @type {Map<string, WindowGroup>} groupName -> WindowGroup */
        this._groups = new Map();

        /** @type {Map<string, string>} registryId -> groupName (reverse index) */
        this._gridToGroup = new Map();

        /** @type {Map<string, {r,g,b}>} groupName -> palette color */
        this._groupColors = new Map();

        /** @type {Map<string, number>} registryId -> saved Z before group Z-pop */
        this._groupOriginalZ = new Map();

        // -- Wire into SceneRegistry for member reconciliation --
        this._registryListener = (type) => {
            if (type === 'grid' || type === 'agent') {
                this._reconcileMembers();
            }
        };
        this._registry.addChangeListener(this._registryListener);

        // -- Wire into SelectionManager for group Z-pop propagation --
        this._selectionListener = (eventType, sourcePath, state) => {
            this._onSelectionChange(eventType, sourcePath, state);
        };
        this._selectionManager.on(this._selectionListener);

        // -- Register group-tint color layer --
        if (this._codeColorManager) {
            this._codeColorManager.registerLayer('group-tint', {
                priority: 5,
                watchProperties: ['groupId'],
                colorFn: (sourcePath, fileProps) => {
                    const groupId = fileProps?.groupId;
                    if (!groupId) return null;
                    return this._groupColors.get(groupId) || null;
                },
            });
        }
    }

    // ============ Group Lifecycle ============

    /**
     * Create a new named group.
     * @param {string} name
     * @returns {WindowGroup}
     */
    createGroup(name) {
        if (this._groups.has(name)) {
            return this._groups.get(name);
        }
        const group = new WindowGroup(name, this._animator);
        this._groups.set(name, group);
        this._groupColors.set(name, GROUP_PALETTE[nameHash(name)]);
        return group;
    }

    /**
     * Add a grid to a group by registry ID.
     * Single mutation path: all stores updated atomically.
     *
     * @param {string} groupName
     * @param {string} registryId
     */
    addToGroup(groupName, registryId) {
        const group = this._groups.get(groupName);
        if (!group) {
            console.warn(`[SpatialWindowManager] group "${groupName}" not found`);
            return;
        }

        // Remove from any existing group first
        const existingGroup = this._gridToGroup.get(registryId);
        if (existingGroup && existingGroup !== groupName) {
            this.removeFromGroup(existingGroup, registryId);
        }

        // (a) Add to WindowGroup.memberIds
        group.add(registryId);

        // (b) Update reverse index
        this._gridToGroup.set(registryId, groupName);

        // (c) Set userData._windowGroup on the grid Object3D
        const entry = this._registry.get(registryId);
        if (entry?.grid) {
            if (!entry.grid.userData) entry.grid.userData = {};
            entry.grid.userData._windowGroup = groupName;
        }

        // (d) Write groupId to FileStateManager
        const sourcePath = entry?.meta?.sourcePath || entry?.grid?.userData?.sourcePath;
        if (sourcePath && this._fileStateManager) {
            this._fileStateManager.setProperty(sourcePath, 'groupId', groupName);
        }
    }

    /**
     * Remove a grid from a group.
     * Inverse of addToGroup -- clears all three stores.
     *
     * @param {string} groupName
     * @param {string} registryId
     */
    removeFromGroup(groupName, registryId) {
        const group = this._groups.get(groupName);
        if (!group) return;

        // (a) Remove from WindowGroup.memberIds
        group.remove(registryId);

        // (b) Clear reverse index
        this._gridToGroup.delete(registryId);

        // (c) Clear userData._windowGroup
        const entry = this._registry.get(registryId);
        if (entry?.grid?.userData) {
            delete entry.grid.userData._windowGroup;
        }

        // (d) Clear groupId from FileStateManager
        const sourcePath = entry?.meta?.sourcePath || entry?.grid?.userData?.sourcePath;
        if (sourcePath && this._fileStateManager) {
            this._fileStateManager.setProperty(sourcePath, 'groupId', null);
        }

        // Auto-dissolve empty groups
        if (group.size === 0) {
            this._groups.delete(groupName);
            this._groupColors.delete(groupName);
        }
    }

    /**
     * Dissolve a group: remove all members, delete the group.
     * @param {string} name
     */
    dissolveGroup(name) {
        const group = this._groups.get(name);
        if (!group) return;

        // Work on a copy since removeFromGroup mutates memberIds
        const memberIds = [...group.memberIds];
        for (const id of memberIds) {
            this.removeFromGroup(name, id);
        }

        this._groups.delete(name);
        this._groupColors.delete(name);
    }

    // ============ Group Queries ============

    /**
     * Get the group name for a grid, or null.
     * @param {string} registryId
     * @returns {string|null}
     */
    getGroupForGrid(registryId) {
        return this._gridToGroup.get(registryId) || null;
    }

    /**
     * Get a WindowGroup by name.
     * @param {string} name
     * @returns {WindowGroup|null}
     */
    getGroup(name) {
        return this._groups.get(name) || null;
    }

    /**
     * Get all group names.
     * @returns {string[]}
     */
    getGroupNames() {
        return [...this._groups.keys()];
    }

    /**
     * Get the color assigned to a group.
     * @param {string} name
     * @returns {{ r: number, g: number, b: number }|null}
     */
    getGroupColor(name) {
        return this._groupColors.get(name) || null;
    }

    // ============ Group Operations ============

    /**
     * Set the layout mode for a group and apply it.
     * @param {string} groupName
     * @param {'stack'|'splay'|'free'} mode
     * @param {Object} [config] - layout config overrides
     * @param {number} [duration=0.3] - animation duration
     */
    setLayout(groupName, mode, config = {}, duration = 0.3) {
        const group = this._groups.get(groupName);
        if (!group) return;

        group.mode = mode;
        group.computeLayout(
            (id) => this._registry.get(id)?.grid || null,
            config,
            duration
        );
    }

    /**
     * Move all members of a group by a world-space delta.
     * Offset-preserving: each member moves by the same delta.
     *
     * @param {string} groupName
     * @param {number} dx - world X delta
     * @param {number} dy - world Y delta
     * @param {number} [dz=0] - world Z delta
     */
    moveGroupByDelta(groupName, dx, dy, dz = 0) {
        const group = this._groups.get(groupName);
        if (!group) return;

        for (const id of group.memberIds) {
            const entry = this._registry.get(id);
            if (entry?.grid) {
                entry.grid.position.x += dx;
                entry.grid.position.y += dy;
                entry.grid.position.z += dz;
            }
        }

        // Also move anchor
        group.anchor.x += dx;
        group.anchor.y += dy;
        group.anchor.z += dz;
    }

    /**
     * Hide all members of a group.
     * Sets userData._userHidden so GridVirtualizer removes them from scene.
     *
     * @param {string} name
     */
    hideGroup(name) {
        const group = this._groups.get(name);
        if (!group) return;

        for (const id of group.memberIds) {
            const entry = this._registry.get(id);
            if (entry?.grid) {
                if (!entry.grid.userData) entry.grid.userData = {};
                entry.grid.userData._userHidden = true;
            }
        }
    }

    /**
     * Show all members of a group (undo hideGroup).
     *
     * @param {string} name
     */
    showGroup(name) {
        const group = this._groups.get(name);
        if (!group) return;

        for (const id of group.memberIds) {
            const entry = this._registry.get(id);
            if (entry?.grid) {
                if (entry.grid.userData) {
                    delete entry.grid.userData._userHidden;
                }
            }
        }
    }

    // ============ Persistence ============

    /**
     * Serialize all groups for persistence.
     * Keyed by sourcePath (stable across sessions) not registry ID (regenerated).
     *
     * @returns {Object[]|null}
     */
    serialize() {
        if (this._groups.size === 0) return null;

        const groups = [];
        for (const [name, group] of this._groups) {
            const memberPaths = [];
            for (const id of group.memberIds) {
                const entry = this._registry.get(id);
                const sourcePath = entry?.meta?.sourcePath || entry?.grid?.userData?.sourcePath;
                if (sourcePath) memberPaths.push(sourcePath);
            }
            if (memberPaths.length > 0) {
                groups.push({
                    name,
                    layout: group.mode,
                    memberPaths,
                });
            }
        }
        return groups.length > 0 ? groups : null;
    }

    /**
     * Deserialize groups from persistence data.
     * Call after grids are loaded so registry lookups succeed.
     *
     * @param {Object[]|null} data
     */
    deserialize(data) {
        if (!data || !Array.isArray(data)) return;

        for (const groupData of data) {
            const { name, layout, memberPaths } = groupData;
            if (!name || !memberPaths?.length) continue;

            this.createGroup(name);

            for (const sourcePath of memberPaths) {
                // Find registry entry by sourcePath
                const entries = this._registry.findByMeta('sourcePath', sourcePath);
                if (entries.length > 0) {
                    this.addToGroup(name, entries[0].id);
                }
            }

            // Set layout mode (no animation on restore)
            const group = this._groups.get(name);
            if (group && layout && layout !== 'free') {
                group.mode = layout;
                group.computeLayout(
                    (id) => this._registry.get(id)?.grid || null,
                    {},
                    0  // instant on restore
                );
            }
        }
    }

    // ============ Lifecycle ============

    /**
     * Clear all groups (dissolve each). Keep the manager alive.
     */
    clear() {
        const names = [...this._groups.keys()];
        for (const name of names) {
            this.dissolveGroup(name);
        }
    }

    /**
     * Full cleanup -- unsubscribe from registry + selection listeners.
     */
    dispose() {
        this.clear();
        this._registry.removeChangeListener(this._registryListener);
        this._selectionManager.off(this._selectionListener);
    }

    // ============ Private ============

    /**
     * Reconcile group members against registry.
     * Removes stale IDs, auto-dissolves empty groups.
     * @private
     */
    _reconcileMembers() {
        for (const [name, group] of this._groups) {
            const stale = group.memberIds.filter(id => !this._registry.has(id));
            for (const id of stale) {
                this._gridToGroup.delete(id);
                group.remove(id);
            }
            if (group.size === 0) {
                this._groups.delete(name);
                this._groupColors.delete(name);
            }
        }
    }

    /**
     * Handle selection change — manage Z-pop for grouped grids independently.
     *
     * SelectionManager skips Z-pop for grouped grids (userData._windowGroup guard).
     * We own the Z state here via _groupOriginalZ, handling both select and
     * deselect/clear to avoid stale positions.
     * @private
     */
    _onSelectionChange(eventType, sourcePath, state) {
        if (eventType === 'select') {
            this._applyGroupZPop(sourcePath);
        } else if (eventType === 'deselect') {
            this._restoreGroupZPop(sourcePath);
        } else if (eventType === 'clear') {
            this._restoreAllGroupZPop();
        }
    }

    /** @private */
    _applyGroupZPop(sourcePath) {
        const registryId = this._findRegistryIdBySourcePath(sourcePath);
        if (!registryId) return;

        const groupName = this._gridToGroup.get(registryId);
        if (!groupName) return;

        const group = this._groups.get(groupName);
        if (!group) return;

        for (const id of group.memberIds) {
            const entry = this._registry.get(id);
            if (!entry?.grid) continue;

            // Save original Z (first-writer-wins — don't overwrite if already saved)
            if (!this._groupOriginalZ.has(id)) {
                this._groupOriginalZ.set(id, entry.grid.position.z);
            }
            entry.grid.position.z = this._groupOriginalZ.get(id) + Z_POP_AMOUNT;
        }
    }

    /** @private */
    _restoreGroupZPop(sourcePath) {
        const registryId = this._findRegistryIdBySourcePath(sourcePath);
        if (!registryId) return;

        const groupName = this._gridToGroup.get(registryId);
        if (!groupName) return;

        const group = this._groups.get(groupName);
        if (!group) return;

        // Check if any OTHER member of this group is still selected
        for (const id of group.memberIds) {
            if (id === registryId) continue;
            const entry = this._registry.get(id);
            const path = entry?.meta?.sourcePath || entry?.grid?.userData?.sourcePath;
            if (path && this._selectionManager.isSelected(path)) return; // group still partially selected
        }

        // No other members selected — restore all
        for (const id of group.memberIds) {
            const originalZ = this._groupOriginalZ.get(id);
            if (originalZ === undefined) continue;
            const entry = this._registry.get(id);
            if (entry?.grid) {
                entry.grid.position.z = originalZ;
            }
            this._groupOriginalZ.delete(id);
        }
    }

    /** @private */
    _restoreAllGroupZPop() {
        for (const [id, originalZ] of this._groupOriginalZ) {
            const entry = this._registry.get(id);
            if (entry?.grid) {
                entry.grid.position.z = originalZ;
            }
        }
        this._groupOriginalZ.clear();
    }

    /**
     * Find a registry ID by sourcePath.
     * @private
     * @param {string} sourcePath
     * @returns {string|null}
     */
    _findRegistryIdBySourcePath(sourcePath) {
        for (const [id] of this._gridToGroup) {
            const entry = this._registry.get(id);
            const entryPath = entry?.meta?.sourcePath || entry?.grid?.userData?.sourcePath;
            if (entryPath === sourcePath) return id;
        }
        return null;
    }
}

export default SpatialWindowManager;
