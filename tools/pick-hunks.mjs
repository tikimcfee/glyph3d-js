// pick-hunks.mjs — stage YOUR hunks of a shared file, leave a co-worker's in the tree.
//
// Two live sessions committing to one working tree routinely co-edit settings.js or
// CommandProvider.jsx. Committing the whole file sweeps the other session's in-flight
// work into your commit (and can break HEAD standalone when their half references
// exports they haven't committed yet). This filters `git diff <file>` down to the
// hunks that match YOUR markers, ready for `git apply --cached`:
//
//   bun tools/pick-hunks.mjs app/client/settings.js 'labels\.turn' 'maxSheets' > /tmp/mine.patch
//   git apply --cached /tmp/mine.patch      # then commit; the tree keeps everything
//
//   argv: <file> <keep-regex> [drop-regex]
//   keep: a hunk is kept when its +/- lines match; drop: rejected even if keep matches.
//   Exits 0 with the patch on stdout (empty output = no hunks kept — do NOT apply).
//   ALWAYS overlap-scan before committing shared files:  git diff <file> | rg '^[+-]' …

const [file, keepRe, dropRe] = process.argv.slice(2);
if (!file || !keepRe) {
    console.error('usage: bun tools/pick-hunks.mjs <file> <keep-regex> [drop-regex]');
    process.exit(2);
}
const diff = await Bun.$`git diff -- ${file}`.text();
if (!diff.trim()) { console.error(`${file}: no diff`); process.exit(0); }
const lines = diff.split('\n');
const headEnd = lines.findIndex((l) => l.startsWith('@@'));
if (headEnd === -1) { console.error(`${file}: no hunks`); process.exit(0); }
const header = lines.slice(0, headEnd).join('\n');
const hunks = [];
let cur = null;
for (const l of lines.slice(headEnd)) {
    if (l.startsWith('@@')) { if (cur) hunks.push(cur); cur = [l]; }
    else if (cur) cur.push(l);
}
if (cur) hunks.push(cur);
const keep = new RegExp(keepRe);
const drop = dropRe ? new RegExp(dropRe) : null;
const picked = hunks.filter((h) => {
    const changed = h.filter((l) => /^[+-]/.test(l)).join('\n');
    return keep.test(changed) && !(drop && drop.test(changed));
});
console.error(`${file}: ${picked.length}/${hunks.length} hunks kept`);
if (picked.length) console.log(header + '\n' + picked.map((h) => h.join('\n')).join('\n'));
