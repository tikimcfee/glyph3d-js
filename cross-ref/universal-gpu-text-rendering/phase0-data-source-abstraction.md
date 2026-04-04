# Phase 0 — Data Source Abstraction

Agent: `data-source-abstraction`

---

## 1. Current Data Flow Audit

### The call chain: source to rendered glyphs

```
External Source (GitHub API / WebSocket relay / CLI command)
  -> GitHubRepoViewer.loadRepository() or _loadLocalRepository()
     -> repoAdapter.getRepositoryTree()        # fetch file tree
     -> repoAdapter.filterCodeFiles()           # select renderable files
     -> repoAdapter.getMultipleFiles()          # parallel content fetch
        -> for each (path, content):
           createGridForFileAsync(path, content)
             -> new CodeGrid(scene, atlas)
             -> grid.loadFileAsync(filename, content)  [or loadText for sync]
                -> collection.addText(content, position, options)
                   # queues into _pendingAdds
                -> collection.flushAsync()
                   -> WorkerBridge.buildBuffers(items, atlasMetrics)
                      -> textToGlyphs() -> buildBuffers()
                      # returns Float32Arrays: positions, sizes, uvs, colors
                   -> renderer.applyPrebuiltBuffers(buffers)
                      # uploads to GPU via InstancedBufferGeometry
                -> _buildLineSlotBase()  # line->buffer slot mapping
```

### Coupling points

1. **CodeGrid.loadText/loadFileAsync expects a complete string.** No streaming, no incremental append. The entire content must be available before the call.
2. **GlyphCollection.addText() takes a string.** The text->glyph conversion happens inside the worker or renderer. No way to feed pre-parsed tokens or structured data.
3. **Buffer builders assume UTF-8 text.** `textToGlyphs()` iterates grapheme clusters. Binary content would need a hex/preview adapter before reaching this layer.
4. **One CodeGrid = one contiguous text block.** There's no concept of a grid that sources content from multiple origins or stitches fragments.
5. **AgentGrid.write/appendLine** is the closest thing to an incremental model -- it accumulates lines and re-renders the full content on dirty flush. Still full-replacement under the hood.

### What CodeGrid.loadText assumes about its input

- Input is a `string` (not Buffer, ArrayBuffer, or ReadableStream)
- Encoding is implicitly UTF-8 (JavaScript strings are UTF-16 internally)
- Content can be split on `\n` for line mapping
- No metadata (language, syntax tokens, line annotations) travels with the text
- The caller has already fetched and decoded the content

---

## 2. The Provider Contract

The existing `FileSystemProvider` from the filesystem-provider-layer cross-ref is file-oriented (readFile, writeFile, listDirectory). The data source abstraction must be broader: any text source, not just files.

### Minimal interface

```javascript
/**
 * @typedef {'ready'|'loading'|'streaming'|'error'|'closed'} SourceState
 *
 * @typedef {Object} SourceContent
 * @property {string} text          - UTF-8 content (full or chunk)
 * @property {Object} [meta]        - source-specific metadata
 * @property {number} [totalLines]  - if known, total line count
 * @property {boolean} [partial]    - true if this is a chunk, not the full content
 */

/**
 * @typedef {Object} SourceEvent
 * @property {'content'|'append'|'patch'|'reset'|'error'|'closed'} type
 * @property {string} [text]        - for content/append
 * @property {Array} [edits]        - for patch (LSP TextEdit[])
 * @property {Error} [error]        - for error
 */

class TextSource {
    /** @type {string} Unique URI identifying this source */
    get uri() {}

    /** @type {SourceState} */
    get state() {}

    /**
     * Read the full current content. For streams, returns whatever has
     * accumulated. For files, fetches if needed.
     * @returns {Promise<SourceContent>}
     */
    async read() {}

    /**
     * Subscribe to content changes. Returns unsubscribe function.
     * @param {(event: SourceEvent) => void} callback
     * @returns {() => void}
     */
    onChange(callback) {}

    /**
     * Optional: hint that this source should pre-fetch or open a connection.
     * No-op for synchronous sources.
     */
    async open() {}

    /**
     * Release resources (close connections, stop watchers).
     */
    async close() {}
}
```

### What about the existing FileSystemProvider?

It composes with -- not replaces -- TextSource. A `FileTextSource` wraps a `FileSystemProvider.readFile()` call and subscribes to its `onDidChange` notifications. The provider handles I/O; the source adapts its output to the rendering pipeline's expectations.

```javascript
class FileTextSource extends TextSource {
    constructor(uri, fsProvider) {
        this._uri = uri;
        this._provider = fsProvider;
        this._content = null;
        this._listeners = new Set();
        this._unsubFs = fsProvider.onDidChange((event) => {
            if (event.uri === uri && event.type === 'changed') {
                this._onExternalChange();
            }
        });
    }

    get uri() { return this._uri; }
    get state() { return this._content ? 'ready' : 'loading'; }

    async read() {
        if (!this._content) {
            const file = await this._provider.readFile(this._uri);
            this._content = file.content;
        }
        return { text: this._content, meta: { uri: this._uri } };
    }

    onChange(cb) {
        this._listeners.add(cb);
        return () => this._listeners.delete(cb);
    }

    async _onExternalChange() {
        const file = await this._provider.readFile(this._uri);
        this._content = file.content;
        for (const cb of this._listeners) {
            cb({ type: 'content', text: this._content });
        }
    }

    async close() {
        this._unsubFs?.();
        this._listeners.clear();
    }
}
```

### Encoding and binary

The contract is: `read()` returns `{ text: string }`. Sources are responsible for decoding to UTF-8 strings. Binary sources should produce a hex dump or preview representation before reaching the TextSource boundary. A `BinaryPreviewSource` adapter can wrap any source and convert non-UTF-8 content to a hex/ASCII view.

### Error handling

Sources surface errors two ways:
1. **Thrown from `read()`** -- fetch failures, permission errors, network timeouts
2. **Via `onChange({ type: 'error', error })`** -- connection drops, watch failures

All errors carry the source URI. Callers decide whether to retry, show a placeholder grid, or dispose.

---

## 3. Source Type Analysis

### Local filesystem (via FileSystemProvider + relay)

```javascript
const fsProvider = new RemoteFileSystemProvider(wsBridge, 'file');
const source = new FileTextSource('file:///home/user/foo.js', fsProvider);
// read() -> JSON-RPC readFile over WebSocket
// onChange() -> fs/didChange notifications from Go relay's fsnotify
```

### Remote HTTP/REST API (GitHub, GitLab)

```javascript
class GitHubFileSource extends TextSource {
    constructor(owner, repo, branch, path, githubProvider) {
        this._uri = `github://${owner}/${repo}/${branch}/${path}`;
        this._provider = githubProvider;
    }
    async read() {
        const file = await this._provider.readFile(this._uri);
        return { text: file.content, meta: { sha: file.stat.sha } };
    }
    onChange(cb) {
        // GitHub has no push notifications. Return no-op.
        // Polling or manual refresh handled at a higher layer.
        return () => {};
    }
}
```

### WebSocket streams (live logs, real-time data)

```javascript
class StreamSource extends TextSource {
    constructor(uri, ws) {
        this._uri = uri;
        this._buffer = [];      // accumulated lines
        this._listeners = new Set();
        this._state = 'streaming';
        ws.addEventListener('message', (e) => {
            this._buffer.push(e.data);
            for (const cb of this._listeners) {
                cb({ type: 'append', text: e.data });
            }
        });
        ws.addEventListener('close', () => { this._state = 'closed'; });
    }
    get state() { return this._state; }
    async read() { return { text: this._buffer.join('\n'), partial: true }; }
    onChange(cb) {
        this._listeners.add(cb);
        return () => this._listeners.delete(cb);
    }
}
```

### Database queries (SQL results as text grids)

```javascript
class QuerySource extends TextSource {
    constructor(uri, queryFn) {
        this._uri = uri;
        this._queryFn = queryFn;
    }
    async read() {
        const rows = await this._queryFn();
        const text = formatAsTable(rows); // tab-aligned columns
        return { text, meta: { rowCount: rows.length } };
    }
    onChange(cb) { return () => {}; } // static unless re-queried
}
```

### Virtual/synthetic sources (REPL, diff views, generated content)

```javascript
class SyntheticSource extends TextSource {
    constructor(uri) {
        this._uri = uri;
        this._text = '';
        this._listeners = new Set();
    }
    async read() { return { text: this._text }; }
    /** External code calls this to push new content */
    set(text) {
        this._text = text;
        for (const cb of this._listeners) cb({ type: 'content', text });
    }
    patch(edits) {
        this._text = applyTextEdits(this._text, edits);
        for (const cb of this._listeners) cb({ type: 'patch', edits });
    }
    onChange(cb) {
        this._listeners.add(cb);
        return () => this._listeners.delete(cb);
    }
}
```

### Archive formats (zip, tar)

```javascript
class ArchiveFileSource extends TextSource {
    constructor(uri, archiveHandle, entryPath) {
        this._uri = uri;
        this._archive = archiveHandle;
        this._entryPath = entryPath;
    }
    async read() {
        const bytes = await this._archive.extract(this._entryPath);
        const text = new TextDecoder().decode(bytes);
        return { text };
    }
    onChange(cb) { return () => {}; } // archives are immutable
}
```

---

## 4. Incremental Updates

### The core problem

`CodeGrid.loadText()` and `loadFileAsync()` do full-replacement: clear all content, re-layout, re-flush, rebuild line slot mapping. This is correct for initial load but wasteful for single-line edits.

### Update protocol: three tiers

**Tier 1: Full replacement (current model)**
- `SourceEvent.type === 'content'` or `'reset'`
- Grid calls `loadTextAsync(newContent)` -- full rebuild
- Suitable for: file saves, query re-execution, small files

**Tier 2: Append-only (new, for streams)**
- `SourceEvent.type === 'append'`
- Grid appends lines to existing buffer, extends GPU buffer
- Requires: GlyphCollection to support `appendText()` that extends rather than rebuilds
- This is close to what `AgentGrid.appendLine()` does, but AgentGrid still does full re-render

**Tier 3: Patch-based (future, for collaborative editing)**
- `SourceEvent.type === 'patch'` with LSP TextEdit array
- Grid applies edits to its internal content string, then re-renders only affected lines
- Requires: line-granular buffer updates in GlyphCollection (update a range of slots without rebuilding the whole buffer)

### What needs to change in the rendering pipeline for Tier 2

```javascript
// New method on GlyphCollection:
appendText(text, position, options) {
    // Appends to existing buffer WITHOUT clearing
    // Uses addUpdateRange() for partial GPU upload
    // Returns new slot indices for the appended glyphs
}
```

### What needs to change for Tier 3

```javascript
// New method on CodeGrid:
applyEdits(edits) {
    // 1. Apply edits to this.content string (bottom-to-top)
    // 2. Determine affected line range
    // 3. Rebuild only those lines' buffer slots
    // 4. Shift subsequent line slot bases
    // 5. Partial GPU upload via addUpdateRange()
}
```

This is non-trivial because the buffer is contiguous -- inserting characters in line 5 shifts every subsequent glyph's buffer index. A gap-buffer or segmented-buffer approach at the GlyphCollection level would make this O(affected_lines) instead of O(total_glyphs).

---

## 5. Grid Lifecycle Management

### The SourceBoundGrid concept

A `SourceBoundGrid` pairs a `TextSource` with a `CodeGrid` and manages the lifecycle automatically:

```javascript
class SourceBoundGrid {
    constructor(source, grid) {
        this.source = source;
        this.grid = grid;
        this._unsub = null;
    }

    async bind() {
        const content = await this.source.read();
        await this.grid.loadTextAsync(content.text);

        this._unsub = this.source.onChange(async (event) => {
            switch (event.type) {
                case 'content':
                case 'reset':
                    await this.grid.loadTextAsync(event.text);
                    break;
                case 'append':
                    // Future: grid.appendText(event.text)
                    this.grid.loadText(this.grid.content + '\n' + event.text);
                    break;
                case 'patch':
                    // Future: grid.applyEdits(event.edits)
                    await this.grid.loadTextAsync(
                        applyTextEdits(this.grid.content, event.edits)
                    );
                    break;
                case 'error':
                    console.warn(`Source error for ${this.source.uri}:`, event.error);
                    break;
                case 'closed':
                    // Source gone -- grid stays visible as last-known state
                    break;
            }
        });
    }

    async unbind() {
        this._unsub?.();
        this._unsub = null;
    }

    dispose() {
        this.unbind();
        this.source.close();
        this.grid.dispose();
    }
}
```

### Interaction with GridVirtualizer

GridVirtualizer handles draw-call elimination (scene graph add/remove based on frustum). SourceBoundGrid handles content lifecycle (fetch, update, dispose). They are orthogonal:

- **GridVirtualizer** decides: "is this grid visible? If not, remove from scene graph."
- **SourceBoundGrid** decides: "does this grid's content need updating? If source changed, re-render."

The key interaction: when a grid is frustum-culled (off-screen), should we still process source updates? Two strategies:

1. **Defer updates** -- queue source events, apply when grid re-enters frustum. Saves CPU/GPU for off-screen grids. Risk: stale content flash on scroll-back.
2. **Apply immediately** -- update content regardless of visibility. Simpler, ensures content is always current. Cost: wasted GPU uploads for invisible grids.

Recommendation: **defer updates with a staleness flag**. When the virtualizer brings a grid back into the scene, check the staleness flag and apply queued updates before the next render frame.

```javascript
// Inside SourceBoundGrid:
_onSourceEvent(event) {
    if (this._frustumCulled) {
        this._pendingEvent = event;  // overwrite -- only latest matters
        this._stale = true;
        return;
    }
    this._applyEvent(event);
}

onBecameVisible() {
    if (this._stale) {
        this._applyEvent(this._pendingEvent);
        this._stale = false;
        this._pendingEvent = null;
    }
}
```

### Reconnection

When a source enters error/closed state and later recovers:

```javascript
// StreamSource reconnect:
reconnect(newWs) {
    this._state = 'streaming';
    // Wire new WebSocket, resume appending
    // Fire { type: 'reset' } if buffer was lost, or resume with { type: 'append' }
}
```

The grid does not need to know about reconnection mechanics. It only sees the SourceEvent stream.

---

## 6. Backpressure and Flow Control

### The problem

A WebSocket stream producing 1000 lines/second will overwhelm the rendering pipeline. `loadText()` on every line is ~5ms (worker path) for small content but grows with total size. At 10,000 accumulated lines, each full re-render becomes expensive.

### Buffering strategy: coalesced render frames

```javascript
class ThrottledSourceBridge {
    constructor(source, grid, { maxFps = 10 } = {}) {
        this._minInterval = 1000 / maxFps;
        this._pendingText = null;
        this._timer = null;

        source.onChange((event) => {
            if (event.type === 'append' || event.type === 'content') {
                this._pendingText = event.type === 'append'
                    ? (this._pendingText || grid.content) + '\n' + event.text
                    : event.text;

                if (!this._timer) {
                    this._timer = setTimeout(() => this._flush(grid), this._minInterval);
                }
            }
        });
    }

    _flush(grid) {
        if (this._pendingText !== null) {
            grid.loadText(this._pendingText);
            this._pendingText = null;
        }
        this._timer = null;
    }
}
```

### Prioritizing visible content

When many sources are active, visible grids should update before off-screen ones. A simple priority queue:

```javascript
class SourceUpdateScheduler {
    constructor(virtualizer) {
        this._queue = [];         // { grid, event, priority }
        this._perFrame = 3;       // max grid updates per animation frame
    }

    enqueue(grid, event) {
        const visible = this._isVisible(grid);
        this._queue.push({ grid, event, priority: visible ? 0 : 1 });
        this._queue.sort((a, b) => a.priority - b.priority);
    }

    processFrame() {
        let processed = 0;
        while (this._queue.length > 0 && processed < this._perFrame) {
            const { grid, event } = this._queue.shift();
            applyEventToGrid(grid, event);
            processed++;
        }
    }
}
```

### Memory limits

When many sources are active (100+ streams), accumulated content can exhaust memory. Each source should declare a `maxLines` or `maxBytes` cap:

```javascript
class StreamSource extends TextSource {
    constructor(uri, ws, { maxLines = 10000 } = {}) {
        // ...
        this._maxLines = maxLines;
    }
    // On append, if _buffer.length > maxLines, shift old lines
    _onMessage(data) {
        this._buffer.push(data);
        if (this._buffer.length > this._maxLines) {
            this._buffer.splice(0, this._buffer.length - this._maxLines);
            // Fire 'content' (full replacement) since lines shifted
            this._notify({ type: 'content', text: this._buffer.join('\n') });
            return;
        }
        this._notify({ type: 'append', text: data });
    }
}
```

---

## Summary of Decisions

1. **TextSource is the adapter contract**, not FileSystemProvider. FSP is an I/O layer; TextSource adapts any content origin to the rendering pipeline's string-in, events-out model.
2. **Three event types cover all update patterns**: `content` (full replacement), `append` (streaming), `patch` (surgical edits via TextEdit).
3. **SourceBoundGrid pairs source to grid** and manages the lifecycle. It is the single point where data-flow meets rendering.
4. **Deferred updates for frustum-culled grids** -- queue the latest event, apply on re-entry to viewport.
5. **Coalesced rendering at configurable FPS cap** prevents stream sources from overwhelming the GPU pipeline.
6. **Memory caps via maxLines/maxBytes** on stream sources prevent unbounded accumulation.
7. **The existing FileSystemProvider composes under FileTextSource** -- no redesign needed, just an adapter layer on top.
8. **Binary content is the caller's problem** -- sources must produce UTF-8 strings. A `BinaryPreviewSource` adapter handles hex/ASCII conversion before the TextSource boundary.
