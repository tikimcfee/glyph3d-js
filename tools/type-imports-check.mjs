#!/usr/bin/env bun
// type-imports-check.mjs — fail loud on JSDoc types that silently resolved to `any`.
//
//   bun tools/type-imports-check.mjs
//
// The repo types its JS with JSDoc, checked by tsserver (editor + agent LSP) against
// jsconfig.json. JSDoc's failure mode is SILENCE: a type whose path is dead degrades to
// `any` with no error unless something asks — and then references, hover, and go-to-def
// quietly stop reaching across that seam. Each code below is one way that happens:
//
//   TS2307  import('…') / import of a path that doesn't exist (the module moved)
//   TS2306  the target is a SCRIPT, not a module — a typedef-only file needs `export {}`
//   TS2305 / TS2614 / TS2724  the module exists but has no such export
//   TS2694  import('…').Name where the module declares no Name (typedef renamed/moved)
//   TS6142  a .jsx module imported while jsconfig lacks "jsx" — every type from it is any
//   TS2304 / TS2552 / TS2503  a type NAME used in JSDoc that the file never imports
//           (`@param {CodeGrid} g` with no `@import CodeGrid …`). Counted only when the
//           position sits inside a block comment; in code these codes are runtime globals.
//
// It runs tsc over jsconfig.json with checkJs ON but reports ONLY these codes, in our
// own files. Full checkJs is thousands of findings of inference noise; this is the narrow
// seam check — zero is the baseline, so any hit is a regression to fix, not triage.
//
// Needs the `typescript` package: the repo's, else bun's global install (the one
// typescript-language-server uses). Missing it is a loud exit 2, never a silent pass.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const CODES = {
    TS2307: 'path does not exist',
    TS2306: 'target is a script, not a module (add `export {}`)',
    TS2305: 'module has no such export',
    TS2614: 'module has no such export',
    TS2724: 'module has no such export',
    TS2694: 'module declares no such type',
    TS6142: '.jsx import but jsconfig lacks "jsx"',
};
// Name-lookup codes: a silent `any` only inside JSDoc (in code they mean a runtime global).
const JSDOC_ONLY = {
    TS2304: 'type name not imported (add an @import)',
    TS2552: 'type name not imported (add an @import)',
    TS2503: 'namespace not imported (add an @import)',
};

/** True when (line, col) — 1-based, as tsc prints — falls inside a block comment of `file`. */
const commentRanges = new Map();
function inBlockComment(file, line, col) {
    if (!commentRanges.has(file)) {
        const text = readFileSync(path.join(ROOT, file), 'utf8');
        const starts = [0];
        for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
        const ranges = [...text.matchAll(/\/\*[\s\S]*?\*\//g)].map((m) => [m.index, m.index + m[0].length]);
        commentRanges.set(file, { starts, ranges });
    }
    const { starts, ranges } = commentRanges.get(file);
    const at = starts[line - 1] + col - 1;
    return ranges.some(([a, b]) => at >= a && at < b);
}

function findTsc() {
    try { return createRequire(path.join(ROOT, 'package.json')).resolve('typescript/bin/tsc'); } catch { /* not a repo dep */ }
    const bunGlobal = path.join(process.env.BUN_INSTALL || path.join(os.homedir(), '.bun'), 'install/global/node_modules/typescript/bin/tsc');
    return existsSync(bunGlobal) ? bunGlobal : null;
}

const tsc = findTsc();
if (!tsc) {
    console.error('type-imports-check: no `typescript` package (repo or bun global) — install it: bun add -g typescript');
    process.exit(2);
}

const t0 = performance.now();
const run = spawnSync(process.execPath, [tsc, '-p', 'jsconfig.json', '--noEmit', '--checkJs', '--skipLibCheck', '--pretty', 'false'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
if (run.error || run.stdout == null) {
    console.error(`type-imports-check: tsc did not run: ${run.error?.message ?? run.stderr}`);
    process.exit(2);
}

const hits = [];
for (const line of run.stdout.split('\n')) {
    const m = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(line);
    if (!m || m[1].includes('node_modules')) continue;
    const why = CODES[m[4]] ?? (JSDOC_ONLY[m[4]] && inBlockComment(m[1], +m[2], +m[3]) ? JSDOC_ONLY[m[4]] : null);
    if (why) hits.push({ file: m[1], line: m[2], col: m[3], code: m[4], msg: m[5], why });
}

const secs = ((performance.now() - t0) / 1000).toFixed(1);
if (!hits.length) {
    console.log(`type-imports-check: ok — every JSDoc type import resolves (tsc ${secs}s)`);
    process.exit(0);
}
for (const h of hits) console.log(`${h.file}:${h.line}:${h.col}  ${h.code} (${h.why})\n    ${h.msg}`);
console.log(`\ntype-imports-check: ${hits.length} unresolved type import(s) — each one silently types its seam as any (tsc ${secs}s)`);
process.exit(1);
