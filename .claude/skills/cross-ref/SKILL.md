---
name: cross-ref
description: Multi-agent cross-referencing analysis. Launches N perspective agents, then runs two rounds of cross-review (forward and inverse order) where each agent reviews the others' work, writing structured conclusions to files.
argument-hint: "[topic] [agent-count or agent-labels]"
user-invocable: true
effort: high
---

# Multi-Agent Cross-Reference Analysis

Run a structured cross-referencing process across multiple perspective agents on a given topic.

## Input

- **Topic**: $ARGUMENTS — the subject, question, or body of work to analyze from multiple perspectives.
- If agent labels/roles are provided (e.g., `"websocket CLI" protocol transport usability`), use those as the agent identities. Each word or quoted phrase after the topic becomes one agent's perspective label.
- If a number is provided (e.g., `"websocket CLI" 3`), create that many agents with generic labels (A, B, C, ...).
- If neither count nor labels are given, default to 3 agents with generic labels.

**Example invocations:**
- `/cross-ref "GPU buffer pipeline" algorithm interfaces implementation` → 3 agents labeled "algorithm", "interfaces", "implementation"
- `/cross-ref "auth rewrite" 4` → 4 agents labeled A, B, C, D
- `/cross-ref "camera system"` → 3 agents labeled A, B, C

## Process

### Phase 0 — Identify Agents and Their Work

Before cross-referencing, you need existing agent outputs to cross-reference. There are two modes:

**Mode A — Fresh analysis**: If no prior agent outputs exist for this topic, first launch N agents in parallel, each analyzing the topic from their assigned perspective. Each agent's perspective is defined by their label:
- **Named labels** (e.g., "protocol", "usability"): The label IS the lens. The agent focuses on that aspect of the topic. For example, an agent labeled "protocol" analyzes the wire format, message structure, and handshake semantics; an agent labeled "usability" analyzes developer ergonomics, discoverability, and error messages.
- **Generic labels** (A, B, C): Each agent independently analyzes the full topic. The value comes from cognitive diversity — different agents naturally emphasize different aspects even with the same prompt.

Each agent MUST read the 3-5 source files most relevant to their perspective before writing. Factual grounding in actual code prevents errors that consume review cycles to correct. Cap Phase 0 output at ~300 lines — lead with decisions and code, not exhaustive rationale.

Each agent writes its output to `{output-dir}/phase0-{agent-label}.md`. Wait for all to complete before Phase 1.

**Mode B — Existing outputs**: If prior agent outputs already exist (from earlier in the conversation, from files on disk, or provided by the user), use those directly. Map outputs to agents by filename or order — if the mapping is ambiguous (e.g., 4 files but user said 3 agents), ask the user. If clear, proceed without asking.

### Phase 0.5 — Predictions (parallel, before reading others' work)

Before Round 1, each agent writes a brief prediction of what the OTHER agents concluded — without reading their outputs. This creates a calibration layer: the gap between what an agent *expected* others to find and what they *actually* found reveals blind spots and assumption divergence.

Each agent writes to `{output-dir}/predictions-{agent-label}.md`:

```markdown
# Predictions: {agent-label}

For each other agent, write 2-3 sentences predicting their main conclusions, key concerns, and likely design choices. Be specific — "I expect agent X concluded Y because Z."
```

These predictions are NOT shared with other agents. The orchestrator reads them after Round 1 to identify high-signal review targets: items where predictions diverged from reality are where assumptions were wrong, and wrong assumptions are where bugs hide.

### Phase 1 — Forward Cross-Reference (parallel)

Launch N agents simultaneously. Each agent reviews the other agents' work in **declaration order** — the order the agents were listed or created:

**Concrete example with 3 agents (protocol, transport, usability):**
- Agent "protocol" reviews transport's output, then usability's output → writes `round1-protocol-reviews-transport-usability.md`
- Agent "transport" reviews protocol's output, then usability's output → writes `round1-transport-reviews-protocol-usability.md`
- Agent "usability" reviews protocol's output, then transport's output → writes `round1-usability-reviews-protocol-transport.md`

**General rule:** Agent `i` reviews agents `[0, 1, ..., N-1]` excluding itself, in that index order.

Each agent writes a markdown file with these headings:

```markdown
# Round 1: {agent-label} reviews {reviewed-labels}

## Errors Found
Factual mistakes, wrong assumptions, or code that won't work. Cite file paths and line numbers. This is the highest-value section.

## Gaps
What this agent covered that others missed, and vice versa. Keep brief — bullet points, not paragraphs.

## Tensions
Contradictions between the reviewed works. Include code references. State which position is correct and why.

## Recommendations
Concrete changes: what to modify, add, or remove. Max 10 items. Each must be actionable.

## Key Insight
One paragraph. The single most important observation.
```

Cap Round 1 output at ~200 lines. Lead with errors, not agreement.

### Phase 2 — Inverse Cross-Reference (conditional, parallel)

**Before launching Round 2**, check Round 1 outputs for unresolved tensions. If all Round 1 reviews agree on all points (no Tensions or Errors remain open), skip directly to Phase 3. Round 2's value is resolving disagreements — if there are none, it's redundant.

If tensions exist, launch N agents simultaneously. Each agent now reviews the others in **reverse declaration order**, and has access to **all Round 1 outputs**:

**Same example (protocol, transport, usability):**
- Agent "protocol" reviews usability, then transport (reversed) + reads all Round 1 files → writes `round2-protocol-reviews-usability-transport.md`
- Agent "transport" reviews usability, then protocol (reversed) + reads all Round 1 files → writes `round2-transport-reviews-usability-protocol.md`
- Agent "usability" reviews transport, then protocol (reversed) + reads all Round 1 files → writes `round2-usability-reviews-transport-protocol.md`

The inverse ordering surfaces different cognitive patterns — reviewing in a different sequence highlights dependencies and assumptions invisible in the first pass. Reading Round 1 outputs from ALL agents (including their own) lets each agent see how the group's thinking evolved.

Each agent writes a markdown file with these headings:

```markdown
# Round 2: {agent-label} reviews {reviewed-labels} (inverse)

## Reaffirm or Retract
For each position you held in Phase 0 that was challenged in Round 1: explicitly state whether you still hold it or are changing your mind. If retracting, explain what changed your thinking. If reaffirming, explain why the challenges didn't convince you. A retraction is not a failure — an unjustified retraction under social pressure is. This section is the anti-conformity mechanism.

## Evolved Understanding
What changed after seeing Round 1 cross-references. What assumptions were confirmed or broken.

## Convergence
Where all agents are now in agreement. These are the high-confidence conclusions.

## Remaining Tensions
What's still unresolved after two rounds. These are the genuine trade-offs or open questions.

## Synthesis
A unified recommendation incorporating all perspectives. This is the agent's best attempt at a combined answer — not consensus, but informed integration.

## Dissent
Any position this agent holds that others don't, and why it matters. Silence here means full agreement.
```

### Phase 3 — Convergence Round (parallel, after Round 2 completes)

Launch N agents simultaneously. Each agent reads ALL Round 2 outputs and produces a final convergence analysis. The agents collectively decide which ONE of them should implement the result.

Each agent writes to `{output-dir}/round3-{agent-label}-convergence.md` with these headings:

```markdown
# Round 3: {agent-label} convergence

## Settled
All points now fully resolved. Numbered list with brief rationale.

## Implementation Plan
Concrete file-by-file plan: what to create, what to modify, what to delete. Code sketches for non-obvious parts.

## Implementer Vote
Which OTHER agent should implement (you may NOT vote for yourself). Consider: whose Phase 0 code is closest to the converged plan? Whose perspective best matches the implementation work?
```

After all Round 3 agents complete, tally the implementer votes. The winning agent is launched as **Phase 4 — Implementation** with the full converged plan and access to all prior outputs. If tied, the agent whose perspective most directly maps to the implementation work wins.

### Phase 4 — Implementation

Launch the voted implementer agent. It reads the Round 3 convergence outputs, then writes actual working code. It has full tool access (read, write, edit, bash) and should produce a runnable result, not a plan.

Output: the actual code changes, committed or staged. The implementer writes a brief summary to `{output-dir}/implementation-summary.md`.

### Phase 5 — Summary

After implementation completes, produce a brief summary for the user:
- Total agreement points (things all agents converged on)
- Key tensions resolved across rounds
- What was implemented
- What was deferred and why

## Output Directory

Write all files to `cross-ref/{topic-slug}/` relative to the project root. Create the directory if needed.

The `{topic-slug}` is a kebab-case version of the topic's first few words (max 40 chars). Examples:
- Topic `"GPU buffer pipeline"` → `cross-ref/gpu-buffer-pipeline/`
- Topic `"websocket CLI for viewer"` → `cross-ref/websocket-cli-for-viewer/`

If the directory already exists from a prior run, append a timestamp: `cross-ref/gpu-buffer-pipeline-2026-03-27/`.

Topic slugs serve as namespaces — different cross-ref runs on different topics naturally avoid collisions by slug. Re-runs on the same topic get the timestamp suffix.

## Agent Instructions Template

When launching each cross-reference agent, include in its prompt:
1. **Identity**: "You are agent '{label}'. Your perspective focuses on: {description of what this label means in context}."
2. **Own work**: The full text of this agent's Phase 0 output (inline or as a file path to read).
3. **Review targets**: The full text of each agent being reviewed, in the specified order. Explicitly state: "Read and analyze {first-agent}'s work FIRST, then {second-agent}'s work SECOND. The order matters."
4. **Round 1 context** (Phase 2 only): "Also read these Round 1 cross-reference outputs for full context: {list of file paths}."
5. **Output path**: The exact file path to write the analysis to.
6. **Concreteness mandate**: "Be specific — reference code, line numbers, function names, file paths, and concrete details. This is a technical review, not a summary. If you identify a problem, show where it is. If you recommend a change, show what the change looks like."

## Orchestrator Principles

The orchestrator (the agent running this skill) is not a scheduler — it is a mechanism designer. It adapts the process between phases based on what outputs reveal.

### Routing Authority

The orchestrator may skip, repeat, or reorder phases based on what the outputs reveal. State the reason when deviating from the default flow. Examples:
- Skip Round 2 if Round 1 shows clear convergence with no substantive tensions
- Re-run Phase 0 with refined prompts if outputs reveal the original framing was ambiguous
- Jump straight to implementation if Phase 0 outputs are already production-quality code

### Prompt Refinement Between Phases

Between phases, the orchestrator reviews outputs for conceptual divergence caused by ambiguous framing. If found, refine the prompts for the next phase — but frame refinements as **constraints** (pointing at source code, establishing scope) rather than **conclusions** (stating design decisions).

Example — **constraint** (good): "The relay at ws-relay.mjs lines 96-111 handles message wrapping. Ground your wire protocol model in that code."

Example — **conclusion** (avoid): "Controllers send raw strings, the relay wraps them."

Constraints narrow the search space without closing the solution space. Agents retain the authority to challenge any assumption — including the orchestrator's refinements — if their private context warrants it.

### Commitment Tracking

The orchestrator should notice when an agent's position shifts between phases. An agent that held position X in Phase 0, was challenged in Round 1, and quietly dropped X in Round 2 may have been conformity-pressured rather than genuinely convinced. Look for:
- Retractions without supporting evidence (just "I agree with the others now")
- Positions that disappear between rounds without being addressed
- Agents that flip to match the majority without explaining what changed

These aren't necessarily wrong — sometimes the majority is right. But the *quality of the mind-change* matters. "I re-read the source and my assumption was wrong" is healthy. "Both other agents disagree so I'll defer" is a conformity signal worth noting.

### Respecting Agent Private Information

Each agent accumulates context from source file reads, their perspective lens, and their reasoning chain that the orchestrator cannot fully see. An agent may hold back an insight until a later round where it becomes relevant. The process must preserve space for this:
- Don't disambiguate so aggressively that agents can't surface contradictory evidence
- When an agent dissents, treat it as signal, not noise
- If an agent says "I found something that contradicts the established framing," that's the highest-value output in the entire run

### Vote Outcomes

After Round 3, tally implementer votes:
- **Clear winner** (2+ votes for one agent) → that agent implements
- **Split vote** (no majority) → two options:
  - **Escalate**: surface the tie to the user with a focused question about where the implementation's center of gravity should be
  - **Partition**: each agent implements the files closest to their domain in parallel, followed by an integration pass (which can itself be a mini cross-ref with the partition outputs as inputs)

## Notes

- All agents in a given phase run in parallel for speed.
- Each agent should be launched with `run_in_background: true` for parallel execution.
- The value of cross-referencing comes from **redundant independent analysis** — multiple agents reading the same code and drawing different conclusions catches errors that single-agent approaches miss.
- Agent count sweet spot is 3. More than 5 produces diminishing returns and exponential file count.
- Choose agent types appropriate to the topic — use specialized subagent types when the work matches their domain, general-purpose otherwise.
