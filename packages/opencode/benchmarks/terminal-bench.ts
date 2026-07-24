/**
 * Benchmark opencode on Terminal-Bench 2.1 through the official Harbor runner.
 *
 * Harbor owns task retrieval, sandbox lifecycle, agent installation, verification,
 * and result/trajectory persistence. This wrapper only supplies reproducible
 * opencode defaults, validates local prerequisites, and records invocation logs.
 */

import { spawn } from "node:child_process"
import { constants as fsConstants, createWriteStream } from "node:fs"
import { access, mkdir, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  BENCHMARK_COORDINATOR_AGENT,
  TERMINAL_BENCHMARK_AGENT_TOPOLOGY,
  terminalBenchmarkAgentConfig,
} from "./opencode-benchmark-agents.ts"
import { benchmarkSourceIdentity, ensureBenchmarkRuntime, type BenchmarkRuntime } from "./opencode-runtime.ts"
import { createTraceRun, type TraceRun } from "./tracing/coordination.ts"
import { collectOpenCodeHarborTraces, stripHarborTraceFrames } from "./tracing/harbor.ts"

export const TERMINAL_BENCH_DATASET = "terminal-bench/terminal-bench-2-1"
export const TERMINAL_BENCH_TASK_COUNT = 89

const DEFAULT_RUN_ROOT = ".benchmark-runs/terminal-bench-2.1"
const DEFAULT_MAX_TASKS = 1
const DEFAULT_ATTEMPTS = 1
const DEFAULT_CONCURRENCY = 1
const DEFAULT_MAX_RETRIES = 0
const DEFAULT_MODEL = "openrouter/qwen/qwen3-coder-next"
const DEFAULT_ENVIRONMENT = "docker"
const OPENCODE_PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const REPO_ROOT = resolve(OPENCODE_PACKAGE_ROOT, "../..")
const OPENCODE_PACKAGE_JSON = join(OPENCODE_PACKAGE_ROOT, "package.json")
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const HARBOR_AGENT = "packages.opencode.benchmarks.opencode_harbor:BenchmarkOpenCode"

interface CliOptions {
  readonly taskNames: readonly string[]
  readonly maxTasks?: number
  readonly attempts: number
  readonly concurrency: number
  readonly maxRetries: number
  readonly model: string
  readonly opencodeVersion: string
  readonly runtime?: BenchmarkRuntime
  readonly environment: string
  readonly outputDir: string
  readonly traceDir?: string
  readonly traceRun?: TraceRun
  readonly recoverTracesFrom?: string
  readonly runId: string
  readonly harborBin: string
  readonly harborVersion?: string
  readonly upload: boolean
  readonly public: boolean
  readonly leaderboard: boolean
  readonly dryRun: boolean
  readonly help: boolean
}

interface BenchmarkPaths {
  readonly runDir: string
  readonly jobsDir: string
  readonly manifestPath: string
  readonly stdoutPath: string
  readonly stderrPath: string
}

interface ProcessResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

interface RunManifest {
  readonly schemaVersion: 2
  readonly benchmark: "terminal-bench"
  readonly dataset: string
  readonly officialTaskCount: number
  readonly officialRunner: "harbor"
  readonly harborVersion: string
  readonly model: string
  readonly agent: "opencode"
  readonly agentAdapter: typeof HARBOR_AGENT
  readonly primaryAgent: typeof BENCHMARK_COORDINATOR_AGENT
  readonly agentTopology: typeof TERMINAL_BENCHMARK_AGENT_TOPOLOGY
  readonly opencodeVersion: string
  readonly opencodeCommit: string
  readonly opencodeBinarySha256: string
  readonly providerAttemptsPerTurn: 1
  readonly environment: string
  readonly taskNames: readonly string[]
  readonly maxTasks?: number
  readonly attempts: number
  readonly concurrency: number
  readonly maxRetries: number
  readonly upload: boolean
  readonly public: boolean
  readonly leaderboard: boolean
  readonly allTasks: boolean
  readonly command: readonly string[]
  readonly jobsDir: string
  readonly stdoutPath: string
  readonly stderrPath: string
  readonly startedAt: string
  readonly finishedAt?: string
  readonly exitCode?: number
  readonly status: "running" | "completed" | "failed"
  readonly runId: string
  readonly traceDir?: string
  readonly traceRunId?: string
  readonly traceCreatedAt?: string
  readonly traceBenchmark?: string
}

export function usage(): string {
  return [
    "Benchmark opencode on Terminal-Bench 2.1 with the official Harbor runner.",
    "",
    "Usage:",
    "  bun run bench:terminal -- [flags]",
    "",
    "Flags:",
    `  --max-tasks N          Maximum tasks after filtering. Default: ${DEFAULT_MAX_TASKS}.`,
    "  --all-tasks            Remove the smoke task limit without leaderboard upload.",
    "  --task-name NAME       Official task name or glob to include. Repeatable.",
    `  --attempts N           Attempts per task. Default: ${DEFAULT_ATTEMPTS}.`,
    `  --concurrency N        Concurrent Harbor trials. Default: ${DEFAULT_CONCURRENCY}.`,
    `  --max-retries N        Infrastructure retries per trial. Default: ${DEFAULT_MAX_RETRIES}.`,
    "  --model MODEL          Agent model in provider/model format.",
    "  The agent runtime is built from the exact clean opencode checkout and cached by commit.",
    `  --environment NAME     Harbor environment. Default: ${DEFAULT_ENVIRONMENT}.`,
    `  --output-dir DIR       Output root. Default: ${DEFAULT_RUN_ROOT}.`,
    "  --trace-dir DIR        Opt-in benchmark-trace/v1 output base; each invocation creates a private trace run.",
    "  --recover-traces-from MANIFEST",
    "                         Finalize staged traces from an interrupted run without launching Harbor.",
    "  --run-id ID            Stable Harbor job and local run identifier.",
    "  --harbor-bin PATH      Harbor executable. Default: harbor.",
    "  --upload               Upload the completed job to Harbor Hub.",
    "  --public               Make an uploaded job public. Requires --upload.",
    "  --leaderboard          Run all 89 tasks with at least five attempts and public upload.",
    "  --dry-run              Print the resolved Harbor command without executing it.",
    "  --help                 Print this message.",
    "",
    "Environment:",
    "  OPENCODE_BENCH_MODEL or OPENCODE_MODEL can set the default model.",
    "  OPENROUTER_MODEL is accepted and normalized to openrouter/<model>.",
    "  OPENROUTER_API_KEY is required when using an openrouter model.",
    "  HARBOR_TELEMETRY defaults to off for benchmark runs unless already set.",
  ].join("\n")
}

export function parseArgs(
  argv: readonly string[],
  defaults: { readonly model: string; readonly opencodeVersion: string; readonly now?: Date },
): CliOptions {
  const taskNames: string[] = []
  let maxTasks: number | undefined = DEFAULT_MAX_TASKS
  let maxTasksWasSet = false
  let allTasks = false
  let attempts = DEFAULT_ATTEMPTS
  let attemptsWasSet = false
  let concurrency = DEFAULT_CONCURRENCY
  let maxRetries = DEFAULT_MAX_RETRIES
  let model = defaults.model
  const opencodeVersion = defaults.opencodeVersion
  let environment = DEFAULT_ENVIRONMENT
  let outputDir = DEFAULT_RUN_ROOT
  let traceDir: string | undefined
  let recoverTracesFrom: string | undefined
  const now = defaults.now ?? new Date()
  let runId = `terminal-bench-2.1-${now.toISOString().replaceAll(/[:.]/g, "-")}`
  let harborBin = "harbor"
  let upload = false
  let publicJob = false
  let leaderboard = false
  let dryRun = false
  let help = false

  const nextValue = (index: number, flag: string): string => {
    const value = argv[index + 1]
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`)
    return value
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === "--help" || arg === "-h") {
      help = true
    } else if (arg === "--max-tasks") {
      maxTasks = parsePositiveInt(nextValue(i, arg), arg)
      maxTasksWasSet = true
      i += 1
    } else if (arg === "--all-tasks") {
      allTasks = true
    } else if (arg === "--task-name") {
      taskNames.push(nextValue(i, arg))
      i += 1
    } else if (arg === "--attempts") {
      attempts = parsePositiveInt(nextValue(i, arg), arg)
      attemptsWasSet = true
      i += 1
    } else if (arg === "--concurrency") {
      concurrency = parsePositiveInt(nextValue(i, arg), arg)
      i += 1
    } else if (arg === "--max-retries") {
      maxRetries = parseNonNegativeInt(nextValue(i, arg), arg)
      i += 1
    } else if (arg === "--model") {
      model = nextValue(i, arg)
      i += 1
    } else if (arg === "--environment") {
      environment = nextValue(i, arg)
      i += 1
    } else if (arg === "--output-dir") {
      outputDir = nextValue(i, arg)
      i += 1
    } else if (arg === "--trace-dir") {
      traceDir = nextValue(i, arg)
      i += 1
    } else if (arg === "--recover-traces-from") {
      recoverTracesFrom = nextValue(i, arg)
      i += 1
    } else if (arg === "--run-id") {
      runId = nextValue(i, arg)
      i += 1
    } else if (arg === "--harbor-bin") {
      harborBin = nextValue(i, arg)
      i += 1
    } else if (arg === "--upload") {
      upload = true
    } else if (arg === "--public") {
      publicJob = true
    } else if (arg === "--leaderboard") {
      leaderboard = true
    } else if (arg === "--dry-run") {
      dryRun = true
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  if (allTasks && maxTasksWasSet) {
    throw new Error("--all-tasks cannot be combined with --max-tasks.")
  }
  if (allTasks) maxTasks = undefined

  if (leaderboard) {
    if (taskNames.length > 0 || maxTasksWasSet) {
      throw new Error("--leaderboard must run the complete Terminal-Bench 2.1 dataset without task filters.")
    }
    if (attemptsWasSet && attempts < 5) throw new Error("--leaderboard requires at least 5 attempts per task.")
    maxTasks = undefined
    attempts = Math.max(attempts, 5)
    upload = true
    publicJob = true
  }

  if (publicJob && !upload) throw new Error("--public requires --upload.")
  if (recoverTracesFrom !== undefined && traceDir !== undefined) {
    throw new Error("--recover-traces-from cannot be combined with --trace-dir.")
  }
  if (!model.includes("/") || model.startsWith("/") || model.endsWith("/")) {
    throw new Error("--model must use provider/model format.")
  }
  if (!opencodeVersion.trim()) throw new Error("--opencode-version cannot be empty.")
  if (!environment.trim()) throw new Error("--environment cannot be empty.")
  if (!harborBin.trim()) throw new Error("--harbor-bin cannot be empty.")
  if (!SAFE_RUN_ID.test(runId) || runId === "." || runId === "..") {
    throw new Error("--run-id may contain only letters, numbers, dots, underscores, and hyphens.")
  }

  return {
    taskNames,
    ...(maxTasks !== undefined ? { maxTasks } : {}),
    attempts,
    concurrency,
    maxRetries,
    model,
    opencodeVersion,
    environment,
    outputDir,
    ...(traceDir !== undefined ? { traceDir } : {}),
    ...(recoverTracesFrom !== undefined ? { recoverTracesFrom } : {}),
    runId,
    harborBin,
    upload,
    public: publicJob,
    leaderboard,
    dryRun,
    help,
  }
}

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer.`)
  return parsed
}

function parseNonNegativeInt(value: string, flag: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${flag} must be a non-negative integer.`)
  return parsed
}

export function resolveDefaultModel(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OPENCODE_BENCH_MODEL) return env.OPENCODE_BENCH_MODEL
  if (env.OPENCODE_MODEL) return env.OPENCODE_MODEL
  if (env.OPENROUTER_MODEL) {
    return env.OPENROUTER_MODEL.startsWith("openrouter/") ? env.OPENROUTER_MODEL : `openrouter/${env.OPENROUTER_MODEL}`
  }
  return DEFAULT_MODEL
}

export function buildHarborArgs(options: CliOptions, jobsDir: string): readonly string[] {
  if (!options.runtime) throw new Error("The exact opencode benchmark runtime has not been prepared.")
  const opencodeConfig = JSON.stringify(terminalBenchmarkAgentConfig())
  const args = [
    "run",
    "--dataset",
    TERMINAL_BENCH_DATASET,
    "--agent",
    HARBOR_AGENT,
    "--model",
    options.model,
    "--agent-kwarg",
    `version=${options.opencodeVersion}`,
    "--agent-kwarg",
    `binary_path=${options.runtime.binaryPath}`,
    "--agent-kwarg",
    `source_commit=${options.runtime.commit}`,
    "--agent-kwarg",
    `binary_sha256=${options.runtime.binarySha256}`,
    "--agent-kwarg",
    `opencode_config=${opencodeConfig}`,
    ...(options.traceRun
      ? [
          "--agent-kwarg",
          `trace_root=${options.traceRun.root}`,
          "--agent-kwarg",
          `trace_run_id=${options.traceRun.id}`,
          "--agent-kwarg",
          `trace_created_at=${options.traceRun.createdAt}`,
          "--agent-kwarg",
          `trace_benchmark=${options.traceRun.benchmark}`,
          "--agent-kwarg",
          `evaluation_workers=${options.concurrency}`,
          "--agent-kwarg",
          `benchmark_retries=${options.maxRetries}`,
          "--agent-kwarg",
          `harbor_version=${options.harborVersion ?? "unknown"}`,
        ]
      : []),
    "--env",
    options.environment,
    "--n-attempts",
    String(options.attempts),
    "--n-concurrent",
    String(options.concurrency),
    "--max-retries",
    String(options.maxRetries),
    "--jobs-dir",
    jobsDir,
    "--job-name",
    options.runId,
  ]

  for (const taskName of options.taskNames) args.push("--include-task-name", taskName)
  if (options.maxTasks !== undefined) args.push("--n-tasks", String(options.maxTasks))
  if (options.upload) args.push("--upload")
  if (options.public) args.push("--public")
  return args
}

function buildPaths(options: CliOptions): BenchmarkPaths {
  const root = resolvePathFromRepoRoot(options.outputDir)
  const runDir = join(root, "runs", options.runId)
  return {
    runDir,
    jobsDir: join(runDir, "harbor-jobs"),
    manifestPath: join(runDir, "manifest.json"),
    stdoutPath: join(runDir, "harbor.stdout.log"),
    stderrPath: join(runDir, "harbor.stderr.log"),
  }
}

function resolvePathFromRepoRoot(path: string): string {
  return resolve(isAbsolute(path) ? path : join(REPO_ROOT, path))
}

async function readLocalOpencodeVersion(): Promise<string> {
  const packageJson: unknown = await Bun.file(OPENCODE_PACKAGE_JSON).json()
  if (
    typeof packageJson !== "object" ||
    packageJson === null ||
    !("version" in packageJson) ||
    typeof packageJson.version !== "string" ||
    !packageJson.version.trim()
  ) {
    throw new Error(`Missing package version in ${OPENCODE_PACKAGE_JSON}.`)
  }
  return packageJson.version
}

async function assertExecutable(command: string): Promise<void> {
  if (command.includes("/") || isAbsolute(command)) {
    await access(command, fsConstants.X_OK).catch(() => {
      throw new Error(`Executable not found or not executable: ${command}`)
    })
    return
  }
  if (Bun.which(command)) return
  throw new Error(`Required executable not found on PATH: ${command}`)
}

async function runCaptured(command: string, args: readonly string[]): Promise<ProcessResult> {
  const child = Bun.spawn([command, ...args], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, exitCode }
}

async function preflight(options: CliOptions): Promise<string> {
  await assertExecutable(options.harborBin)
  const version = await runCaptured(options.harborBin, ["--version"])
  if (version.exitCode !== 0) {
    throw new Error(`Could not execute Harbor: ${version.stderr.trim() || version.stdout.trim()}`)
  }

  if (options.environment === "docker") {
    await assertExecutable("docker")
    const docker = await runCaptured("docker", ["info", "--format", "{{.ServerVersion}}"])
    if (docker.exitCode !== 0) {
      throw new Error(`Docker is required and must be running: ${docker.stderr.trim() || docker.stdout.trim()}`)
    }
  }

  if (options.model.startsWith("openrouter/") && !process.env.OPENROUTER_API_KEY?.trim()) {
    throw new Error("OPENROUTER_API_KEY is required for an openrouter model.")
  }

  return version.stdout.trim() || version.stderr.trim() || "unknown"
}

async function runStreaming(
  command: string,
  args: readonly string[],
  paths: Pick<BenchmarkPaths, "stdoutPath" | "stderrPath">,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const stdoutFile = createWriteStream(paths.stdoutPath, { encoding: "utf8" })
  const stderrFile = createWriteStream(paths.stderrPath, { encoding: "utf8" })
  const child = spawn(command, args, { cwd: REPO_ROOT, env, stdio: ["inherit", "pipe", "pipe"] })

  child.stdout.on("data", (chunk: Buffer) => {
    process.stdout.write(chunk)
    stdoutFile.write(chunk)
  })
  child.stderr.on("data", (chunk: Buffer) => {
    process.stderr.write(chunk)
    stderrFile.write(chunk)
  })

  const forwardSignal = (signal: NodeJS.Signals) => child.kill(signal)
  const onSigint = () => forwardSignal("SIGINT")
  const onSigterm = () => forwardSignal("SIGTERM")
  process.once("SIGINT", onSigint)
  process.once("SIGTERM", onSigterm)

  try {
    return await new Promise<number>((resolvePromise, reject) => {
      child.once("error", reject)
      child.once("close", (code, signal) => {
        if (code !== null) resolvePromise(code)
        else reject(new Error(`Harbor terminated by signal ${signal ?? "unknown"}.`))
      })
    })
  } finally {
    process.removeListener("SIGINT", onSigint)
    process.removeListener("SIGTERM", onSigterm)
    await Promise.all([
      new Promise<void>((resolvePromise) => stdoutFile.end(resolvePromise)),
      new Promise<void>((resolvePromise) => stderrFile.end(resolvePromise)),
    ])
  }
}

async function writeManifest(path: string, manifest: RunManifest): Promise<void> {
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
}

export async function collectTerminalBenchTraces(input: {
  readonly run: TraceRun
  readonly jobsDir: string
  readonly harborJobName: string
  readonly sourceCommit: string
  readonly taskNames: readonly string[]
  readonly maxTasks?: number
  readonly attempts: number
}): Promise<string | undefined> {
  return collectOpenCodeHarborTraces({
    ...input,
    officialTaskCount: TERMINAL_BENCH_TASK_COUNT,
  })
}

export async function recoverTerminalBenchTraces(manifestPath: string): Promise<string> {
  const path = resolvePathFromRepoRoot(manifestPath)
  const value: unknown = await Bun.file(path).json()
  if (!isRecoverableManifest(value)) {
    throw new Error("Terminal-Bench trace recovery manifest is invalid or lacks trace preflight metadata.")
  }
  const run: TraceRun = {
    id: value.traceRunId,
    root: resolve(value.traceDir),
    createdAt: value.traceCreatedAt,
    benchmark: value.traceBenchmark,
    framework: "opencode",
  }
  const warning = await collectTerminalBenchTraces({
    run,
    jobsDir: resolve(value.jobsDir),
    harborJobName: value.runId,
    sourceCommit: value.opencodeCommit,
    taskNames: value.taskNames,
    ...(value.maxTasks !== undefined ? { maxTasks: value.maxTasks } : {}),
    attempts: value.attempts,
  })
  if (warning) throw new Error(warning)
  return run.root
}

export function stripTerminalBenchmarkTraceFrames(output: string): string {
  return stripHarborTraceFrames(output)
}

async function main(): Promise<void> {
  const opencodeVersion = await readLocalOpencodeVersion()
  const options = parseArgs(process.argv.slice(2), {
    model: resolveDefaultModel(),
    opencodeVersion,
  })
  if (options.help) {
    console.log(usage())
    return
  }
  if (options.recoverTracesFrom) {
    console.log(`Benchmark traces: ${await recoverTerminalBenchTraces(options.recoverTracesFrom)}`)
    return
  }

  const runtime = await ensureBenchmarkRuntime(await benchmarkSourceIdentity())
  const resolvedOptions = { ...options, opencodeVersion: runtime.version, runtime }
  const paths = buildPaths(resolvedOptions)
  const previewArgs = buildHarborArgs(resolvedOptions, paths.jobsDir)

  if (resolvedOptions.dryRun) {
    console.log(JSON.stringify([resolvedOptions.harborBin, ...previewArgs]))
    return
  }

  const harborVersion = await preflight(resolvedOptions)
  const traceRun = resolvedOptions.traceDir
    ? createTraceRun(resolvedOptions.traceDir, "terminal-bench-2.1", "opencode")
    : undefined
  const executionOptions = traceRun ? { ...resolvedOptions, traceRun, harborVersion } : resolvedOptions
  const harborArgs = buildHarborArgs(executionOptions, paths.jobsDir)
  const renderedCommand = [executionOptions.harborBin, ...harborArgs]
  await mkdir(paths.runDir, { recursive: true })
  await mkdir(paths.jobsDir, { recursive: true })

  const startedAt = new Date().toISOString()
  const manifest: RunManifest = {
    schemaVersion: 2,
    benchmark: "terminal-bench",
    dataset: TERMINAL_BENCH_DATASET,
    officialTaskCount: TERMINAL_BENCH_TASK_COUNT,
    officialRunner: "harbor",
    harborVersion,
    model: resolvedOptions.model,
    agent: "opencode",
    agentAdapter: HARBOR_AGENT,
    primaryAgent: BENCHMARK_COORDINATOR_AGENT,
    agentTopology: TERMINAL_BENCHMARK_AGENT_TOPOLOGY,
    opencodeVersion: resolvedOptions.opencodeVersion,
    opencodeCommit: runtime.commit,
    opencodeBinarySha256: runtime.binarySha256,
    providerAttemptsPerTurn: 1,
    environment: resolvedOptions.environment,
    taskNames: resolvedOptions.taskNames,
    ...(resolvedOptions.maxTasks !== undefined ? { maxTasks: resolvedOptions.maxTasks } : {}),
    attempts: resolvedOptions.attempts,
    concurrency: resolvedOptions.concurrency,
    maxRetries: resolvedOptions.maxRetries,
    upload: resolvedOptions.upload,
    public: resolvedOptions.public,
    leaderboard: resolvedOptions.leaderboard,
    allTasks: resolvedOptions.maxTasks === undefined,
    command: renderedCommand,
    jobsDir: paths.jobsDir,
    stdoutPath: paths.stdoutPath,
    stderrPath: paths.stderrPath,
    startedAt,
    status: "running",
    runId: resolvedOptions.runId,
    ...(traceRun
      ? {
          traceDir: traceRun.root,
          traceRunId: traceRun.id,
          traceCreatedAt: traceRun.createdAt,
          traceBenchmark: traceRun.benchmark,
        }
      : {}),
  }
  await writeManifest(paths.manifestPath, manifest)

  const finalizeTraces = async () => {
    if (!traceRun) return
    const warning = await collectTerminalBenchTraces({
      run: traceRun,
      jobsDir: paths.jobsDir,
      harborJobName: executionOptions.runId,
      sourceCommit: runtime.commit,
      taskNames: executionOptions.taskNames,
      ...(executionOptions.maxTasks !== undefined ? { maxTasks: executionOptions.maxTasks } : {}),
      attempts: executionOptions.attempts,
    })
    if (warning) console.warn(warning)
  }

  let exitCode: number
  try {
    exitCode = await runStreaming(executionOptions.harborBin, harborArgs, paths, {
      ...process.env,
      HARBOR_TELEMETRY: process.env.HARBOR_TELEMETRY ?? "off",
      PYTHONPATH: [REPO_ROOT, process.env.PYTHONPATH].filter(Boolean).join(":"),
    })
  } catch (error) {
    await finalizeTraces()
    await writeManifest(paths.manifestPath, {
      ...manifest,
      finishedAt: new Date().toISOString(),
      status: "failed",
    })
    throw error
  }

  await finalizeTraces()
  await writeManifest(paths.manifestPath, {
    ...manifest,
    finishedAt: new Date().toISOString(),
    exitCode,
    status: exitCode === 0 ? "completed" : "failed",
  })

  console.log(`\nHarbor artifacts: ${paths.jobsDir}`)
  console.log(`Run manifest: ${paths.manifestPath}`)
  if (traceRun) console.log(`Benchmark traces: ${traceRun.root}`)
  if (exitCode !== 0) throw new Error(`Harbor exited with code ${exitCode}.`)
}

function isRecoverableManifest(value: unknown): value is RunManifest & {
  readonly traceDir: string
  readonly traceRunId: string
  readonly traceCreatedAt: string
  readonly traceBenchmark: "terminal-bench-2.1"
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "schemaVersion" in value &&
    value.schemaVersion === 2 &&
    "benchmark" in value &&
    value.benchmark === "terminal-bench" &&
    "agent" in value &&
    value.agent === "opencode" &&
    "runId" in value &&
    typeof value.runId === "string" &&
    SAFE_RUN_ID.test(value.runId) &&
    "traceDir" in value &&
    typeof value.traceDir === "string" &&
    value.traceDir.length > 0 &&
    "traceRunId" in value &&
    typeof value.traceRunId === "string" &&
    value.traceRunId.startsWith("trace-run-") &&
    "traceCreatedAt" in value &&
    typeof value.traceCreatedAt === "string" &&
    Number.isFinite(Date.parse(value.traceCreatedAt)) &&
    "traceBenchmark" in value &&
    value.traceBenchmark === "terminal-bench-2.1" &&
    "jobsDir" in value &&
    typeof value.jobsDir === "string" &&
    value.jobsDir.length > 0 &&
    "opencodeCommit" in value &&
    typeof value.opencodeCommit === "string" &&
    /^[0-9a-f]{40}$/.test(value.opencodeCommit) &&
    "taskNames" in value &&
    Array.isArray(value.taskNames) &&
    value.taskNames.every((name) => typeof name === "string" && name.length > 0) &&
    "attempts" in value &&
    typeof value.attempts === "number" &&
    Number.isInteger(value.attempts) &&
    value.attempts > 0 &&
    (!("maxTasks" in value) ||
      value.maxTasks === undefined ||
      (typeof value.maxTasks === "number" && Number.isInteger(value.maxTasks) && value.maxTasks > 0))
  )
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
