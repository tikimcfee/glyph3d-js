// semantic.itest.mjs — the arborist end-to-end. Parse real files in a live WebGPU
// browser and read the structure model back off the command bus (semantic.outline),
// confirming the full named-node walk + web-tree-sitter node API + kind labeling.
//
//   bun tools/itest.mjs --headed semantic
//
// Files come from GitHub (repo.load); the PARSING CODE is the local vite-served build,
// so this exercises our new analyzer against real committed source. Restart vite after
// core edits first (core serves stale otherwise).

export default async ({ app, assert }) => {
    assert.ok(app.booted, 'app booted');

    const load = await app.cmd('repo.load tikimcfee/glyph3d-js');
    assert.ok(!load.error, `repo.load: ${load.error || load.text}`);
    await app.waitFor(2500);

    const targets = [
        'package.json',                                              // JSON: object/property
        'packages/glyph3d-core/src/collections/CodeGrid.js',        // class + many methods
        'app/commands/handlers/highlightCommands.js',               // top-level functions + nested arrows
    ];
    for (const t of targets) {
        const r = await app.cmd(`file.open ${t}`);
        assert.ok(!r.error, `file.open ${t}: ${r.error || ''}`);
        await app.waitFor(4000); // lazy grammar wasm fetch (first of a type) + parse + full walk
    }

    // Probe just the three targets. For each: confirm structure is NOT eagerly built
    // on bulk load (lazy), gets built on first query, and the cache returns the SAME
    // model object on repeat. router.execute gives us .data, which app.cmd drops.
    const probe = await app.evalPage(`(async () => {
        const c = window.__glyphClient;
        const ex = async (line) => { try { return await c.router.execute(line); } catch (e) { return { error: String(e) }; } };
        const grids = c.ctx.getGrids?.() || [];
        const want = [/CodeGrid\\.js$/, /highlightCommands\\.js$/, /package\\.json$/];
        const out = [];
        for (let i = 0; i < grids.length; i++) {
            const g = grids[i];
            const fn = g.getFilename?.() || g.filename || '';
            if (!want.some((re) => re.test(fn))) continue;
            const lazyBefore = g.getSemantics?.() == null;       // not eagerly built on bulk load
            const def = await ex('semantic.outline ' + i);       // forces ensureSemantics → build
            const sem = g.getSemantics?.();
            const m1 = await g.ensureSemantics?.();
            const m2 = await g.ensureSemantics?.();
            const cacheHit = !!m1 && m1 === m2 && m1 === sem;     // same object, no rebuild
            const kinds = {};
            for (const k of ['function','method','class','variable','import','property']) {
                const r = await ex('semantic.outline ' + i + ' ' + k);
                const n = r.data?.nodes?.length || 0; if (n) kinds[k] = n;
            }
            out.push({ i, fn, lazyBefore, builtAfter: sem != null, cacheHit, total: sem?.flat?.length ?? 0, kinds, headline: def.text || '' });
        }
        return out;
    })()`);

    console.log('\n══════════ semantic report ══════════');
    for (const g of probe) {
        console.log(`\n[${g.i}] ${g.fn}  —  ${g.total} nodes | lazyBefore=${g.lazyBefore} builtAfter=${g.builtAfter} cacheHit=${g.cacheHit}`);
        console.log('  kinds:', JSON.stringify(g.kinds));
        console.log('  ── outline ──\n' + g.headline.split('\n').map((l) => '    ' + l).join('\n'));
    }

    // Parse failures log to the [tree-sitter] warnings bucket, not errors — surface
    // them explicitly so a silent throw across the bulk colorize load shows.
    const tsFails = app.warnings.filter((w) => /analyzeGrid failed|buildGridSemantics failed/.test(w));
    console.log(`\nwarnings: ${app.warnings.length} | analyze/build failures: ${tsFails.length}`);
    for (const w of tsFails.slice(0, 8)) console.log('  ⚠ ' + w);
    console.log('═════════════════════════════════════\n');

    // ── assertions: laziness + cache ────────────────────────────────────────
    assert.atLeast(probe.length, 3, `found the targets (${probe.length}; monorepo has several package.json)`);
    for (const g of probe) {
        assert.ok(g.lazyBefore, `${g.fn}: structure NOT eagerly built on load (lazy)`);
        assert.ok(g.builtAfter, `${g.fn}: structure built on first query`);
        assert.ok(g.cacheHit, `${g.fn}: cache returns the same model on repeat`);
    }
    assert.equal(tsFails.length, 0, `no analyze/build failures (${tsFails.length})`);

    // ── assertions: structure correctness ───────────────────────────────────
    const cg = probe.find((r) => /CodeGrid\.js$/.test(r.fn));
    assert.atLeast(cg.total, 50, `CodeGrid.js full-AST node count (${cg.total})`);
    assert.atLeast(cg.kinds.method || 0, 10, `CodeGrid.js method count (${cg.kinds.method})`);
    assert.atLeast(cg.kinds.class || 0, 1, `CodeGrid.js class count (${cg.kinds.class})`);
    assert.ok(/class\s+CodeGrid/.test(cg.headline), 'outline names class CodeGrid');

    const hc = probe.find((r) => /highlightCommands\.js$/.test(r.fn));
    assert.atLeast(hc.kinds.function || 0, 1, `highlightCommands.js function count (${hc.kinds.function})`);
    assert.ok(/registerHighlightCommands/.test(hc.headline), 'outline names registerHighlightCommands');

    const pj = probe.find((r) => /package\.json$/.test(r.fn));
    assert.atLeast(pj.total, 5, `package.json node count (${pj.total})`);

    // ── "click → where am I": the enclosing-scope chain off the cursor ───────
    // Key the CodeGrid grid, drop the cursor inside a method, and read the AST
    // chain back off context.info — the same surface the breadcrumb renders.
    const ctxProbe = await app.evalPage(`(async () => {
        const c = window.__glyphClient;
        const ex = (line) => c.router.execute(line);
        const grids = c.ctx.getGrids?.() || [];
        const g = grids.find((x) => /CodeGrid\\.js$/.test(x.getFilename?.() || x.filename || ''));
        if (!g) return { err: 'no CodeGrid grid' };
        const id = g.getFilename?.() || g.filename;
        const model = await g.ensureSemantics();
        const m = model.outline('method').find((n) => n.name && (n.end.line - n.start.line) >= 2);
        if (!m) return { err: 'no multi-line named method' };
        await ex(['attention.set', 'primary', id]);
        // edit.goto is what a click fires — it establishes the cursor (setCursor only
        // MOVES an existing one) and keys the grid, so the edit + ast chips derive.
        await ex(['edit.goto', id, String(m.start.line + 1), '4']);
        const info = await ex('context.info');
        return {
            method: m.name,
            text: info.text,
            nodes: (info.data?.nodes || []).map((n) => ({ kind: n.kind, label: n.label, nodeKind: n.nodeKind, name: n.name })),
        };
    })()`);

    console.log('── click → context ──');
    console.log('  ' + JSON.stringify(ctxProbe, null, 2).split('\n').join('\n  '));

    assert.ok(!ctxProbe.err, `context probe ran (${ctxProbe.err || 'ok'})`);
    const astNodes = ctxProbe.nodes.filter((n) => n.kind === 'ast');
    assert.atLeast(astNodes.length, 1, `enclosing-scope chips present (${astNodes.length})`);
    assert.ok(
        astNodes.some((n) => n.nodeKind === 'method' && n.name === ctxProbe.method),
        `breadcrumb names the method "${ctxProbe.method}" (got ${astNodes.map((n) => n.label).join(' › ')})`,
    );
    assert.ok(
        astNodes.some((n) => n.nodeKind === 'class' && n.name === 'CodeGrid'),
        'breadcrumb names the enclosing class CodeGrid',
    );
    const kinds = ctxProbe.nodes.map((n) => n.kind);
    assert.ok(kinds.indexOf('ast') < kinds.lastIndexOf('edit'), 'scope chain precedes the edit chip');

    // Ground truth: the breadcrumb DOM actually renders the chips (not just the bus).
    await app.waitFor(300); // let the InteractionContext emit flush into React
    const dom = await app.evalPage(`document.querySelector('[data-g3d-context]')?.textContent ?? ''`);
    console.log('  breadcrumb DOM: ' + JSON.stringify(dom));
    assert.ok(dom.includes(ctxProbe.method), `breadcrumb DOM shows the method "${ctxProbe.method}" (got "${dom}")`);
    assert.ok(dom.includes('CodeGrid'), `breadcrumb DOM shows the enclosing class (got "${dom}")`);

    await app.shot('/tmp/semantic-itest.png');
    assert.noErrors(app);
};
