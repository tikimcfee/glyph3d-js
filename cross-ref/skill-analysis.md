# Cross-Ref Skill Analysis

Analysis of two cross-ref runs: **websocket-cli-viewer** (3 agents: protocol, interface, implementation) and **cli-annotations-agent-hooks** (3 agents: scene-api, agent-hooks, visualization). Focus on process effectiveness, not the technical content itself.

---

## 1. Phase 0 Quality

### 1.1 Factual Errors From Insufficient Context

The interface agent built its entire wire protocol model on wrong assumptions. Three specific errors:

1. **JSON envelope direction.** Phase 0 section 7.5 shows the CLI sending `{"from":"cli-1","cmd":"grid.new \"Hello\""}`. The relay expects raw strings from controllers and wraps them itself (`ws-relay.mjs` lines 96-111). This was not a minor detail -- protocol's Round 1 called it "the most consequential finding," and implementation's Round 1 called it the "single most critical alignment point." If the CLI had been built to interface's spec, every command would fail.

2. **Registration ack format.** Interface showed `{"ok":true}` as the controller registration response. The actual ack is a plain string `"OK: connected as ctrl-N"`. Interface confused the display ack (which IS JSON) with the controller ack.

3. **Registration string.** Interface proposed sending `CONTROLLER` as the first message. The relay only special-cases `DISPLAY`; anything else becomes both a registration trigger AND a command forwarded to the display. `CONTROLLER` would generate a spurious error.

**Could the Phase 0 prompt have prevented this?** Yes. The SKILL.md "Agent Instructions Template" (line 151-158) says to include identity, own work, review targets, round 1 context, output path, and a concreteness mandate. It does NOT instruct Phase 0 agents to read specific source files before writing. A Phase 0 prompt addition like "Before writing, identify and read the 3-5 source files most relevant to your perspective" would have forced the interface agent to read `ws-relay.mjs` and discover the actual wire format.

### 1.2 Perspective Distinctiveness

The three perspectives were genuinely distinct:

- **Protocol** produced a 650-line wire format reference with message flow diagrams, error classification tables, and exact byte sequences. This was the grounding document -- other agents cited it 15+ times across rounds.
- **Interface** produced a CLI UX specification: invocation modes, command syntax options, tab completion, output formatting, exit codes. Much of this (watch mode, aliasing, REPL meta-commands) was original material not covered by others.
- **Implementation** produced working code: `CliConnection.mjs`, `glyph-cli.mjs`, `grid.create` handler with exact import paths and constructor subtleties.

The overlap was primarily in command naming (all three independently proposed command tables) and the "Hello demo" walkthrough (all three wrote one). The command naming overlap was productive -- it surfaced the `grid.new` vs `grid.create` tension. The Hello demo overlap was redundant -- three versions of essentially the same walkthrough consumed ~400 lines total for ~50 lines of unique signal.

### 1.3 Signal-to-Noise Ratio

Measuring what Phase 0 content was actually referenced or debated in later rounds:

| Agent | Phase 0 lines | Lines cited/debated in R1+R2 | Ratio |
|-------|--------------|-------------------------------|-------|
| protocol | 650 | ~400 (wire format, error classification, batch command, context bag) | 62% |
| interface | 618 | ~250 (wire trace errors, command naming, registration, three modes, exit codes, stderr/stdout) | 40% |
| implementation | ~500 | ~350 (CliConnection code, ping trick, CodeGrid constructor, import paths, handler code) | 70% |

The implementation agent had the best ratio because working code is inherently specific and reviewable. The interface agent's lower ratio came from sections that were acknowledged once ("good idea, defer to v2") but never debated: watch mode (section 6.4), aliasing (section 6.5), compound shortcuts (section 6.1), namespace browsing (section 5.2). These were well-written but had no influence on the converged plan.

---

## 2. Round 1 vs Round 2 Value

### 2.1 Unique Round 1 Insights

Round 1 produced the process's highest-value discoveries:

1. **Interface's `\n` parser bug** (Round 1 Tensions section): "Looking at the actual `CommandRouter.parse()` in `CommandRouter.js` lines 76-85: `\\` sets `escaped = true`, then the next character is appended literally. So `\n` in the input produces `n` (the backslash is consumed, `n` is appended). This means the handler receives the literal character `n`, not the two-character sequence `\n`." Neither protocol nor implementation caught this in Phase 0 -- both proposed a `.replace(/\\n/g, '\n')` fix that would never match. Interface found it by actually tracing the parser line by line.

2. **Protocol's JSON-envelope error detection** (Round 1 Key Insight): Identified that building the CLI against interface's model would produce "double-wrapped messages that break command routing entirely."

3. **Implementation's argument-order analysis** (Round 1 Tensions section 5): Reframed the `grid.create` debate from "which API does it match" to "which order minimizes friction for the common case."

### 2.2 Unique Round 2 Insights

Round 2 produced significantly fewer novel insights. Measuring genuinely new findings:

**Protocol Round 2**: Conceded on `grid.create` argument order (text-first). Acknowledged the `\n` bug was worse than Phase 0 described. Maintained `batch` as Day 1 feature and dissented on `set` prefix. No new technical findings.

**Interface Round 2**: Acknowledged all three Phase 0 errors. Proposed "the `grid.create` argument-order debate is overweighted" -- a meta-observation about process efficiency that was itself a unique Round 2 contribution. No new technical findings.

**Implementation Round 2**: Shifted to agreeing with protocol on dropping `set` prefix. No new technical findings.

**Quantified**: Round 1 produced 3 high-value technical discoveries (parser bug, wire format error, argument-order reframing) and resolved 4 design tensions (command naming, registration protocol, wire format, context bag approach). Round 2 produced 0 new technical discoveries and resolved 1 additional tension (dropping `set` prefix via 2-to-1 consensus). Round 2's primary function was convergence confirmation, not insight generation.

### 2.3 Was the Inverse Ordering Effect Real?

The SKILL.md claims (line 165): "The value of this process comes from the ordering effect -- seeing B before C produces different insights than seeing C before B."

Evidence from the websocket-cli-viewer run:

- **Round 1**: Protocol reviewed interface first, then implementation. Protocol's Key Insight focused on interface's wire format error.
- **Round 2**: Protocol reviewed implementation first, then interface. Protocol's Evolved Understanding section focused on the `\n` bug (surfaced by interface's Round 1, not by the ordering change).

The Round 2 ordering did not produce observably different patterns. All three Round 2 documents read as "here is what I now agree with after reading Round 1 outputs" rather than "here is what I noticed by reading in a different order." The agents explicitly attributed their evolved positions to Round 1 content, not to re-reading Phase 0 outputs in different order.

**Assessment**: The inverse ordering effect is not measurably real in this sample. The Round 2 value came entirely from having access to Round 1 outputs, not from the review sequence.

### 2.4 Did Agents Evolve or Restate?

Interface genuinely evolved -- it acknowledged three factual errors and withdrew positions. Protocol partially evolved -- it conceded on argument order and refined its `\n` analysis. Implementation mostly restated -- its Round 2 positions were the same as Round 1 with minor adjustments.

The Dissent sections were the most valuable part of Round 2. Protocol's dissent on `set` prefix and `batch` as Day 1, and interface's dissent on short aliases and tab completion, were positions that survived two rounds of scrutiny. These represent genuine conviction after full deliberation, not initial positions that were never challenged.

---

## 3. Round 3 Vote Mechanism

### 3.1 Three-Way Tie (Structural Problem)

In the annotations/hooks run, the vote results were:

| Voter | Vote |
|-------|------|
| scene-api | scene-api |
| agent-hooks | agent-hooks |
| visualization | visualization |

Each agent voted for itself. This is a structural problem, not a coincidence. Each agent's Phase 0 code is most familiar to that agent, and each agent's Implementation Plan naturally describes how to start from its own Phase 0 as the base. The "whose Phase 0 code sketches were closest to the converged plan" criterion (SKILL.md line 119) incentivizes self-voting because each agent wrote its own plan to align with its own Phase 0.

### 3.2 Did Round 3 Converge?

The three Round 3 "Settled" sections are remarkably similar -- 13-16 items each, with substantial overlap in content and wording. This IS genuine convergence. The Settled items are nearly identical across all three documents, which means the agents agree on what was resolved.

However, the Implementation Plans diverge in structure:
- scene-api's plan lists 9 items with code sketches for the shared state helpers
- agent-hooks' plan lists 8 items organized by create/modify/delete
- visualization's plan lists 8 items with the most detailed `agentLayoutCommands.js` spec

Each plan foregrounds its own Phase 0 code as the starting point. This is the same self-referential bias that produces the vote tie.

### 3.3 Better Vote Mechanisms

**Option A: Agents cannot vote for themselves.** Simple rule change. Each agent must vote for one of the other agents. This forces genuine assessment of others' work.

Proposed SKILL.md change for the Implementer Vote section:

```markdown
## Implementer Vote
Which agent (EXCLUDING self) should implement, and why. You may not vote for yourself.
Consider: whose Phase 0 code is closest to the converged plan? Whose perspective
best matches the implementation work? Be specific about which files from that agent's
Phase 0 carry over with minimal changes.
```

**Option B: Vote on file ownership, not overall implementer.** Instead of one agent implementing everything, agents vote on which agent's code should be the starting point for each file. This maps better to reality -- scene-api's annotation commands might be closest to final while agent-hooks' window manager is closest.

**Option C: Skip the vote entirely.** The Round 3 Settled sections already contain the implementation plan. Any agent (or a fresh agent) can implement from these specs. The vote adds a round of deliberation for a question that the process structurally cannot answer.

**Recommendation**: Option A is the minimum fix. Option C is the pragmatic choice -- the convergence documents are the deliverable, not the vote.

---

## 4. Process Efficiency

### 4.1 Output Volume

For the websocket-cli-viewer run (through Round 2, no Round 3):

| Phase | Files | Approximate lines | Approximate tokens |
|-------|-------|-------------------|-------------------|
| Phase 0 | 3 | ~1,770 | ~15,000 |
| Round 1 | 3 | ~510 | ~7,500 |
| Round 2 | 3 | ~600 | ~8,500 |
| **Total** | **9** | **~2,880** | **~31,000** |

For the annotations/hooks run (Round 3 only, from files read):

| Phase | Files | Approximate lines | Approximate tokens |
|-------|-------|-------------------|-------------------|
| Round 3 | 3 | ~560 | ~7,500 |

### 4.2 Insight Density

Key decisions made across the websocket-cli-viewer run:

1. CLI sends raw strings (not JSON envelopes)
2. Use `ping` for registration (not `CONTROLLER`)
3. Command names: `grid.create`, not `grid.new`
4. No `set` prefix on commands
5. `grid.create <text> [name]` argument order
6. `\n` parser bug must be fixed in `CommandRouter.parse()`
7. Context bag needs `addGrid()`/`removeGrid()` helpers
8. Three operating modes (one-shot, REPL, pipe)
9. Stderr/stdout separation
10. Exit codes 0-3
11. Dot-prefixed REPL meta-commands
12. `batch` wire command using existing `executeBatch()`
13. `loadText()` for v1, `loadFileAsync()` for production

That is 13 decisions from ~31,000 tokens of output. Roughly 2,400 tokens per decision. Many of these decisions (items 8-11) were proposed by one agent and accepted without debate. Only items 1-6 involved genuine cross-agent tension and resolution.

### 4.3 Consistently Low-Value Sections

**Round 1 "Alignment" sections** were the lowest-value content. They enumerate what agents agree on, which is useful for tracking but produces no new information. In the websocket-cli-viewer Round 1, the three Alignment sections total ~60 lines that could be reduced to a one-line "Confirmed: [list of Phase 0 section numbers we agree on]" format.

**Round 2 "Convergence" sections** overlap heavily with Round 1 Recommendations. Protocol's Round 2 Convergence lists 10 items; 8 of them were already in Protocol's Round 1 Recommendations. The incremental information is 2 items.

**Hello demo walkthroughs** appeared in all three Phase 0 outputs and both Round 2 Synthesis sections. Five versions of essentially the same walkthrough is excessive.

### 4.4 Redundant Findings

These findings appeared independently in multiple agents but could have been detected once:

- "No relay changes needed" -- stated 6 times across 6 documents
- "CLI is a thin transport" -- stated in every document (9 times)
- "Use existing `{response, data}` format" -- stated 5 times
- Command naming tables -- 3 nearly identical tables in Phase 0

A shared "established facts" document, populated after Phase 0 and before Round 1, could eliminate this repetition.

### 4.5 Single-Agent Comparison

A single agent with the same concreteness mandate could have:
- Read `ws-relay.mjs`, `CommandRouter.js`, `gridCommands.js`, `WebSocketBridge.js`
- Produced a correct wire format spec
- Written the CLI code
- Identified the `\n` parser bug (by reading the parser code)

The cross-ref process's unique contribution was catching the interface agent's wire format error through independent verification. A single agent that happened to get the wire format wrong would have no correction mechanism. The cross-ref process caught it in Round 1 -- two agents independently flagged the same error. This is the process's core value: error detection through redundancy.

The tradeoff: ~31,000 tokens and 9 files vs ~8,000 tokens and 1-2 files for a single agent. The cross-ref is ~4x the cost for error-catching capability.

---

## 5. Skill Prompt Improvements

### 5.1 Add Source Reading to Phase 0

Current SKILL.md Agent Instructions Template (line 151-158) does not instruct Phase 0 agents to read source code before writing.

**Add after line 158:**

```markdown
7. **Source grounding**: "Before writing your analysis, identify and READ the 3-5 source files
   most relevant to your perspective. Cite file paths and line numbers for every factual claim
   about existing code behavior. Do not describe how code works from memory -- read it and quote it."
```

This would have prevented all three of interface's factual errors.

### 5.2 Tighter Round 1 Format

The current Round 1 format has 5 sections (Alignment, Gaps, Tensions, Recommendations, Key Insight). The Alignment section is low-value.

**Replace the Round 1 format with:**

```markdown
# Round 1: {agent-label} reviews {reviewed-labels}

## Errors Found
Factual errors in the reviewed work. Cite the specific passage and the source code that contradicts it.

## Tensions
Design disagreements between agents. State each agent's position and your verdict with rationale.

## New Findings
Observations that no Phase 0 output covers. These must be grounded in source code, not speculation.

## Key Insight
The single most important observation from this cross-reference -- one paragraph.
```

This drops Alignment (low value), merges Gaps into New Findings (same content, clearer name), and adds Errors Found as a first-class section (the highest-value output of Round 1).

### 5.3 Eliminate Round 2 or Make It Conditional

Round 2 produced near-zero unique insights in the websocket-cli-viewer run. Its value was convergence confirmation, which could be achieved more cheaply.

**Option A: Make Round 2 conditional.** After Round 1 completes, the orchestrator checks: are there unresolved tensions? If Round 1 reviews agree on all key points, skip Round 2 and go to Round 3. If there are genuine disagreements (e.g., command naming split), run Round 2 only on the disagreeing agents.

**Option B: Replace Round 2 with a short "Final Position" statement.** Each agent reads all Round 1 outputs and writes a 1-paragraph final position on each unresolved tension. No full review format. This captures the convergence signal in ~100 lines instead of ~600.

Proposed SKILL.md change:

```markdown
### Phase 2 -- Convergence Check (conditional)

After Round 1 completes, assess whether genuine tensions remain:
- If all Round 1 reviews agree on key decisions, SKIP to Phase 3.
- If 2+ unresolved tensions exist, run a short Round 2 where each agent writes ONLY:

```markdown
# Round 2: {agent-label} final positions

## Position on {tension-1}
[1-3 sentences: what you now believe and why, citing which Round 1 argument convinced you or why you still disagree]

## Position on {tension-2}
[same format]

## New finding (if any)
[Only if reading Round 1 outputs revealed something no one has mentioned]
```
```

### 5.4 Fix the Vote Mechanism

Replace the current Implementer Vote section (line 117-122):

```markdown
## Implementer Vote
Which agent (EXCLUDING yourself) should implement, and why. You may not vote for your own
perspective. Consider: whose Phase 0 code sketches are closest to the converged plan?
Whose perspective most directly maps to the implementation work? If you believe the
implementation requires work from multiple Phase 0 bases, say which files come from which agent.
```

### 5.5 Add Shared Facts Document

After Phase 0, before Round 1, the orchestrator should produce a short "Established Facts" document listing claims that all Phase 0 outputs agree on. This prevents agents from re-confirming the same points in every review.

**Add to SKILL.md after Phase 0:**

```markdown
### Phase 0.5 -- Established Facts (automatic)

After all Phase 0 outputs complete, the orchestrator extracts facts that appear in 2+ Phase 0
outputs and writes them to `{output-dir}/established-facts.md`. Each Round 1 agent receives
this file with the instruction: "These facts are already confirmed by multiple agents. Do not
re-state them in your Alignment section. Focus your review on disagreements, errors, and gaps."
```

### 5.6 Cap Phase 0 Length

Phase 0 outputs ranged from 500-650 lines. Much of the length came from Hello demo walkthroughs and exhaustive option analysis (interface's three command syntax options). A length guideline would force prioritization.

**Add to Agent Instructions Template:**

```markdown
8. **Length**: Keep Phase 0 output under 300 lines. Prioritize concrete code, wire traces, and
   specific claims over exhaustive option analysis. If you have three options, state your
   recommendation and a one-sentence dismissal of alternatives -- do not write full sections
   for options you reject.
```

### 5.7 Restructured Process Flow

Incorporating all changes, the revised flow would be:

```
Phase 0 (parallel)     -- 3 agents, each reads source first, max 300 lines
Phase 0.5 (automatic)  -- Extract established facts
Round 1 (parallel)     -- Tighter format: Errors, Tensions, New Findings, Key Insight
Convergence check      -- Are there unresolved tensions?
  If yes: Round 2      -- Short final-position statements on tensions only
  If no:  Skip to R3
Round 3 (parallel)     -- Settled items, Implementation Plan, Vote (no self-votes)
Phase 4                -- Implementation by voted agent
Phase 5                -- Summary
```

Expected improvement: ~40% reduction in total output tokens (shorter Phase 0, no Alignment sections, conditional Round 2) with no loss of the error-catching capability that is the process's core value.

---

## Summary

The cross-ref process's strongest outcome was catching interface's wire format error through independent verification -- two agents flagged the same critical mistake that would have broken the entire CLI. This error-catching capability justifies the process for high-stakes design work.

The process's weakest outcomes were Round 2 (near-zero unique insights), the self-voting tie in Round 3, and significant redundancy across documents (the phrase "CLI is a thin transport" appears 9 times). The five recommended SKILL.md changes -- source grounding in Phase 0, tighter Round 1 format, conditional Round 2, no-self-vote rule, and an established-facts extraction step -- would preserve the error-catching value while cutting output volume by roughly 40%.
