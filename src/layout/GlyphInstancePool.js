/**
 * @deprecated This file is no longer used. Worker-based rendering provides
 * buffers directly via applyPrebuiltBuffers(). Safe to delete.
 *
 * GlyphInstancePool - Efficient instance data management
 *
 * Manages pre-allocated instance buffers for zero-allocation
 * rendering. Provides fast updates and memory efficiency.
 */

class GlyphInstancePool {
    /**
     * Create an instance pool
     * @param {number} maxInstances - Maximum number of instances
     */
    constructor(maxInstances) {
        this.maxInstances = maxInstances;

        // Pre-allocate typed arrays for instance attributes
        this.positions = new Float32Array(maxInstances * 3);
        this.sizes = new Float32Array(maxInstances * 2);
        this.uvs = new Float32Array(maxInstances * 4);
        this.colors = new Float32Array(maxInstances * 3);

        // Track active instances
        this.activeCount = 0;
        this.freeList = [];
        this.allocatedMap = new Map();

        // Initialize free list
        for (let i = maxInstances - 1; i >= 0; i--) {
            this.freeList.push(i);
        }

        // Performance tracking
        this.stats = {
            allocations: 0,
            deallocations: 0,
            peakUsage: 0,
            reuses: 0
        };
    }

    /**
     * Allocate space for new instances
     * @param {number} count - Number of instances needed
     * @returns {number} Starting index, or -1 if not enough space
     */
    allocate(count) {
        if (count > this.freeList.length) {
            console.warn(`GlyphInstancePool: Requested ${count} but only ${this.freeList.length} free`);
            return -1;
        }

        // For simplicity, allocate contiguous block from end of free list
        // In production, could use more sophisticated allocation strategy
        const indices = [];
        for (let i = 0; i < count; i++) {
            indices.push(this.freeList.pop());
        }

        // Track allocation
        const allocationId = this._generateId();
        this.allocatedMap.set(allocationId, indices);

        // Update stats
        this.activeCount += count;
        this.stats.allocations++;
        if (this.activeCount > this.stats.peakUsage) {
            this.stats.peakUsage = this.activeCount;
        }

        return indices[0]; // Return first index
    }

    /**
     * Free previously allocated instances
     * @param {number} allocationId - ID from allocate()
     */
    free(allocationId) {
        const indices = this.allocatedMap.get(allocationId);
        if (!indices) {
            console.warn(`GlyphInstancePool: Unknown allocation ${allocationId}`);
            return;
        }

        // Return indices to free list
        for (const index of indices) {
            this.freeList.push(index);
            // Clear data to avoid rendering garbage
            this._clearInstance(index);
        }

        // Remove from allocated map
        this.allocatedMap.delete(allocationId);
        this.activeCount -= indices.length;
        this.stats.deallocations++;
    }

    /**
     * Update instance data at specific index
     * @param {number} index - Instance index
     * @param {Object} data - Instance data {position, size, uv, color}
     */
    updateInstance(index, data) {
        if (index < 0 || index >= this.maxInstances) {
            console.warn(`GlyphInstancePool: Invalid index ${index}`);
            return;
        }

        // Update position
        if (data.position) {
            this.positions[index * 3] = data.position.x;
            this.positions[index * 3 + 1] = data.position.y;
            this.positions[index * 3 + 2] = data.position.z;
        }

        // Update size
        if (data.size) {
            this.sizes[index * 2] = data.size.width;
            this.sizes[index * 2 + 1] = data.size.height;
        }

        // Update UV
        if (data.uv) {
            this.uvs[index * 4] = data.uv.u0;
            this.uvs[index * 4 + 1] = data.uv.v0;
            this.uvs[index * 4 + 2] = data.uv.u1;
            this.uvs[index * 4 + 3] = data.uv.v1;
        }

        // Update color
        if (data.color) {
            this.colors[index * 3] = data.color.r;
            this.colors[index * 3 + 1] = data.color.g;
            this.colors[index * 3 + 2] = data.color.b;
        }
    }

    /**
     * Batch update instances from glyph array
     * @param {Array} glyphs - Array of glyph data
     * @param {number} startIndex - Starting index in pool
     */
    batchUpdate(glyphs, startIndex = 0) {
        const count = Math.min(glyphs.length, this.maxInstances - startIndex);

        for (let i = 0; i < count; i++) {
            const glyph = glyphs[i];
            const index = startIndex + i;

            // Position
            this.positions[index * 3] = glyph.position.x;
            this.positions[index * 3 + 1] = glyph.position.y;
            this.positions[index * 3 + 2] = glyph.position.z;

            // Size
            this.sizes[index * 2] = glyph.size.width;
            this.sizes[index * 2 + 1] = glyph.size.height;

            // UV
            this.uvs[index * 4] = glyph.uv.u0;
            this.uvs[index * 4 + 1] = glyph.uv.v0;
            this.uvs[index * 4 + 2] = glyph.uv.u1;
            this.uvs[index * 4 + 3] = glyph.uv.v1;

            // Color
            this.colors[index * 3] = glyph.color.r;
            this.colors[index * 3 + 1] = glyph.color.g;
            this.colors[index * 3 + 2] = glyph.color.b;
        }

        return count;
    }

    /**
     * Copy instance data to GPU buffers
     * @param {THREE.InstancedBufferGeometry} geometry - Target geometry
     * @param {number} count - Number of instances to copy
     */
    copyToGeometry(geometry, count) {
        const actualCount = Math.min(count, this.maxInstances);

        // Get attribute arrays
        const posAttr = geometry.attributes.instancePosition;
        const sizeAttr = geometry.attributes.instanceSize;
        const uvAttr = geometry.attributes.instanceUV;
        const colorAttr = geometry.attributes.instanceColor;

        // Copy data
        if (posAttr) {
            posAttr.array.set(this.positions.subarray(0, actualCount * 3));
            posAttr.needsUpdate = true;
        }

        if (sizeAttr) {
            sizeAttr.array.set(this.sizes.subarray(0, actualCount * 2));
            sizeAttr.needsUpdate = true;
        }

        if (uvAttr) {
            uvAttr.array.set(this.uvs.subarray(0, actualCount * 4));
            uvAttr.needsUpdate = true;
        }

        if (colorAttr) {
            colorAttr.array.set(this.colors.subarray(0, actualCount * 3));
            colorAttr.needsUpdate = true;
        }

        // Update instance count
        geometry.instanceCount = actualCount;
    }

    /**
     * Clear all instances
     */
    clear() {
        // Reset arrays
        this.positions.fill(0);
        this.sizes.fill(0);
        this.uvs.fill(0);
        this.colors.fill(0);

        // Reset allocation tracking
        this.freeList = [];
        for (let i = this.maxInstances - 1; i >= 0; i--) {
            this.freeList.push(i);
        }

        this.allocatedMap.clear();
        this.activeCount = 0;
    }

    /**
     * Defragment the pool (compact active instances)
     * @returns {Map} Map of old indices to new indices
     */
    defragment() {
        const remapping = new Map();
        const tempPositions = new Float32Array(this.positions);
        const tempSizes = new Float32Array(this.sizes);
        const tempUVs = new Float32Array(this.uvs);
        const tempColors = new Float32Array(this.colors);

        let newIndex = 0;

        // Compact active instances
        for (const [id, indices] of this.allocatedMap.entries()) {
            const newIndices = [];
            for (const oldIndex of indices) {
                // Copy data to new position
                this.positions.set(
                    tempPositions.subarray(oldIndex * 3, oldIndex * 3 + 3),
                    newIndex * 3
                );
                this.sizes.set(
                    tempSizes.subarray(oldIndex * 2, oldIndex * 2 + 2),
                    newIndex * 2
                );
                this.uvs.set(
                    tempUVs.subarray(oldIndex * 4, oldIndex * 4 + 4),
                    newIndex * 4
                );
                this.colors.set(
                    tempColors.subarray(oldIndex * 3, oldIndex * 3 + 3),
                    newIndex * 3
                );

                remapping.set(oldIndex, newIndex);
                newIndices.push(newIndex);
                newIndex++;
            }
            // Update allocation map with new indices
            this.allocatedMap.set(id, newIndices);
        }

        // Rebuild free list
        this.freeList = [];
        for (let i = this.maxInstances - 1; i >= newIndex; i--) {
            this.freeList.push(i);
        }

        return remapping;
    }

    /**
     * Get pool statistics
     * @returns {Object} Statistics
     */
    getStats() {
        return {
            ...this.stats,
            activeCount: this.activeCount,
            freeCount: this.freeList.length,
            utilization: (this.activeCount / this.maxInstances * 100).toFixed(1) + '%',
            fragmentation: this._calculateFragmentation()
        };
    }

    /**
     * Check if pool has space
     * @param {number} count - Number of instances needed
     * @returns {boolean} True if space available
     */
    hasSpace(count) {
        return this.freeList.length >= count;
    }

    // ============ Private Helpers ============

    /**
     * Clear instance data
     * @private
     */
    _clearInstance(index) {
        // Zero out all data for this instance
        this.positions[index * 3] = 0;
        this.positions[index * 3 + 1] = 0;
        this.positions[index * 3 + 2] = 0;

        this.sizes[index * 2] = 0;
        this.sizes[index * 2 + 1] = 0;

        this.uvs[index * 4] = 0;
        this.uvs[index * 4 + 1] = 0;
        this.uvs[index * 4 + 2] = 0;
        this.uvs[index * 4 + 3] = 0;

        this.colors[index * 3] = 0;
        this.colors[index * 3 + 1] = 0;
        this.colors[index * 3 + 2] = 0;
    }

    /**
     * Generate unique allocation ID
     * @private
     */
    _generateId() {
        return Date.now() + Math.random();
    }

    /**
     * Calculate fragmentation percentage
     * @private
     */
    _calculateFragmentation() {
        if (this.activeCount === 0) return 0;

        // Find highest used index
        let maxUsedIndex = 0;
        for (const indices of this.allocatedMap.values()) {
            for (const index of indices) {
                maxUsedIndex = Math.max(maxUsedIndex, index);
            }
        }

        // Fragmentation = wasted space / total used space
        const totalSpace = maxUsedIndex + 1;
        const wastedSpace = totalSpace - this.activeCount;
        return (wastedSpace / totalSpace * 100).toFixed(1) + '%';
    }
}

export default GlyphInstancePool;