// terminal-frame-format-check.mjs — locks the OUTPUT data-plane frame wire format across the
// Go/JS seam. The adapter (cli/attach_unix.go encodeOutputFrame) and the client
// (WebSocketBridge._handleBinary) must agree byte-for-byte on:
//   [type:u8][idLen:u8][id:utf8][cols:u16 BE][rows:u16 BE][payload]
// A drift here silently mis-tags size (→ wrong emulator resize) or offsets the payload (→ garbage).
//
//   bun tools/terminal-frame-format-check.mjs

let pass = 0, fail = 0;
const ok = (c, m) => { console.log(`${c ? '✓' : '✗ FAIL'} ${m}`); if (c) pass++; else fail++; };

const frameOutput = 0x01;

// Mirror of Go encodeOutputFrame(id, cols, rows, payload) — the source of truth is attach_unix.go.
function encodeOutputFrame(id, cols, rows, payload) {
    const idb = new TextEncoder().encode(id);
    const frame = new Uint8Array(2 + idb.length + 4 + payload.length);
    frame[0] = frameOutput;
    frame[1] = idb.length;
    frame.set(idb, 2);
    const off = 2 + idb.length;
    frame[off] = (cols >> 8) & 0xff; frame[off + 1] = cols & 0xff;
    frame[off + 2] = (rows >> 8) & 0xff; frame[off + 3] = rows & 0xff;
    frame.set(payload, off + 4);
    return frame;
}

// Mirror of WebSocketBridge._handleBinary decode — kept in lockstep with the real parser.
function decode(buf) {
    const view = new Uint8Array(buf);
    if (view.length < 2) return null;
    const type = view[0];
    const idLen = view[1];
    if (view.length < 2 + idLen + 4) return null;
    const id = new TextDecoder().decode(view.subarray(2, 2 + idLen));
    const off = 2 + idLen;
    const cols = (view[off] << 8) | view[off + 1];
    const rows = (view[off + 2] << 8) | view[off + 3];
    const payload = view.subarray(off + 4);
    return { type, id, cols, rows, payload };
}

// Roundtrip a variety of ids/sizes/payloads.
const cases = [
    { id: 'term-1', cols: 80, rows: 24, payload: [0x1b, 0x5b, 0x32, 0x4a] },       // ESC[2J
    { id: 'term-42', cols: 200, rows: 60, payload: [...'hello world'].map((c) => c.charCodeAt(0)) },
    { id: 't', cols: 1, rows: 1, payload: [] },                                     // min dims, empty payload
    { id: 'term-999', cols: 65535, rows: 65535, payload: [0xff, 0x00, 0x80] },      // u16 max (BE high byte set)
    { id: 'term-256', cols: 256, rows: 300, payload: [0x0a, 0x0d] },                // cross a byte boundary in BE
];

for (const c of cases) {
    const frame = encodeOutputFrame(c.id, c.cols, c.rows, new Uint8Array(c.payload));
    const d = decode(frame.buffer);
    ok(d && d.type === frameOutput, `[${c.id}] type byte survives`);
    ok(d && d.id === c.id, `[${c.id}] id roundtrips (got "${d?.id}")`);
    ok(d && d.cols === c.cols, `[${c.id}] cols ${c.cols} roundtrips BE (got ${d?.cols})`);
    ok(d && d.rows === c.rows, `[${c.id}] rows ${c.rows} roundtrips BE (got ${d?.rows})`);
    ok(d && d.payload.length === c.payload.length && [...d.payload].every((b, i) => b === c.payload[i]),
        `[${c.id}] payload intact (${c.payload.length} bytes, no offset drift)`);
}

// A truncated frame (header claims a size that isn't there) must be rejected, not misread.
ok(decode(new Uint8Array([frameOutput, 1, 0x61]).buffer) === null, 'truncated frame (no size block) → rejected');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
