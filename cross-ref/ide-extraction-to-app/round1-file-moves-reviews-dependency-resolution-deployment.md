# Round 1: file-moves reviews dependency-resolution, deployment

## Errors Found

### dependency-resolution

1. **File count is wrong (Section 1).** The inventory lists 4 files. There are 5. The missing file is `examples/ide/index.html` -- a meta-refresh redirect to `ide.html`. This file must move with the others; it is the entry point when navigating to the directory URL (the server serves `index.html` by default for directory listings). The dependency-resolution agent scoped to "imports" and correctly noted that `index.html` has no JS imports, but omitting it from the inventory creates a gap for anyone using this document as a move checklist.

2. **Import count is internally inconsistent (Sections 3 and 8).** Section 3 identifies imports #1-3, #6, #8, #9 as changing for `app/ide/` -- that is 6 imports. Section 8's summary table says "5 path rewrites (for `app/ide/`)" and the narrative on line 177 also says "5 paths change." The correct count is **6**. The enumerated imports in the table are correct; only the stated total is wrong.

3. **CommandBar.js new path in Section 3 (Option A, row #6).** The table shows the new path as `../../examples/github-viewer/websocket/commands/encoding.js`. This is wrong. CommandBar.js lives at `app/ide/components/CommandBar.js` (depth 3). To reach `examples/github-viewer/...` from depth 3, you need `../../../examples/github-viewer/...` (three `../` segments: up to `app/ide/`, up to `app/`, up to root). The dependency-resolution table only shows two `../` segments. Cross-referencing with my own analysis confirms the correct path is `'../../../examples/github-viewer/websocket/commands/encoding.js'`.

   **Wait -- let me re-read.** The table on line 69 says `../../examples/github-viewer/websocket/commands/encoding.js`. That is indeed wrong for `app/ide/components/CommandBar.js`. It resolves to `app/examples/github-viewer/...` which does not exist. The correct new path needs three `../` to reach the project root from depth 3.

### deployment

4. **Import count is self-contradictory (Section 4 vs Section 11).** Section 4 line 107 says "Total imports to update: 7" then line 109 says "5 imports across 3 files." The Section 11 checklist says "Update 5 relative imports" but the parenthetical breakdown "(3), (2), (1)" sums to 6. The correct answer is **6 imports change** for the `app/ide/` destination. The initial "7" appears to have included the two `src/` imports before the agent caught that they don't change, but the correction over-subtracted.

5. **CommandBar.js import count in checklist (Section 11).** The checklist says "CommandBar.js (1)" under github-viewer refs. But CommandBar.js has **1** github-viewer import (encoding.js) that changes. This happens to be correct in the checklist even though the total is wrong. However, the Section 4 claim of "7" initially implies the agent counted 2 for CommandBar.js (encoding + platform), then subtracted platform but didn't fix the total.

## Gaps

### What I covered that dependency-resolution missed

- **`index.html` redirect file.** Not a JS import concern, but a file that must move. The dependency-resolution agent's scope was appropriately narrow, but flagging this exclusion would help readers.
- **External references that need updating**: root `index.html` link, `examples/index.html` card, `package.json` `files` array, `CLAUDE.md` project structure. These are not import paths, so they're outside the dependency-resolution scope. No gap here -- just different scope.
- **Git history verification** (`git log --follow`). Not an import concern, but part of the extraction.

### What I covered that deployment missed

- **Git commands for the move.** The deployment agent covers the "what" but not the "how" of the filesystem operations. My analysis includes exact `git mv` commands and directory cleanup.
- **`examples/index.html` card removal rationale.** I recommended removing the IDE card entirely (Option A). Deployment recommends keeping it with a modified link (their Option A). This is a tension, covered below.

### What dependency-resolution covered that I missed

- **Promotion of `encoding.js` to `src/utils/`.** Good observation. The encoding utility is a pure function with zero dependencies, buried in the github-viewer's websocket directory. Promoting it would clean up the cross-boundary dependency. I did not flag this opportunity.
- **Detailed per-dependency architectural verdicts** (Sections 4.1-4.6). The reasoning for keeping Drawer HTML builders as cross-directory imports (avoiding drift) is sound and something I did not articulate.
- **Validation commands** (Section 7). Useful grep-based checks I did not include.

### What deployment covered that I missed

- **URL-driven auto-load regex analysis** (Section 3c). The `/ide/` regex in ide.html that parses `owner/repo` from the URL path. I did not examine this. The deployment agent correctly notes the regex is location-agnostic.
- **Service worker / browser caching gotchas** (Section 12). Minor but thorough.
- **CORS analysis** (Section 9). Confirms no issues with CDN importmap. I assumed this but did not state it.
- **npm scripts analysis** (Section 6). Confirms none reference `examples/ide/`. I noted `package.json` `files` array but not the scripts.
- **Redirect stub proposal** (Section 7). A `examples/ide/index.html` redirect for backward compatibility. I explicitly argued against this. Tension below.

## Tensions

### 1. Redirect stub at old location: yes (deployment) vs no (file-moves)

**Deployment** recommends leaving a redirect stub at `examples/ide/index.html`. **I** argued against it: no external consumers, the old URL was only used in development, redirect stubs create maintenance debt.

**Correct position: mine (no redirect stub).** This is a development-only URL. The root `index.html` and `examples/index.html` will be updated with the new paths. Anyone navigating `localhost:8000/examples/ide/` will get a 404, which correctly signals the resource moved. A redirect stub means one more file to eventually delete, one more thing to confuse `git status`, and zero audience benefit. If this were a public API or published URL, a redirect would be warranted. It is not.

### 2. examples/index.html IDE card: keep with updated link (deployment) vs remove (file-moves)

**Deployment** recommends Option A: change the link to `../app/ide/` and label it "(production app)." **I** recommend Option A: remove the card entirely because the IDE is a production app, not an example.

**Correct position: mine (remove the card), but deployment's reasoning has merit.** Keeping the card improves discoverability for someone browsing the examples gallery. However, a production app listed among examples sends the wrong signal. The root `index.html` already links to the IDE. Removing the card enforces the semantic separation that is the entire point of this extraction.

### 3. Import count

All three analyses arrive at slightly different totals (I said "4+1+2 = 7 edits across 3 files" but some of those don't change; dependency-resolution says 5; deployment says 5, 7, or 6 depending on which paragraph). **The correct count is 6 import path changes across 3 files**: IDEShell.js (3), ide.html (2), CommandBar.js (1). All three of us got the individual line items right; only the stated totals are muddled.

## Recommendations

1. **Fix the CommandBar.js new import path in the dependency-resolution table.** Row #6 for Option A should read `../../../examples/github-viewer/websocket/commands/encoding.js` (three `../`, not two).

2. **Agree on 6 as the canonical import-change count.** All three documents should state: 6 import paths change for `app/ide/`, 0 for `src/` references, total 6.

3. **Add `index.html` to the dependency-resolution file inventory.** Even though it has no JS imports, it is part of the IDE and must move.

4. **Do not leave a redirect stub.** Internal dev URL, zero external consumers.

5. **Remove the IDE card from `examples/index.html`.** Enforce the semantic boundary. The root `index.html` provides discoverability.

6. **Defer `encoding.js` promotion to `src/utils/`.** Good idea from dependency-resolution, but out of scope for this extraction. The import path rewrite works regardless, and promoting it is a separate refactor.

7. **Add the URL auto-load regex note to the file-moves checklist.** Deployment correctly identified this as a "no change needed" item, but it should be explicitly verified during the move.

8. **Update Caddy config as a separate step after the git changes land.** Deployment correctly notes the Caddyfile is not in the repo. This is a server-side task that should be done immediately after the commit is deployed, not as part of the file-move commit.

9. **Add deployment's validation commands alongside my `git log --follow` checks.** The grep-based import verification from dependency-resolution Section 7 is valuable.

10. **Confirm no npm publish impact.** Deployment correctly notes glyph3d-js is not published to npm, so the `files` array change is cosmetic. Still worth doing for correctness.

## Key Insight

All three analyses converge on the same core conclusion: this extraction is low-risk because there is no build system, no bundler path aliases, no TypeScript config, and no deployment config in the repo. The entire operation is "move 5 files, fix 6 relative imports, update 2-3 references in peripheral files, update one Caddy directive on the server." The disagreements are minor (redirect stubs, card removal, import counts that differ by 1) and none of them block execution. The most architecturally interesting observation comes from dependency-resolution: the `encoding.js` utility should eventually be promoted to `src/utils/`, which would eliminate the last cross-boundary import from `app/` into `examples/` internals (the remaining github-viewer imports are the correct architectural relationship -- the IDE wraps the viewer).
