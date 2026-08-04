// bridge-binary.test.mjs — behavior lock for the RPC binary result plane:
//
//   bun tools/bridge-binary.test.mjs
//
// The relay answers binary-opted content RPCs (fs/readFile, fs/readRange,
// agentSessions/read) with ONE raw frame instead of a JSON-escaped string:
//
//   [0x02][idLen:u8][id:utf8][hdrLen:u32 BE][hdr JSON][raw payload]
//
// The bridge demuxes it in _handleBinary (type 0x02 — terminal OUTPUT stays 0x01),
// parses header + payload, and resolves the pending rpcRequest with
// { ...headerFields, bytes }. Headless: _handleBinary only touches _rpcPending /
// _binaryHandlers, so a prototype shell stands in for a connected bridge.

import WebSocketBridge from '../packages/glyph3d-core/src/services/orchestration/WebSocketBridge.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error(`  ✗ ${msg}`); } };
const J = (v) => JSON.stringify(v);
const eq = (a, b, msg) => ok(J(a) === J(b), `${msg}\n      got  ${J(a)}\n      want  ${J(b)}`);

/** A bridge shell with just the state _handleBinary reads. */
function shell() {
    const b = Object.create(WebSocketBridge.prototype);
    b._rpcPending = new Map();
    b._binaryHandlers = new Map();
    return b;
}

/** Frame a binary result exactly like cli/fs.go sendRPCBinaryResult. */
function frame(id, hdr, payload) {
    const idBytes = new TextEncoder().encode(String(id));
    const hdrBytes = new TextEncoder().encode(JSON.stringify(hdr));
    const out = new Uint8Array(2 + idBytes.length + 4 + hdrBytes.length + payload.length);
    out[0] = 0x02;
    out[1] = idBytes.length;
    out.set(idBytes, 2);
    new DataView(out.buffer).setUint32(2 + idBytes.length, hdrBytes.length);
    out.set(hdrBytes, 2 + idBytes.length + 4);
    out.set(payload, 2 + idBytes.length + 4 + hdrBytes.length);
    return out;
}

/** Register a pending RPC and return its promise. */
function pending(bridge, id) {
    return new Promise((resolve, reject) => {
        bridge._rpcPending.set(id, { resolve, reject, timer: setTimeout(() => reject(new Error('timeout')), 5000) });
    });
}

// ── binary result resolves its pending rpc with header fields + raw bytes ─────
{
    const b = shell();
    const body = new TextEncoder().encode('{"line":1}\n{"line":2}\n');
    const p = pending(b, 7);
    b._handleBinary(frame(7, { uri: 'file:///x.jsonl', size: body.length, truncated: false }, body).buffer);
    const r = await p;
    eq(r.uri, 'file:///x.jsonl', 'header fields spread onto the result');
    eq(r.size, body.length, 'numeric header field');
    eq(r.truncated, false, 'boolean header field');
    eq(Array.from(r.bytes), Array.from(body), 'payload arrives as raw bytes');
    eq(new TextDecoder().decode(r.bytes), '{"line":1}\n{"line":2}\n', 'payload TextDecodes to the content string');
    ok(!b._rpcPending.has(7), 'pending entry consumed');
}

// ── non-UTF-8 payloads cross untouched (the readRange case — no base64 anywhere) ──
{
    const b = shell();
    const raw = new Uint8Array([0x00, 0xff, 0xfe, 0x01, 0x61]);
    const p = pending(b, 3);
    b._handleBinary(frame(3, { offset: 1, length: 5, totalSize: 8 }, raw).buffer);
    const r = await p;
    eq(Array.from(r.bytes), [0x00, 0xff, 0xfe, 0x01, 0x61], 'binary payload verbatim');
}

// ── terminal OUTPUT frames still demux with cols/rows (type 0x01 untouched) ────
{
    const b = shell();
    const idBytes = new TextEncoder().encode('term-1');
    const payload = new Uint8Array([0x1b, 0x5b, 0x48]); // ESC [ H
    const out = new Uint8Array(2 + idBytes.length + 4 + payload.length);
    out[0] = 0x01;
    out[1] = idBytes.length;
    out.set(idBytes, 2);
    const o = 2 + idBytes.length;
    out[o] = 0; out[o + 1] = 80;   // cols BE
    out[o + 2] = 0; out[o + 3] = 24; // rows BE
    out.set(payload, o + 4);
    let got = null;
    b._binaryHandlers.set(0x01, (id, pl, cols, rows) => { got = { id, pl: Array.from(pl), cols, rows }; });
    b._handleBinary(out.buffer);
    eq(got, { id: 'term-1', pl: [0x1b, 0x5b, 0x48], cols: 80, rows: 24 }, 'OUTPUT frame layout unchanged');
}

// ── junk frames settle nothing and throw nothing ───────────────────────────────
{
    const b = shell();
    b._handleBinary(new Uint8Array([0x02]).buffer);                       // too short
    b._handleBinary(new Uint8Array([0x02, 1, 0x39, 0, 0]).buffer);        // hdrLen truncated
    b._handleBinary(frame(99, {}, new Uint8Array()).buffer);              // no such pending id
    b._handleBinary(new TextEncoder().encode('\x02\x019not json at all payload').buffer); // bad hdr JSON
    ok(true, 'malformed frames are dropped quietly');
    eq(b._rpcPending.size, 0, 'nothing pends after junk');
}

console.log(`\nbridge-binary: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
