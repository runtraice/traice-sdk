---
name: benchmark-repo
description: Run a reproducible A/B benchmark of coding-agent work on a public GitHub repository. Use when a user asks to benchmark a repository, compare a baseline with Graphify or another context tool, measure token or cost savings, include setup and re-index overhead, or produce a trAIce benchmark report.
---

# Benchmark Repository

Create a fair Baseline-versus-Candidate benchmark, record evidence with `@traice/collector`, and upload a private draft
for human review. Never publish directly or infer effectiveness from token totals alone.

## Rules

- Use two clean worktrees or clones pinned to the same public commit.
- Use the same agent, model, settings, task text, order, retry policy, and verification rubric.
- Keep raw prompts local except for the explicitly authored public task suite. Never upload captured agent output,
  private paths, credentials, people, teams, or unrestricted telemetry.
- Record every attempt. Do not discard an unfavorable or failed run without disclosing the exclusion.
- Require completion or quality evidence. If the Candidate uses fewer tokens but fails or scores materially lower, do
  not call the difference savings.
- Record one-time setup and incremental refresh separately. Show cold-start, steady-state, and amortized results.
- Stop if repository state, task suite, model settings, or verification rules differ between variants.

Read [references/protocol.md](references/protocol.md) for recording fields, Graphify refresh rules, and failure cases.

## Workflow

### 1. Pin the protocol

Confirm both worktrees are at the same commit and initialize the manifest from either one:

```sh
npx @traice/collector@latest benchmark init \
  --title "Graphify vs baseline on OWNER/REPO" \
  --summary "Identical repository tasks with setup and refresh included." \
  --candidate-label "Graphify" \
  --candidate-tool "Coding agent + Graphify" \
  --candidate-configuration "Graphify graph queried before repository-context work." \
  --amortization-task-count 20 \
  --prompt "PROMPT_1" \
  --prompt "PROMPT_2" \
  --disclosure "Candidate totals include initial Graphify bootstrap and required incremental refreshes."
```

Copy the resulting private `.traice/benchmark.json` to the Candidate worktree. Do not commit it to the target
repository.

### 2. Run the Baseline

When the local collector is configured, start bounded OpenTelemetry activity capture before the first prompt:

```sh
npx @traice/collector@latest benchmark observe start --variant baseline
```

Run every task without the Candidate tool. For each task:

1. Capture start and end wall-clock time.
2. Read actual input, cached input, output, billable token, retry, and cost values from the agent or trAIce telemetry.
3. Run the declared verification and assign a 0-100 score or record no score when no defensible rubric exists.
4. Record the result with the same stable task ID used by the Candidate.

```sh
npx @traice/collector@latest benchmark task \
  --variant baseline \
  --id TASK_ID \
  --title "TASK_TITLE" \
  --input-tokens N \
  --cache-read-tokens N \
  --output-tokens N \
  --billable-tokens N \
  --cost-usd-micros N \
  --duration-ms N \
  --quality-score N
```

After the last Baseline prompt, stop capture:

```sh
npx @traice/collector@latest benchmark observe stop
```

Observation records only fixed categories, counts, aggregate duration, and failures. It must never persist raw
commands, arguments, output, or paths. If OpenTelemetry is unavailable, use `benchmark activity` to record a bounded
aggregate from agent events and disclose its source.

### 3. Prepare and run the Candidate

Verify the Graphify CLI and the installed agent skill report the same version. If either is absent or stale, install
the Codex integration with `graphify install --platform codex` and include that wall time in Candidate setup. If the
CLI or skill was already installed globally, disclose that precondition instead of claiming a from-scratch software
install.

Record Candidate initialization before the first task. Invoke Graphify through its installed agent skill with
`/graphify . --no-viz` (or `graphify extract . --code-only` in a code-only headless CLI flow), time the complete graph
build, and record the token and cost totals from `graphify-out/cost.json`:

```sh
npx @traice/collector@latest benchmark stage \
  --variant candidate \
  --kind setup \
  --label "Graphify bootstrap" \
  --duration-ms N \
  --input-tokens N \
  --output-tokens N \
  --cost-usd-micros N \
  --command "/graphify . --no-viz" \
  --source-revision REVISION
```

Start Candidate observation immediately before its first prompt, run the identical tasks, and record them with
`benchmark task --variant candidate`:

```sh
npx @traice/collector@latest benchmark observe start --variant candidate
# Run every Candidate prompt and any required refreshes.
npx @traice/collector@latest benchmark observe stop
```

Before each later Candidate task, compare the repository state with the state used by its graph. If tracked or
untracked source changed, run the tool's incremental preparation. For Graphify, invoke `/graphify . --update` through
the agent skill (or `graphify update .` in a headless CLI flow) and record it as `--kind refresh`. Include its wall
time, tokens, cost, exit status, and new source fingerprint. Do not silently reuse a stale graph.

Record explicit test or rubric work as a `verify` stage when it is not already included in the task duration.

### 4. Validate and compare

```sh
npx @traice/collector@latest benchmark compare
```

The comparison must fail when task IDs or titles differ. Review raw values and percentage deltas. A zero Baseline must
show `N/A`, never an invented percentage. Call out where cold-start and steady-state conclusions differ.

### 5. Authenticate and upload a draft

Local initialization, manual activity aggregates, and comparison do not require an account. Automatic OpenTelemetry
observation requires a configured local collector. Cloud measurement and durable reports require an account:

```sh
npx @traice/collector@latest benchmark upload
```

When a personal benchmark credential is not already stored, upload starts browser authorization automatically. The
browser flow creates or signs into a trAIce account and grants only `benchmarks:write` to My Benchmarks. It does not
select or create a workspace and cannot ingest general usage or publish. Uploading creates a private personal draft.
Tell the user to review the allowlisted projection in trAIce before publishing. Copy to team is a separate action that
preserves the personal original and report lineage.

## Final response

Report:

- repository and pinned revision;
- exact public task suite;
- Baseline and Candidate configurations;
- initial setup and every refresh or re-index;
- A/B values, absolute differences, and percentage differences;
- per-task completion and quality evidence;
- cold-start, steady-state, and amortized conclusions;
- exclusions, failures, and whether the report remains private or was published.
