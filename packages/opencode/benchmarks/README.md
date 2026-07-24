# Benchmarks

This directory contains official-harness benchmark runners for exercising
opencode as a black-box agent.

Generated data is written under `.benchmark-runs/` at the repository root and is
ignored by git.

By default, each benchmark instance uses a primary `benchmark-coordinator` and
foreground, ordered delegation through opencode's native task/subagent tool.
The SWE runners install project-local navigator, patcher, and reviewer agents.
Terminal-Bench passes the same fixed-budget team through the Harbor adapter. In
both cases, one benchmark attempt remains one outer attempt; the subagent calls
are the multi-agent work inside it. SWE runners still allow `--agent` to
override the primary agent for experiments.

## SWE-bench Verified

This runner follows the official dataset, per-instance task images, JSONL
prediction schema, and Docker evaluation harness:

- Dataset: <https://huggingface.co/datasets/princeton-nlp/SWE-bench_Verified>
- Evaluation guide: <https://www.swebench.com/SWE-bench/guides/evaluation/>

Inference and evaluation are deliberately separate. Inference builds the exact
clean opencode checkout once, caches the Linux binary by full Git commit, and
copies it into the official SWE-bench image for each instance. The model
receives the concise public problem statement and optional public hints, never
the gold patch or hidden test patch.

Docker is required for inference because the official task image defines the
repository and dependency environment. Run a smoke inference pass:

```bash
OPENROUTER_API_KEY=... bun run bench:swe-verified:infer -- \
  --run-id swe-verified-smoke
```

The safe defaults use `scikit-learn__scikit-learn-13439`,
`openrouter/qwen/qwen3-coder-next`, one inference worker, one agent attempt, a
30-minute agent timeout, and zero infrastructure retries. Passing
`--max-instances` or `--offset` opts into dataset-window selection instead of
the fixed smoke instance. Implicit windows preserve dataset order. Explicit
`--instance-id` values preserve command order, reject duplicates, and take
precedence over the window size.

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
- `prediction-manifest.json` with the selected instances, model, full opencode
  commit, binary SHA-256, official images, provider-attempt policy, and SHA-256
  of `predictions.jsonl`.
- `summary.json` for the benchmark run.

Predictions, manifest, and summary are atomically checkpointed after every
instance. An interrupted run resumes completed instances and continues an
interrupted retry sequence without resetting its attempt budget when invoked
with the same configuration and run id. Agent failures remain explicit
predictions, and any partial patch is preserved even when opencode exits
nonzero. The runner never reads hidden evaluator fields to filter or rewrite a
prediction.

The inference coordinator supports bounded local concurrency with
`--inference-workers`. Each instance receives one agent execution by default;
infrastructure retries are disabled unless explicitly requested. Each enabled
retry receives a fresh official task container and uses exponential backoff.
Retries are deliberately conservative: only pre-action transient provider,
network, service, container, or setup failures qualify. A timeout, any emitted
patch, or any agent tool call makes the attempt final. Incorrect patches and
empty completed attempts are never retried semantically. Configure the policy
with `--max-infrastructure-retries` and `--retry-base-delay-ms`; set retries
above zero only when additional infrastructure recovery calls are acceptable.
The retry count is capped at ten and each
backoff delay is capped at one minute. This coordinator is reusable benchmark
infrastructure, but it does not provide a remote/distributed runtime backend.
Within every benchmark agent turn, opencode makes one provider request attempt:
its normal interactive provider-retry policy is disabled only for these
benchmark-launched processes.

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
the run directory. Evaluation uses one worker and an explicit 3,600-second
per-test timeout by default, matching the OpenHands and Hermes runners. Override
the timeout with `--evaluation-timeout-seconds` only for an intentional scoring
configuration change. `--dry-run` validates the artifact and prints the exact
harness command without starting evaluation.

## SWE-bench Pro

SWE-bench Pro uses Scale AI's official test split and its separate evaluator:

- Dataset: <https://huggingface.co/datasets/ScaleAI/SWE-bench_Pro>
- Evaluator: <https://github.com/scaleapi/SWE-bench_Pro-os>

Run one prediction instance:

```bash
OPENROUTER_API_KEY=... bun run bench:swe-pro:infer -- \
  --run-id swe-pro-example
```

The safe defaults use
`instance_qutebrowser__qutebrowser-5fdc83e5da6222fe61163395baaad7ae57fa2cb4-v363c8a7e5ccdf6968fc7ab84a2053ac78036691d`,
`openrouter/qwen/qwen3-coder-next`, one inference worker, one agent attempt, a
30-minute agent timeout, and zero infrastructure retries. Passing
`--max-instances` or `--offset` opts into dataset-window selection instead.
Implicit windows preserve dataset order. Explicit `--instance-id` values
preserve command order, reject duplicates, and take precedence over the window
size.

Inference runs opencode at `/app` inside the official
`docker.io/jefzda/sweap-images:<dockerhub_tag>` image for each instance. The
exact clean checkout is built and cached by commit before the run. The agent
receives only the concise public problem statement, requirements, interface,
repository metadata, and language. Gold patches, hidden test patches, and
evaluator-only fields are neither retained nor used to filter the model's
prediction. Provider retries are disabled for the benchmark process, yielding
one provider request attempt per turn.

The local coordinator is resumable, supports bounded concurrency through
`--inference-workers`, and retries only classified transient infrastructure
failures that occur before meaningful agent work. Each retry starts a fresh
official task container. Each instance receives one agent execution by default,
with zero infrastructure retries and no critic-selected or semantic retries.
The default per-instance timeout remains 30 minutes because Pro tasks exercise
longer-horizon repository work.

Inference writes the official JSON-array `predictions.json` with `instance_id`,
`patch`, and `prefix`, plus a SHA-256-bound `prediction-manifest.json`. Evaluation
will refuse incomplete or modified prediction artifacts. It separately fetches
the selected official dataset rows only when evaluation starts.

Run the official evaluator in a later process. The runner automatically caches
the Scale harness at the pinned commit used by this integration; an explicit
`--harness-dir` must point at the same commit. Local Docker is the runner default
(the upstream evaluator itself defaults to Modal):

```bash
bun run bench:swe-pro:eval -- \
  --run-id swe-pro-example \
  --max-workers 1
```

Use Modal instead with:

```bash
bun run bench:swe-pro:eval -- \
  --run-id swe-pro-example \
  --no-use-local-docker \
  --max-workers 1
```

For artifacts outside the standard run directory, pass both `--predictions-path`
and the matching `--manifest-path`. `--dry-run` verifies the frozen artifact,
materializes evaluator rows, and records the pinned harness command without
starting the official evaluation.

## Research tracing

SWE-bench Verified and SWE-bench Pro inference enable the framework-native
`benchmark-trace/v1` adapter by default. Each runner creates a private
`trace-run-<uuid>` beneath the repository-local `.benchmark-traces/` base:

The tracing integration is benchmark-agnostic. A shared run coordinator owns
run identity, instance selection, attempt coverage, and final indexing; the
OpenCode adapter owns native agent events; and a pluggable harness adapter owns
only harness-specific topology. Direct SWE runners use `DirectTraceHarness`,
while Terminal-Bench uses the reusable `HarborTraceHarness`. Future benchmarks
on either execution path provide metadata and selected IDs without adding a new
trace extractor.

```bash
OPENROUTER_API_KEY=... bun run bench:swe-verified:infer -- \
  --run-id traced-verified

OPENROUTER_API_KEY=... bun run bench:swe-pro:infer -- \
  --run-id traced-pro
```

Use `--trace-dir <base-directory>` to override the repository-local base, or
`--no-trace` for an intentional untraced inference run. Evaluation-only modes
never create traces. Initialization occurs before container setup or any
provider request. A traced invocation must be fresh; use `--restart` or a new
benchmark run id instead of attaching tracing partway through a checkpointed
run.

Capture occurs inside the benchmark process; it is not reconstructed from logs.
The live OpenCode event stream is recorded as each agent action occurs, and the
runner prints the exact private trace path when it finishes. No separate
collector command needs to run before, during, or after inference. The stable
base can also be used to discover its finalized `trace-run-<uuid>` children.

The trace-enabled OpenCode process publishes its native event stream to the
adapter, which records root and child sessions without
changing native task delegation, model-message boundaries, pending/running/final
tool state, complete tool input and output, shell/file/search/browser activity,
delegation and child-session identity, compaction boundaries, errors, and native
wall-clock durations. This includes the command, arguments, retained output,
exit code when exposed, and timing for shell actions. Native records and large
values are stored as pre-persistence-sanitized, content-addressed artifacts.
Credential fields and recognizable credential text are removed or replaced;
token usage and cost accounting are deliberately excluded.

Exact provider payloads are not exposed by this OpenCode event mode, and nested
operating-system activity below an OpenCode tool call remains outside the
observable boundary. These limitations are explicit in each attempt's
`capabilities.json`. A trace contains a durable `journal.jsonl`, finalized
`events.jsonl`, native evidence index, health report, capability matrix,
manifest, and run-level index. A tracing failure after agent execution starts
does not alter the benchmark outcome or trigger a retry. Trace health is
reported separately in the attempt summary.

The framework- and benchmark-independent `benchmark-trace` researcher CLI lives
with the canonical contract in the OpenHands-benchmarks repository. It can
validate, inspect, summarize, compare, and render this output directly, including
comparison with OpenHands and Hermes traces. Analysis is read-only; its explicit
recovery operation only finalizes an interrupted durable journal and never
launches an agent.

Terminal-Bench uses the same OpenCode-native adapter with Harbor as an outer
execution boundary, not a fourth agent adapter. The trace adds the observable
Harbor agent phase and resolved task-container identity. Harbor's verifier runs
outside the installed-agent boundary, so evaluator lifecycle remains explicitly
`not_exposed`; Harbor's logs, results, and ATIF trajectory remain authoritative
auxiliary artifacts.

## Terminal-Bench 2.1

Terminal-Bench 2.1 is run through Harbor, the benchmark's official evaluation
framework. The wrapper does not recreate task setup or grading: Harbor downloads
`terminal-bench/terminal-bench-2-1`, installs the cached binary for the exact
clean opencode commit in each task environment, runs the dataset verifier, and
preserves its native results, agent logs, and ATIF trajectories. The
benchmark-only wrapper also enforces one provider request attempt per turn.
Each trial uses a supervisor-led foreground
sequence of investigation, execution, and independent verification. The
coordinator and three fresh phases have iteration caps of 24, 10, 18, and 12,
with temperature `0.1` throughout.

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

OPENROUTER_API_KEY=... bun run bench:terminal -- \
  --run-id traced-terminal-smoke
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
resolved dataset, model, full opencode commit and binary digest, Harbor version,
provider-attempt policy, execution settings, and exit status. Harbor's complete
official job directory is retained under
`harbor-jobs/`, alongside streamed stdout and stderr logs. Credentials are
inherited through the environment and are never written to the command or
manifest. A completed wrapper run means Harbor finished successfully; per-task
resolution is determined only by the official verifier rewards in Harbor's
`result.json` and trial artifacts.

Tracing defaults to the repository-local `.benchmark-traces/` base. Use
`--trace-dir <base-directory>` to override it or `--no-trace` to disable tracing
for a run. After preflight, the host creates a private trace run while the
installed adapter records non-secret attempt timing and provenance before the
provider can run. The OpenCode process emits native timestamped frames for
sessions, model turns, tools, shell/file/search/browser activity, delegation,
and compaction. After applying credential redaction and removing accounting
fields at the emission boundary, those frames pass through the JSONL stream.
After Harbor returns, the wrapper normalizes them, strips only its internal
transport frames from `opencode.txt`, and retains all ordinary Harbor output.

Canonicalization is staged per attempt and promoted atomically, so a host
interruption cannot expose a half-built attempt. The run manifest checkpoints
the trace-run identity before Harbor starts. Normal exits and forwarded signals
finalize automatically; after a host crash or forced termination, resume the
same retained native stream without launching Harbor or spending API credits:

```bash
bun run bench:terminal -- \
  --recover-traces-from .benchmark-runs/terminal-bench-2.1/runs/<run-id>/manifest.json
```

Recovery is idempotent: already promoted attempts are verified and skipped,
unfinished staging is rebuilt from the sanitized native frames, and `run.json`
is finalized only after the requested coverage is present.

The trace uses Harbor's pinned task identity, effective agent timeout, and
container image. Concurrent trials receive locked per-instance attempt
ordinals, and `run.json` is written only for complete requested coverage.
Post-start tracing failures never change the Harbor result or trigger a retry;
token usage and cost are deliberately excluded.
