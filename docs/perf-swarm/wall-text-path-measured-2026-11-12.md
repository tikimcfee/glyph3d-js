# AFTER-TEXT — the wall after text-path and atlas-growth, on the M2

> **A dated record (2026-11-12), not current numbers.** It measured the wall when terminals were
> tmux + xterm (since replaced by g3d-termd + libghostty-vt), so the flood and parser figures describe
> a path that no longer exists. Kept for the method (two runs each, noise bands, an interleaved
> old-vs-new control for machine drift) and for what the text-path and atlas-growth merges measured
> at. The run scripts and raw data (`run-b.sh`, `run-c.sh`, `run-ab.sh`, `compare3.py`, `gap-watch.mjs`,
> `raw/`) were not kept; `tools/wall-text-perf.mjs`, `tools/wall-gpu-attribution.mjs`,
> `tools/atlas-cold-perf.mjs` and `tools/perf-ledger.mjs` are the tools that remain.

Third round on the same machine and set: **baseline** (`a169ed1`), **after-port** (`ea5c555`), **after-text** (`2f1bcef`, measured 2026-11-12, 11:30–12:15). Every number is two runs, shown as `run 1 · run 2`. All 770 metrics, with bands and verdicts against both earlier rounds, are in `raw/after-text/compare3.md`.

Because this machine drifts between sessions, I also ran the commit just before the two merges (`a64def3`) against `2f1bcef` back to back, interleaved, in this session. That control is `raw/after-text/compare-ab.md`, and I cite it wherever it changes the reading.

## Verdict

Both merges do what they say here, nothing the user sees got slower, and no wall check broke (one unrelated headless check can't run on this machine; see Checks).

- **A terminal update costs a tenth of what it did.** `applyScreen` went from 0.2–0.5 ms to 0.02–0.05 ms, and the upload per update from 303 KB to 1–10 KB (35 KB on a full-screen source dump).
- **Output is drawn one frame sooner.** A warm burst reaches the screen in 33 ms instead of 50 ms.
- **A new glyph no longer stalls the frame.** 935 Nerd icons cost 7 ms of `applyScreen` instead of 72 ms, with no long task; one new glyph uploads about 700 B instead of 5.1 MB.
- **A new glyph does not appear any sooner.** Time to visible is unchanged: about two frames for one glyph, 100 ms for 935 icons, 170 ms for 406 emoji.
- **A flood written straight into the terminals is unchanged**, at 28 fps for 4 terminals and 12.5 fps for 14. That path is xterm's parser, which is now 99% of the main thread there.
- **Two upload sizes went up**, both when a texture outgrows its capacity: the emoji burst re-sends the whole 35.8 MB emoji texture, and the Nerd burst sends 8.4 MB where it sent 4.9 MB.

Against the baseline, 203 metrics are beyond their noise band for the better and 23 for the worse (182 and 14 against after-port). The worse ones are all accounted for under "What got worse or needs a look"; none is a regression in what the user sees.

## The four questions

### 1. Flood frame gaps at 4 and 14 terminals

**Bytes written straight into the terminals: no change.** The gaps are set by the parser, and the text path's own share of each frame is now a tenth of what it was.

| metric | baseline | after-port | after-text | Δ vs baseline | Δ vs after-port | vs baseline | vs after-port |
|---|---|---|---|---|---|---|---|
| ×4 · fps during the flood | 27.4 · 27.6 | 27.7 · 27.7 | 27.6 · 27.9 | +0.26 (+1%) | +0.10 (+0%) | noise | noise |
| ×4 · frame gap p50 (ms) | 49.5 · 48 | 48.2 · 48.6 | 49 · 49.6 | +0.55 (+1%) | +0.90 (+2%) | noise | noise |
| ×4 · frame gap p95 (ms) | 50.5 · 52.1 | 52.1 · 50.3 | 51.1 · 50.6 | -0.45 (-1%) | -0.35 (-1%) | noise | noise |
| ×4 · frame gap max (ms) | 50.5 · 52.1 | 52.1 · 50.3 | 51.1 · 50.6 | -0.45 (-1%) | -0.35 (-1%) | noise | noise |
| ×4 · frame gaps over 33 ms | 3 · 3 | 4 · 3 | 3 · 3 | 0 (+0%) | -0.50 (-14%) | noise | noise |
| ×4 · text work / display frame p50 (ms) | 0.80 · 0.90 | 0.90 · 0.80 | 0.10 · 0.10 | -0.75 (-88%) | -0.75 (-88%) | **BETTER** | **BETTER** |
| ×4 · parse share of main thread (%) | 96.6 · 96.7 | 96.8 · 96.9 | 98.8 · 98.6 | +2.07 (+2%) | +1.80 (+2%) | noise | noise |
| ×14 · fps during the flood | 12.3 · 12.6 | 12.2 · 12.6 | 12.5 · 12.8 | +0.27 (+2%) | +0.27 (+2%) | noise | noise |
| ×14 · frame gap p50 (ms) | 99.2 · 99.9 | 100 · 100 | 98.9 · 99.4 | -0.40 (-0%) | -0.85 (-1%) | noise | noise |
| ×14 · frame gap p95 (ms) | 118 · 117.4 | 116.9 · 118.3 | 117 · 117.3 | -0.55 (-0%) | -0.45 (-0%) | noise | noise |
| ×14 · frame gap max (ms) | 118 · 117.4 | 116.9 · 118.3 | 117 · 117.3 | -0.55 (-0%) | -0.45 (-0%) | noise | noise |
| ×14 · frame gaps over 33 ms | 7 · 7 | 7 · 7 | 7 · 6 | -0.50 (-7%) | -0.50 (-7%) | noise | noise |
| ×14 · text work / display frame p50 (ms) | 2 · 2 | 1.90 · 2 | 0.30 · 0.30 | -1.70 (-85%) | -1.65 (-85%) | **BETTER** | **BETTER** |
| ×14 · parse share of main thread (%) | 97.2 · 97.1 | 97.2 · 97.3 | 99.2 · 99.2 | +1.99 (+2%) | +1.94 (+2%) | noise | noise |

**Through tmux, which is what a person runs: the frame does much less work, and the gaps moved the right way but inside the noise band.** Source dumps already held 60 fps and still do. The 14-terminal `seq` flood is the worst case. Its busy time per frame fell beyond the band (p95 27–30 ms to 16–20 ms). Its gaps over 33 ms fell from 7–13 to 3–5 and its p95 gap from 31–33 ms to 21 ms, but I gave tmux floods a ±50% band because tmux's byte stream is not repeatable, and those sit inside it. The gaps that remain are parse bursts.

| metric | baseline | after-port | after-text | Δ vs baseline | Δ vs after-port | vs baseline | vs after-port |
|---|---|---|---|---|---|---|---|
| seq ×4 · fps during the flood | 49.4 · 59.3 | 46.7 · 49.8 | 47.1 · 60 | -0.76 (-1%) | +5.32 (+11%) | noise | noise |
| seq ×4 · frame gap p50 (ms) | 16.8 · 16.7 | 17 · 16.7 | 16.8 · 16.6 | -0.05 (-0%) | -0.15 (-1%) | noise | noise |
| seq ×4 · frame gap p95 (ms) | 49.9 · 18.6 | 35.1 · 34.5 | 35.3 · 18.4 | -7.40 (-22%) | -7.95 (-23%) | noise | noise |
| seq ×4 · frame gap max (ms) | 66.7 · 34 | 51.6 · 49.9 | 66.1 · 20.7 | -6.95 (-14%) | -7.35 (-14%) | noise | noise |
| seq ×4 · frame gaps over 33 ms | 5 · 1 | 8 · 8 | 6 · 0 | 0 (+0%) | -5 (-62%) | noise | noise |
| seq ×4 · main thread busy / display frame p95 (ms) | 42.2 · 19.3 | 33.9 · 33.3 | 39.4 · 15.5 | -3.30 (-11%) | -6.15 (-18%) | noise | noise |
| seq ×14 · fps during the flood | 54.0 · 55.9 | 49.9 · 44.0 | 56.9 · 58.2 | +2.58 (+5%) | +10.6 (+23%) | noise | **BETTER** |
| seq ×14 · frame gap p50 (ms) | 16.8 · 16.7 | 16.8 · 17.1 | 16.8 · 16.7 | 0 (+0%) | -0.20 (-1%) | noise | noise |
| seq ×14 · frame gap p95 (ms) | 33.4 · 31.3 | 46.6 · 50 | 20.8 · 21.3 | -11.3 (-35%) | -27.2 (-56%) | noise | **BETTER** |
| seq ×14 · frame gap max (ms) | 66.9 · 67.1 | 53.3 · 116 | 98.3 · 66.8 | +15.5 (+23%) | -2.10 (-2%) | noise | noise |
| seq ×14 · frame gaps over 33 ms | 13 · 7 | 21 · 32 | 5 · 3 | -6 (-60%) | -22.5 (-85%) | noise | **BETTER** |
| seq ×14 · main thread busy / display frame p50 (ms) | 8.50 · 7.60 | 8.30 · 10.6 | 3.20 · 2.40 | -5.25 (-65%) | -6.65 (-70%) | **BETTER** | **BETTER** |
| seq ×14 · main thread busy / display frame p95 (ms) | 29.9 · 27.4 | 39.9 · 47.4 | 19.9 · 15.8 | -10.8 (-38%) | -25.8 (-59%) | **BETTER** | **BETTER** |
| seq ×14 · text work / display frame p95 (ms) | 13.8 · 15.7 | 12.4 · 14.4 | 2.10 · 3.20 | -12.1 (-82%) | -10.8 (-80%) | **BETTER** | **BETTER** |
| source ×4 · fps during the flood | 60.0 · 60.0 | 60.1 · 60.1 | 60 · 60.0 | +0.01 (+0%) | -0.12 (-0%) | noise | noise |
| source ×4 · frame gap p95 (ms) | 18.6 · 18.5 | 18.7 · 18.5 | 18.7 · 18.5 | +0.05 (+0%) | 0 (+0%) | noise | noise |
| source ×4 · frame gap max (ms) | 18.7 · 18.5 | 18.7 · 18.6 | 18.7 · 18.6 | +0.05 (+0%) | 0 (+0%) | noise | noise |
| source ×14 · fps during the flood | 60 · 57.2 | 60.0 · 57.8 | 60 · 60 | +1.38 (+2%) | +1.12 (+2%) | noise | noise |
| source ×14 · frame gap p95 (ms) | 18.2 · 18.7 | 18.5 · 18.5 | 18.5 · 18.5 | +0.05 (+0%) | 0 (+0%) | noise | noise |
| source ×14 · frame gap max (ms) | 18.9 · 64.9 | 19.3 · 67.2 | 18.8 · 19 | -23.0 (-55%) | -24.4 (-56%) | noise | noise |
| source ×14 · frame gaps over 33 ms | 0 · 2 | 0 · 1 | 0 · 0 | -1 (-100%) | -0.50 (-100%) | noise | noise |

The control agrees: the direct floods are unchanged, and every tmux row is down, two of them beyond the band at 4 terminals:

| metric | before the merges (`a64def3`) | after (`2f1bcef`) | change | verdict |
|---|---|---|---|---|
| direct seq ×4 · frame gap p95 (ms) | 52 · 52 | 51.7 · 52 | -0.15 (-0%) | noise |
| direct seq ×14 · frame gap p95 (ms) | 118.3 · 118 | 116.9 · 117 | -1.20 (-1%) | noise |
| tmux seq ×4 · frame gap p95 (ms) | 18.7 · 50.1 | 18.3 · 18.6 | -15.9 (-46%) | noise |
| tmux seq ×4 · frame gap max (ms) | 73.6 · 66.8 | 18.6 · 26.8 | -47.5 (-68%) | **BETTER** |
| tmux seq ×4 · frame gaps over 33 ms | 2 · 8 | 0 · 0 | -5 (-100%) | noise |
| tmux seq ×4 · main thread busy / display frame p95 (ms) | 16.5 · 47.4 | 4.10 · 2.80 | -28.5 (-89%) | **BETTER** |
| tmux seq ×14 · frame gap p95 (ms) | 21.4 · 33 | 21.6 · 21.4 | -5.70 (-21%) | noise |
| tmux seq ×14 · frame gap max (ms) | 50.9 · 67.6 | 34.1 · 49.1 | -17.6 (-30%) | noise |
| tmux seq ×14 · frame gaps over 33 ms | 4 · 12 | 1 · 5 | -5 (-62%) | noise |
| tmux seq ×14 · main thread busy / display frame p95 (ms) | 18.6 · 30.4 | 13 · 20.9 | -7.55 (-31%) | noise |

### 2. Is xterm parsing now nearly all of the main thread?

**Yes for direct floods (99%). Through tmux at 14 terminals it is 59–79%, up from 22–37%.**

| metric | baseline | after-port | after-text | Δ vs baseline | Δ vs after-port | vs baseline | vs after-port |
|---|---|---|---|---|---|---|---|
| direct seq ×14 · parse total (ms) | 702.4 · 690.4 | 698.4 · 690.4 | 695.5 · 688.5 | -4.40 (-1%) | -2.40 (-0%) | noise | noise |
| direct seq ×14 · applyScreen total (ms) | 13.7 · 13.8 | 14.3 · 13 | 1.20 · 1.40 | -12.4 (-91%) | -12.4 (-90%) | **BETTER** | **BETTER** |
| direct seq ×14 · renderer.render CPU total (ms) | 3.80 · 3.20 | 3.10 · 3.20 | 3 · 2.50 | -0.75 (-21%) | -0.40 (-13%) | noise | noise |
| direct seq ×14 · main thread total (ms) | 722.5 · 710.8 | 718.6 · 709.8 | 701.4 · 694.2 | -18.9 (-3%) | -16.4 (-2%) | noise | noise |
| direct seq ×14 · parse share of main thread (%) | 97.2 · 97.1 | 97.2 · 97.3 | 99.2 · 99.2 | +1.99 (+2%) | +1.94 (+2%) | noise | noise |
| tmux seq ×14 · parse total (ms) | 950.7 · 853.3 | 1,214 · 1,706 | 1,301 · 696.6 | +96.8 (+11%) | -460.8 (-32%) | noise | noise |
| tmux seq ×14 · readScreen total (ms) | 109.3 · 147 | 128.5 · 80 | 72.2 · 93.3 | -45.4 (-35%) | -21.5 (-21%) | noise | noise |
| tmux seq ×14 · applyScreen total (ms) | 1,195 · 1,313 | 1,067 · 1,048 | 97.2 · 138.6 | -1,136 (-91%) | -939.7 (-89%) | **BETTER** | **BETTER** |
| tmux seq ×14 · renderer.render CPU total (ms) | 230.1 · 238.7 | 197.6 · 229.6 | 127.9 · 100.8 | -120.0 (-51%) | -99.2 (-46%) | **BETTER** | **BETTER** |
| tmux seq ×14 · main thread total (ms) | 2,546 · 2,607 | 2,655 · 3,135 | 1,655 · 1,124 | -1,187 (-46%) | -1,506 (-52%) | **BETTER** | **BETTER** |
| tmux seq ×14 · parse share of main thread (%) | 37.3 · 32.7 | 45.7 · 54.4 | 78.6 · 62.0 | +35.3 (+101%) | +20.3 (+40%) | changed (up) | changed (up) |
| tmux source ×14 · parse total (ms) | 101.9 · 118.3 | 119.4 · 118.2 | 119.5 · 122.3 | +10.8 (+10%) | +2.10 (+2%) | noise | noise |
| tmux source ×14 · readScreen total (ms) | 25.2 · 25.7 | 25.9 · 33.3 | 17.5 · 18.6 | -7.40 (-29%) | -11.5 (-39%) | noise | noise |
| tmux source ×14 · applyScreen total (ms) | 270.4 · 330 | 291.4 · 308.6 | 27.5 · 29.2 | -271.8 (-91%) | -271.6 (-91%) | **BETTER** | **BETTER** |
| tmux source ×14 · renderer.render CPU total (ms) | 60.7 · 52.5 | 50.8 · 52.2 | 26.3 · 24.5 | -31.2 (-55%) | -26.1 (-51%) | **BETTER** | **BETTER** |
| tmux source ×14 · main thread total (ms) | 470.9 · 540.1 | 501.1 · 523.9 | 204 · 203.8 | -301.6 (-60%) | -308.6 (-60%) | **BETTER** | **BETTER** |
| tmux source ×14 · parse share of main thread (%) | 21.6 · 21.9 | 23.8 · 22.6 | 58.6 · 60.0 | +37.5 (+172%) | +36.1 (+156%) | changed (up) | changed (up) |
| CPU profile, tmux ×14 · JS busy (ms) | 2,845 · 2,663 | 2,340 · 2,844 | 1,854 · 1,429 | -1,113 (-40%) | -950.4 (-37%) | **BETTER** | **BETTER** |
| CPU profile, tmux ×14 · xterm (ms) | 1,096 · 1,033 | 820 · 1,356 | 1,449 · 1,034 | +176.8 (+17%) | +153.6 (+14%) | noise | noise |
| CPU profile, tmux ×14 · core (ms) | 1,383 · 1,287 | 1,235 · 1,208 | 176.2 · 158.7 | -1,168 (-87%) | -1,054 (-86%) | **BETTER** | **BETTER** |
| CPU profile, tmux ×14 · xterm share of JS busy (%) | 38.5 · 38.8 | 35.0 · 47.7 | 78.1 · 72.4 | +36.6 (+95%) | +33.9 (+82%) | changed (up) | changed (up) |

What is left beside the parser in the 14-terminal tmux `seq` flood (run 1 · run 2, of 1,655 · 1,124 ms on the main thread):

| stage | ms | note |
|---|---|---|
| `renderer.render` | 128 · 101 | 0.4–0.5 ms a frame over 254–259 frames |
| `applyScreen` | 97 · 139 | 80 · 83 ms of it is `_diffLive` (`TerminalGrid.js:393`); 0.03–0.05 ms each over 2,852–2,908 calls |
| `readScreen` | 72 · 93 | 0.03 ms each |
| other frame callbacks | 40 · 71 | |
| `writeBytes` | 17 · 23 | |

The CPU profile puts xterm at 72–78% of JS time in that flood, but about 75–80 ms of that is our `readScreen`: the sampler books it to xterm's `_checkProposedApi` under `get buffer` (called from `applyPendingScreen`, `TerminalGrid.js:331`), and the figure matches the `readScreen` stage timer. I did not confirm that reading in the code.

### 3. Cold-glyph time to visible

**Unchanged.** The glyph lands in the same number of frames as before; what changed is what it costs on the way.

| burst | baseline ¹ | after-port ¹ | after-text ² | control, before the merges ² | control, after ² |
|---|---|---|---|---|---|
| 406 new emoji | 192.4 · 199.9 | 214.7 · 183.1 | 168 · 167.9 | 170.9 · 174.4 | 168.9 · 166.7 |
| 935 Nerd icons | 99.9 · 101 | 116.7 · 131.2 | 85 · 100 | 87.7 · 101 | 100.6 · 100 |
| 404 syllabics | 50.2 · 49.1 | 67.8 · 49.2 | 49.2 · 49.4 | 47.2 · 39.2 | 50.8 · 48.7 |
| one new glyph (median of 8) | 50 · 49.4 | 50.7 · 50.5 | 33.2 · 33.4 | 34.4 · 34.4 | 32.3 · 33.3 |

¹ `wall-text-perf` cold pass on the old code: bytes in, to the GPU finishing the first frame that shows the glyphs. It includes a wait for the GPU of about one frame (17 ms), so subtract that to compare with ².
² `atlas-cold-perf` "visible": bytes in, to the first frame rendered after every glyph of the burst has landed. The control columns are the same tool on both commits in one session, so they are the like-for-like pair.

What the same bursts cost on the way, from the control:

| metric | before the merges (`a64def3`) | after (`2f1bcef`) | change | verdict |
|---|---|---|---|---|
| 406 emoji · applyScreen on the main thread (ms) | 29.5 · 30.3 | 18.2 · 18.4 | -11.6 (-39%) | **BETTER** |
| 406 emoji · worst frame gap (ms) | 155.9 · 157.2 | 45.9 · 46.8 | -110.2 (-70%) | **BETTER** |
| 406 emoji · long tasks | 0 · 1 | 0 · 0 | -0.50 (-100%) | noise |
| 406 emoji · texture upload bytes | 118,784 · 118,784 | 44,257,120 · 44,257,120 | +44,138,336 (+37158%) | **WORSE** |
| 935 Nerd icons · applyScreen on the main thread (ms) | 71.5 · 72.5 | 6.20 · 7.60 | -65.1 (-90%) | **BETTER** |
| 935 Nerd icons · worst frame gap (ms) | 72.9 · 73.7 | 24.5 · 25 | -48.6 (-66%) | **BETTER** |
| 935 Nerd icons · long tasks | 1 · 1 | 0 · 0 | -1 (-100%) | **BETTER** |
| 935 Nerd icons · texture upload bytes | 4,853,760 · 4,853,760 | 8,403,568 · 8,403,568 | +3,549,808 (+73%) | **WORSE** |
| 404 syllabics · applyScreen on the main thread (ms) | 19.8 · 21.2 | 3.10 · 4.60 | -16.6 (-81%) | **BETTER** |
| 404 syllabics · worst frame gap (ms) | 21.8 · 196.8 | 35.4 · 21.6 | -80.8 (-74%) | noise |
| 404 syllabics · texture upload bytes | 5,115,904 · 5,115,904 | 254,848 · 254,848 | -4,861,056 (-95%) | **BETTER** |
| one glyph · landed (ms) | 19.4 · 19.4 | 21.9 · 23.2 | +3.20 (+17%) | noise |
| one glyph · applyScreen on the main thread (ms) | 2.20 · 2.15 | 0.30 · 0.35 | -1.85 (-85%) | **BETTER** |
| one glyph · worst frame gap (ms) | 18.8 · 19.0 | 18.6 · 18.7 | -0.20 (-1%) | noise |
| one glyph · texture upload bytes | 5,115,904 · 5,115,904 | 720 · 720 | -5,115,184 (-100%) | **BETTER** |

- **One glyph** lands 3 ms later (19 ms to 22–23 ms) and is still drawn in the same frame as before.
- **The emoji burst** still has one 46 ms frame gap and 18 ms of `applyScreen` across its frames (about 10 ms of that is shape lookups; the atlas growing, `EmojiAtlas.js:171`, is in there too).
- **The upload sizes that went up** are covered under "What got worse".

### 4. The first-sight regression and the cycling uploads from AFTER-PORT

**First sight: gone from the main thread.** The +6% was outline extraction and glyph bookkeeping inside `applyScreen`. Outline extraction no longer runs there, and every first-sight `applyScreen` is now well under its baseline value, not only its after-port value.

| metric | baseline | after-port | after-text | Δ vs baseline | Δ vs after-port | vs baseline | vs after-port |
|---|---|---|---|---|---|---|---|
| warm burst · applyScreen (ms) | 0.50 · 0.55 | 0.90 · 0.85 | 0.10 · 0.10 | -0.43 (-81%) | -0.78 (-89%) | **BETTER** | **BETTER** |
| one new glyph · applyScreen (ms) | 1.10 · 1.00 | 2.10 · 1.95 | 0.20 · 0.30 | -0.80 (-76%) | -1.77 (-88%) | **BETTER** | **BETTER** |
| one new glyph · renderer.render CPU (ms) | 0.80 · 0.75 | 1.60 · 1.25 | 0.50 · 0.50 | -0.28 (-35%) | -0.93 (-65%) | noise | **BETTER** |
| 935 Nerd icons · applyScreen (ms) | 59 · 59.3 | 70.4 · 69.1 | 5.70 · 6.90 | -52.8 (-89%) | -63.5 (-91%) | **BETTER** | **BETTER** |
| 935 Nerd icons · outline extraction on the main thread (ms) | 53.6 · 54.1 | 63.1 · 60.9 | 0 · 0 | -53.9 (-100%) | -62.0 (-100%) | **BETTER** | **BETTER** |
| 935 Nerd icons · longest long task (ms) | 59 · 59 | 71 · 70 | 0 · 0 | -59 (-100%) | -70.5 (-100%) | **BETTER** | **BETTER** |
| 404 syllabics · applyScreen (ms) | 13.3 · 13.8 | 19.5 · 13.8 | 5.50 · 3.10 | -9.25 (-68%) | -12.3 (-74%) | **BETTER** | **BETTER** |
| 404 syllabics · outline extraction on the main thread (ms) | 9.90 · 10.1 | 13.6 · 10.3 | 0 · 0 | -10.0 (-100%) | -11.9 (-100%) | **BETTER** | **BETTER** |
| 406 emoji · applyScreen (ms) | 20.2 · 19.9 | 29 · 13 | 11.1 · 11.2 | -8.90 (-44%) | -9.85 (-47%) | **BETTER** | noise |
| 406 emoji · applyScreen → render start (ms) | 123.7 · 125.5 | 126.7 · 117 | 0 · 0.10 | -124.5 (-100%) | -121.8 (-100%) | **BETTER** | **BETTER** |
| 406 emoji · longest long task (ms) | 122 · 123 | 0 · 116 | 0 · 0 | -122.5 (-100%) | -58 (-100%) | **BETTER** | noise |

I can't say whether the encode itself got faster or slower in the worker. The tools time it only for single glyphs (0.0–0.4 ms each in the log), and the Nerd burst lands when it did before (87–93 ms before, 87–95 ms after, in the control).

**Cycling uploads: did not move.** They are where the render port left them, double the baseline's texture bytes, with GPU time and frame gaps unchanged.

| metric | baseline | after-port | after-text | Δ vs baseline | Δ vs after-port | vs baseline | vs after-port |
|---|---|---|---|---|---|---|---|
| texture upload bytes / frame | 6,144 · 6,144 | 13,005 · 12,800 | 12,340 · 12,902 | +6,477 (+105%) | -280.9 (-2%) | **WORSE** | noise |
| buffer upload bytes / frame | 0 · 0 | 1,868 · 1,852 | 1,829 · 1,856 | +1,842 | -17.6 (-1%) | **WORSE** | noise |
| GL calls / frame (all kinds) | 166 · 166 | 168.2 · 167.9 | 167.2 · 167.9 | +1.55 (+1%) | -0.50 (-0%) | noise | noise |
| GPU p50 (ms) | 10.1 · 9.96 | 10.5 · 9.87 | 9.19 · 9.38 | -0.73 (-7%) | -0.90 (-9%) | noise | noise |
| frame gap p95 (ms) | 19 · 19 | 19 · 18.9 | 18.9 · 18.9 | -0.10 (-1%) | -0.05 (-0%) | noise | noise |
| main thread / frame p50 (ms) | 1.10 · 1 | 1 · 1 | 1.10 · 1.10 | +0.05 (+5%) | +0.10 (+10%) | noise | noise |

## What got better

Beyond the per-update numbers above:

| metric | baseline | after-port | after-text | Δ vs baseline | Δ vs after-port | vs baseline | vs after-port |
|---|---|---|---|---|---|---|---|
| warm burst · total latency (ms) | 50.2 · 50.2 | 50.4 · 50.3 | 33.3 · 33.5 | -16.8 (-33%) | -17.0 (-34%) | **BETTER** | **BETTER** |
| warm burst · applyScreen → render start (ms) | 15.9 · 15.8 | 15.4 · 15.6 | 0.00 · 0.10 | -15.8 (-100%) | -15.4 (-100%) | **BETTER** | **BETTER** |
| warm burst · buffer upload bytes | 268,064 · 268,064 | 266,240 · 266,240 | 0.00 · 0.00 | -268,064 (-100%) | -266,240 (-100%) | **BETTER** | **BETTER** |
| warm burst · texture upload bytes | 43,008 · 43,008 | 36,864 · 36,864 | 0.00 · 0.00 | -43,008 (-100%) | -36,864 (-100%) | **BETTER** | **BETTER** |
| 12.4 MB flood ×1 · digest time (ms) | 416.1 · 384 | 406.9 · 383.7 | 414.8 · 431.7 | +23.2 (+6%) | +28.0 (+7%) | noise | noise |
| 12.4 MB flood ×1 · fps during the flood | 60.1 · 60.2 | 59.8 · 60 | 60.2 · 59.9 | -0.06 (-0%) | +0.19 (+0%) | noise | noise |
| 12.4 MB flood ×1 · parse ms / MB | 21.8 · 20.7 | 21.1 · 21.2 | 21.6 · 21.9 | +0.50 (+2%) | +0.59 (+3%) | noise | noise |
| 12.4 MB flood ×1 · applyScreen ms each | 0.20 · 0.24 | 0.21 · 0.24 | 0.06 · 0.03 | -0.17 (-80%) | -0.18 (-80%) | **BETTER** | **BETTER** |
| 12.4 MB flood ×1 · upload bytes per applyScreen | 316,971 · 317,883 | 303,104 · 303,104 | 4,270 · 4,350 | -313,116 (-99%) | -298,794 (-99%) | **BETTER** | **BETTER** |
| direct seq ×14 · digest time (ms) | 727 · 713.5 | 722.4 · 713.3 | 703.8 · 696.1 | -20.3 (-3%) | -17.9 (-2%) | noise | noise |
| direct seq ×14 · applyScreen ms each | 0.20 · 0.20 | 0.20 · 0.19 | 0.02 · 0.02 | -0.18 (-90%) | -0.18 (-90%) | **BETTER** | **BETTER** |
| direct seq ×14 · upload bytes per applyScreen | 304,738 · 304,887 | 303,104 · 303,104 | 3,755 · 3,852 | -301,009 (-99%) | -299,300 (-99%) | **BETTER** | **BETTER** |
| direct seq ×14 · upload bytes total (MB) | 21.3 · 21.3 | 21.2 · 20.9 | 0.26 · 0.27 | -21.1 (-99%) | -20.8 (-99%) | **BETTER** | **BETTER** |
| direct source ×14 · digest time (ms) | 371.2 · 372.5 | 375 · 373.3 | 364.7 · 363.1 | -7.95 (-2%) | -10.2 (-3%) | noise | noise |
| direct source ×14 · applyScreen ms each | 0.23 · 0.21 | 0.23 · 0.22 | 0.06 · 0.07 | -0.15 (-70%) | -0.16 (-71%) | **BETTER** | **BETTER** |
| direct source ×14 · upload bytes per applyScreen | 305,085 · 305,085 | 303,104 · 303,104 | 35,426 · 35,321 | -269,712 (-88%) | -267,731 (-88%) | **BETTER** | **BETTER** |
| tmux seq ×14 · digest time (ms) | 4,304 · 4,625 | 4,411 · 4,521 | 4,439 · 4,422 | -34.1 (-1%) | -35.7 (-1%) | noise | noise |
| tmux seq ×14 · applyScreen ms each | 0.46 · 0.49 | 0.45 · 0.52 | 0.03 · 0.05 | -0.43 (-92%) | -0.45 (-92%) | **BETTER** | **BETTER** |
| tmux seq ×14 · slot write ms each (sync, now spans) | 0.34 · 0.34 | 0.31 · 0.36 | 0 · 0.01 | -0.34 (-99%) | -0.33 (-99%) | **BETTER** | **BETTER** |
| tmux seq ×14 · upload bytes per applyScreen | 304,189 · 304,229 | 303,194 · 303,244 | 1,458 · 1,166 | -302,898 (-100%) | -301,907 (-100%) | **BETTER** | **BETTER** |
| tmux seq ×14 · upload bytes total (MB) | 783.3 · 812.0 | 715.8 · 608.0 | 4.16 · 3.39 | -793.9 (-100%) | -658.1 (-99%) | **BETTER** | **BETTER** |
| tmux seq ×14 · GL upload CPU total (ms) | 82.5 · 76.1 | 74.0 · 106.4 | 22.6 · 13.4 | -61.3 (-77%) | -72.2 (-80%) | **BETTER** | **BETTER** |
| tmux source ×14 · digest time (ms) | 1,335 · 1,431 | 1,555 · 1,392 | 1,520 · 1,423 | +88.4 (+6%) | -1.75 (-0%) | noise | noise |
| tmux source ×14 · applyScreen ms each | 0.28 · 0.35 | 0.29 · 0.32 | 0.03 · 0.03 | -0.29 (-90%) | -0.28 (-90%) | **BETTER** | **BETTER** |
| tmux source ×14 · upload bytes per applyScreen | 304,291 · 304,226 | 303,238 · 303,215 | 8,792 · 9,371 | -295,177 (-97%) | -294,145 (-97%) | **BETTER** | **BETTER** |
| tmux source ×14 · upload bytes total (MB) | 297.9 · 289.3 | 299.9 · 289.0 | 8.65 · 9.15 | -284.7 (-97%) | -285.5 (-97%) | **BETTER** | **BETTER** |
| one new glyph · texture upload bytes in that frame | 5,122,048 · 5,122,048 | 5,115,904 · 5,115,904 | 0.00 · 0.00 | -5,122,048 (-100%) | -5,115,904 (-100%) | **BETTER** | **BETTER** |
| one new glyph · fields hot-swapped | 29.0 · 29.0 | 29.0 · 29.0 | 0.00 · 0.00 | -29.0 (-100%) | -29.0 (-100%) | changed (down) | changed (down) |

**GPU time per pass reads 1–3 ms lower** (timer-query units, which are relative only). It is beyond the band on 13 `wall-gpu-attribution` rows and at idle overview, and inside it on the `frame-profile` rows. The control confirms it at idle overview (6.8 ms before, 4.9 ms after) and reads the same way on laps (10.0–10.4 ms before, 7.9–8.5 ms after, at the edge of the band). Draw calls and triangles are identical, and I did not look for the cause.

## What got worse or needs a look

1. **Emoji growth re-sends the whole emoji texture.** When the emoji grid grows from 24 to 36 rows, the first frame uploads all of it: 35.8 MB (3456 × 2592 RGBA), costing 10–13 ms of GL time in that frame. The 406 cells then add 8.4 MB as they land, 44.3 MB in all. Before, the atlas was a canvas whose upload neither tool could count, and it cost a 122–126 ms long task, so this is better than it was, but it is not "only its own texels".
2. **The Nerd burst uploads 8.4 MB, up from 4.9 MB.** 935 icons overrun the curve array's spare rows, so the array doubles and its texture is rebuilt whole (`slugData.js:204`, as its header says it will). On this wall the first large batch after boot triggers it.
3. **At-rest stalls appeared this session, and they are the machine.** The 30-second no-probe watch shows gaps of 30–80 ms in three of four runs, where the baseline had none. The commit before the merges stalls the same way in the control (up to 145 ms at rest, 273 ms in a lap), with no long tasks on either. Same for the lap frame-gap maxima.
4. **The first flood on a fresh page parses slower in the probed pass**: about 30 ms/MB against 24 ms/MB on the pre-merge commit, in both control runs. I don't think it is real: the baseline read 30 too, the 4- and 14-terminal floods and the 12.4 MB flood read 22 ms/MB on every commit, and the unprobed CPU profile of the same flood shows no difference. I did not find what differs.
5. **Vsync-off capacity sits between the two earlier rounds** (overview 623 · 625, then 529 · 532, now 591 · 574 frames in 5 s). The after-port control showed this number follows the machine; I did not repeat that control.
6. **Profile-only flags, not regressions.** `TerminalWall.tick` inclusive time is up because the text work now runs inside the frame's tick. Garbage collection in the 14-terminal tmux flood read 86–98 ms against 37–69 ms at baseline, but the pre-merge commit read 62–84 ms in the control: it follows tmux's stream.
7. **Carried over from the port:** the cycling uploads in question 4.

The control rows behind items 3 and 4, and the GPU reading:

| metric | before the merges (`a64def3`) | after (`2f1bcef`) | change | verdict |
|---|---|---|---|---|
| at rest 30 s, framed · frame gap max (ms) | 144.6 · 63.1 | 98.3 · 20.1 | -44.6 (-43%) | noise |
| at rest 30 s, framed · gaps over 30 ms | 1 · 4 | 4 · 0 | -0.50 (-20%) | noise |
| at rest 30 s, overview · frame gap max (ms) | 42.2 · 32.2 | 40.2 · 49 | +7.40 (+20%) | noise |
| at rest 30 s, overview · gaps over 30 ms | 1 · 1 | 1 · 5 | +2 (+200%) | noise |
| laps · LAP all layers — frame gap max | 39.8 · 28 | 23.8 · 58.6 | +7.30 (+22%) | noise |
| laps · LAP glyphs hidden — frame gap max | 273.5 · 88.7 | 21.5 · 20.2 | -160.2 (-88%) | **BETTER** |
| laps · LAP depth-history off — frame gap max | 206.2 · 66.7 | 37.4 · 37.9 | -98.8 (-72%) | **BETTER** |
| laps · LAP all layers — GPU p50 | 10 · 10.1 | 7.90 · 8.50 | -1.85 (-18%) | noise |
| laps · LAP all layers again — GPU p50 | 10.3 · 9.80 | 8.10 · 8.30 | -1.85 (-18%) | noise |
| idle overview · GPU p50 (ms) | 6.84 · 6.79 | 4.95 · 4.85 | -1.91 (-28%) | **BETTER** |
| idle overview · GPU p95 (ms) | 12.4 · 11.7 | 6.73 · 6.71 | -5.31 (-44%) | **BETTER** |
| first flood, direct seq ×1 · parse ms / MB | 23.6 · 23.8 | 30.1 · 29.7 | +6.13 (+26%) | **WORSE** |
| first flood, direct seq ×1 · digest time (ms) | 67.4 · 67 | 71.6 · 70.6 | +3.90 (+6%) | noise |
| direct seq ×4 · parse ms / MB | 22.1 · 21.6 | 22.6 · 22.1 | +0.50 (+2%) | noise |
| direct seq ×14 · parse ms / MB | 21.5 · 21.3 | 22.2 · 21.5 | +0.44 (+2%) | noise |
| CPU profile (no probes), direct flood ×1 · JS busy (ms) | 65.6 · 78.5 | 72.8 · 76.1 | +2.34 (+3%) | noise |

## Render baseline, three rounds

Frame gap p95, main thread per frame, draw calls and GL calls are where the port left them. Three things read differently from after-port: the GPU reading (lower), the frame-gap maxima (higher; the machine this session, item 3 above) and vsync-off capacity (item 5).

| metric | baseline | after-port | after-text | Δ vs baseline | Δ vs after-port | vs baseline | vs after-port |
|---|---|---|---|---|---|---|---|
| overview · GPU p50 (ms) | 10.2 · 10.9 | 10.1 · 9.29 | 9.13 · 9.15 | -1.41 (-13%) | -0.54 (-6%) | noise | noise |
| overview · GPU p95 (ms) | 13 · 13.2 | 12.7 · 12.6 | 13.1 · 13.3 | +0.12 (+1%) | +0.55 (+4%) | noise | noise |
| overview · frame gap p95 (ms) | 18.7 · 18.6 | 18.8 · 18.9 | 18.9 · 18.7 | +0.15 (+1%) | -0.05 (-0%) | noise | noise |
| overview · main thread / frame p50 (ms) | 1.10 · 0.90 | 0.90 · 0.90 | 0.90 · 0.90 | -0.10 (-10%) | 0 (+0%) | noise | noise |
| overview · draw calls / frame | 31 · 31 | 31 · 31 | 31 · 31 | 0 (+0%) | 0 (+0%) | noise | noise |
| overview · GL calls / frame (all kinds) | 201 · 201 | 166 · 166 | 166 · 166 | -35 (-17%) | 0 (+0%) | **BETTER** | noise |
| overview · texture upload bytes / frame | 6,144 · 6,144 | 0 · 0 | 0 · 0 | -6,144 (-100%) | 0 | **BETTER** | noise |
| framed · GPU p50 (ms) | 8.39 · 8.47 | 8.33 · 8.63 | 7.35 · 7.43 | -1.04 (-12%) | -1.09 (-13%) | noise | noise |
| framed · GPU p95 (ms) | 13.4 · 13.2 | 13.7 · 13.2 | 12.3 · 12.3 | -1.00 (-7%) | -1.11 (-8%) | noise | noise |
| framed · frame gap p95 (ms) | 19.1 · 18.7 | 18.7 · 18.6 | 18.8 · 18.6 | -0.20 (-1%) | +0.05 (+0%) | noise | noise |
| framed · main thread / frame p50 (ms) | 1 · 0.80 | 0.80 · 0.80 | 0.90 · 0.80 | -0.05 (-6%) | +0.05 (+6%) | noise | noise |
| framed · draw calls / frame | 23 · 23 | 23 · 23 | 23 · 23 | 0 (+0%) | 0 (+0%) | noise | noise |
| framed · GL calls / frame (all kinds) | 149 · 149 | 114 · 114 | 114 · 114 | -35 (-23%) | 0 (+0%) | **BETTER** | noise |
| cycling · GPU p50 (ms) | 10.1 · 9.96 | 10.5 · 9.87 | 9.19 · 9.38 | -0.73 (-7%) | -0.90 (-9%) | noise | noise |
| cycling · frame gap p95 (ms) | 19 · 19 | 19 · 18.9 | 18.9 · 18.9 | -0.10 (-1%) | -0.05 (-0%) | noise | noise |
| cycling · main thread / frame p50 (ms) | 1.10 · 1 | 1 · 1 | 1.10 · 1.10 | +0.05 (+5%) | +0.10 (+10%) | noise | noise |
| cycling · draw calls / frame | 25.4 · 25.4 | 25.4 · 25.4 | 25.4 · 25.4 | 0 (+0%) | 0 (+0%) | noise | noise |
| idle overview · GPU p50 (ms) | 6.78 · 6.58 | 6.29 · 6.62 | 4.38 · 4.88 | -2.05 (-31%) | -1.83 (-28%) | **BETTER** | noise |
| idle overview · GPU p95 (ms) | 11.5 · 12.6 | 9.42 · 9.28 | 6.70 · 6.72 | -5.35 (-44%) | -2.64 (-28%) | **BETTER** | noise |
| idle overview · main thread busy / frame p50 (ms) | 1.10 · 1.20 | 0.90 · 0.90 | 1 · 1.20 | -0.05 (-4%) | +0.20 (+22%) | noise | noise |
| idle overview · buffer upload bytes / frame | 4,280 · 4,280 | 0.00 · 0.00 | 0.00 · 0.00 | -4,280 (-100%) | 0 | **BETTER** | noise |
| idle framed · GPU p50 (ms) | 5.09 · 5.02 | 4.45 · 5.65 | 4.69 · 4.71 | -0.35 (-7%) | -0.35 (-7%) | noise | noise |
| idle framed · main thread busy / frame p50 (ms) | 0.90 · 1 | 0.80 · 0.80 | 0.80 · 0.90 | -0.10 (-11%) | +0.05 (+6%) | noise | noise |
| sweep · OVERVIEW all layers — GPU p50 | 8.58 · 10.3 | 10.1 · 8.90 | 8.83 · 8.68 | -0.71 (-8%) | -0.75 (-8%) | noise | noise |
| sweep · FRAMED all layers — GPU p50 | 9.02 · 8.80 | 9.22 · 8.44 | 6.85 · 7.80 | -1.59 (-18%) | -1.51 (-17%) | noise | noise |
| sweep · FRAMED all layers — GPU p95 | 13.4 · 13.2 | 13.0 · 13.2 | 10.8 · 10.4 | -2.71 (-20%) | -2.53 (-19%) | **BETTER** | **BETTER** |
| sweep · SWEEP zoom ×2 of fit — GPU p50 | 12.2 · 12.2 | 12.3 · 12.2 | 9.46 · 9.31 | -2.83 (-23%) | -2.87 (-23%) | **BETTER** | **BETTER** |
| laps · LAP all layers — GPU p50 | 10.5 · 10.1 | 9.90 · 9.90 | 8.20 · 8 | -2.20 (-21%) | -1.80 (-18%) | **BETTER** | **BETTER** |
| laps · LAP all layers — frame gap p95 | 17.9 · 18.8 | 18 · 18.7 | 18.7 · 18.7 | +0.35 (+2%) | +0.35 (+2%) | noise | noise |
| laps · LAP all layers — frame gap max | 25.3 · 19.4 | 38.8 · 21.5 | 55.1 · 50.5 | +30.4 (+136%) | +22.6 (+75%) | **WORSE** | **WORSE** |
| vsync off, overview · frames in 5 s | 623 · 625 | 529 · 532 | 591 · 574 | -41.5 (-7%) | +52.0 (+10%) | **WORSE** | **BETTER** |
| vsync off, framed · frames in 5 s | 720 · 719 | 604 · 599 | 647 · 650 | -71.0 (-10%) | +47.0 (+8%) | **WORSE** | **BETTER** |
| at rest 30 s, framed · frame gap p95 (ms) | 17.6 · 18.3 | 18.5 · 18.5 | 18.5 · 18.6 | +0.60 (+3%) | +0.05 (+0%) | noise | noise |
| at rest 30 s, framed · frame gap max (ms) | 18 · 18.7 | 31.7 · 19.3 | 36.6 · 81.8 | +40.9 (+223%) | +33.7 (+132%) | **WORSE** | **WORSE** |
| at rest 30 s, framed · gaps over 30 ms | 0 · 0 | 2 · 0 | 1 · 3 | +2 | +1 (+100%) | **WORSE** | noise |
| at rest 30 s, framed · long tasks | 0 · 0 | 0 · 0 | 0 · 0 | 0 | 0 | noise | noise |
| at rest 30 s, overview · frame gap p95 (ms) | 18.5 · 18.5 | 18.5 · 18.5 | 18.6 · 18.5 | +0.05 (+0%) | +0.05 (+0%) | noise | noise |
| at rest 30 s, overview · frame gap max (ms) | 20.2 · 18.7 | 18.7 · 20.1 | 58.6 · 19.7 | +19.7 (+101%) | +19.8 (+102%) | noise | noise |
| at rest 30 s, overview · gaps over 30 ms | 0 · 0 | 0 · 0 | 5 · 0 | +2.50 | +2.50 | noise | noise |
| at rest 30 s, overview · long tasks | 0 · 0 | 0 · 0 | 0 · 0 | 0 | 0 | noise | noise |

## Checks

- **`bun install`, `go build`:** clean.
- **`wall-e2e`:** all passed, twice (41 checks; it was 26 at after-port).
- **`bun tools/check.mjs --tier inner`:** 99 of 100 pass. `agent-events` is red because it needs `GOMUXAI_DIR` pointing at a gomuxai checkout with its corpus, which this machine doesn't have set.
- **All measuring tools exited 0 with no page errors**, on both commits.
- **`wall-text-perf` can no longer wrap five functions** (`_refreshEmojiTextures`, `appendGlyphs`, `appendBitmapSlots`, `_buildTextures`, `addGlyphs`): that work left the main thread. It says so and reports 0 in those columns of the cold pass.
- **The cold pass's "atlas gained" still reports the full count** for a frame that draws the glyphs blank, because it reads the atlas after waiting for the GPU.
- **Perf ledger:** `frame-profile --ledger` wrote two rows per scenario (`wall-overview`, `wall-framed`, `wall-cycle`, and the two `-uncapped`) to `perf/apple-m2-3f69d9.jsonl` in the repo, which is gitignored. It needs three rows before it compares.

## Conditions

- MacBook Air 15" M2, 16 GB, fanless, on AC at 100%. Viewport 3024 × 1964, headed Chromium on ANGLE Metal, 14 terminals of 80 × 24, as before.
- Load averages 1.8–2.4 before the runs and 2–9 during them. `TGOnDeviceInferenceProviderService` was at 21% CPU at 11:32. No thermal warning recorded.
- The tools now start their own relay on :8099 and spawn their own 14 terminals, so `wall-gpu-attribution`, `wall-text-perf` and `atlas-cold-perf` ran that way. `frame-profile` and the at-rest watch ran against my relay on :8098 with 14 terminals, as in the earlier rounds.
- One browser at a time. The tools' relays and tmux servers stop with each run; mine was stopped after each batch that needed it.
