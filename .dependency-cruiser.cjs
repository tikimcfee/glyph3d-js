/**
 * dependency-cruiser — the layering CLAUDE.md states, held as rules over the import graph.
 *
 *   bunx depcruise --config .dependency-cruiser.cjs packages app wall
 *
 * The check runner runs it as the `layering` gate (tools/check-manifest.mjs). Every rule is
 * an error: the graph today has no violation and no cycle, so a new edge of any of these
 * kinds is a regression, not debt.
 *
 * node_modules is `doNotFollow`, never `exclude`: an excluded path drops the EDGE into it too,
 * so a core → react import would vanish from the graph and core-no-react could never fire.
 * Not followed, the edge stays (to node_modules/react/…) and only react's own imports go
 * uncruised.
 *
 * Blind to: dynamic `import()` of a computed string, `new URL(…, import.meta.url)` assets,
 * workers spawned by URL, globals (a worker touching `document` imports nothing), and type-only
 * JSDoc `import('…')` references — the graph is what static ESM imports say.
 */
module.exports = {
  forbidden: [
    {
      name: 'core-no-app',
      severity: 'error',
      comment: '@glyph3d/core is the library: it imports neither the IDE (app/) nor the wall (wall/)',
      from: { path: '^packages/glyph3d-core/src' },
      to: { path: '^(app|wall)/' },
    },
    {
      name: 'core-no-bindings',
      severity: 'error',
      comment: 'core sits under the r3f binding, never on it',
      from: { path: '^packages/glyph3d-core/src' },
      to: { path: '^packages/glyph3d-r3f/' },
    },
    {
      name: 'core-no-react',
      severity: 'error',
      comment: 'core is vanilla Three.js with no UI-framework dependency (CLAUDE.md)',
      from: { path: '^packages/glyph3d-core/src' },
      to: { path: '(^|/)node_modules/(react|react-dom|@react-three/[^/]+)/' },
    },
    {
      name: 'workers-no-three',
      severity: 'error',
      comment: 'worker-compatible code in workers/ stays free of Three.js (and DOM) imports (CLAUDE.md)',
      from: { path: '^packages/glyph3d-core/src/workers/' },
      to: { path: '(^|/)node_modules/three/' },
    },
    {
      name: 'wall-no-app',
      severity: 'error',
      comment: 'the wall shares the core, not the IDE',
      from: { path: '^wall/' },
      to: { path: '^app/' },
    },
    {
      name: 'core-no-cycles',
      severity: 'error',
      comment: 'no circular imports inside the core',
      from: { path: '^packages/glyph3d-core/src' },
      to: { path: '^packages/glyph3d-core/src', circular: true },
    },
  ],
  options: {
    doNotFollow: { path: '(^|/)node_modules/' },
    // Build output and agent worktrees (which live INSIDE the repo, under .claude/worktrees).
    exclude: { path: '(^|/)(dist|\\.claude)/' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'default'],
      extensions: ['.js', '.jsx', '.mjs'],
    },
  },
};
