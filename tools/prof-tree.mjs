// prof-tree.mjs — summarize a V8 .cpuprofile by CALL TREE, not just self-time. Answers
// "what DRIVES the hot leaf functions" (e.g. the render loop vs the picking pass) by rolling
// total time (self + descendants) up the tree and printing the heaviest root→leaf spines.
//
//   bun tools/prof-tree.mjs <file.cpuprofile> [--depth N] [--min MS] [--grep substr]

const file = process.argv[2];
if (!file) { console.error('usage: bun tools/prof-tree.mjs <file.cpuprofile> [--depth N] [--min MS] [--grep s]'); process.exit(2); }
const flags = process.argv.slice(3);
const depth = Number((flags[flags.indexOf('--depth') + 1]) || 16);
const minMs = Number((flags[flags.indexOf('--min') + 1]) || 30);
const grep = flags.includes('--grep') ? flags[flags.indexOf('--grep') + 1] : null;

const prof = JSON.parse(await Bun.file(file).text());
const byId = new Map(prof.nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of prof.nodes) for (const ch of (n.children || [])) parent.set(ch, n.id);

// self time (samples) → ms
const sampleMs = (prof.endTime && prof.startTime && prof.samples?.length)
  ? (prof.endTime - prof.startTime) / 1000 / prof.samples.length : 0.2;
const selfMs = new Map();
for (const n of prof.nodes) selfMs.set(n.id, (n.hitCount || 0) * sampleMs);

// total time (self + descendants), memoized
const totalMs = new Map();
function total(id) {
  if (totalMs.has(id)) return totalMs.get(id);
  let t = selfMs.get(id) || 0;
  for (const ch of (byId.get(id).children || [])) t += total(ch);
  totalMs.set(id, t);
  return t;
}
const label = (n) => {
  const cf = n.callFrame;
  const url = (cf.url || '').replace(/^https?:\/\/[^/]+/, '').split('?')[0].replace('/node_modules/.vite/deps/', '~/');
  return `${cf.functionName || '(anon)'} ${url ? '· ' + url + ':' + (cf.lineNumber + 1) : ''}`;
};

// roots = nodes whose parent is missing or is "(root)"
const rootId = prof.nodes.find((n) => n.callFrame.functionName === '(root)')?.id ?? prof.nodes[0].id;
const wall = (prof.endTime - prof.startTime) / 1000;
console.log(`profile: ${file}  wall ${Math.round(wall)}ms · ${prof.samples.length} samples · ${sampleMs.toFixed(3)}ms/sample\n`);

// Heaviest spine: from each root child, descend always into the heaviest child, printing total/self.
console.log('── heaviest call spines (total ms; ▸self) ──');
function spine(id, d, prefixTotal) {
  const n = byId.get(id);
  const tot = total(id), self = selfMs.get(id) || 0;
  if (tot < minMs) return;
  const bar = '  '.repeat(d);
  console.log(`${String(Math.round(tot)).padStart(6)}ms ${bar}${label(n)}  ▸${Math.round(self)}ms`);
  if (d >= depth) return;
  const kids = (n.children || []).map((c) => [c, total(c)]).sort((a, b) => b[1] - a[1]);
  for (const [c, t] of kids) { if (t >= minMs) spine(c, d + 1, tot); }
}
for (const c of (byId.get(rootId).children || []).map((c) => [c, total(c)]).sort((a, b) => b[1] - a[1])) {
  if (c[1] >= minMs) spine(c[0], 0, 0);
}

// Optional: total time under any frame matching --grep (e.g. "Picking", "render", "updateMatrixWorld").
if (grep) {
  let hit = 0;
  for (const n of prof.nodes) if ((n.callFrame.functionName + ' ' + (n.callFrame.url || '')).toLowerCase().includes(grep.toLowerCase())) hit += total(n.id);
  console.log(`\nΣ total time under any "${grep}" frame: ~${Math.round(hit)}ms (double-counts nested matches)`);
}
