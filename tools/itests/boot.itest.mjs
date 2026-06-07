// boot — the app initializes with no uncaught/console errors.
//
// Regression guard for render-crash bugs: an undefined variable in a panel (e.g. the
// RepoPanel `progress` bug) throws during React render and, with no error boundary,
// takes down the whole tree — which this catches as either "not booted" or errors.

export default async ({ app, assert }) => {
  assert.ok(app.booted, 'app booted (window.__glyphClient present)');
  assert.noErrors(app);
};
