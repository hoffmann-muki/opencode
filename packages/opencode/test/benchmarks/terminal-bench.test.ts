import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  TERMINAL_BENCH_DATASET,
  buildHarborArgs,
  normalizeTerminalBenchTaskName,
  parseArgs,
  recoverTerminalBenchTraces,
  resolveDefaultModel,
  stripTerminalBenchmarkTraceFrames,
} from "../../benchmarks/terminal-bench"
import { createOpenCodeTraceRun } from "../../benchmarks/tracing/integration"
import {
  BENCHMARK_COORDINATOR_AGENT,
  BENCHMARK_NAVIGATOR_AGENT,
  BENCHMARK_PATCHER_AGENT,
  BENCHMARK_REVIEWER_AGENT,
  TERMINAL_BENCHMARK_AGENT_TOPOLOGY,
  terminalBenchmarkAgentConfig,
} from "../../benchmarks/opencode-benchmark-agents"

const defaults = {
  model: "openrouter/qwen/qwen3-coder-next",
  opencodeVersion: "1.18.4",
  now: new Date("2026-07-20T12:34:56.789Z"),
}
const runtime = {
  version: "1.18.4",
  commit: "a".repeat(40),
  binaryPath: "/cache/opencode",
  binarySha256: "b".repeat(64),
}

describe("Terminal-Bench runner", () => {
  test("uses a reproducible one-task smoke configuration by default", () => {
    const options = parseArgs([], defaults)

    expect(options).toMatchObject({
      maxTasks: 1,
      attempts: 1,
      concurrency: 1,
      maxRetries: 0,
      model: defaults.model,
      opencodeVersion: defaults.opencodeVersion,
      environment: "docker",
      runId: "terminal-bench-2.1-2026-07-20T12-34-56-789Z",
      upload: false,
      public: false,
      leaderboard: false,
      traceDir: resolve(import.meta.dir, "../../../..", ".benchmark-traces"),
    })
    expect(parseArgs(["--no-trace"], defaults).traceDir).toBeUndefined()
    expect(() => parseArgs(["--trace-dir", "/traces", "--no-trace"], defaults)).toThrow("cannot be combined")
  })

  test("builds the official Harbor invocation with an immutable local runtime", () => {
    const options = {
      ...parseArgs(
        [
          "--task-name",
          "git-*",
          "--task-name",
          "compression",
          "--max-tasks",
          "2",
          "--attempts",
          "3",
          "--concurrency",
          "2",
          "--max-retries",
          "1",
          "--run-id",
          "terminal-smoke",
        ],
        defaults,
      ),
      runtime,
    }

    expect(buildHarborArgs(options, "/runs/harbor-jobs")).toEqual([
      "run",
      "--dataset",
      TERMINAL_BENCH_DATASET,
      "--agent",
      "packages.opencode.benchmarks.opencode_harbor:BenchmarkOpenCode",
      "--model",
      defaults.model,
      "--agent-kwarg",
      "version=1.18.4",
      "--agent-kwarg",
      "binary_path=/cache/opencode",
      "--agent-kwarg",
      `source_commit=${"a".repeat(40)}`,
      "--agent-kwarg",
      `binary_sha256=${"b".repeat(64)}`,
      "--agent-kwarg",
      `opencode_config=${JSON.stringify(terminalBenchmarkAgentConfig())}`,
      "--env",
      "docker",
      "--n-attempts",
      "3",
      "--n-concurrent",
      "2",
      "--max-retries",
      "1",
      "--jobs-dir",
      "/runs/harbor-jobs",
      "--job-name",
      "terminal-smoke",
      "--include-task-name",
      "terminal-bench/git-*",
      "--include-task-name",
      "terminal-bench/compression",
      "--n-tasks",
      "2",
    ])
  })

  test("accepts short or qualified task names and sends canonical Harbor filters", () => {
    expect(normalizeTerminalBenchTaskName("write-compressor")).toBe("write-compressor")
    expect(normalizeTerminalBenchTaskName("terminal-bench/write-compressor")).toBe("write-compressor")
    expect(
      parseArgs(
        ["--task-name", "terminal-bench/write-compressor", "--task-name", "git-*"],
        defaults,
      ).taskNames,
    ).toEqual(["write-compressor", "git-*"])
    expect(() =>
      parseArgs(
        ["--task-name", "write-compressor", "--task-name", "terminal-bench/write-compressor"],
        defaults,
      ),
    ).toThrow("must be unique")
    expect(() => normalizeTerminalBenchTaskName("another-package/task")).toThrow(
      "official Terminal-Bench task name",
    )
  })

  test("accepts trace-only recovery without a provider run", () => {
    expect(parseArgs(["--recover-traces-from", "/runs/manifest.json"], defaults).recoverTracesFrom).toBe(
      "/runs/manifest.json",
    )
    expect(parseArgs(["--recover-traces-from", "/runs/manifest.json"], defaults).traceDir).toBeUndefined()
    expect(() =>
      parseArgs(["--recover-traces-from", "/runs/manifest.json", "--trace-dir", "/traces"], defaults),
    ).toThrow("--recover-traces-from cannot be combined with --trace-dir")
  })

  test("configures a coordinator with blocking native subagent delegation", () => {
    const config = terminalBenchmarkAgentConfig()
    const coordinator = config.agent[BENCHMARK_COORDINATOR_AGENT]

    expect(config.default_agent).toBe(BENCHMARK_COORDINATOR_AGENT)
    expect(config.agent.title.disable).toBe(true)
    expect(TERMINAL_BENCHMARK_AGENT_TOPOLOGY).toBe("supervisor-delegation")
    expect(coordinator.mode).toBe("primary")
    expect(coordinator.permission.task).toBe("allow")
    expect(coordinator.prompt).toContain(BENCHMARK_NAVIGATOR_AGENT)
    expect(coordinator.prompt).toContain(BENCHMARK_PATCHER_AGENT)
    expect(coordinator.prompt).toContain(BENCHMARK_REVIEWER_AGENT)
    expect(config.agent[BENCHMARK_NAVIGATOR_AGENT].steps).toBe(10)
    expect(config.agent[BENCHMARK_PATCHER_AGENT].steps).toBe(18)
    expect(config.agent[BENCHMARK_REVIEWER_AGENT].steps).toBe(12)
    expect(coordinator.prompt.match(/fresh benchmark-/g)).toHaveLength(3)
    expect(coordinator.prompt).toContain("Do not use background delegation")
  })

  test("leaderboard mode enforces the complete public five-attempt protocol", () => {
    const options = parseArgs(["--leaderboard", "--concurrency", "4"], defaults)
    const args = buildHarborArgs({ ...options, runtime }, "/runs/harbor-jobs")

    expect(options.maxTasks).toBeUndefined()
    expect(options.attempts).toBe(5)
    expect(options.upload).toBe(true)
    expect(options.public).toBe(true)
    expect(args).toContain("--upload")
    expect(args).toContain("--public")
    expect(args).not.toContain("--n-tasks")
  })

  test("all-tasks mode removes only the safe smoke limit", () => {
    const options = parseArgs(["--all-tasks"], defaults)
    const args = buildHarborArgs({ ...options, runtime }, "/runs/harbor-jobs")

    expect(options.maxTasks).toBeUndefined()
    expect(options.attempts).toBe(1)
    expect(options.upload).toBe(false)
    expect(options.public).toBe(false)
    expect(args).not.toContain("--n-tasks")
    expect(() => parseArgs(["--all-tasks", "--max-tasks", "5"], defaults)).toThrow("cannot be combined")
  })

  test("rejects partial or under-sampled leaderboard runs", () => {
    expect(() => parseArgs(["--leaderboard", "--max-tasks", "5"], defaults)).toThrow(
      "complete Terminal-Bench 2.1 dataset",
    )
    expect(() => parseArgs(["--leaderboard", "--task-name", "task"], defaults)).toThrow(
      "complete Terminal-Bench 2.1 dataset",
    )
    expect(() => parseArgs(["--leaderboard", "--attempts", "4"], defaults)).toThrow("at least 5 attempts")
  })

  test("validates visibility, model format, numeric values, and safe run ids", () => {
    expect(() => parseArgs(["--public"], defaults)).toThrow("--public requires --upload")
    expect(() => parseArgs(["--model", "model-only"], defaults)).toThrow("provider/model")
    expect(() => parseArgs(["--max-retries", "-1"], defaults)).toThrow("non-negative integer")
    expect(() => parseArgs(["--run-id", "../escape"], defaults)).toThrow("--run-id may contain")
  })

  test("normalizes model environment defaults without embedding credentials", () => {
    expect(resolveDefaultModel({ OPENROUTER_MODEL: "qwen/qwen3-coder-next" })).toBe("openrouter/qwen/qwen3-coder-next")
    expect(resolveDefaultModel({ OPENCODE_BENCH_MODEL: "anthropic/claude-sonnet-4" })).toBe("anthropic/claude-sonnet-4")
  })

  test("wires a trace override into the custom Harbor adapter", () => {
    const options = {
      ...parseArgs(["--trace-dir", "/traces"], defaults),
      runtime,
      harborVersion: "0.20.0",
      traceRun: {
        id: "trace-run-test",
        root: "/traces/trace-run-test",
        createdAt: "2026-07-20T12:34:56.789Z",
        benchmark: "terminal-bench-2.1",
        framework: "opencode",
      },
    }
    const args = buildHarborArgs(options, "/runs/harbor-jobs")
    const kwargs = args.flatMap((value, index) => (value === "--agent-kwarg" ? [args[index + 1]] : []))

    expect(options.traceDir).toBe("/traces")
    expect(kwargs).toContain("trace_root=/traces/trace-run-test")
    expect(kwargs).toContain("trace_run_id=trace-run-test")
    expect(kwargs).toContain("trace_created_at=2026-07-20T12:34:56.789Z")
    expect(kwargs).toContain("trace_benchmark=terminal-bench-2.1")
    expect(kwargs).toContain("evaluation_workers=1")
    expect(kwargs).toContain("benchmark_retries=0")
    expect(kwargs).toContain("harbor_version=0.20.0")
  })

  test("strips internal trace frames without changing ordinary Harbor output", () => {
    const retained = JSON.stringify({ type: "tool_use", part: { tool: "bash" } })
    const native = JSON.stringify({ type: "benchmark_trace.native", sequence: 1, event: {} })

    expect(stripTerminalBenchmarkTraceFrames(`${retained}\n\n${native}\nplain stderr\n`)).toBe(
      `${retained}\n\nplain stderr\n`,
    )
  })

  test("promotes a Harbor native stream into a valid run index", async () => {
    const root = mkdtempSync(join(tmpdir(), "opencode-terminal-trace-"))
    try {
      const run = createOpenCodeTraceRun(join(root, "traces"), "terminal-bench-2.1")
      const agentDir = join(root, "jobs", "job", "task-a__trial", "agent")
      mkdirSync(agentDir, { recursive: true })
      const frame = (sequence: number, timestamp: number, event: object) =>
        JSON.stringify({
          type: "benchmark_trace.native",
          sequence,
          timestamp,
          sessionID: "session-root",
          event,
        })
      writeFileSync(
        join(agentDir, "opencode.txt"),
        [
          frame(1, 1_000, {
            type: "session.created",
            properties: { info: { id: "session-root", agent: "benchmark" } },
          }),
          frame(2, 1_100, {
            type: "session.status",
            properties: {
              sessionID: "session-root",
              status: { type: "idle" },
            },
          }),
        ].join("\n") + "\n",
      )
      writeFileSync(
        join(agentDir, "benchmark-trace.json"),
        JSON.stringify({
          schemaVersion: 1,
          runId: run.id,
          benchmark: "terminal-bench-2.1",
          instanceId: "task-a",
          attempt: 1,
          traceRoot: run.root,
          createdAt: run.createdAt,
          frameworkRevision: "a".repeat(40),
          model: defaults.model,
          evaluationWorkers: 1,
          inferenceTimeoutSeconds: 900,
          benchmarkRetries: 0,
          harborVersion: "0.20.0",
          image: "example/task:latest",
          sessionId: "task-a__trial__agent",
          agentSightProfileId: `agentsight-${"c".repeat(32)}`,
          agentSightStrict: false,
          startedAt: new Date(1_000).toISOString(),
          finishedAt: new Date(1_100).toISOString(),
          status: "completed",
        }),
      )
      const profileDir = join(agentDir, ".agentsight-profile", "profiles", "agentsight")
      mkdirSync(profileDir, { recursive: true })
      writeFileSync(
        join(profileDir, "profile.json"),
        JSON.stringify({
          schema: "benchmark-agentsight-profile/v1",
          profileId: `agentsight-${"c".repeat(32)}`,
          status: "completed",
        }),
      )
      writeFileSync(
        join(profileDir, "health.json"),
        JSON.stringify({
          schema: "benchmark-agentsight-health/v1",
          profileId: `agentsight-${"c".repeat(32)}`,
          status: "completed",
          complete: true,
        }),
      )
      writeFileSync(
        join(root, "jobs", "job", "lock.json"),
        JSON.stringify({
          trials: [{ task: { name: "terminal-bench/task-a" } }, { task: { name: "terminal-bench/task-a" } }],
        }),
      )

      const recoveryManifest = join(root, "manifest.json")
      writeFileSync(
        recoveryManifest,
        JSON.stringify({
          schemaVersion: 2,
          benchmark: "terminal-bench",
          agent: "opencode",
          runId: "job",
          traceDir: run.root,
          traceRunId: run.id,
          traceCreatedAt: run.createdAt,
          traceBenchmark: run.benchmark,
          jobsDir: join(root, "jobs"),
          opencodeCommit: "a".repeat(40),
          taskNames: [],
          maxTasks: 1,
          attempts: 1,
        }),
      )

      expect(await recoverTerminalBenchTraces(recoveryManifest)).toBe(run.root)
      expect(await recoverTerminalBenchTraces(recoveryManifest)).toBe(run.root)
      expect(Bun.file(join(run.root, "run.json")).size).toBeGreaterThan(0)
      expect(readFileSync(join(agentDir, "opencode.txt"), "utf8")).not.toContain("benchmark_trace.native")
      expect(await Bun.file(join(run.root, ".harbor-staging")).exists()).toBe(false)
      expect(
        JSON.parse(
          readFileSync(
            join(run.root, "instances", "task-a", "attempt-1", "profiles", "agentsight", "profile.json"),
            "utf8",
          ),
        ).profileId,
      ).toBe(`agentsight-${"c".repeat(32)}`)
      expect(await Bun.file(join(agentDir, ".agentsight-profile")).exists()).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
