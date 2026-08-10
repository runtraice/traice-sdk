---
title: Repository Benchmarks
excerpt: Run a reproducible Baseline-versus-Candidate coding-agent benchmark and publish a privacy-safe report.
section: Tools
sectionOrder: 4
order: 2
---

# Repository Benchmarks

Repository benchmarks compare two coding-agent configurations on the same public repository revision and prompt
suite. The report measures tokens, cost, task time, completion, quality, setup, refresh or re-index overhead, and a
bounded summary of agent activity.

Use this workflow to test Graphify or another repository context tool. A benchmark result applies only to its pinned
repository, prompts, agent, model, settings, and verification rubric. It is not a universal claim about either tool.

## Add the benchmark skill

Install the [`benchmark-repo` skill](https://github.com/runtraice/traice-sdk/tree/main/skills/benchmark-repo) in the
coding agent that will conduct the run. The skill contains the complete protocol and collector commands.

In Codex, ask:

```text
Install the benchmark-repo skill from https://github.com/runtraice/traice-sdk/tree/main/skills/benchmark-repo
```

For a Graphify candidate, install its Codex integration before the measured bootstrap:

```sh
graphify install --platform codex
```

The benchmark records whether Graphify and its agent skill were already installed. A from-scratch installation must
be timed and disclosed. Do not describe a preinstalled tool as a clean installation.

## Prompt your agent

Open the public repository at the revision you want to test, then send:

```text
Use $benchmark-repo to benchmark this repository with a baseline and Graphify.
```

You can replace `Graphify` with another Candidate tool. The agent will ask for or propose representative repository
tasks when the suite is not already defined.

The **prompt suite** is the ordered set of task prompts sent unchanged to both variants. A fair run also keeps the
agent, model, settings, task order, retry policy, and verification rubric identical.

## What the skill runs

The skill creates two clean worktrees or clones at the same public commit and performs these phases:

1. Initialize a private `.traice/benchmark.json` manifest with the exact prompts and comparison configuration.
2. Run every prompt with the Baseline and record measured usage, duration, completion, and quality evidence.
3. Record Candidate installation and initial bootstrap before its first task.
4. Run the identical prompts with the Candidate.
5. Refresh or re-index the Candidate after source changes and record every refresh as a separate stage.
6. Verify the results and compare cold-start, steady-state, and amortized outcomes.

The manifest is local and should not be committed to the repository under test.

## Inspect the result locally

Run the comparison before uploading it:

```sh
npx @traice/collector@latest benchmark compare
```

The comparison fails if task IDs, titles, or order differ between variants. A Candidate that uses fewer tokens but
fails tasks or scores materially lower must not be reported as savings.

## Measure privacy-safe agent activity

When the collector is configured, the skill can observe each variant:

```sh
npx @traice/collector@latest benchmark observe start --variant baseline
# Run the public benchmark prompts.
npx @traice/collector@latest benchmark observe stop
```

Repeat with `--variant candidate`. Observation reads local OpenTelemetry events and retains only allowlisted activity
categories, counts, aggregate duration, and failed counts. Commands, arguments, output, prompts, file paths,
credentials, people, and team names are not written to the manifest or uploaded report.

Only one benchmark observation can run on a device at a time. Avoid unrelated agent work until it is stopped.

## Upload a private draft

Local initialization, manual activity aggregates, and comparison do not require an account. Sign in only when you
want to upload a durable report:

```sh
npx @traice/collector@latest benchmark upload
```

If needed, upload opens browser authorization automatically. You can also authorize first:

```sh
npx @traice/collector@latest benchmark login
```

Browser authorization selects the signed-in account and grants only `benchmarks:write` to **My Benchmarks**. It does
not select or create a workspace, ingest general coding-agent usage, read workspace telemetry, or publish. Upload
always creates a private personal draft.

Open [My Benchmarks](https://www.runtraice.com/app/benchmarks) to review personal and accessible team history. A
personal owner can publish, unpublish, or archive local-only reports. Copy to team creates a separate team-owned fork
with lineage and keeps the personal original. Team owners and admins manage publication for that fork.

## Public reports

A published report is an immutable, privacy-filtered projection. It contains the authored public prompt suite,
repository and revision, variant configurations, aggregate metrics, setup and refresh stages, verification evidence,
disclosures, and allowlisted activity aggregates.

It does not expose workspace identity, workspace telemetry, raw OpenTelemetry events, recorded commands, output, file
paths, credentials, or private repository content. Published reports appear in the public
[benchmark directory](https://www.runtraice.com/benchmarks) and can be shared by URL.

Anyone can inspect a public report and download its exact prompt-suite manifest without signing in. Signed-in users
can save a private reproduction fork to My Benchmarks. Both actions retain the parent report version for attribution.

Unpublishing removes the report from the public directory and its public URL. Archiving keeps the private benchmark
record but leaves it unpublished.
