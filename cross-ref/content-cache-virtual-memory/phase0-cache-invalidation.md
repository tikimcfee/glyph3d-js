# Phase 0: Persistent Content Cache — Invalidation Design

## 1. Cache Key Design

The current in-memory cache keys (`RepositoryContentCache.makeKey`, line 37) are:
```
file:owner/repo@branch:path
```

This is **branch-name-keyed** — a fatal flaw for persistence. `main` today != `main` tomorrow.

**Persistent cache key**: use the **blob SHA** from the tree response.

```
blob:{sha}
```

The tree response (`_parseTreeResponse`, GitHubRepositorySource.js line 608-625) already provides per-file SHAs:
```js
tree: data.tree.map(item => ({
    path: item.path,
    sha: item.sha,   // <-- git blob SHA, content-addressable
    size: item.size,
    ...
}))
```

Git blob SHAs are content hashes. Two files with identical content have the same SHA regardless of repo, branch, or path. This means:
- **Same file, different branch** — if content is identical, same SHA, cache hit.
- **Same path, content changed** — different SHA, cache miss (correct).
- **Fork with unmodified file** — same SHA, cache hit (free cross-repo dedup).

The lookup index is a separate concern: `owner/repo@treeSha` → mapping of `{path → blobSha}`.

## 2. Staleness Detection

The tree SHA (`data.sha` at line 614) is the root hash of the entire tree. If ANY file changes, the tree SHA changes. This gives us a single check:

**On session start / repo load:**
1. Fetch the tree (1 API call, already required by `loadRepository` at GitHubRepoViewer.js line 922).
2. Compare the returned `tree.sha` against the cached tree SHA for `owner/repo@branch`.
3. If match → every cached blob is still valid. Skip all file fetches.
4. If mismatch → diff the old tree's `{path→sha}` map against the new one. Only fetch files whose SHA changed.

**Cost of staleness check**: zero extra API calls. The tree fetch is already mandatory — it's how the app discovers what files exist. The staleness check is a pure in-memory comparison after that fetch.

**Raw URL problem**: `fetchRawFile` (line 308-359) returns `sha: null` — raw.githubusercontent.com doesn't provide blob SHAs. But the tree already gave us the SHA for every file. The adapter just needs to thread it through. In `streamFiles` (line 131-135), the tree item's `sha` is already yielded:
```js
yield { path: file.path, content: content.content, size: file.size, sha: file.sha };
```

So the SHA is available at the point of caching — it comes from the tree, not the file fetch.

## 3. IndexedDB Schema

Two object stores:

### `blobs` — content-addressed file storage
```
Key:    blob SHA (string, 40 hex chars)
Value:  { content: string, size: number, storedAt: number }
Index:  storedAt (for LRU eviction)
```

No path, no repo, no branch in the value. Pure content by hash. A 4KB file stored once regardless of how many repos/branches reference it.

### `treeMaps` — maps tree SHA to path→blobSha index
```
Key:    "owner/repo@branch" (string)
Value:  { treeSha: string, paths: { [path]: blobSha }, storedAt: number, fileCount: number }
```

This is small (~50 bytes per file path). A 1500-file repo = ~75KB for the tree map. Storing by `owner/repo@branch` allows instant comparison on next load.

### Why not one store?

Deduplication. If you switch from `main` to `feature-branch` and 1400/1500 files are identical, those 1400 blob SHAs already exist. The tree map diff tells you to fetch only 100 files.

### Database initialization:
```js
const db = await openDB('glyph3d-content', 1, {
  upgrade(db) {
    const blobs = db.createObjectStore('blobs');  // keyPath: inline key (sha)
    blobs.createIndex('storedAt', 'storedAt');

    const trees = db.createObjectStore('treeMaps'); // keyPath: inline key
  }
});
```

## 4. Eviction Policy

**Strategy: LRU by blob, with size awareness.**

- **Budget**: 100 MB soft limit (safe for mobile; desktop can go higher).
- **Track**: running total of stored bytes (maintained in a lightweight `meta` store or in-memory on open).
- **Evict when**: total exceeds budget OR IndexedDB write throws `QuotaExceededError`.
- **Evict what**: blobs with the oldest `storedAt` timestamp, in batches of 50.
- **Never evict**: blobs referenced by the current session's tree map (pin active repo).
- **Tree maps**: evict when their repo hasn't been loaded in 30 days. Small enough that aggressive eviction isn't needed.

```js
async evictIfNeeded(bytesNeeded) {
    if (this._totalBytes + bytesNeeded < this._budget) return;

    const tx = this.db.transaction('blobs', 'readwrite');
    const index = tx.store.index('storedAt');
    let cursor = await index.openCursor();  // oldest first
    let freed = 0;

    while (cursor && this._totalBytes + bytesNeeded - freed > this._budget) {
        if (!this._pinnedShas.has(cursor.key)) {
            freed += cursor.value.size;
            await cursor.delete();
        }
        cursor = await cursor.continue();
    }
    this._totalBytes -= freed;
}
```

On `QuotaExceededError` during write: trigger emergency eviction (drop 25% of oldest blobs), then retry once.

## 5. Integration with RepositoryAdapter

The persistent cache sits **below** the in-memory cache, not beside it. The lookup chain:

```
request → RepositoryContentCache (in-memory, <5min TTL)
        → PersistentContentCache (IndexedDB, SHA-validated)
        → GitHub API / raw.githubusercontent.com
```

**Modified `getFileContent`** (RepositoryAdapter.js, line 240-275):

```js
async getFileContent(owner, repo, path, branch = 'main') {
    this.stats.totalRequests++;

    const cacheKey = RepositoryContentCache.makeKey('file', owner, repo, path, branch);

    // L1: in-memory (fast, session-scoped)
    const memCached = await this.cache.get(cacheKey);
    if (memCached) {
        this.stats.cacheHits++;
        return memCached;
    }

    // L2: IndexedDB (persistent, SHA-keyed)
    const blobSha = this._getBlobSha(owner, repo, branch, path);
    if (blobSha && this.persistentCache) {
        const persisted = await this.persistentCache.getBlob(blobSha);
        if (persisted) {
            // Promote to L1
            const file = { content: persisted.content, size: persisted.size,
                           sha: blobSha, path, name: path.split('/').pop() };
            await this.cache.set(cacheKey, file);
            this.stats.cacheHits++;
            return file;
        }
    }

    // L3: network fetch
    const file = await this._fetchFromNetwork(owner, repo, path, branch);
    if (file && blobSha && this.persistentCache) {
        // Write-through to IndexedDB (fire and forget)
        this.persistentCache.putBlob(blobSha, file.content, file.size);
    }
    return file;
}
```

**`_getBlobSha`** looks up the path in the loaded tree map:
```js
_getBlobSha(owner, repo, branch, path) {
    const tree = this._currentTree;
    if (!tree) return null;
    const item = tree.tree.find(t => t.path === path);
    return item?.sha || null;
}
```

For repos with 1500+ files, this linear scan should be replaced with a Map built once at tree load time — `this._pathToSha = new Map(tree.tree.map(t => [t.path, t.sha]))`.

**On `loadRepository`** (before file fetching begins):
1. Fetch tree from GitHub (already happens, line 922).
2. Load stored tree map from IndexedDB for `owner/repo@branch`.
3. Compare `storedTreeMap.treeSha` vs `fetchedTree.sha`.
4. If match: all blob SHAs are valid — every file fetch will hit L2.
5. If mismatch: diff the path→sha maps to identify changed files. Only those need network.
6. Save the new tree map to IndexedDB.

## 6. Edge Cases

### Force push
A force push changes the tree SHA. The staleness check (section 2) catches this automatically — tree SHA mismatch triggers a diff. Files whose blob SHA changed get re-fetched. Files with the same content (same blob SHA) remain cached. No special handling needed.

### Branch switch
Different branch = different tree map key (`owner/repo@main` vs `owner/repo@feature`). Each branch has its own tree map, but they share the blob store. Switching branches with 90% shared files means 90% cache hits from existing blobs.

### Repo switch
Different repo = different tree map key. Blobs are content-addressed, so even cross-repo dedup works (forks share most content). The eviction policy pins the active repo's blobs.

### Offline use
If the tree fetch fails (no network): fall back to the stored tree map. Load all files from L2 cache. The content may be stale, but stale content is better than nothing. Flag the UI that content may be outdated.

```js
async loadRepository(url) {
    let tree;
    try {
        tree = await this.source.fetchTree(owner, repo, branch);
    } catch (e) {
        if (this.persistentCache) {
            const stored = await this.persistentCache.getTreeMap(`${owner}/${repo}@${branch}`);
            if (stored) {
                tree = stored;  // offline fallback
                this._offlineMode = true;
            }
        }
        if (!tree) throw e;
    }
}
```

### Partial cache (some blobs evicted)
The tree map says file X has SHA `abc123`, but that blob was evicted. No problem — L2 miss, falls through to L3 network fetch, re-populates the blob. The tree map doesn't need updating.

### Very large files
Files >1 MB should be stored with lower priority (evict first). The `storedAt` timestamp handles this naturally if large files are accessed less frequently, but a size-weighted eviction score would be better:
```js
evictionScore = lastAccessAge * Math.log2(sizeBytes)
```

### Multiple tabs
IndexedDB supports concurrent access. Two tabs loading the same repo will both write the same blob SHAs (idempotent — content-addressed). No locking needed. The in-memory L1 cache is per-tab.

## 7. Code Sketch: PersistentContentCache

```js
/**
 * PersistentContentCache — IndexedDB-backed content-addressed blob store.
 *
 * Keys are git blob SHAs. Content is deduplicated across repos/branches.
 * Tree maps track which SHAs belong to which repo@branch state.
 */
const DB_NAME = 'glyph3d-content';
const DB_VERSION = 1;
const BLOB_STORE = 'blobs';
const TREE_STORE = 'treeMaps';
const DEFAULT_BUDGET = 100 * 1024 * 1024; // 100 MB

export class PersistentContentCache {
    constructor(options = {}) {
        this.db = null;
        this._budget = options.budget || DEFAULT_BUDGET;
        this._totalBytes = 0;
        this._pinnedShas = new Set();
        this._ready = this._open();
    }

    async _open() {
        this.db = await new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(BLOB_STORE)) {
                    const blobs = db.createObjectStore(BLOB_STORE);
                    blobs.createIndex('storedAt', 'storedAt');
                }
                if (!db.objectStoreNames.contains(TREE_STORE)) {
                    db.createObjectStore(TREE_STORE);
                }
            };
            req.onsuccess = (e) => resolve(e.target.result);
            req.onerror = (e) => reject(e.target.error);
        });
        await this._computeTotalBytes();
    }

    async _computeTotalBytes() {
        const tx = this.db.transaction(BLOB_STORE, 'readonly');
        const store = tx.objectStore(BLOB_STORE);
        let total = 0;
        await new Promise((resolve, reject) => {
            const req = store.openCursor();
            req.onsuccess = (e) => {
                const cursor = e.target.result;
                if (cursor) {
                    total += cursor.value.size || 0;
                    cursor.continue();
                } else {
                    resolve();
                }
            };
            req.onerror = () => reject(req.error);
        });
        this._totalBytes = total;
    }

    /** Get blob content by SHA. Returns { content, size } or null. */
    async getBlob(sha) {
        await this._ready;
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(BLOB_STORE, 'readonly');
            const req = tx.objectStore(BLOB_STORE).get(sha);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
        });
    }

    /** Store blob content by SHA. Handles eviction and quota errors. */
    async putBlob(sha, content, size) {
        await this._ready;
        const byteSize = size || new Blob([content]).size;
        await this._evictIfNeeded(byteSize);

        try {
            await this._write(BLOB_STORE, sha, {
                content, size: byteSize, storedAt: Date.now()
            });
            this._totalBytes += byteSize;
        } catch (e) {
            if (e.name === 'QuotaExceededError') {
                await this._emergencyEvict();
                await this._write(BLOB_STORE, sha, {
                    content, size: byteSize, storedAt: Date.now()
                });
                this._totalBytes += byteSize;
            }
        }
    }

    /** Batch-check which SHAs exist. Returns Set of present SHAs. */
    async hasShas(shaArray) {
        await this._ready;
        const present = new Set();
        const tx = this.db.transaction(BLOB_STORE, 'readonly');
        const store = tx.objectStore(BLOB_STORE);

        await Promise.all(shaArray.map(sha => new Promise((resolve) => {
            const req = store.count(sha);
            req.onsuccess = () => {
                if (req.result > 0) present.add(sha);
                resolve();
            };
            req.onerror = () => resolve(); // missing = not present
        })));
        return present;
    }

    /** Get stored tree map for a repo@branch. */
    async getTreeMap(key) {
        await this._ready;
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(TREE_STORE, 'readonly');
            const req = tx.objectStore(TREE_STORE).get(key);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
        });
    }

    /** Store tree map: { treeSha, paths: {path: blobSha}, storedAt }. */
    async putTreeMap(key, treeSha, pathMap) {
        await this._ready;
        await this._write(TREE_STORE, key, {
            treeSha,
            paths: pathMap, // { 'src/index.js': 'abc123...', ... }
            storedAt: Date.now(),
            fileCount: Object.keys(pathMap).length,
        });
    }

    /** Pin SHAs so they won't be evicted (call with current repo's blobs). */
    pinShas(shas) {
        this._pinnedShas = new Set(shas);
    }

    async _write(storeName, key, value) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(storeName, 'readwrite');
            const req = tx.objectStore(storeName).put(value, key);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    }

    async _evictIfNeeded(bytesNeeded) {
        if (this._totalBytes + bytesNeeded < this._budget) return;
        // Evict oldest unpinned blobs
        const tx = this.db.transaction(BLOB_STORE, 'readwrite');
        const index = tx.objectStore(BLOB_STORE).index('storedAt');
        let freed = 0;
        await new Promise((resolve, reject) => {
            const req = index.openCursor();
            req.onsuccess = (e) => {
                const cursor = e.target.result;
                if (!cursor || this._totalBytes + bytesNeeded - freed < this._budget) {
                    resolve(); return;
                }
                if (!this._pinnedShas.has(cursor.primaryKey)) {
                    freed += cursor.value.size || 0;
                    cursor.delete();
                }
                cursor.continue();
            };
            req.onerror = () => reject(req.error);
        });
        this._totalBytes -= freed;
    }

    async _emergencyEvict() {
        const target = this._totalBytes * 0.75; // drop 25%
        const tx = this.db.transaction(BLOB_STORE, 'readwrite');
        const index = tx.objectStore(BLOB_STORE).index('storedAt');
        let freed = 0;
        await new Promise((resolve, reject) => {
            const req = index.openCursor();
            req.onsuccess = (e) => {
                const cursor = e.target.result;
                if (!cursor || this._totalBytes - freed < target) {
                    resolve(); return;
                }
                if (!this._pinnedShas.has(cursor.primaryKey)) {
                    freed += cursor.value.size || 0;
                    cursor.delete();
                }
                cursor.continue();
            };
            req.onerror = () => reject(req.error);
        });
        this._totalBytes -= freed;
    }

    /** Get cache statistics. */
    getStats() {
        return {
            totalBytes: this._totalBytes,
            budgetBytes: this._budget,
            usage: ((this._totalBytes / this._budget) * 100).toFixed(1) + '%',
            pinnedCount: this._pinnedShas.size,
        };
    }
}

export default PersistentContentCache;
```

### Integration point in RepositoryAdapter constructor (line 14-54):
```js
constructor(options = {}) {
    this.cache = new RepositoryContentCache({ ... });     // L1: in-memory
    this.persistentCache = new PersistentContentCache();   // L2: IndexedDB
    this.source = new GitHubRepositorySource({ ... });     // L3: network
    this._pathToSha = null;  // populated on tree load
}
```

### Tree-load integration (new method on RepositoryAdapter):
```js
async _syncTreeMap(owner, repo, branch, tree) {
    const key = `${owner}/${repo}@${branch}`;
    const pathMap = {};
    for (const item of tree.tree) {
        if (item.type === 'blob') pathMap[item.path] = item.sha;
    }

    // Build fast lookup
    this._pathToSha = new Map(Object.entries(pathMap));

    // Pin active repo's blobs
    this.persistentCache.pinShas(new Set(Object.values(pathMap)));

    // Check staleness
    const stored = await this.persistentCache.getTreeMap(key);
    const isStale = !stored || stored.treeSha !== tree.sha;

    if (isStale) {
        await this.persistentCache.putTreeMap(key, tree.sha, pathMap);
    }

    // Pre-check which blobs we already have
    const allShas = Object.values(pathMap);
    const presentShas = await this.persistentCache.hasShas(allShas);
    const missingPaths = Object.entries(pathMap)
        .filter(([_, sha]) => !presentShas.has(sha))
        .map(([path]) => path);

    return { missingPaths, totalFiles: allShas.length, cached: presentShas.size };
}
```

This returns exactly which files need network fetching. For a warm cache on an unchanged repo: `missingPaths = []`, zero network requests for file content.
