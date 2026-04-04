# Cross-Ref Synthesis: Glyph Dimension Pipeline

## Root Cause

PlaneGeometry(1,1) creates quads from -0.5 to +0.5 (centered). The vertex shader computes:
```glsl
vec3 scaled = position * vec3(instanceSize, 1.0);  // [-W/2, +W/2]
vec3 worldPos = scaled + instancePosition;          // centered ON instancePosition
```

But `instancePosition.x` is the LEFT edge cursor from the builder. Result: every quad is shifted left by `W/2`. With per-glyph width variation (from `Math.ceil(measureText)`), adjacent quads have different shift amounts, causing overlaps/gaps in picking geometry.

## Fix: Shader Offset

Add `instanceSize.x * 0.5` to worldPos in all 3 shaders:
```glsl
vec3 offset = vec3(instanceSize.x * 0.5, 0.0, 0.0);
vec3 worldPos = scaled + offset + instancePosition * gScale.xyz + gPos.xyz;
```

Apply to:
1. GlyphRenderer._getVertexShader()
2. PICKING_VERTEX_CELL in PickingSystem.js
3. PICKING_VERTEX_GLYPH in PickingSystem.js

## Secondary Issues

- **Math.ceil drift**: Per-character width variation compounds across lines. For monospace fonts the effect is small (~0-1px per char). Consider uniform advance for monospace in future.
- **lineSlotOffsets**: buildBatchBuffers stores absolute buffer indices. CodeGrid must subtract itemStartOffset for programmatic highlights.
- **Dead code**: GlyphBatcher, InstanceBuffer, textToGlyphs.js, layoutText.js — all dead, safe to remove.
- **glyphWidths cache staleness**: Workers may have stale widths after ensureGraphemes() adds new glyphs.
