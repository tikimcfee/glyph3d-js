#!/usr/bin/env bun
// lsp.mjs — one-shot headless code intelligence: ask typescript-language-server about the
// repo's JS from a shell. The same answers Claude Code's LSP tool gives, for any agent or
// session that lacks that tool (cloud sessions don't start plugin language servers).
//
//   bun tools/lsp.mjs hover   app/client/CommandProvider.jsx:349:11
//   bun tools/lsp.mjs refs    packages/glyph3d-core/src/services/orchestration/CommandRouter.js:139:execute
//   bun tools/lsp.mjs def     app/FileTree.jsx:336:execute
//   bun tools/lsp.mjs callers packages/glyph3d-core/src/collections/CodeGrid.js:749:_relayout
//   bun tools/lsp.mjs callees <file:line:col>
//   bun tools/lsp.mjs impl    <file:line:col>
//   bun tools/lsp.mjs symbols TerminalGrid            (workspace search; --all keeps node_modules)
//   bun tools/lsp.mjs outline app/client/settings.js
//
// A position is FILE:LINE:COL (1-based, as editors show) or FILE:LINE:NAME — the column of
// NAME's first occurrence on that line, so an rg hit (file:line) plus the identifier is
// enough. Several targets may follow one op (they share one server boot). --json prints the
// raw LSP results.
//
// WARM-UP: tsserver answers BEFORE its project finishes loading, and those early answers are
// partial (refs from only the open file, `ctx: any` for types that cross modules). The server
// announces the load as a progress span ("Initializing JS/TS language features…" begin → end,
// ~1.2s here); this tool waits for its end before asking anything. If the end never comes it
// says so on stderr rather than passing partial answers off as complete.
//
// Types reach only as far as the JSDoc does: a reference through an untyped receiver is
// invisible to `refs`. `bun tools/type-imports-check.mjs` guards the seams that silently
// degrade types to any; rg remains the completeness check for dynamic call sites.

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const WARM_TIMEOUT_MS = Number(process.env.LSP_WARM_TIMEOUT_MS || 30000);
const OPS = ['hover', 'def', 'refs', 'impl', 'callers', 'callees', 'symbols', 'outline'];

const argv = process.argv.slice(2);
const json = argv.includes('--json');
const all = argv.includes('--all');
const [op, ...targets] = argv.filter((a) => !a.startsWith('--'));
if (!OPS.includes(op) || !targets.length) {
    console.error(`usage: bun tools/lsp.mjs <${OPS.join('|')}> <file:line:col|file:line:name|query>... [--json] [--all]`);
    process.exit(2);
}
if (spawnSync('typescript-language-server', ['--version']).error) {
    console.error('lsp: typescript-language-server not on PATH — install it: bun add -g typescript-language-server typescript');
    process.exit(2);
}

// --- a minimal stdio JSON-RPC client -------------------------------------------------------
const server = spawn('typescript-language-server', ['--stdio'], { cwd: ROOT });
let inbox = Buffer.alloc(0), nextId = 0;
const pending = new Map();
let warmResolve;
const warm = new Promise((r) => { warmResolve = r; });
const warmTokens = new Set();

const send = (msg) => {
    const body = JSON.stringify({ jsonrpc: '2.0', ...msg });
    server.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
};
const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
    send({ id, method, params });
});
const notify = (method, params) => send({ method, params });

server.stdout.on('data', (chunk) => {
    inbox = Buffer.concat([inbox, chunk]);
    for (;;) {
        const head = inbox.indexOf('\r\n\r\n');
        if (head < 0) return;
        const len = Number(/Content-Length: (\d+)/i.exec(inbox.subarray(0, head))[1]);
        if (inbox.length < head + 4 + len) return;
        const msg = JSON.parse(inbox.subarray(head + 4, head + 4 + len));
        inbox = inbox.subarray(head + 4 + len);
        if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); continue; }
        if (msg.id != null && msg.method) send({ id: msg.id, result: null });   // server→client requests (progress/create)
        if (msg.method === '$/progress') {
            const { token, value } = msg.params;
            if (value?.kind === 'begin' && /Initializing/i.test(value.title || '')) warmTokens.add(token);
            if (value?.kind === 'end' && warmTokens.has(token)) warmResolve(true);
        }
    }
});
server.on('exit', (code) => { if (pending.size) { console.error(`lsp: server exited (${code})`); process.exit(1); } });

// --- positions + formatting ----------------------------------------------------------------
const abs = (f) => (path.isAbsolute(f) ? f : path.join(ROOT, f));
const uriOf = (f) => pathToFileURL(abs(f)).href;
const relOf = (uri) => path.relative(ROOT, fileURLToPath(uri));
const lineCache = new Map();
const linesOf = (file) => {
    if (!lineCache.has(file)) lineCache.set(file, readFileSync(file, 'utf8').split('\n'));
    return lineCache.get(file);
};
const opened = new Set();
const open = (file) => {
    if (opened.has(file)) return;
    opened.add(file);
    const languageId = /x$/.test(file) ? 'javascriptreact' : 'javascript';
    notify('textDocument/didOpen', { textDocument: { uri: pathToFileURL(file).href, languageId, version: 1, text: readFileSync(file, 'utf8') } });
};

/** FILE:LINE:COL or FILE:LINE:NAME → { file, position } (LSP's 0-based UTF-16 coordinates). */
function parsePosition(spec) {
    const m = /^(.+):(\d+):([^:]+)$/.exec(spec);
    if (!m) throw new Error(`not a position: ${spec} (want file:line:col or file:line:name)`);
    const file = abs(m[1]), line = Number(m[2]) - 1;
    const text = linesOf(file)[line];
    if (text == null) throw new Error(`${m[1]} has no line ${m[2]}`);
    let character;
    if (/^\d+$/.test(m[3])) character = Number(m[3]) - 1;
    else {
        const re = new RegExp(`\\b${m[3].replace(/[$]/g, '\\$')}\\b`);
        const hit = re.exec(text);
        if (!hit) throw new Error(`"${m[3]}" not on ${m[1]}:${m[2]}: ${text.trim()}`);
        character = hit.index;
    }
    return { file, position: { line, character } };
}

const at = (uri, range) => {
    const file = fileURLToPath(uri), line = range.start.line;
    const text = (linesOf(file)[line] ?? '').trim();
    return `${relOf(uri)}:${line + 1}:${range.start.character + 1}  ${text.length > 110 ? text.slice(0, 110) + '…' : text}`;
};
const locations = (result) => [].concat(result ?? []).map((l) => ({ uri: l.uri ?? l.targetUri, range: l.range ?? l.targetSelectionRange }));
const SYMBOL_KINDS = { 5: 'class', 6: 'method', 7: 'property', 8: 'field', 9: 'constructor', 12: 'function', 13: 'variable', 14: 'constant' };

function printOutline(symbols, depth = 0) {
    for (const s of symbols ?? []) {
        console.log(`${'  '.repeat(depth)}${SYMBOL_KINDS[s.kind] ?? `kind${s.kind}`} ${s.name}  :${s.range.start.line + 1}`);
        printOutline(s.children, depth + 1);
    }
}

// --- the session ---------------------------------------------------------------------------
await request('initialize', {
    processId: process.pid,
    rootUri: pathToFileURL(ROOT).href,
    workspaceFolders: [{ uri: pathToFileURL(ROOT).href, name: path.basename(ROOT) }],
    capabilities: { window: { workDoneProgress: true }, textDocument: { callHierarchy: {}, documentSymbol: { hierarchicalDocumentSymbolSupport: true } } },
});
notify('initialized', {});

// The project loads on the first open document, so open one before waiting.
let firstFile;
try {
    firstFile = op === 'symbols' ? path.join(ROOT, 'app/client/CommandProvider.jsx')
        : op === 'outline' ? abs(targets[0]) : parsePosition(targets[0]).file;
} catch (e) {
    console.error(`lsp: ${e.message}`);
    server.kill();
    process.exit(1);
}
open(firstFile);
const warmed = await Promise.race([warm, new Promise((r) => setTimeout(() => r(false), WARM_TIMEOUT_MS))]);
if (!warmed) console.error(`lsp: no project-load "end" within ${WARM_TIMEOUT_MS}ms — answers below may be PARTIAL`);

let failed = false;
for (const target of targets) {
    try {
        if (targets.length > 1 && !json) console.log(`── ${op} ${target}`);
        if (op === 'symbols') {
            const found = (await request('workspace/symbol', { query: target }) ?? [])
                .filter((s) => all || !s.location.uri.includes('/node_modules/'));
            if (json) { console.log(JSON.stringify(found, null, 2)); continue; }
            for (const s of found) console.log(`${SYMBOL_KINDS[s.kind] ?? `kind${s.kind}`} ${s.containerName ? s.containerName + '.' : ''}${s.name}  ${at(s.location.uri, s.location.range)}`);
            if (!found.length) console.log('(no symbols)');
            continue;
        }
        if (op === 'outline') {
            const file = abs(target); open(file);
            const syms = await request('textDocument/documentSymbol', { textDocument: { uri: uriOf(file) } });
            if (json) console.log(JSON.stringify(syms, null, 2)); else printOutline(syms);
            continue;
        }
        const { file, position } = parsePosition(target);
        open(file);
        const textDocument = { uri: pathToFileURL(file).href };
        if (op === 'hover') {
            const h = await request('textDocument/hover', { textDocument, position });
            if (json) { console.log(JSON.stringify(h, null, 2)); continue; }
            const v = h?.contents?.value ?? (Array.isArray(h?.contents) ? h.contents.map((c) => c.value ?? c).join('\n') : h?.contents);
            console.log(v ? v.replace(/```typescript\n?|```/g, '').trim() : '(no hover)');
        } else if (op === 'def' || op === 'refs' || op === 'impl') {
            const method = { def: 'textDocument/definition', refs: 'textDocument/references', impl: 'textDocument/implementation' }[op];
            const res = locations(await request(method, { textDocument, position, context: { includeDeclaration: false } }));
            if (json) { console.log(JSON.stringify(res, null, 2)); continue; }
            for (const l of res) console.log(at(l.uri, l.range));
            if (op === 'refs') console.log(`${res.length} refs in ${new Set(res.map((l) => l.uri)).size} files`);
            if (!res.length && op !== 'refs') console.log(`(no ${op})`);
        } else {
            const [item] = (await request('textDocument/prepareCallHierarchy', { textDocument, position })) ?? [];
            if (!item) { console.log('(not a callable at that position)'); continue; }
            const calls = await request(op === 'callers' ? 'callHierarchy/incomingCalls' : 'callHierarchy/outgoingCalls', { item }) ?? [];
            if (json) { console.log(JSON.stringify(calls, null, 2)); continue; }
            for (const c of calls) {
                const node = c.from ?? c.to;
                console.log(`${node.name}  ${at(node.uri, node.selectionRange)}`);
            }
            console.log(`${calls.length} ${op}`);
        }
    } catch (e) {
        failed = true;
        console.error(`lsp: ${target}: ${e.message}`);
    }
}

await request('shutdown', null).catch(() => {});
notify('exit', null);
server.kill();
process.exit(failed ? 1 : 0);
