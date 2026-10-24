/**
 * @glyph3d/core/core
 *
 * Core rendering, buffer layout, and layout generator subsystems.
 */

export { InstancedSlotBuffer, packRgba8, unpackRgba8 } from './InstancedSlotBuffer.js';
export { generateLayout } from './LayoutGenerator.js';
export {
    createGlyphMaterial,
    setGlyphGreekPx,
    getGlyphGreekPx,
    GLYPH_GREEK_PX_DEFAULT,
} from './glyphMaterial.js';
export { computeCellMetrics, deriveCharSize, LINE_PITCH, LETTER_SPACING } from './cellMetrics.js';
export { RENDER_ORDER } from './renderOrder.js';
export { LAYER_BAND, getBandDistance } from './layerBands.js';
export { READABLE_MAX_CHARS, READABLE_MAX_LINE_CHARS, unreadableReason } from './readability.js';
export { extOf, mimeForFormat, classifyByExtension, sniffMagic, isProbablyUtf8, classifyBytes, partitionDirEntries } from './fileKind.js';
export { toFileUri, fromFileUri } from './fileUri.js';
export { PERF_THRESHOLDS, shouldDebugLog } from './constants.js';
export { default as LayoutDescription } from './LayoutDescription.js';
