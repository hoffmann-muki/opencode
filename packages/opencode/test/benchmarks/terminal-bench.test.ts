import { describe, expect, test } from "bun:test"
import {
  TERMINAL_BENCH_DATASET,
  buildHarborArgs,
  parseArgs,
  resolveDefaultModel,
} from "../../benchmarks/terminal-bench"
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
    })
  })

  test("builds the official Harbor invocation with filters and a pinned opencode version", () => {
    const options = parseArgs(
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
    )

    expect(buildHarborArgs(options, "/runs/harbor-jobs")).toEqual([
      "run",
      "--dataset",
      TERMINAL_BENCH_DATASET,
      "--agent",
      "opencode",
      "--model",
      defaults.model,
      "--agent-kwarg",
      "version=1.18.4",
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
      "git-*",
      "--include-task-name",
      "compression",
      "--n-tasks",
      "2",
    ])
  })

  test("configures a coordinator with blocking native subagent delegation", () => {
    const config = terminalBenchmarkAgentConfig()
    const coordinator = config.agent[BENCHMARK_COORDINATOR_AGENT]

    expect(config.default_agent).toBe(BENCHMARK_COORDINATOR_AGENT)
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
    const args = buildHarborArgs(options, "/runs/harbor-jobs")

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
    const args = buildHarborArgs(options, "/runs/harbor-jobs")

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
})
