# Benchmarks

This directory contains the SWE-bench Verified runner for exercising opencode as
a black-box coding agent.

Generated data is written under `.benchmark-runs/` at the repository root and is
ignored by git.

By default, each benchmark instance installs a project-local opencode benchmark
team in the temporary worktree/workspace. The primary agent is
`benchmark-coordinator`, which delegates to `benchmark-navigator`,
`benchmark-patcher`, and `benchmark-reviewer` through opencode's task/subagent
tool. Navigator -> patcher -> reviewer work stays foreground and ordered so the
noninteractive runner cannot finish before a subagent result is incorporated.
This makes benchmark runs exercise an explicit multi-agent workflow while still
allowing `--agent` to override the primary agent for experiments.

## SWE-bench Verified

Run a smoke pass over one SWE-bench Verified instance:

```bash
OPENROUTER_API_KEY=... bun run bench:swe-verified -- --max-instances 1
```

Useful flags:

```bash
bun run bench:swe-verified -- --list-instances --max-instances 3
bun run bench:swe-verified -- --instance-id astropy__astropy-12907
bun run bench:swe-verified -- --model openrouter/qwen/qwen3-coder-next
bun run bench:swe-verified -- --max-instances 1 --evaluate
```

The runner writes:

- `instances.jsonl` with selected dataset rows.
- Per-instance `prompt.txt`, `opencode.stdout.jsonl`, `opencode.stderr.txt`,
  `run.json`, and `prediction.json`.
- `predictions.jsonl` in SWE-bench harness format.
- `summary.json` for the benchmark run.

`predictions.jsonl` and `summary.json` are updated after every instance, so a
later infrastructure failure does not discard completed predictions. Agent
failures and empty patches remain explicit empty predictions, matching the
official harness treatment of ungenerated patches. The runner also rejects a
model patch that changes a path present in the hidden test patch; it records the
rejected diff for audit without exposing the hidden patch to the agent or
persisting it in benchmark artifacts.

Runner summaries distinguish agent completion, prediction production, and
generation success. They do not claim that a task is resolved; resolution is
reported only by the official Docker evaluation.

The optional `--evaluate` flag calls the official SWE-bench Python/Docker
harness, which must be installed separately.

Evaluate an existing SWE-bench run without re-running opencode:

```bash
bun run bench:swe-verified -- \
  --run-id swe-verified-example \
  --evaluate-only \
  --max-workers 1
```

Use `--predictions-path <path>/predictions.jsonl` when evaluating a predictions
file outside the standard run directory.
