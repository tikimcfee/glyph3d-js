# Metal GPU Text Rendering Pipeline — Exploration Report

Source: `/home/user/dev/swift-glyph3d/MetalLink/`

## Three-Stage Compute Shader Pipeline

### Stage 1: UTF-8 → UTF-32 Decode (fully parallel)
**Kernel:** `utf8ToUtf32Kernel` (Compute.metal:569)
- Thread-per-byte: each GPU thread processes one byte position
- `sequenceCountForByteAtIndex()` detects UTF-8 sequence length (1-4 bytes)
- `codePointForSequence()` extracts the U+32 codepoint value
- `categoryForGraphemeBytes()` classifies emoji/ZWJ/tag sequences

### Stage 2: Layout (backtracking, sequential dependency)
**Kernel:** `utf32GlyphMap_FastLayout` (Compute.metal:463)
- Each glyph traces backward through previous glyphs via `indexOfCharacterBefore()`
- Accumulates X/Y positions from previous glyph texture sizes
- Handles line breaks (U+000A) by resetting X, adjusting Y
- **NOT parallel** — inherently sequential within a glyph's chain

### Stage 3: Pagination (fully parallel)
**Kernel:** `utf32GlyphMap_FastLayout_Paginate` (Compute.metal:430)
- Remaps positions into paged grid layout
- Pure arithmetic, no dependencies

## UTF-8 Multi-byte Handling

Byte detection (Compute.metal:64-87):
```metal
if ((byte & 0x80) == 0x00) → 1 byte  (ASCII)
if ((byte & 0xE0) == 0xC0) → 2 bytes
if ((byte & 0xF0) == 0xE0) → 3 bytes
if ((byte & 0xF8) == 0xF0) → 4 bytes (supplementary plane, emoji)
```

Decode functions (lines 148-196): `decodeByteSequence_2/3/4()` extract bits correctly for all sequence lengths.

## Emoji & ZWJ Handling (Heuristic)

**NOT true Unicode grapheme segmentation.** Pattern-based classification:

| Byte Pattern | Category | Handling |
|---|---|---|
| START/MIDDLE/MIDDLE/END | `utf32GlyphEmojiSingle` | Single emoji glyph |
| START/MIDDLE/MIDDLE/MIDDLE | `utf32GlyphEmojiPrefix` | Lookahead for ZWJ |
| START/END/MIDDLE/END | `utf32GlyphTag` | Tag sequence loop |

ZWJ detection via `attemptUnicodeScalarSetLookahead()` (lines 255-305):
- Looks ahead for consecutive emoji prefixes
- Accumulates codepoints into same glyph hash
- Limited to ~10 consecutive tags

**Limitations:**
- No combining mark support (U+0300-U+036F treated as separate codepoints)
- No contextual shaping (Arabic, Devanagari)
- No ligature support
- ZWJ lookahead can fail on complex sequences

## Atlas Lookup

**CPU side:** Rolling hash `(hash * 31 + scalar.value) % 1_000_000`
**GPU side:** Direct index into `atlasBuffer[hash]` (Compute.metal:921)
**Pre-built:** Core Graphics rasterizes glyphs, serialized to disk for fast startup

```c
struct GlyphMapKernelAtlasIn {
    uint64_t unicodeHash;
    simd_float2 textureSize;
    simd_float4 textureDescriptorU;
    simd_float4 textureDescriptorV;
};
```

## Instance Data Layout

```c
struct InstancedConstants {     // ~200+ bytes per glyph
    simd_float4 textureDescriptorU;
    simd_float4 textureDescriptorV;
    simd_float2 textureSize;
    simd_float4 positionOffset;
    simd_float4 scale;
    uint64_t unicodeHash;
    uint8_t addedColorR/G/B;
    uint8_t multipliedColorR/G/B;
    int bufferIndex;
    uint8_t flags;
};
```

vs glyph3d-js: 40 bytes/glyph (10 floats) + 4 bytes RGBA8 highlight

## Memory Profile

- Input: 6.268 MB UTF-8
- GlyphMapKernelOut: 1004 MB (200x expansion — 1:1 byte:glyph mapping)
- InstancedConstants: ~200 MB (filtered to visible glyphs)

## Key Architectural Decisions

1. **Thread-per-byte, not thread-per-glyph** — allows fully parallel decode but wastes threads on continuation bytes
2. **Backtracking layout** instead of prefix scan — simpler but kills parallelism
3. **Heuristic emoji detection** over Unicode-correct segmentation — pragmatic for code viewing
4. **Hash-based atlas lookup** — O(1) GPU-side, no collision resolution
5. **Persistent atlas serialization** — avoids re-rasterization on startup

## Relevance to glyph3d-js

| Metal Approach | JS Equivalent | Status |
|---|---|---|
| UTF-8 byte decode in compute shader | `codePointAt()` iteration in builder | **BUG**: builder uses `charCodeAt()` |
| Heuristic emoji classification | `Intl.Segmenter` (more correct) | Not implemented |
| GPU layout backtracking | Worker-based builder (sequential) | Equivalent |
| Hash-based atlas lookup | `uvMap` codepoint lookup | Equivalent |
| 200-byte instance struct | 40-byte instance (10 floats) | JS is leaner |
| Compute shader pipeline | Web Worker pipeline | Equivalent parallelism model |

### What JS can adopt:
1. **Fix `charCodeAt` → `codePointAt`** with proper advancement (2 for supplementary plane) — matches Metal's decode stage
2. **`Intl.Segmenter` pre-pass** before builder — more correct than Metal's heuristic, CPU-side but fast enough for file-sized text
3. **Grapheme hash for atlas** — composite graphemes (emoji) get a single atlas entry keyed by hash, not by individual codepoints
4. **Future: WebGPU compute** could port the three-stage pipeline directly
