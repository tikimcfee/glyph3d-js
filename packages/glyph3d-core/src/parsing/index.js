// src/parsing/index.js — barrel export for parsing layer

export { parseFileRef } from './parseFileRef.js';
export { parseStackTrace } from './parseStackTrace.js';
export { parseLogLine } from './parseLogLine.js';
export { parseAuto } from './parseAuto.js';

// Tree-sitter syntax coloring (main-thread; grammars lazy-loaded).
export { detectLanguage, LANGUAGES } from './languageRegistry.js';
export { colorizeGrid } from './SyntaxColorizer.js';
export { DEFAULT_SYNTAX_THEME, FOREGROUND, resolveScopeColor } from './syntaxTheme.js';
export { highlight as treeSitterHighlight } from './TreeSitterEngine.js';
