# Mechanism Design Research for Cross-Ref Multi-Agent Orchestration

Research conducted 2026-03-27. Covers academic papers, frameworks, and practical implementations relevant to our structured multi-agent cross-referencing process.

---

## 1. Multi-Agent Debate and Deliberation Frameworks

### What exists

The Multi-Agent Debate (MAD) paradigm has exploded in 2024-2025 research. The canonical pattern mirrors ours: N agents independently generate responses, then review each other's work over multiple rounds, with a final aggregation step.

**Key frameworks and their review patterns:**

- **Standard MAD** (Du et al., 2023; Liang et al., 2023): Agents generate initial answers in parallel, then iteratively review others' answers and refine their own. Communication is typically all-to-all (every agent sees every other agent's output each round). This is expensive --- 3-5x the token cost of single-agent approaches --- for 1.5-5.3% accuracy gains.

- **MetaGPT** (Hong et al., ICLR 2024): Uses an assembly-line SOP model where specialized roles (product manager, architect, engineer, QA) pass structured artifacts downstream. The key insight is **structured communication interfaces** --- agents don't just pass prose, they pass formatted artifacts (PRDs, API specs, code) that constrain what downstream agents can misinterpret. Their publish-subscribe mechanism lets agents selectively consume outputs rather than reading everything.

- **FREE-MAD** (Cui et al., 2024): Eliminates the consensus requirement entirely. Instead of forcing agents to agree, it tracks each agent's *reasoning trajectory* across rounds and scores candidates based on trajectory quality. This directly addresses our convergence concern --- it says "don't force convergence, instead evaluate the quality of each agent's evolving reasoning."

- **S2-MAD** (NAACL 2025): Introduces sparsification --- similarity calculation between responses, redundancy filtering (keep only info that differs from the agent's own view), and conditional participation (agents can opt out of a round if they have nothing new to add). Reduces token costs by 94.5% with <2% accuracy loss. Their conditional participation module is directly relevant to our Round 2 skip logic.

- **Sparse Communication Topologies**: Instead of all-to-all review, agents are arranged in neighbor-connected graphs where each agent only sees a subset of others' outputs. This reduces context length by 41%+ while preserving accuracy. The topology itself becomes a design parameter.

### How it maps to our process

Our cross-ref skill is already more structured than standard MAD. Our phases (independent analysis -> forward review -> inverse review -> convergence -> implementation) are a superset of the typical MAD pattern. But the research surfaces several gaps:

1. **We use all-to-all communication but the research says sparse topologies work just as well.** With 3 agents this doesn't matter much, but it's worth noting that our forward/inverse ordering already creates a kind of temporal sparsity --- each agent processes reviews in a specific sequence rather than as a monolithic blob.

2. **FREE-MAD's trajectory scoring is more principled than our vote.** Instead of asking agents "who should implement?", we could score each agent's reasoning trajectory across rounds --- whose thinking evolved most productively? Whose initial analysis held up best under scrutiny?

3. **MetaGPT's structured artifacts vs our prose.** Our agents write markdown with headings (Errors Found, Gaps, Tensions, etc.) which is semi-structured. MetaGPT goes further with formal interfaces. We could enforce stricter output schemas --- e.g., requiring each error to be a structured object with file path, line range, severity, and proposed fix.

### Specific techniques to adopt

- **Conditional participation from S2-MAD**: Before Round 2, compute similarity between Round 1 outputs. If an agent's Round 1 review is >90% aligned with the others, that agent can skip Round 2 and only the agents with genuine disagreements continue. This is more nuanced than our current binary "skip Round 2 if all agree."

- **Trajectory scoring from FREE-MAD**: Track how each agent's positions evolve across rounds. An agent that consistently holds a correct minority position (later validated) should score higher than one that flip-flops to match the majority. This could replace or supplement the implementer vote.

- **Structured output schemas**: Move from markdown headings to JSON-in-markdown or structured templates that force agents to be specific. "Error: { file: 'src/foo.js', line: 42, description: '...', severity: 'blocking' }" is harder to hand-wave than a paragraph.

### References
- [Multi-LLM-Agents Debate: Performance, Efficiency, and Scaling Challenges (ICLR 2025)](https://d2jud02ci9yv69.cloudfront.net/2025-04-28-mad-159/blog/mad/)
- [S2-MAD: Breaking the Token Barrier (NAACL 2025)](https://arxiv.org/html/2502.04790v1)
- [FREE-MAD: Consensus-Free Multi-Agent Debate](https://arxiv.org/abs/2509.11035)
- [MetaGPT: Meta Programming for Multi-Agent Collaborative Framework (ICLR 2024)](https://arxiv.org/abs/2308.00352)
- [Improving Factuality and Reasoning through Multiagent Debate](https://arxiv.org/abs/2305.14325)

---

## 2. Mechanism Design for AI Agents

### What exists

Classical mechanism design asks: given self-interested agents with private information, how do you design rules (a "mechanism") that produce desirable outcomes? The revelation principle says that any mechanism with a good equilibrium can be replaced by one where truthful reporting is optimal.

**Recent work applying this to LLMs:**

- **Game-Theoretic Lens on LLM-based Multi-Agent Systems** (2025): Frames multi-agent LLM systems through cooperative game theory, examining how coalition formation, Shapley values, and mechanism design apply when the "players" are language models. The key tension: LLMs are not truly self-interested (they don't have utility functions in the classical sense), but they do exhibit behavior analogous to strategic play --- sycophancy, conformity bias, self-promotion.

- **MAC-SPGG** (2025): Applies Public Goods Game theory to multi-agent LLM collaboration. Agents contribute "effort" (quality of analysis) to a shared pool, and rewards are distributed based on collective outcome. The mechanism incentivizes contribution because free-riding (producing low-quality analysis) reduces collective payout. This maps directly to our concern about agents coasting in later rounds.

- **Auction-based mechanisms**: Some work frames LLM agent selection as a Vickrey auction --- agents "bid" by providing capability assessments, and the mechanism ensures truthful bidding is optimal. The second-price structure means agents don't benefit from overstating their capabilities.

- **LLM Strategic Deception** (2025): Recent work shows reasoning models can engage in goal-driven, intentional misinformation where their explicit reasoning contradicts their outputs. This is relevant because our agents *could* strategically withhold information or emphasize their own strengths in the vote phase, even if they're not "self-interested" in the classical sense.

### How it maps to our process

Our orchestrator IS a mechanism designer. The skill document says this explicitly. But we're designing mechanisms for agents that are cooperative-but-biased rather than adversarial. Key mappings:

1. **The no-self-vote rule is a mechanism design choice.** In classical terms, it's removing a strategy (self-nomination) from the strategy space to prevent a dominant but unhelpful equilibrium. This is justified because self-voting is always rational for an agent (you always believe your own work is good) but reveals no useful information.

2. **The revelation principle suggests we should design for truthful reporting.** Our current format asks agents to report "Errors Found" and "Tensions" --- but agents may underreport errors in work that aligns with their own perspective (confirmation bias) or overreport errors in work that contradicts it. A mechanism that makes honest error reporting dominant-strategy optimal would be valuable.

3. **Prompt refinement between phases is mechanism adjustment.** When the orchestrator adds constraints based on Phase 0 outputs, it's narrowing the strategy space --- reducing the set of "moves" available to agents. The skill doc's distinction between constraints (good) and conclusions (bad) maps to the mechanism design principle that you should constrain the action space without constraining the outcome space.

### Specific techniques to adopt

- **Blind error validation**: After Round 1, have a separate (cheap) validation step where each reported error is checked against the actual code. Agents that report more *verified* errors in others' work get weighted more heavily in later rounds. This creates an incentive for thorough, honest error-finding rather than superficial agreement.

- **Shapley-value-inspired credit assignment**: Instead of a binary vote, assess each agent's marginal contribution. What did agent A's review add that B and C missed? This is computationally tractable with 3 agents and produces a richer signal than majority vote.

- **Commitment devices**: Have agents commit to key claims in Phase 0 (e.g., "I believe the buffer format should be X because Y"). In later rounds, they must explicitly address whether they still hold these commitments. This creates a record of position changes that reveals which insights genuinely updated beliefs vs. which were conformity.

### References
- [Game-Theoretic Lens on LLM-based Multi-Agent Systems](https://arxiv.org/html/2601.15047v1)
- [Everyone Contributes! Incentivizing Strategic Cooperation in Multi-LLM Systems via Sequential Public Goods Games](https://arxiv.org/html/2508.02076v1)
- [Game Theory Meets Large Language Models: A Systematic Survey (IJCAI 2025)](https://www.ijcai.org/proceedings/2025/1184.pdf)
- [Rethinking Strategic Mechanism Design In The Age Of Large Language Models](https://arxiv.org/html/2412.00495v1)
- [When Thinking LLMs Lie: Unveiling Strategic Deception in Reasoning Models](https://arxiv.org/html/2506.04909v1)

---

## 3. Information Aggregation

### What exists

**The Delphi Method** is the closest classical analogue to our process. Its four pillars:

1. **Anonymity**: Panelists don't know who said what, preventing authority/reputation from dominating. This prevents the "bandwagon effect" and allows free expression and admission of errors.
2. **Iteration with controlled feedback**: Multiple rounds where panelists see aggregated (not attributed) prior-round results.
3. **Statistical group response**: Consensus measured via mean/median/IQR of responses, not requiring unanimity.
4. **Expert input**: Panelists are selected for relevant expertise.

Typically runs 2-4 rounds. Stopping criteria: when the IQR narrows below a threshold, or responses stabilize between rounds, or a predetermined round limit is hit.

**Wisdom of Crowds with LLMs:**

- **"Wisdom of the Silicon Crowd"** (Science Advances, 2025): An ensemble of 12 different LLMs making probabilistic predictions achieved accuracy statistically indistinguishable from human crowds. Key finding: LLM predictions improved 17-28% when exposed to the median human prediction, suggesting that providing aggregate information between rounds genuinely helps.

- **LLM Council / Double Delphi**: The LLM Council framework aggregates judgments across multiple LLMs, drawing on ensemble methods. Errors from different models tend to cancel out. The "Double Delphi" variant adds a human-in-the-loop validation layer.

- **DelphiAgent**: A multi-agent verification framework directly inspired by Delphi, incorporating anonymous feedback, statistical analysis of agreement, and iterative refinement for fact verification.

**The sobering finding --- "Debate or Vote":**

A NeurIPS 2025 spotlight paper by Wang et al. disentangled MAD into two components: majority voting and inter-agent debate. They proved that debate induces a *martingale* over agents' belief trajectories, meaning **debate alone does not improve expected correctness**. Simple majority voting accounts for most of the observed gains in standard MAD setups.

However, this result applies primarily to homogeneous agents on well-defined tasks with clear right/wrong answers. Our cross-ref process involves heterogeneous perspectives on open-ended design questions, where the value of debate is in *surfacing considerations* rather than *converging on a single correct answer*.

### How it maps to our process

1. **We partially implement Delphi but miss anonymity.** Our agents know each other's labels and can form "opinions about opinions." In Phase 2, agent "protocol" knows it's reading "usability's" review, which may trigger different processing than anonymous input. For code review this may be fine (knowing the reviewer's perspective is useful context), but it could amplify conformity if one perspective is seen as more authoritative.

2. **The martingale result challenges our multi-round structure.** If debate doesn't improve expected correctness, why do Rounds 1 and 2? The answer is that our process is not trying to converge on a single correct answer --- it's trying to enumerate considerations, surface errors, and integrate perspectives. The value is in the *structured output* of each round, not in the final vote. This is a crucial distinction from the standard MAD evaluation setup.

3. **We don't do statistical aggregation.** Delphi uses IQR/median to measure convergence. We use prose-based "check for tensions." A more quantitative convergence metric --- even a rough one like counting the number of disagreement points remaining --- would give the orchestrator better skip/continue signals.

### Specific techniques to adopt

- **Quantitative convergence metrics**: Instead of the orchestrator reading Round 1 outputs and deciding whether to skip Round 2, compute a simple disagreement score. Count explicit tensions, contradictions, and unresolved questions across all Round 1 outputs. If the count is below a threshold (e.g., 2 remaining tensions), skip Round 2. If above (e.g., 5+), definitely run it. This is more reliable than the orchestrator's subjective judgment.

- **Controlled feedback between rounds**: When providing Round 1 outputs to Round 2 agents, include a statistical summary: "3 agents reviewed this work. 2/3 agreed the buffer format is correct. 1/3 identified a potential race condition." This aggregate framing (borrowed from Delphi) reduces the influence of any single agent's rhetoric.

- **Surprising Popularity algorithm**: From the "Beyond Majority Voting" research --- when agents report both their own answer and their prediction of what others will answer, the "surprisingly popular" answer (one that more agents hold than others predicted) is often correct. We could add a "prediction" step: before seeing others' work, each agent predicts what the others will conclude. Deviations from predictions are high-signal.

### References
- [Debate or Vote: Which Yields Better Decisions in Multi-Agent LLMs? (NeurIPS 2025)](https://arxiv.org/html/2508.17536v1)
- [Wisdom of the Silicon Crowd: LLM Ensemble Prediction (Science Advances 2025)](https://www.science.org/doi/10.1126/sciadv.adp1528)
- [Beyond Majority Voting: LLM Aggregation by Leveraging Higher-Order Information](https://arxiv.org/abs/2510.01499)
- [LLM Council with Double Delphi](https://www.researchgate.net/publication/399363236)
- [DelphiAgent: A Trustworthy Multi-Agent Verification Framework](https://www.sciencedirect.com/science/article/abs/pii/S0306457325001827)
- [Delphi Methodology in Healthcare Research (PMC)](https://pmc.ncbi.nlm.nih.gov/articles/PMC8299905/)
- [Wisdom from Diversity: Bias Mitigation Through Hybrid Human-LLM Crowds](https://arxiv.org/html/2505.12349)

---

## 4. Ordering Effects in Deliberation

### What exists

**Primacy and recency effects** are well-documented in human jury deliberation --- evidence presented first (primacy) or last (recency) disproportionately influences conclusions. This extends to LLM agents:

- **Debate order as a controllable factor**: The ICLR 2025 MAD survey identifies review order as one of four key controllable factors (alongside agent count, round count, and communication topology). It is studied as an independent variable that affects outcomes.

- **"Can LLM Agents Really Debate?"** (2024): Controlled study finding that majority opinion strongly suppresses independent correction. Weak agents rarely overturn initial majorities unless exposed to high-validity arguments. The order in which an agent encounters arguments affects which position it anchors to.

- **FOMC simulation** (GWU, 2025): Simulating monetary policy committee deliberation with LLM agents. Round 1 has selected members present recommendations; Round 2 shifts to focused trade-off discussion; Round 3 enables direct challenge. The ordering is designed to move from broad to narrow, preventing early anchoring on specific positions.

- **Jury research crossover**: Homogeneous juries amplify bias effects during deliberation. When evidence is ambiguous, the order of presentation significantly affects post-deliberation verdicts compared to pre-deliberation positions.

**The critical finding for us**: Ordering effects are real and significant. An agent that reads a strong argument first will process all subsequent arguments through that lens. This is not a bug --- it's how both human and LLM reasoning works. The question is whether we can use ordering strategically.

### How it maps to our process

Our forward-then-inverse ordering pattern has theoretical backing, though the literature frames it differently:

1. **Round 1 (forward order)** establishes initial positions. Agent A reads B then C; Agent B reads A then C. Each agent's review is anchored by whoever they read first.

2. **Round 2 (inverse order)** breaks the anchoring. Agent A now reads C then B. The item that was processed last (and thus less influential) in Round 1 is now processed first (and thus more influential) in Round 2. This is a debiasing technique --- it doesn't eliminate ordering effects but ensures no single agent's work consistently benefits from or is harmed by position effects.

3. **The combination produces richer coverage** than either order alone. This is consistent with the committee simulation research showing that moving from broad to narrow framing across rounds produces better outcomes.

### Specific techniques to adopt

- **Randomized ordering as a baseline**: For some runs, randomize the review order in Round 1 instead of using declaration order. Compare output quality. If randomized ordering produces equivalently good results, our inverse-order Round 2 may not be doing what we think it's doing.

- **Sequential disclosure with reaction tracking**: Instead of giving an agent all other agents' work at once, feed them one at a time and ask them to note reactions before seeing the next. This creates an explicit record of how each new piece of information shifts their thinking, making anchoring effects visible and analyzable.

- **Strategic ordering by divergence**: Instead of fixed forward/inverse ordering, the orchestrator could analyze Phase 0 outputs and order reviews to maximize information gain --- e.g., an agent with perspective X reviews the most-different-from-X perspective first. This uses ordering as a mechanism design lever rather than a fixed protocol.

### References
- [Can LLM Agents Really Debate? A Controlled Study of Multi-Agent Debate](https://arxiv.org/pdf/2511.07784)
- [Multi-LLM-Agents Debate (ICLR 2025)](https://d2jud02ci9yv69.cloudfront.net/2025-04-28-mad-159/blog/mad/)
- [A Multi-Agent System for Monetary Policy Decision Modeling](https://www2.gwu.edu/~forcpgm/2025-005.pdf)
- [Cognitive and Human Factors in Juror Decision Making (PMC)](https://pmc.ncbi.nlm.nih.gov/articles/PMC9198394/)

---

## 5. Exploration vs. Exploitation in Committee Processes

### What exists

The exploration-exploitation tradeoff in our context: should the process keep running more rounds (exploring for more insights) or converge and implement (exploiting what's been found)?

**Adaptive stopping mechanisms:**

- **KS-statistic convergence detection** (Hu et al., 2024): Models the debate as a time-varying mixture of Beta-Binomial distributions. Monitors the Kolmogorov-Smirnov statistic between consecutive rounds. When KS < 0.05 for 2 consecutive rounds, the distribution has stabilized and debate terminates. This is the most principled stopping criterion in the literature.

- **S2-MAD conditional participation**: Agents opt out when their similarity score with others exceeds a threshold. The debate naturally winds down as agents have less unique information to contribute.

- **Fixed-round protocols**: Most frameworks use fixed round counts (2-4 rounds). The MAD survey notes this risks either premature stopping or wasted computation.

**Bandit analogy:**

The exploration-exploitation framing maps imperfectly. In a bandit problem, you're choosing between arms with unknown reward distributions. In our process, each "round" is not choosing between alternatives --- it's refining understanding of a single problem. The closer analogy is **optimal stopping theory** (secretary problem variant): at what point has enough information been gathered that continuing yields diminishing returns?

**MCTS analogy:**

Monte Carlo Tree Search balances exploration (trying new branches) and exploitation (deepening promising branches) via UCB scores. In our context:
- Exploration = raising new concerns, reading additional files, changing perspective
- Exploitation = refining existing recommendations, resolving known tensions, converging on implementation plan

The MCTS UCB formula gives a principled way to balance these: explore when uncertainty is high relative to the quality of the best-known path. Translated to our domain: keep running rounds when there are many unresolved tensions (high uncertainty) and the implementation plan is still vague (low exploitation value).

### How it maps to our process

Our current stopping logic is binary and heuristic: "if Round 1 has unresolved tensions, run Round 2." The research suggests more nuanced approaches:

1. **We should measure convergence quantitatively, not qualitatively.** Instead of the orchestrator reading prose and deciding, compute a metric.

2. **The conditional participation idea is powerful for us.** If 2 of 3 agents agree after Round 1 and the third has a single remaining dissent, run Round 2 with just the dissenting agent and one other, not all three. This saves 1/3 of the Round 2 cost and focuses attention on the actual disagreement.

3. **We lack an "exploration budget" concept.** The orchestrator has no explicit sense of "we've spent X tokens / Y minutes, is continuing worth it?" A simple cost-benefit signal --- estimated remaining disagreements vs. tokens already spent --- would help.

### Specific techniques to adopt

- **Disagreement count as convergence metric**: After each round, count: (a) explicit errors found, (b) unresolved tensions, (c) new recommendations not present in previous rounds. When (a) + (b) + (c) drops below a threshold (e.g., 3 total new items from all agents combined), the process has converged. Skip remaining rounds.

- **Diminishing returns detection**: If Round 2 produces fewer new findings than Round 1 by a factor of >3x, further rounds will almost certainly produce even less. Terminate.

- **Partial rounds**: Instead of always running N agents per round, run only the agents whose prior-round output contained dissent or novel findings. Others' positions are considered "locked in."

- **Token budget**: Set a total token budget for the cross-ref process. The orchestrator allocates portions to each phase and dynamically adjusts --- if Phase 0 was cheap (agents agreed quickly), allocate more to review rounds; if Phase 0 was expensive (long analyses), trim later rounds.

### References
- [Multi-Agent Debate for LLM Judges with Adaptive Stability Detection](https://arxiv.org/html/2510.12697v1)
- [S2-MAD: Breaking the Token Barrier (NAACL 2025)](https://arxiv.org/html/2502.04790v1)
- [Exploration-Exploitation in Multi-Agent Competition: Convergence with Bounded Rationality](https://openreview.net/forum?id=OSLVL-tIBei)

---

## 6. Practical Implementations

### What exists

**Existing frameworks and what they learned:**

- **MetaGPT** (ICLR 2024): SOP-driven multi-agent software development. Key lesson: **structured artifacts between agents massively reduce error propagation**. When agents pass PRDs, API specs, and code rather than prose, downstream agents have less room to misinterpret. Their assembly-line model (each role produces a specific artifact type) prevents the "everyone reviews everything" explosion. They also found that a QA/reviewer role that specifically looks for errors in others' work is more effective than having every agent do everything.

- **AutoGen** (Microsoft): Dynamic multi-turn dialogue between agents. Key lesson: **flexibility in conversation structure is valuable but dangerous**. Without guard rails, agents loop, digress, or produce redundant output. Teams using AutoGen in production route runs through evaluation pipelines checking for hallucination, off-topic behavior, and missed requirements.

- **CrewAI**: Role-based crews with explicit task dependencies. Key lesson: **explicit dependency graphs between tasks prevent wasted work**. An agent shouldn't start reviewing until the work it's reviewing is complete. Sounds obvious, but async multi-agent systems often have agents working with stale or incomplete inputs.

- **Encouraging Divergent Thinking in LLMs through Multi-Agent Debate** (EMNLP 2024): Specifically studies how to prevent premature convergence. Found that prompting agents to "think differently" or assigning contrarian roles preserves cognitive diversity across rounds.

- **A-HMAD** (Adaptive Heterogeneous Multi-Agent Debate, 2025): Uses different LLM models (not just different prompts) for different agents. Achieved 4-6% absolute accuracy gains over homogeneous debate and reduced factual errors by 30%+ in biography generation. The diversity comes from different training data and different model architectures, not just different prompts.

### How it maps to our process

1. **We're already doing some things right.** Our phased structure with explicit outputs per phase is closer to MetaGPT's SOP model than to AutoGen's free-form dialogue. Our named perspectives (e.g., "protocol", "usability") serve the same function as MetaGPT's role assignments.

2. **We're missing structured artifact types.** Our agents all produce markdown prose with the same headings. MetaGPT's lesson suggests that different phases should produce different artifact types --- Phase 0 might produce code + brief rationale, Round 1 might produce structured error reports, Round 3 might produce a file-by-file implementation plan with code sketches.

3. **Heterogeneous agents are underexplored.** If we could use different models for different perspectives (e.g., a model that's strong at code analysis for the "implementation" perspective, one that's strong at architecture for the "design" perspective), the research suggests this would meaningfully improve outcomes. Even with the same model, varying temperature or system prompt style creates some heterogeneity.

4. **We lack the AutoGen lesson about evaluation pipelines.** We don't validate agent outputs between phases. A lightweight check --- did the agent actually read the files it claimed to? Does its error report reference real line numbers? --- would catch low-quality outputs before they propagate.

### Specific techniques to adopt

- **Phase-specific output schemas**: Phase 0 outputs code snippets + brief rationale (not essays). Round 1 outputs structured error reports (file, line, severity, proposed fix). Round 3 outputs a formal implementation plan with file paths and code blocks. Each phase has a different template.

- **Inter-phase validation**: Before starting Round 1, the orchestrator spot-checks Phase 0 outputs: Do referenced files exist? Are line numbers accurate? Are code snippets syntactically valid? Failed checks trigger a targeted re-run of that agent's Phase 0, not the whole phase.

- **Temperature diversity**: Run agents with slightly different temperatures (e.g., 0.3, 0.5, 0.7) to create output diversity even with the same model and prompt structure. Lower temperature for the "errors found" agent (precision matters), higher for the "gaps and insights" agent (creativity matters).

- **Contrarian role assignment**: Explicitly assign one agent the "devil's advocate" role in Round 2. Their job is to challenge the emerging consensus, even if they agree with it. Research shows this preserves exploration when the group is converging too early.

### References
- [MetaGPT (ICLR 2024)](https://arxiv.org/abs/2308.00352)
- [CrewAI vs LangGraph vs AutoGen (DataCamp)](https://www.datacamp.com/tutorial/crewai-vs-langgraph-vs-autogen)
- [Encouraging Divergent Thinking in LLMs through Multi-Agent Debate (EMNLP 2024)](https://aclanthology.org/2024.emnlp-main.992/)
- [Adaptive Heterogeneous Multi-Agent Debate (Springer 2025)](https://link.springer.com/article/10.1007/s44443-025-00353-3)
- [Agentic AI: A Comprehensive Survey of Architectures (2025)](https://arxiv.org/html/2510.25445v1)

---

## Surprising and Counterintuitive Findings

These findings challenge assumptions we might hold about how our process works:

### 1. Debate may not improve correctness --- but that might not matter for us

The NeurIPS 2025 "Debate or Vote" paper proves that multi-agent debate induces a martingale over belief trajectories, meaning debate alone doesn't improve expected correctness. Simple majority voting captures most of the gains. **But** this result applies to tasks with clear right/wrong answers. Our cross-ref process is doing something different --- it's enumerating considerations, surfacing errors in code, and integrating perspectives. The value isn't "the final answer is more likely correct" but "the final answer accounts for more considerations." The martingale result doesn't apply to information aggregation breadth, only to point-estimate accuracy.

**Implication**: Don't evaluate our process by whether the final implementation is "correct." Evaluate it by whether the implementation accounts for concerns that a single-agent approach would have missed.

### 2. Correct answers get flipped --- and this is the biggest risk

The "Talk Isn't Always Cheap" paper (ICML 2025) documents that agents frequently shift from correct to incorrect positions during debate due to conformity pressure. An agent with an eloquent but wrong argument can sway agents holding correct but less articulate positions. This is our biggest process risk: an agent that identifies a real bug in Phase 0 might get talked out of it in Round 1 by two agents who don't understand the bug.

**Implication**: Our Dissent section in Round 2 is critically important. We should make dissent *structurally privileged* --- perhaps requiring agents to explicitly re-affirm or retract Phase 0 claims that others challenged, with code evidence. A retraction without evidence should be flagged.

### 3. The optimal agent count is smaller than intuition suggests

Research consistently shows 3 agents as the sweet spot. More agents increase conformity pressure (more voices = stronger majority effect) while adding diminishing marginal information. The 5-agent and 7-agent configurations in studies often perform worse than 3-agent on tasks where conformity can flip correct answers.

**Implication**: Our default of 3 agents is well-calibrated. Resist the temptation to add more agents for "more perspectives." If additional perspectives are needed, run a second cross-ref with different perspective labels rather than a single cross-ref with 5+ agents.

### 4. Homogeneous agents create correlated errors that amplify rather than cancel

When all agents share the same training data and model architecture, their errors are correlated. The Condorcet Jury Theorem (which justifies majority voting) assumes independent errors --- when errors are correlated, majority voting can actually *amplify* shared misconceptions rather than canceling independent errors.

**Implication**: Our agents are all the same model with different prompts. This means their errors are highly correlated. The diversity comes from perspective labels, not from genuinely independent reasoning processes. To improve: (a) make perspective prompts as divergent as possible, (b) consider using different model configurations (temperature, system prompts) to decorrelate errors, (c) don't over-trust unanimous agreement --- it might reflect shared blind spots rather than genuine convergence.

### 5. Anonymity matters more than we might think

The Delphi method's insistence on anonymity isn't just academic tradition. Research shows that when participants know who made which argument, authority effects dominate --- a senior expert's mediocre argument beats a junior expert's brilliant insight. Our agents don't have "seniority," but they do have perspective labels that carry implicit authority. An agent labeled "implementation" may have outsized influence on implementation decisions, even when the "design" agent has a better implementation insight.

**Implication**: Consider an experiment where Round 1 reviews are anonymized before being passed to Round 2 agents. Instead of "protocol's review says X," present "Review A says X." This would test whether perspective-label authority effects are distorting our process.

### 6. One round of debate plus trajectory scoring may beat multiple rounds of consensus-seeking

FREE-MAD's single-round debate with trajectory scoring outperforms multi-round consensus MAD. The insight: forcing consensus is the problem, not the solution. When agents must agree, correct-but-minority positions get suppressed. When agents can maintain their positions and a scoring mechanism evaluates trajectories, minority insights survive.

**Implication**: Our Phase 3 convergence round might be counterproductive if it pressures agents to agree. Consider replacing "converge on a plan" with "present your final position, whether or not it matches others." Then have the orchestrator (or a scoring mechanism) synthesize the final plan from the strongest elements of each position, rather than asking agents to self-synthesize.

---

## Synthesis: Recommended Changes to Cross-Ref Skill

Based on this research, here are the highest-impact changes ranked by expected improvement-to-effort ratio:

### High impact, low effort

1. **Add quantitative convergence metrics.** Between rounds, count explicit disagreements/tensions/new-findings. Use this number to decide whether to continue, not the orchestrator's subjective reading. Threshold: <3 new items = skip next round.

2. **Structurally privilege dissent.** Add an explicit "Reaffirm or Retract" section to Round 2 where agents must address each of their Phase 0 claims that were challenged. Require code evidence for retractions.

3. **Add commitment tracking.** Phase 0 agents must list 3-5 "key claims" as structured bullet points. These are tracked through all rounds and each must be explicitly resolved (affirmed, retracted with evidence, or marked as unresolved) by Phase 3.

### High impact, medium effort

4. **Replace the implementer vote with trajectory scoring.** Instead of "who should implement?", score each agent on: (a) how many of their Phase 0 claims survived review, (b) how many valid errors they found in others' work, (c) how their position evolved productively. The highest-scoring agent implements.

5. **Conditional participation in Round 2.** Only agents with unresolved dissent or who received substantive challenges participate in Round 2. Agents whose Round 1 output shows full alignment with others can "lock in" their position.

6. **Phase-specific output schemas.** Move from uniform markdown to phase-appropriate structured formats. Phase 0: code + rationale. Round 1: structured error reports. Round 3: file-by-file implementation plan.

### Medium impact, higher effort

7. **Inter-phase validation.** Spot-check file paths, line numbers, and code references between phases. Flag agents that reference non-existent code.

8. **Surprising Popularity mechanism.** Before Round 1, each agent predicts what the others concluded in Phase 0. Deviations between predictions and reality are flagged as high-signal items for review focus.

9. **Anonymous Round 2.** Strip perspective labels from Round 1 outputs before feeding them to Round 2 agents. Test whether this reduces conformity and improves dissent quality.

### Experimental (worth testing)

10. **Temperature diversity.** Vary agent temperature settings to decorrelate errors.

11. **Contrarian role in Round 2.** Explicitly assign one agent to challenge the emerging consensus.

12. **Single-round + trajectory scoring.** Test whether Phase 0 -> Round 1 -> trajectory-scored implementation (skipping Rounds 2-3 entirely) produces comparable or better results at much lower cost.
