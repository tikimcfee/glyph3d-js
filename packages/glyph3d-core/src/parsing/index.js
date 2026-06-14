// src/parsing/index.js — barrel export for parsing layer

export { parseFileRef } from './parseFileRef.js';
export { parseStackTrace } from './parseStackTrace.js';
export { parseLogLine } from './parseLogLine.js';
export { parseAuto } from './parseAuto.js';

// Tree-sitter parsing (main-thread; grammars lazy-loaded). One parse →
// syntax colors + the semantic structure model (the arborist).
export { detectLanguage, LANGUAGES } from './languageRegistry.js';
export { analyzeGrid, buildGridSemantics } from './SyntaxColorizer.js';
export { DEFAULT_SYNTAX_THEME, FOREGROUND, resolveScopeColor } from './syntaxTheme.js';
export { parseDocument as treeSitterParseDocument } from './TreeSitterEngine.js';
export { structureSpecFor } from './semanticKinds.js';
export { default as SemanticModel } from './SemanticModel.js';
