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

This runner follows the official dataset, per-instance task images, JSONL
prediction schema, and Docker evaluation harness:

- Dataset: <https://huggingface.co/datasets/princeton-nlp/SWE-bench_Verified>
- Evaluation guide: <https://www.swebench.com/SWE-bench/guides/evaluation/>

Inference and evaluation are deliberately separate. Inference runs a pinned
`opencode-ai` release inside the official SWE-bench image for each instance; it
does not clone an approximate host-side worktree. The model receives the public
problem statement and optional public hints, never the gold patch or hidden test
patch.

Docker is required for inference because the official task image defines the
repository and dependency environment. Run a smoke inference pass:

```bash
OPENROUTER_API_KEY=... bun run bench:swe-verified:infer -- \
  --run-id swe-verified-smoke \
  --max-instances 1
```

Useful flags:

```bash
bun run bench:swe-verified:infer -- --list-instances --max-instances 3
bun run bench:swe-verified:infer -- --instance-id astropy__astropy-12907
bun run bench:swe-verified:infer -- --model openrouter/qwen/qwen3-coder-next
bun run bench:swe-verified:infer -- --inference-workers 2
bun run bench:swe-verified:infer -- --run-id existing-incomplete-run
bun run bench:swe-verified:infer -- --run-id existing-run --restart
```

The runner writes:

- `instances.jsonl` with selected dataset rows.
- Per-attempt prompts, raw JSONL event output, a structured root-session export,
  setup/cleanup logs, the captured patch, and runtime metadata under each
  instance's `attempts/` directory.
- Final per-instance `run.json`, `prediction.json`, `patch.diff`, and
  `final-attempt.json` files referencing the selected attempt.
- `predictions.jsonl` in SWE-bench harness format.
- `prediction-manifest.json` with the selected instances, model, pinned
  opencode version, official images, and SHA-256 of `predictions.jsonl`.
- `summary.json` for the benchmark run.

Predictions, manifest, and summary are atomically checkpointed after every
instance. An interrupted run resumes completed instances and continues an
interrupted retry sequence without resetting its attempt budget when invoked
with the same configuration and run id. Agent failures remain explicit
predictions, and any partial patch is preserved even when opencode exits
nonzero. The runner never reads hidden evaluator fields to filter or rewrite a
prediction.

The inference coordinator supports bounded local concurrency with
`--inference-workers` and up to three infrastructure retries by default. Each
retry receives a fresh official task container and uses exponential backoff.
Retries are deliberately conservative: only pre-action transient provider,
network, service, container, or setup failures qualify. A timeout, any emitted
patch, or any agent tool call makes the attempt final. Incorrect patches and
empty completed attempts are never retried semantically. Configure the policy
with `--max-infrastructure-retries` and `--retry-base-delay-ms`; use zero retries
to reproduce one-shot inference. The retry count is capped at ten and each
backoff delay is capped at one minute. This coordinator is reusable benchmark
infrastructure, but it does not provide a remote/distributed runtime backend.

Runner summaries distinguish agent completion, prediction production, and
generation success. They do not claim that a task is resolved; resolution is
reported only by the official Docker evaluation.

On a Docker-capable evaluation machine, install the pinned official harness and
evaluate the completed artifact without re-running inference:

```bash
python -m pip install 'swebench==4.1.0'
bun run bench:swe-verified:eval -- \
  --run-id swe-verified-smoke \
  --max-workers 1
```

Evaluation verifies the prediction SHA-256 and run manifest before invoking
`python -m swebench.harness.run_evaluation`. Use both `--predictions-path` and
`--manifest-path` for an artifact outside the standard run directory. Harness
stdout, stderr, version, command, prediction digest, and status are recorded in
the run directory. `--dry-run` validates the artifact and prints the exact
harness command without starting evaluation.

## SWE-bench Pro

SWE-bench Pro uses Scale AI's official test split and its separate evaluator:

- Dataset: <https://huggingface.co/datasets/ScaleAI/SWE-bench_Pro>
- Evaluator: <https://github.com/scaleapi/SWE-bench_Pro-os>

Run one prediction instance:

```bash
OPENROUTER_API_KEY=... bun run bench:swe-pro:infer -- \
  --run-id swe-pro-example \
  --max-instances 1
```

Inference runs opencode at `/app` inside the official
`docker.io/jefzda/sweap-images:<dockerhub_tag>` image for each instance. The
agent receives only the public problem statement, requirements, interface,
repository metadata, and language. Gold patches, hidden test patches, and
evaluator-only fields are neither retained nor used to filter the model's
prediction.

The local coordinator is resumable, supports bounded concurrency through
`--inference-workers`, and retries only classified transient infrastructure
failures that occur before meaningful agent work. Each retry starts a fresh
official task container. The default is three infrastructure retries; there are
no critic-selected or semantic retries. The default per-instance timeout remains
30 minutes because Pro tasks exercise longer-horizon repository work.

Inference writes the official JSON-array `predictions.json` with `instance_id`,
`patch`, and `prefix`, plus a SHA-256-bound `prediction-manifest.json`. Evaluation
will refuse incomplete or modified prediction artifacts. It separately fetches
the selected official dataset rows only when evaluation starts.

Run the official evaluator in a later process. The runner automatically caches
the Scale harness at the pinned commit used by this integration; an explicit
`--harness-dir` must point at the same commit. Modal remains the upstream default:

```bash
bun run bench:swe-pro:eval -- \
  --run-id swe-pro-example \
  --max-workers 1
```

Use local Docker on the evaluation machine with:

```bash
bun run bench:swe-pro:eval -- \
  --run-id swe-pro-example \
  --use-local-docker \
  --max-workers 1
```

For artifacts outside the standard run directory, pass both `--predictions-path`
and the matching `--manifest-path`. `--dry-run` verifies the frozen artifact,
materializes evaluator rows, and records the pinned harness command without
starting the official evaluation.

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
bun run bench:terminal -- --all-tasks
bun run bench:terminal -- --dry-run
```

`--all-tasks` runs the complete dataset locally with the configured attempt
count, without enabling upload or the stricter leaderboard submission preset.

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
