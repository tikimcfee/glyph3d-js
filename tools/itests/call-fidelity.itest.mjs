// call-fidelity — the `call` bundle hatch carries any arg through the bus intact.
//
// The bus tokenizer (CommandRouter.parse) strips quotes and splits on spaces, so a
// detail string with spaces/quotes/backslashes (a bash command, a grep pattern) can't ride
// a plain command line. `call <base64-json>` is the escape hatch: it decodes to the same
// [name, ...args] vector and re-dispatches. This locks that the hatch round-trips a corpus
// of gnarly inputs BYTE-IDENTICAL — it's the regression guard for cli/hook.go's activity
// transport (see the field-visitor system + the call-bundle-hatch memory).
//
// Built to DISCRIMINATE, not rubber-stamp: it also asserts the naive plain-line path
// genuinely corrupts spaced/quoted inputs. If that stops being true (someone makes the bus
// quote-proof), the teeth assertion flags that this test may no longer test what it thinks.
//
// The corpus is authored as plain JS literals here and passed to the page as a structured
// arg (Playwright clones it) — NOT embedded in an eval string. A fidelity test must not be
// fragile about its own escaping.

const CORPUS = [
  ['plain',           'analyzed'],
  ['spaces',          'rg -n TODO src/'],
  ['dquotes-pipe',    'rg -n "TODO|FIXME" src/'],
  ['squotes',         "grep -E 'foo|bar' ."],
  ['backslash',       'find . -name \\*.js'],
  ['win-path',        'C:\\Users\\ivan\\x'],
  ['tab',             'col1\tcol2'],
  ['newline',         'line1\nline2'],
  ['json-blob',       '{"mode":"newspaper","n":3}'],
  ['looks-like-flag', '--mode'],
  ['unicode-emoji',   'café ☕ 日本語 — slug 🐌'],
  ['empty',           ''],
  ['embedded-quotes', 'he said "hi" then \\ left'],
  ['git-commit',      'git commit -m "fix: pipe | and quotes"'],
  ['multiline-task',  'Map the system.\nReport file:line refs.'],
  ['path-with-space', 'my notes/draft file.md'],
  ['kitchen-sink',    'awk \'{print $1}\' | sed "s/x/y/" > /tmp/o\tand'],
];

// Inputs whose detail has a space/quote/backslash — the plain line MUST corrupt these, or
// the test isn't exercising real corruption (the discrimination canary).
const MUST_CORRUPT_NAIVE = ['spaces', 'dquotes-pipe', 'backslash', 'json-blob', 'git-commit', 'empty'];

export default async ({ app, assert }) => {
  assert.ok(app.booted, 'app booted (window.__glyphClient present)');

  // Run the whole corpus through the REAL in-browser bus + the REAL `call` handler. The
  // probe verb echoes the args it received so we can compare to the original byte-for-byte.
  const rows = await app.evalPage(async (corpus) => {
    const router = window.__glyphClient.router;
    router.register('itestprobe', (args) => ({ text: 'ok', data: { got: args } }));

    const enc = new TextEncoder();
    const b64 = (s) => { let bin = ''; for (const b of enc.encode(s)) bin += String.fromCharCode(b); return btoa(bin); };
    const asBundle = (argv) => 'call ' + b64(JSON.stringify(argv));
    // Best-effort disciplined quoting — the strongest the plain-line path can manage.
    const asQuoted = (s) => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t') + '"';

    const survives = async (line, expect) => {
      const r = await router.execute(line);
      const got = r && r.data && r.data.got;
      return Array.isArray(got) && got.length === 1 && got[0] === expect;
    };

    const out = [];
    for (const [name, detail] of corpus) {
      out.push({
        name,
        naive:  await survives('itestprobe ' + detail, detail),
        quoted: await survives('itestprobe ' + asQuoted(detail), detail),
        bundle: await survives(asBundle(['itestprobe', detail]), detail),
      });
    }
    return out;
  }, CORPUS);

  // (1) THE GUARD: the bundle must round-trip every input, byte-identical.
  for (const r of rows) {
    assert.ok(r.bundle, `call bundle preserves "${r.name}" intact`);
  }

  // (2) THE TEETH: the naive plain line must corrupt the spaced/quoted inputs — proof this
  //     test exercises real corruption rather than passing vacuously.
  for (const r of rows.filter((x) => MUST_CORRUPT_NAIVE.includes(x.name))) {
    assert.ok(!r.naive, `naive line corrupts "${r.name}" (the problem the hatch solves is real)`);
  }

  // (3) Sanity: a no-special-char input rides the plain line fine — so the hatch is for the
  //     gnarly cases, not a blanket replacement (validates the hook's hybrid transport).
  assert.ok(rows.find((r) => r.name === 'plain').naive, 'plain input needs no hatch (bare line works)');

  const tally = (k) => rows.reduce((n, r) => n + (r[k] ? 1 : 0), 0);
  console.log(`      fidelity: naive ${tally('naive')}/${rows.length} · quoted ${tally('quoted')}/${rows.length} · bundle ${tally('bundle')}/${rows.length}`);

  assert.noErrors(app);
};
