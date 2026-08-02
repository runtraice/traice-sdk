# Repository benchmark protocol

## Recorded stages

| Kind      | Include                                                                                      |
| --------- | -------------------------------------------------------------------------------------------- |
| `setup`   | Initial installation, indexing, graph construction, or other one-time Candidate preparation  |
| `refresh` | Incremental re-indexing or preparation required after repository state changes               |
| `execute` | Optional explicit execution overhead not already represented by individual task duration     |
| `verify`  | Tests, rubric evaluation, or deterministic checks performed outside individual task duration |

Each stage records wall time, input tokens, output tokens, cost in USD micros, status, a safe command summary, and a
source revision or dirty-tree fingerprint. Use zero for a measured zero. Do not use zero for an unknown value. Resolve
unknown values before publishing or disclose that the metric is unavailable.

Graphify's initial full build is `setup`. A required `--update` after source changes is `refresh`. Graphify reports its
own extraction token counts; include them in the relevant stage. Structural code extraction can legitimately report
zero LLM tokens.

## Task parity

Both variants must contain the same stable task IDs and titles. Keep prompts, repository revision, agent, model,
settings, time limits, retries, network rules, and verification criteria identical. Use a new report version when the
protocol changes.

Recommended launch suite:

- architecture or request-flow tracing;
- locating the files and symbols needed for a bounded change;
- implementing and verifying that bounded change;
- debugging a supplied failing test;
- one trivial or context-free negative control.

## Comparison math

Compute `Candidate - Baseline`. Compute percentage as `difference / abs(Baseline) * 100`. When Baseline is zero, show
`N/A`. Lower is better for tokens, cost, time, errors, and retries. Higher is better for completion and quality.

Cold-start duration includes setup, refresh, task execution, and verification. Steady-state excludes initial setup but
includes every refresh required by source changes. Amortized duration divides setup by the disclosed task count and
adds steady-state work.

All-in token and cost totals include setup and refresh. Per-task rows remain execution-only so readers can see where
the difference came from.

## Stop conditions

Stop and fix the protocol before comparing when:

- worktrees are on different commits;
- task IDs, titles, prompts, or ordering differ;
- the Candidate graph or index is stale;
- either variant received undisclosed manual help;
- task output cannot be verified under the declared rubric;
- a requested public field contains private repository or identity information;
- a run failed but would otherwise be omitted from the result.
