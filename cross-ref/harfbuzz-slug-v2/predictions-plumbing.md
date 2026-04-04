# Predictions: plumbing

## encoding
SlugEncoder will decompose HarfBuzz outlines (M/Q/C segments from `glyphToJson`) into quadratic Bezier curves, pack control points into a float DataTexture (likely RGBA32F or RGBA16F), and organize them into horizontal/vertical bands per glyph for efficient ray-intersection in the shader. They will propose a glyphMapTexture that maps glyphId to an offset+count into the curve/band textures, so the fragment shader can look up which bands belong to a given glyph via texelFetch. The per-glyph data will be built once for the unique glyph set and shared across all instances.

## rendering
The rendering agent will conclude that the fragment shader must replace atlas texture sampling with a Slug-style winding-number evaluation: for each fragment, fetch the glyph's band list from the band texture, iterate curve segments, and compute inside/outside via ray crossings against the packed quadratic curves. They will propose removing the atlas DataTexture and UV-related instance attributes (instanceSize becoming glyph metric-based, instanceCodepoint becoming instanceGlyphId indexing into the glyphMap texture). GlyphRenderer's `_getFragmentShader` and `_getVertexShader` will be rewritten for GLSL ES 3.00 with texelFetch-based curve lookups, and GlyphAtlas.js along with Canvas 2D rasterization will be marked for deletion.
