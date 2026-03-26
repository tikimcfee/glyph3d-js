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
- If agent labels/roles are provided (e.g., "algorithm interfaces implementation"), use those as the agent identities.
- If a number is provided (e.g., "3"), create that many agents with generic labels (A, B, C, ...).
- If neither, default to 3 agents.

## Process

### Phase 0 — Identify Agents and Their Work

Before cross-referencing, you need existing agent outputs to cross-reference. There are two modes:

**Mode A — Fresh analysis**: If no prior agent outputs exist for this topic, first launch N agents in parallel, each analyzing the topic from their assigned perspective. Wait for all to complete.

**Mode B — Existing outputs**: If prior agent outputs already exist (from earlier in the conversation, from files on disk, or provided by the user), use those directly. Ask the user to confirm which outputs map to which agents.

### Phase 1 — Forward Cross-Reference (parallel)

Launch N agents simultaneously. Each agent reviews the other agents' work **in natural order**:
- Agent A reviews B, then C (A:BC)
- Agent B reviews A, then C (B:AC)
- Agent C reviews A, then B (C:AB)

For N agents, agent `i` reviews all others in order `[0, 1, ..., N-1]` excluding itself.

Each agent writes a structured analysis covering:
1. **Alignment** — Where do the reviewed agents agree with this agent's perspective?
2. **Gaps** — What did this agent specify that others missed, and vice versa?
3. **Tensions** — Contradictions between the reviewed works, or between them and this agent's work.
4. **Recommendations** — What should change? What's correct as-is?
5. **Key insight** — The single most important observation from this cross-reference.

Output files: `{output-dir}/round1-{agent-label}-reviews-{order}.md`

### Phase 2 — Inverse Cross-Reference (parallel, after Round 1 completes)

Launch N agents simultaneously again. Each agent now reviews the others in **reverse order**, and has access to **all Round 1 outputs**:
- Agent A reviews C, then B — plus reads Round 1 outputs from all agents (A:CB)
- Agent B reviews C, then A — plus reads Round 1 outputs from all agents (B:CA)
- Agent C reviews B, then A — plus reads Round 1 outputs from all agents (C:BA)

The inverse ordering surfaces different cognitive patterns — reviewing in a different sequence often highlights dependencies and assumptions that were invisible in the first pass.

Each agent writes a structured analysis covering:
1. **Evolved understanding** — What changed after seeing Round 1 cross-references?
2. **Convergence** — Where are all agents now in agreement?
3. **Remaining tensions** — What's still unresolved?
4. **Synthesis** — A unified recommendation incorporating all perspectives.
5. **Dissent** — Any position this agent holds that others don't, and why it matters.

Output files: `{output-dir}/round2-{agent-label}-reviews-{order}.md`

### Phase 3 — Summary

After both rounds complete, produce a brief summary for the user:
- Total agreement points
- Key tensions resolved in Round 2
- Remaining open questions
- Recommended next actions

Do NOT auto-synthesize into a single "final answer" — present the perspectives and let the user decide.

## Output Directory

Write all files to `.claude/cross-ref/` relative to the project root. Create the directory if needed. Use descriptive filenames that sort naturally.

## Agent Instructions Template

When launching each cross-reference agent, include:
1. A summary of **their own** prior work/perspective (so they have identity)
2. The **full output** of the agents they're reviewing (read from files or pass inline)
3. Clear instructions on review order (which to read FIRST vs SECOND)
4. The output file path to write to
5. Instruction to be specific — reference code, line numbers, types, concrete details. Technical review, not summary.

## Notes

- All agents in a given phase run in parallel for speed.
- Round 2 MUST wait for Round 1 to complete (it depends on Round 1 outputs).
- Each agent should be launched with `run_in_background: true` for parallel execution.
- For implementation-focused agents, use the `Rendering Specialist` subagent type if the topic involves GPU/rendering work.
- The value of this process comes from the **ordering effect** — seeing B before C produces different insights than seeing C before B. The two rounds together cover both orderings.
