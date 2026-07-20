# Benchmarks

This directory contains official-harness benchmark runners for exercising
opencode as a black-box agent.

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

This runner follows the official dataset, JSONL prediction schema, and Docker
evaluation harness:

- Dataset: <https://huggingface.co/datasets/SWE-bench/SWE-bench_Verified>
- Evaluation guide: <https://www.swebench.com/SWE-bench/guides/evaluation/>

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

## SWE-bench Pro

SWE-bench Pro uses Scale AI's official test split and its separate evaluator:

- Dataset: <https://huggingface.co/datasets/ScaleAI/SWE-bench_Pro>
- Evaluator: <https://github.com/scaleapi/SWE-bench_Pro-os>

Run one prediction instance:

```bash
OPENROUTER_API_KEY=... bun run bench:swe-pro -- --max-instances 1
```

The runner gives opencode the public problem statement, requirements, and
interface fields, but never the gold patch or hidden test patch. It writes the
official JSON-array `predictions.json` with `instance_id`, `patch`, and `prefix`,
plus a minimal `evaluation-instances.jsonl` containing the fields needed by the
official evaluator. The default per-instance timeout is 30 minutes because Pro
tasks are intended to exercise longer-horizon repository work.

Clone and install the official evaluator separately, following its upstream
README. Evaluation uses Modal by default:

```bash
SWE_BENCH_PRO_HARNESS_DIR=/path/to/SWE-bench_Pro-os \
  bun run bench:swe-pro -- --run-id swe-pro-example --evaluate
```

Evaluate an existing run without generating predictions again:

```bash
SWE_BENCH_PRO_HARNESS_DIR=/path/to/SWE-bench_Pro-os \
  bun run bench:swe-pro -- \
    --run-id swe-pro-example \
    --evaluate-only \
    --max-workers 1
```

Use `--use-local-docker` for the evaluator's beta local-Docker mode. When
evaluating an external prediction file, pass both `--predictions-path` and the
matching `--evaluation-instances-path`; the latter can be reused from the run
that generated those predictions.

## Terminal-Bench 2.1

Terminal-Bench 2.1 is run through Harbor, the benchmark's official evaluation
framework. The wrapper does not recreate task setup or grading: Harbor downloads
`terminal-bench/terminal-bench-2-1`, installs the pinned opencode version in each
task environment, runs the dataset verifier, and preserves its native results,
agent logs, and ATIF trajectories.

- Dataset: <https://hub.harborframework.com/datasets/terminal-bench/terminal-bench-2-1/6>
- Harbor evaluation guide: <https://www.harborframework.com/docs/run-jobs/run-evals>
- Terminal-Bench 2.1 release: <https://www.tbench.ai/news/terminal-bench-2-1>

Prerequisites are Python 3.12+, Harbor, and a supported Harbor environment.
For the default local environment, Docker must be installed and running:

```bash
uv tool install harbor
docker info
```

Run a one-task smoke evaluation:

```bash
OPENROUTER_API_KEY=... bun run bench:terminal
```

Select named tasks or increase the smoke sample without changing official task
behavior:

```bash
bun run bench:terminal -- --task-name task-name --attempts 1
bun run bench:terminal -- --max-tasks 5 --concurrency 2
bun run bench:terminal -- --dry-run
```

The official leaderboard protocol requires the complete 89-task dataset, at
least five attempts per task, and a public Harbor upload. The leaderboard preset
enforces those conditions while leaving concurrency configurable:

```bash
OPENROUTER_API_KEY=... bun run bench:terminal -- \
  --leaderboard \
  --concurrency 4
```

Generated data is stored under
`.benchmark-runs/terminal-bench-2.1/runs/<run-id>/`. `manifest.json` records the
resolved dataset, model, opencode and Harbor versions, execution settings, and
exit status. Harbor's complete official job directory is retained under
`harbor-jobs/`, alongside streamed stdout and stderr logs. Credentials are
inherited through the environment and are never written to the command or
manifest. A completed wrapper run means Harbor finished successfully; per-task
resolution is determined only by the official verifier rewards in Harbor's
`result.json` and trial artifacts.
