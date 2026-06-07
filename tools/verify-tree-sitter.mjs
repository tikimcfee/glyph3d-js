// verify-tree-sitter.mjs — headless health check for the syntax-coloring grammars.
//
// No GPU, no browser: loads each vendored grammar, compiles its highlight query,
// parses a snippet, and reports captures. This is the probe that caught the
// tree-sitter-wasms ABI mismatch and the TS class-name query bug — kept as a tool.
//
//   bun tools/verify-tree-sitter.mjs
//
// Run after: upgrading web-tree-sitter or a grammar package, adding a language, or
// editing a highlight query. Catches ABI mismatches (a grammar wasm the runtime
// can't load), query-compile errors (a node name not in the grammar), and
// zero-capture regressions. Exits non-zero on any failure. Reads the real
// languageRegistry, so it always tests what actually ships.

import * as TSMOD from 'web-tree-sitter';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LANGUAGES } from '../packages/glyph3d-core/src/parsing/languageRegistry.js';

const { Parser, Language, Query } = (TSMOD.default && TSMOD.default.Parser) ? TSMOD.default : TSMOD;

// One small but representative snippet per language — enough to exercise the query.
const SAMPLES = {
  javascript: '// c\nconst x = 42;\nfunction foo(a) { return a + "s"; }\nclass Z extends Y {}\nfoo(1);',
  typescript: 'interface I { n: number }\nconst x: number = 1;\nfunction f(a: string): void { return; }\nclass C {}',
  tsx: 'const E = () => <div className="x">{y}</div>;\nconst n: number = 2;',
  go: 'package main\nimport "fmt"\nfunc main() { fmt.Println("hi") }\ntype T struct{}',
  python: 'import os\ndef f(a):\n    return a + 1  # c\nclass Z: pass',
  json: '{"a": 1, "b": "x", "c": true, "d": null}',
};

await Parser.init();
let failures = 0;
for (const key of Object.keys(LANGUAGES)) {
  const desc = LANGUAGES[key];
  try {
    const bytes = new Uint8Array(readFileSync(fileURLToPath(desc.grammarUrl)));
    const lang = await Language.load(bytes);
    let q;
    try { q = new Query(lang, desc.query); }
    catch (e) { console.log(`  ✗ ${key.padEnd(11)} query: ${e.message}`); failures++; continue; }
    const parser = new Parser();
    parser.setLanguage(lang);
    const tree = parser.parse(SAMPLES[key] ?? 'x');
    const caps = q.captures(tree.rootNode);
    const scopes = [...new Set(caps.map((c) => c.name))].sort();
    if (caps.length === 0) {
      console.log(`  ✗ ${key.padEnd(11)} 0 captures (sample produced no highlights)`);
      failures++;
    } else {
      console.log(`  ✓ ${key.padEnd(11)} ${String(caps.length).padStart(3)} caps | ${scopes.join(' ')}`);
    }
    tree.delete?.();
    parser.delete?.();
  } catch (e) {
    console.log(`  ✗ ${key.padEnd(11)} load: ${e.message || 'failed (ABI mismatch?)'}`);
    failures++;
  }
}
console.log(failures ? `\n${failures} FAILED` : `\nall ${Object.keys(LANGUAGES).length} grammars OK`);
process.exit(failures ? 1 : 0);
