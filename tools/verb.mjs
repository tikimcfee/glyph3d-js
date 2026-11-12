#!/usr/bin/env bun
/**
 * verb.mjs — where a command-bus verb is handled, and what of the app it touches.
 *
 *   bun tools/verb.mjs grid.move              the handler's file:line + its ctx.* / host.* surface
 *   bun tools/verb.mjs 'carrel.*'             every verb under a prefix (a trailing .* only)
 *   bun tools/verb.mjs --list                 every verb registered by a literal name, file:line
 *   bun tools/verb.mjs grid.move --recv ctx,host,router   which receivers count as "the surface"
 *
 * Structural, not textual: ast-grep finds `<x>.register('<verb>', …)` calls (a registry's
 * `register(id, grid)` with a computed id is not a verb and is skipped), then, inside that call's
 * span, every member expression whose object is a receiver (`ctx.registry`, `ctx?.camera`,
 * `host.surfaces`), every destructuring of one (`const { registry } = ctx`), and every call that
 * hands `ctx` to a helper. Strings and comments never match.
 *
 * Blind to — and it says so in its output rather than guessing:
 *   - verbs registered under a COMPUTED name (layoutCommands' overlay table, panelCommands'
 *     `verb(name, …)` helper, CommandRouter.registerAll): it falls back to where the verb's
 *     string literal appears, which is usually the table row, not the handler;
 *   - what a helper does with `ctx`: helpers are named (with their line when defined in the same
 *     file), not followed — read them, or ask `tools/lsp.mjs refs` / srcwalk;
 *   - a surface reached through an alias (`const c = ctx; c.registry`).
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SG = join(ROOT, 'node_modules/.bin/ast-grep');
/** Where verbs are registered: the IDE's handlers and the core's command modules. */
const SEARCH = ['app', 'packages/glyph3d-core/src', 'wall'];

const argv = process.argv.slice(2);
const flag = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const RECV = flag('--recv', 'ctx,host').split(',').map((s) => s.trim()).filter(Boolean);
const LIST = argv.includes('--list');
const query = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--recv');
if (!LIST && !query) {
    console.error('usage: bun tools/verb.mjs <verb | prefix.*> [--recv ctx,host]   |   --list');
    process.exit(2);
}
if (RECV.some((r) => !/^[A-Za-z_$][\w$]*$/.test(r))) { console.error(`--recv takes identifiers, got ${RECV.join(',')}`); process.exit(2); }

/** Run ast-grep and parse its JSON; fail loud on a tool error (a missing binary is not "no match"). */
function sg(args, cwd = ROOT) {
    const r = spawnSync(SG, args, { cwd, encoding: 'utf8', maxBuffer: 256 << 20 });
    if (r.error) { console.error(`verb.mjs: cannot run ast-grep (${SG}): ${r.error.message} — bun install?`); process.exit(2); }
    if (r.status !== 0 && !r.stdout.trim().startsWith('[')) { console.error(`verb.mjs: ast-grep failed (${r.status}): ${r.stderr.trim()}`); process.exit(2); }
    return JSON.parse(r.stdout || '[]');
}

const REGISTER_RULE = `
id: verb-registration
language: js
rule:
  pattern: $R.register($NAME, $$$REST)
constraints:
  NAME: { kind: string }
`;

const registrations = sg(['scan', '--inline-rules', REGISTER_RULE, '--json=compact', ...SEARCH])
    .map((m) => ({
        verb: m.metaVariables.single.NAME.text.slice(1, -1),
        file: m.file, line: m.range.start.line + 1, endLine: m.range.end.line + 1,
        start: m.range.byteOffset.start, end: m.range.byteOffset.end,
    }))
    .sort((a, b) => a.verb.localeCompare(b.verb));

if (LIST) {
    for (const r of registrations) console.log(`${r.verb.padEnd(28)} ${r.file}:${r.line}`);
    console.log(`\n${registrations.length} verbs registered by a literal name (computed names not listed — see the header)`);
    process.exit(0);
}

const prefix = query.endsWith('.*') ? query.slice(0, -1) : null;
const hits = registrations.filter((r) => (prefix ? r.verb.startsWith(prefix) : r.verb === query));

if (!hits.length) {
    // A computed registration: say where the literal lives, and say that it is a fallback.
    const lit = prefix ? null : spawnSync('rg', ['-n', '--no-heading', '-F', `'${query}'`, ...SEARCH], { cwd: ROOT, encoding: 'utf8' });
    const lines = lit?.stdout?.trim().split('\n').filter(Boolean) ?? [];
    console.log(`${query}: no literal registration found (ast-grep: <x>.register('${query}', …)).`);
    if (lines.length) {
        console.log(`  the string appears here (rg, textual — likely a table row feeding a computed register):`);
        for (const l of lines.slice(0, 10)) console.log(`    ${l.slice(0, 160)}`);
    } else if (!prefix) {
        console.log('  nor as a string literal anywhere under ' + SEARCH.join(', ') + ' — not a verb?');
    }
    process.exit(1);
}

const recvRe = RECV.join('|');
const SURFACE_RULES = `
id: member
language: js
rule:
  kind: member_expression
  has: { field: object, kind: identifier, regex: '^(${recvRe})$' }
---
id: destructure
language: js
rule:
  kind: variable_declarator
  all:
    - has: { field: name, kind: object_pattern }
    - has: { field: value, kind: identifier, regex: '^(${recvRe})$' }
---
id: helper
language: js
rule:
  kind: call_expression
  has:
    field: arguments
    has: { kind: identifier, regex: '^ctx$' }
---
id: fn-def
language: js
rule:
  any:
    - kind: function_declaration
    - all:
        - kind: variable_declarator
        - has: { field: value, any: [ { kind: arrow_function }, { kind: function_expression } ] }
`;

const fileCache = new Map();
function surfaceOf(file) {
    if (!fileCache.has(file)) {
        const text = readFileSync(join(ROOT, file));   // a Buffer: ast-grep's offsets are BYTES
        const found = sg(['scan', '--inline-rules', SURFACE_RULES, '--json=compact', file]);
        fileCache.set(file, { text, found });
    }
    return fileCache.get(file);
}

/** `ctx.registry` + the next `.member` after it, read from the source (one more level of chain). */
function chainAt(text, m) {
    const at = m.range.byteOffset.end;
    const tail = text.subarray(at, at + 80).toString('utf8').match(/^(\?\.|\.)([A-Za-z_$][\w$]*)/);
    return m.text.replace('?.', '.') + (tail ? `.${tail[2]}` : '');
}

for (const r of hits) {
    const { text, found } = surfaceOf(r.file);
    const inside = (m) => m.range.byteOffset.start >= r.start && m.range.byteOffset.end <= r.end;
    const counts = new Map();
    const bump = (k) => counts.set(k, (counts.get(k) || 0) + 1);
    for (const m of found) {
        if (!inside(m)) continue;
        if (m.ruleId === 'member') bump(chainAt(text, m));
        else if (m.ruleId === 'destructure') {
            const [names, recv] = m.text.split('=').map((s) => s.trim());
            for (const n of names.replace(/[{}]/g, '').split(',').map((s) => s.split(':')[0].trim()).filter(Boolean)) bump(`${recv}.${n} (destructured)`);
        }
    }
    const defs = new Map(found.filter((m) => m.ruleId === 'fn-def')
        .map((m) => [m.text.match(/^(?:async\s+)?(?:function\*?\s+)?([A-Za-z_$][\w$]*)/)?.[1], m.range.start.line + 1]));
    const helpers = new Map();
    for (const m of found) {
        if (m.ruleId !== 'helper' || !inside(m)) continue;
        const callee = m.text.slice(0, m.text.indexOf('(')).trim();
        if (RECV.some((rv) => callee.startsWith(`${rv}.`))) continue;   // a surface call, already counted
        helpers.set(callee, defs.get(callee) ?? null);
    }

    const lines = r.endLine - r.line + 1;
    console.log(`${r.verb}  ${r.file}:${r.line}  (${lines} lines)`);
    const surface = [...counts].sort((a, b) => a[0].localeCompare(b[0]));
    if (surface.length) for (const [k, n] of surface) console.log(`  ${k}${n > 1 ? `  ×${n}` : ''}`);
    else console.log(`  (no ${RECV.join(' / ')} access in the handler's own span)`);
    if (helpers.size) {
        console.log('  hands ctx to (not followed):');
        for (const [h, line] of helpers) console.log(`    ${h}${line ? `  ${relative(ROOT, join(ROOT, r.file))}:${line}` : '  (defined elsewhere)'}`);
    }
}
