# Round 1: dependency-resolution reviews file-moves, deployment

## Errors Found

### file-moves: Checklist count mismatch (line 186)
The checklist says "Update 4 import paths in IDEShell.js (3 github-viewer imports gain `../`)" -- the number 4 contradicts the description "3 github-viewer imports." The table at lines 47-53 correctly shows only 3 imports change in IDEShell.js (Drawer.js, LogCapturePanel.js, DiffPanel.js; platform.js stays the same). The checklist item should read "Update 3 import paths in IDEShell.js."

### deployment: Import count confusion (lines 107-109)
Line 107 states "Total imports to update: 7" then line 109 recounts to "5 imports across 3 files." Both numbers are wrong. The correct count from the deployment analysis's own table (lines 94-103) is **6**: 3 in IDEShell.js + 1 in CommandBar.js + 2 in ide.html. The self-correction attempted on line 109 overcorrected.

### file-moves: Omitted CommandBar.js from import count total
The checklist (lines 186-188) lists 4 + 1 + 2 = 7 path changes, but given the IDEShell.js count should be 3, the actual total is 3 + 1 + 2 = **6** path changes. This matches my Phase 0 analysis when the import groups are expanded to individual paths.

### dependency-resolution (my own Phase 0): Missed index.html
My Phase 0 inventory listed 4 files. The actual count is 5 -- I missed `examples/ide/index.html` (the meta-refresh redirect). Both file-moves and deployment correctly identified 5 files. The omission does not affect the import analysis since index.html has no JS imports, but it would have caused an incomplete `git mv` if someone followed only my file list.

## Gaps

### Covered by me, missed by others
1. **Promotion of `encoding.js` to `src/utils/`.** My Phase 0 (Section 4.2) identified that `encodeBase64`/`decodeBase64` in `examples/github-viewer/websocket/commands/encoding.js` is a general-purpose utility with zero dependencies, and recommended promoting it to `src/utils/encoding.js`. Neither file-moves nor deployment mentions this opportunity. This is not blocking, but it eliminates a cross-example dependency that looks architecturally wrong regardless of the IDE extraction.

2. **Validation commands.** My Phase 0 (Section 7) provided concrete shell commands to verify all import paths resolve after the move. File-moves has a verify step (lines 176-178) but only for git blame, not import resolution. Deployment has no verification commands.

3. **Architectural reasoning for keeping cross-directory imports.** My Phase 0 (Section 4) analyzed each dependency individually and explained *why* the IDE should import from github-viewer rather than copying. Neither other analysis addresses whether any dependencies should be relocated or inlined.

### Covered by others, missed by me
1. **Redirect stub at old location.** Deployment (Section 7, lines 156-175) recommends leaving a redirect stub at `examples/ide/index.html`. File-moves (line 84-89) explicitly argues against this. I did not address backward compatibility at all.

2. **Caddy server configuration.** Deployment (Section 3b) details the production Caddy config update needed on the the host server. My analysis focused entirely on in-repo changes and did not mention the production deployment path.

3. **`examples/index.html` IDE card.** Both file-moves (line 99-106) and deployment (lines 179-187) address what to do with the IDE card in the examples gallery. I did not mention this.

4. **URL-driven auto-load regex.** Deployment (Section 3c, lines 59-71) verified that the `/ide/` path-matching regex in ide.html works regardless of directory depth. This is a deployment concern I did not examine.

5. **npm `"ide"` convenience script.** Deployment (lines 146-148) suggests adding an npm script to launch the IDE directly. Neither file-moves nor I mentioned this.

## Tensions

### Redirect stub: file-moves vs deployment
File-moves (lines 84-89) says "No redirect stub" with three reasons: production URL never depended on the filesystem path, the old dev URL should 404, and redirect stubs create maintenance debt. Deployment (lines 156-175) recommends a redirect stub at `examples/ide/index.html` and calls it "zero maintenance cost."

**file-moves is correct.** The IDE has zero external consumers bookmarking `localhost:8000/examples/ide/`. The only users are Ivan and possibly collaborators, all of whom will know it moved because they performed the move. A redirect stub is a file that exists only to be eventually deleted -- the definition of maintenance debt, however small. The 404 is the correct signal for a moved resource in a development-only context.

### Examples gallery card: file-moves vs deployment
File-moves (lines 100-106) recommends removing the IDE card from `examples/index.html` entirely ("it's not an example; it's a production app"). Deployment (lines 181-187) recommends keeping the card with an updated link to `../app/ide/`.

**file-moves is correct.** The entire point of this extraction is to distinguish the IDE from examples. Keeping it in the examples gallery undermines that distinction. The root `index.html` already links to the IDE (line 106 of root index.html), so discoverability is preserved.

### Import count: all three analyses
My Phase 0 says "5 paths change" for `app/ide/`, file-moves' checklist implies 7 (4+1+2, though the 4 should be 3), and deployment says first 7, then 5. The verified correct count is **6 individual import path edits** for the `app/ide/` destination. The confusion arises from whether to count the 3 Drawer/panel imports in IDEShell.js as individual edits or as a group. They are 3 separate import statements that each need their path changed.

## Recommendations

1. **Fix the import count to 6.** All three analyses should agree: 3 in IDEShell.js, 1 in CommandBar.js, 2 in ide.html = 6 path rewrites for `app/ide/`.

2. **Use `git mv` for all 5 files** (not 4). Include `index.html`.

3. **Do not leave a redirect stub.** Follow file-moves' reasoning.

4. **Remove the IDE card from `examples/index.html`.** The root `index.html` already provides the link.

5. **Update the root `index.html`** href from `examples/ide/` to `app/ide/`.

6. **Add `"app"` to the `package.json` `files` array** if there is any chance of npm publishing. Otherwise skip it.

7. **Update `CLAUDE.md`** project structure to add `app/ide/` and remove `examples/ide/`.

8. **Update the Caddy config on the host** to point `/ide` to `app/ide/` instead of `examples/ide/`.

9. **Consider promoting `encoding.js` to `src/utils/`** as a follow-up. Not blocking for extraction, but eliminates a cross-example import that both the IDE and github-viewer would benefit from resolving.

10. **Run import-resolution verification** after the move using the commands from my Phase 0 Section 7, not just git blame checks.

## Key Insight

All three analyses converge on `app/ide/` as the destination and agree that the move is low-risk due to the absence of any build tooling, bundler config, or path aliases. The only substantive disagreements are about peripheral decisions (redirect stubs, examples gallery card) that have low impact either way. The core technical work is straightforward: move 5 files, rewrite 6 import paths, update 2-3 references in files outside the IDE. The most valuable contribution from the dependency-resolution perspective is the per-dependency analysis explaining *why* each cross-directory import is architecturally correct -- the IDE is a shell that wraps the viewer, and its imports should reflect that consumption relationship rather than owning copies of the viewer's UI definitions. The one dependency worth promoting (`encoding.js`) is a pure utility that ended up in the wrong place and should be lifted to `src/utils/` regardless of the IDE extraction.
