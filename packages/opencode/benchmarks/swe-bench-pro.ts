/**
 * Benchmark opencode on SWE-bench Pro.
 *
 * The runner treats opencode as a black-box coding agent: each instance gets a
 * clean repository checkout, opencode runs non-interactively in that worktree,
 * and the runner captures `git diff --binary` as the SWE-bench prediction.
 */

import { spawn } from "node:child_process"
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  BENCHMARK_COORDINATOR_AGENT,
  benchmarkAgentWorkflowInstructions,
  installBenchmarkAgentTeam,
} from "./opencode-benchmark-agents.ts"

const DATASET_NAME = "ScaleAI/SWE-bench_Pro"
const DATASET_CONFIG = "default"
const DATASET_SPLIT = "test"
const HUGGING_FACE_ROWS_URL = "https://datasets-server.huggingface.co/rows"
const DEFAULT_RUN_ROOT = ".benchmark-runs/swe-bench-pro"
const DEFAULT_MAX_INSTANCES = 1
const DEFAULT_MAX_WORKERS = 1
const DEFAULT_MODEL = "openrouter/qwen/qwen3-coder-next"
const DEFAULT_AGENT = BENCHMARK_COORDINATOR_AGENT
const DEFAULT_OPENCODE_TIMEOUT_MS = 30 * 60 * 1000
const DEFAULT_DOCKERHUB_USERNAME = "jefzda"
const DATASET_PAGE_SIZE = 100
const DATASET_FETCH_ATTEMPTS = 3
const DATASET_FETCH_RETRY_MS = 1_000
const OPENCODE_PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const REPO_ROOT = resolve(OPENCODE_PACKAGE_ROOT, "../..")
const BUN_EXECUTABLE =
  typeof (process.versions as Record<string, string | undefined>).bun === "string" ? process.execPath : "bun"

type JsonObject = Record<string, unknown>

export interface SweBenchProRow {
  readonly repo: string
  readonly instance_id: string
  readonly base_commit: string
  readonly problem_statement: string
  readonly requirements: string
  readonly interface: string
  readonly repo_language: string
  readonly before_repo_set_cmd: string
  readonly selected_test_files_to_run: string
  readonly fail_to_pass: string
  readonly pass_to_pass: string
  readonly protectedTestPaths: readonly string[]
}

interface CliOptions {
  readonly maxInstances: number
  readonly offset: number
  readonly instanceIds: readonly string[]
  readonly outputDir: string
  readonly runId: string
  readonly resetWorktrees: boolean
  readonly evaluate: boolean
  readonly evaluateOnly: boolean
  readonly maxWorkers: number
  readonly harnessDir?: string
  readonly evaluationInstancesPath?: string
  readonly useLocalDocker: boolean
  readonly dockerPlatform?: string
  readonly dockerhubUsername: string
  readonly blockNetwork: boolean
  readonly redo: boolean
  readonly listInstances: boolean
  readonly predictionsPath?: string
  readonly model: string
  readonly agent: string
  readonly timeoutMs: number
  readonly pure: boolean
  readonly help: boolean
}

interface BenchmarkPaths {
  readonly root: string
  readonly worktrees: string
  readonly runs: string
  readonly predictionsPath: string
  readonly summaryPath: string
  readonly datasetPath: string
  readonly evaluationDatasetPath: string
  readonly evaluationOutput: string
}

interface ProcessResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

interface CapturedPatch {
  readonly patch: string
  readonly changedPaths: readonly string[]
}

interface PredictionStatus {
  readonly agentCompleted: boolean
  readonly predictionProduced: boolean
  readonly generationSucceeded: boolean
}

export interface SweBenchProPrediction {
  readonly instance_id: string
  readonly patch: string
  readonly prefix: string
}

export interface SweBenchProEvaluationConfig {
  readonly evaluatorPath: string
  readonly rawSamplePath: string
  readonly patchPath: string
  readonly outputDir: string
  readonly scriptsDir: string
  readonly maxWorkers: number
  readonly dockerhubUsername: string
  readonly useLocalDocker: boolean
  readonly dockerPlatform?: string
  readonly blockNetwork: boolean
  readonly redo: boolean
}

function usage(): string {
  return [
    "Benchmark opencode on SWE-bench Pro.",
    "",
    "Usage:",
    "  bun run bench:swe-pro -- [flags]",
    "",
    "Flags:",
    "  --max-instances N       Number of instances to run. Default: 1.",
    "  --offset N              Dataset offset for fetched instances.",
    "  --instance-id ID        Specific SWE-bench instance. Repeatable.",
    "  --run-id ID             Output/evaluation run id.",
    "  --output-dir DIR        Output directory. Default: .benchmark-runs/swe-bench-pro.",
    "  --reset-worktrees       Remove existing per-instance worktrees before cloning.",
    "  --evaluate              Invoke the official SWE-bench Pro evaluator after prediction.",
    "  --evaluate-only         Evaluate existing predictions for --run-id and exit.",
    "  --predictions-path PATH Existing Pro predictions JSON array to evaluate.",
    "  --evaluation-instances-path PATH  Evaluator JSONL; defaults to the run artifact.",
    "  --harness-dir DIR       Checkout of scaleapi/SWE-bench_Pro-os.",
    "  --max-workers N         Evaluation workers. Default: 1.",
    "  --use-local-docker      Use the evaluator's local Docker mode instead of Modal.",
    "  --docker-platform NAME  Evaluator Docker platform override, such as linux/amd64.",
    `  --dockerhub-username ID Docker Hub image owner. Default: ${DEFAULT_DOCKERHUB_USERNAME}.`,
    "  --block-network         Block network access inside evaluation containers.",
    "  --redo                  Re-run evaluator outputs that already exist.",
    "  --list-instances        Fetch and print selected instances without running opencode.",
    "  --model MODEL           opencode model in provider/model format.",
    `  --agent AGENT           Primary opencode agent to use. Default: ${DEFAULT_AGENT}.`,
    `  --timeout-ms N          Per-instance opencode timeout. Default: ${DEFAULT_OPENCODE_TIMEOUT_MS}.`,
    "  --no-pure               Do not pass opencode --pure.",
    "  --help                  Print this message.",
    "",
    "Environment:",
    "  OPENCODE_BENCH_MODEL or OPENCODE_MODEL can set the default model.",
    "  OPENROUTER_MODEL is accepted and normalized to openrouter/<model>.",
    "  Provider credentials are read by opencode from its normal config/env,",
    "  for example OPENROUTER_API_KEY or `opencode auth login openrouter`.",
    "  SWE_BENCH_PRO_HARNESS_DIR can set the official evaluator checkout.",
  ].join("\n")
}

function parseArgs(argv: readonly string[]): CliOptions {
  let maxInstances = DEFAULT_MAX_INSTANCES
  let offset = 0
  const instanceIds: string[] = []
  let outputDir = DEFAULT_RUN_ROOT
  let runId = `swe-pro-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`
  let resetWorktrees = false
  let evaluate = false
  let evaluateOnly = false
  let maxWorkers = DEFAULT_MAX_WORKERS
  let harnessDir = process.env.SWE_BENCH_PRO_HARNESS_DIR
  let evaluationInstancesPath: string | undefined
  let useLocalDocker = false
  let dockerPlatform: string | undefined
  let dockerhubUsername = DEFAULT_DOCKERHUB_USERNAME
  let blockNetwork = false
  let redo = false
  let listInstances = false
  let predictionsPath: string | undefined
  let model = resolveDefaultModel()
  let agent = DEFAULT_AGENT
  let timeoutMs = DEFAULT_OPENCODE_TIMEOUT_MS
  let pure = true
  let help = false

  const nextValue = (index: number, flag: string): string => {
    const value = argv[index + 1]
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`)
    return value
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (arg === "--help" || arg === "-h") {
      help = true
    } else if (arg === "--max-instances") {
      maxInstances = parsePositiveInt(nextValue(i, arg), arg)
      i += 1
    } else if (arg === "--offset") {
      offset = parseNonNegativeInt(nextValue(i, arg), arg)
      i += 1
    } else if (arg === "--instance-id") {
      instanceIds.push(nextValue(i, arg))
      i += 1
    } else if (arg === "--output-dir") {
      outputDir = nextValue(i, arg)
      i += 1
    } else if (arg === "--run-id") {
      runId = nextValue(i, arg)
      i += 1
    } else if (arg === "--reset-worktrees") {
      resetWorktrees = true
    } else if (arg === "--evaluate") {
      evaluate = true
    } else if (arg === "--evaluate-only") {
      evaluateOnly = true
    } else if (arg === "--predictions-path") {
      predictionsPath = nextValue(i, arg)
      i += 1
    } else if (arg === "--evaluation-instances-path") {
      evaluationInstancesPath = nextValue(i, arg)
      i += 1
    } else if (arg === "--harness-dir") {
      harnessDir = nextValue(i, arg)
      i += 1
    } else if (arg === "--max-workers") {
      maxWorkers = parsePositiveInt(nextValue(i, arg), arg)
      i += 1
    } else if (arg === "--use-local-docker") {
      useLocalDocker = true
    } else if (arg === "--docker-platform") {
      dockerPlatform = nextValue(i, arg)
      i += 1
    } else if (arg === "--dockerhub-username") {
      dockerhubUsername = nextValue(i, arg)
      i += 1
    } else if (arg === "--block-network") {
      blockNetwork = true
    } else if (arg === "--redo") {
      redo = true
    } else if (arg === "--list-instances") {
      listInstances = true
    } else if (arg === "--model") {
      model = nextValue(i, arg)
      i += 1
    } else if (arg === "--agent") {
      agent = nextValue(i, arg)
      i += 1
    } else if (arg === "--timeout-ms") {
      timeoutMs = parsePositiveInt(nextValue(i, arg), arg)
      i += 1
    } else if (arg === "--no-pure") {
      pure = false
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return {
    maxInstances,
    offset,
    instanceIds,
    outputDir,
    runId,
    resetWorktrees,
    evaluate,
    evaluateOnly,
    maxWorkers,
    ...(harnessDir !== undefined ? { harnessDir: resolvePathFromRepoRoot(harnessDir) } : {}),
    ...(evaluationInstancesPath !== undefined ? { evaluationInstancesPath } : {}),
    useLocalDocker,
    ...(dockerPlatform !== undefined ? { dockerPlatform } : {}),
    dockerhubUsername,
    blockNetwork,
    redo,
    listInstances,
    ...(predictionsPath !== undefined ? { predictionsPath } : {}),
    model,
    agent,
    timeoutMs,
    pure,
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

function resolveDefaultModel(): string {
  if (process.env.OPENCODE_BENCH_MODEL) return process.env.OPENCODE_BENCH_MODEL
  if (process.env.OPENCODE_MODEL) return process.env.OPENCODE_MODEL
  if (process.env.OPENROUTER_MODEL) {
    return process.env.OPENROUTER_MODEL.startsWith("openrouter/")
      ? process.env.OPENROUTER_MODEL
      : `openrouter/${process.env.OPENROUTER_MODEL}`
  }
  return DEFAULT_MODEL
}

function predictionPrefix(options: Pick<CliOptions, "runId">): string {
  return options.runId.replaceAll(/[^A-Za-z0-9._-]/g, "_")
}

function buildPaths(options: CliOptions): BenchmarkPaths {
  const root =
    options.outputDir === DEFAULT_RUN_ROOT
      ? resolve(REPO_ROOT, DEFAULT_RUN_ROOT)
      : resolvePathFromRepoRoot(options.outputDir)
  const runs = join(root, "runs", options.runId)
  const predictionsPath =
    options.predictionsPath === undefined
      ? join(runs, "predictions.json")
      : resolvePathFromRepoRoot(options.predictionsPath)
  const evaluationDatasetPath =
    options.evaluationInstancesPath === undefined
      ? join(runs, "evaluation-instances.jsonl")
      : resolvePathFromRepoRoot(options.evaluationInstancesPath)
  return {
    root,
    worktrees: join(root, "worktrees"),
    runs,
    predictionsPath,
    summaryPath: join(runs, "summary.json"),
    datasetPath: join(runs, "instances.jsonl"),
    evaluationDatasetPath,
    evaluationOutput: join(runs, "evaluation"),
  }
}

function resolvePathFromRepoRoot(path: string): string {
  return resolve(isAbsolute(path) ? path : join(REPO_ROOT, path))
}

async function fetchSweBenchProRows(options: CliOptions): Promise<readonly SweBenchProRow[]> {
  if (options.instanceIds.length > 0) return fetchSpecificRows(options.instanceIds)
  const rows = await fetchRowsPage(options.offset, options.maxInstances)
  return rows.slice(0, options.maxInstances)
}

async function fetchSpecificRows(instanceIds: readonly string[]): Promise<readonly SweBenchProRow[]> {
  const wanted = new Set(instanceIds)
  const found = new Map<string, SweBenchProRow>()

  for (let offset = 0; found.size < wanted.size; offset += DATASET_PAGE_SIZE) {
    const rows = await fetchRowsPage(offset, DATASET_PAGE_SIZE)
    if (rows.length === 0) break
    for (const row of rows) {
      if (wanted.has(row.instance_id)) found.set(row.instance_id, row)
    }
  }

  const missing = instanceIds.filter((id) => !found.has(id))
  if (missing.length > 0) throw new Error(`Could not find SWE-bench instance(s): ${missing.join(", ")}`)
  return instanceIds.map((id) => found.get(id)!)
}

async function fetchRowsPage(offset: number, length: number): Promise<readonly SweBenchProRow[]> {
  const url = new URL(HUGGING_FACE_ROWS_URL)
  url.searchParams.set("dataset", DATASET_NAME)
  url.searchParams.set("config", DATASET_CONFIG)
  url.searchParams.set("split", DATASET_SPLIT)
  url.searchParams.set("offset", String(offset))
  url.searchParams.set("length", String(length))

  for (let attempt = 1; attempt <= DATASET_FETCH_ATTEMPTS; attempt += 1) {
    let response: Response
    try {
      response = await fetch(url)
    } catch (error) {
      if (attempt === DATASET_FETCH_ATTEMPTS) throw error
      await delay(DATASET_FETCH_RETRY_MS * attempt)
      continue
    }

    if (response.ok) {
      const parsed = (await response.json()) as { rows?: Array<{ row?: unknown }> }
      return (parsed.rows ?? []).map((item) => parseSweBenchProRow(item.row))
    }

    const message = `Failed to fetch SWE-bench Pro rows (${response.status}): ${await response.text()}`
    const retryable = response.status === 429 || response.status >= 500
    if (!retryable || attempt === DATASET_FETCH_ATTEMPTS) throw new Error(message)
    await delay(DATASET_FETCH_RETRY_MS * attempt)
  }

  throw new Error("SWE-bench Pro dataset fetch exhausted without a response.")
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

export function parseSweBenchProRow(value: unknown): SweBenchProRow {
  const row = value as Partial<Record<keyof SweBenchProRow | "test_patch", unknown>>
  const required = [
    "repo",
    "instance_id",
    "base_commit",
    "problem_statement",
    "requirements",
    "interface",
    "repo_language",
    "before_repo_set_cmd",
    "selected_test_files_to_run",
    "fail_to_pass",
    "pass_to_pass",
    "test_patch",
  ] as const
  for (const key of required) {
    if (typeof row[key] !== "string") throw new Error(`SWE-bench Pro row is missing string field "${key}".`)
  }
  return {
    repo: row.repo as string,
    instance_id: row.instance_id as string,
    base_commit: row.base_commit as string,
    problem_statement: row.problem_statement as string,
    requirements: row.requirements as string,
    interface: row.interface as string,
    repo_language: row.repo_language as string,
    before_repo_set_cmd: row.before_repo_set_cmd as string,
    selected_test_files_to_run: row.selected_test_files_to_run as string,
    fail_to_pass: row.fail_to_pass as string,
    pass_to_pass: row.pass_to_pass as string,
    protectedTestPaths: parseUnifiedDiffPaths(row.test_patch as string),
  }
}

export function parseUnifiedDiffPaths(patch: string): readonly string[] {
  const paths = new Set<string>()
  let inFileHeader = false

  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      inFileHeader = true
      continue
    }
    if (!inFileHeader) continue
    if (line.startsWith("@@") || line.startsWith("GIT binary patch")) {
      inFileHeader = false
      continue
    }
    if (!line.startsWith("--- ") && !line.startsWith("+++ ")) continue

    const path = decodePatchPath(line.slice(4))
    if (path) paths.add(path)
  }

  return [...paths].sort()
}

function decodePatchPath(value: string): string | undefined {
  const raw = value.split("\t", 1)[0]!.trim()
  if (raw === "/dev/null") return undefined

  let decoded = raw
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try {
      decoded = JSON.parse(raw) as string
    } catch {
      decoded = raw.slice(1, -1)
    }
  }
  if (decoded.startsWith("a/") || decoded.startsWith("b/")) return decoded.slice(2)
  return decoded
}

export function findProtectedPathOverlap(
  changedPaths: readonly string[],
  protectedPaths: readonly string[],
): readonly string[] {
  const protectedPathSet = new Set(protectedPaths)
  return [...new Set(changedPaths.filter((path) => protectedPathSet.has(path)))].sort()
}

function datasetArtifactRow(row: SweBenchProRow): JsonObject {
  return {
    repo: row.repo,
    instance_id: row.instance_id,
    base_commit: row.base_commit,
    problem_statement: row.problem_statement,
    requirements: row.requirements,
    interface: row.interface,
    repo_language: row.repo_language,
  }
}

export function formatProblemStatement(
  row: Pick<SweBenchProRow, "problem_statement" | "requirements" | "interface">,
): string {
  return `${row.problem_statement}\n\nRequirements:\n${row.requirements}\n\nNew interfaces introduced:\n${row.interface}`
}

function evaluationArtifactRow(row: SweBenchProRow): JsonObject {
  return {
    repo: row.repo,
    instance_id: row.instance_id,
    base_commit: row.base_commit,
    before_repo_set_cmd: row.before_repo_set_cmd,
    selected_test_files_to_run: row.selected_test_files_to_run,
    fail_to_pass: row.fail_to_pass,
    pass_to_pass: row.pass_to_pass,
  }
}

async function prepareWorktree(row: SweBenchProRow, paths: BenchmarkPaths, reset: boolean): Promise<string> {
  const worktree = join(paths.worktrees, row.instance_id)
  if (reset) await rm(worktree, { recursive: true, force: true })

  if (!(await gitRepoExists(worktree))) {
    await mkdir(dirname(worktree), { recursive: true })
    await runHostCommand("git", [
      "clone",
      "--quiet",
      "--filter=blob:none",
      `https://github.com/${row.repo}.git`,
      worktree,
    ])
  }

  await runHostCommand("git", ["-C", worktree, "fetch", "--quiet", "origin", row.base_commit])
  await runHostCommand("git", ["-C", worktree, "checkout", "--quiet", row.base_commit])
  await runHostCommand("git", ["-C", worktree, "reset", "--hard", "--quiet", row.base_commit])
  await runHostCommand("git", ["-C", worktree, "clean", "-fdxq"])
  return worktree
}

async function gitRepoExists(path: string): Promise<boolean> {
  try {
    await runHostCommand("git", ["-C", path, "rev-parse", "--is-inside-work-tree"])
    return true
  } catch {
    return false
  }
}

function buildPrompt(row: SweBenchProRow, worktree: string): string {
  return [
    "Resolve this SWE-bench Pro issue using opencode.",
    "",
    "You are running inside the checked-out repository worktree.",
    "Edit the repository files directly; do not merely describe a patch.",
    "Do not use the gold patch, test patch, or hidden benchmark tests.",
    "Do not modify tests or benchmark metadata unless the issue explicitly requires it.",
    "",
    benchmarkAgentWorkflowInstructions(),
    "## Repository",
    `Worktree: ${worktree}`,
    `Repo: ${row.repo}`,
    `Base commit: ${row.base_commit}`,
    `Instance id: ${row.instance_id}`,
    `Repository language: ${row.repo_language}`,
    "",
    "## Issue",
    formatProblemStatement(row),
    "",
    "## Completion requirements",
    "- Leave the final source changes in the worktree.",
    "- Run relevant lightweight verification when feasible.",
    "- Inspect the final diff before answering.",
    "- Final response should summarize changed files, verification commands, and residual risk.",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n")
}

async function runInstance(row: SweBenchProRow, options: CliOptions, paths: BenchmarkPaths): Promise<JsonObject> {
  const worktree = await prepareWorktree(row, paths, options.resetWorktrees)
  const instanceRunDir = join(paths.runs, row.instance_id)
  await rm(instanceRunDir, { recursive: true, force: true })
  await mkdir(instanceRunDir, { recursive: true })
  await installBenchmarkAgentTeam(worktree)

  const prompt = buildPrompt(row, worktree)
  const startedAt = new Date().toISOString()
  const result = await runOpencode(prompt, row, worktree, options)
  const completedAt = new Date().toISOString()
  const captured = await capturePatch(worktree)
  const protectedPathOverlap = findProtectedPathOverlap(captured.changedPaths, row.protectedTestPaths)
  const integrityViolations = protectedPathOverlap.map(
    (path) => `Model patch overlaps a file supplied by the SWE-bench Pro test patch: ${path}`,
  )
  const patch = integrityViolations.length === 0 ? captured.patch : ""
  const status = assessPrediction(result.exitCode, patch)
  const events = parseJsonl(result.stdout)
  const prediction = {
    instance_id: row.instance_id,
    patch,
    prefix: predictionPrefix(options),
  }

  await writeFile(join(instanceRunDir, "prompt.txt"), prompt, "utf8")
  await writeFile(join(instanceRunDir, "opencode.stdout.jsonl"), result.stdout, "utf8")
  await writeFile(join(instanceRunDir, "opencode.stderr.txt"), result.stderr, "utf8")
  if (integrityViolations.length > 0) {
    await writeFile(join(instanceRunDir, "rejected.patch.diff"), captured.patch, "utf8")
  }
  await writeFile(join(instanceRunDir, "prediction.json"), `${JSON.stringify(prediction, null, 2)}\n`, "utf8")
  await writeFile(
    join(instanceRunDir, "run.json"),
    `${JSON.stringify(
      {
        instanceId: row.instance_id,
        repo: row.repo,
        worktree,
        startedAt,
        completedAt,
        model: options.model,
        agent: options.agent,
        subagentExecution: "foreground",
        exitCode: result.exitCode,
        ...status,
        patchBytes: Buffer.byteLength(patch, "utf8"),
        capturedPatchBytes: Buffer.byteLength(captured.patch, "utf8"),
        changedPaths: captured.changedPaths,
        integrityViolations,
        events,
      },
      null,
      2,
    )}\n`,
    "utf8",
  )

  return {
    instanceId: row.instance_id,
    repo: row.repo,
    worktree,
    startedAt,
    completedAt,
    ...status,
    exitCode: result.exitCode,
    patchBytes: Buffer.byteLength(patch, "utf8"),
    predictionPath: join(instanceRunDir, "prediction.json"),
    runPath: join(instanceRunDir, "run.json"),
  }
}

async function runOpencode(
  prompt: string,
  row: SweBenchProRow,
  worktree: string,
  options: CliOptions,
): Promise<ProcessResult> {
  const args = [
    "run",
    "--conditions=browser",
    "src/index.ts",
    ...(options.pure ? ["--pure"] : []),
    "run",
    "--format",
    "json",
    "--dir",
    worktree,
    "--agent",
    options.agent,
    "--model",
    options.model,
    "--title",
    `SWE-bench Pro ${row.instance_id}`,
    "--dangerously-skip-permissions",
  ]

  console.log(`Running opencode for ${row.instance_id}: bun ${args.join(" ")} <prompt-stdin>`)
  return runProcess(BUN_EXECUTABLE, args, {
    cwd: OPENCODE_PACKAGE_ROOT,
    timeoutMs: options.timeoutMs,
    env: opencodeEnv(process.env),
    stdin: prompt,
  })
}

export function assessPrediction(exitCode: number, patch: string): PredictionStatus {
  const agentCompleted = exitCode === 0
  const predictionProduced = patch.trim().length > 0
  return {
    agentCompleted,
    predictionProduced,
    generationSucceeded: agentCompleted && predictionProduced,
  }
}

export async function capturePatch(worktree: string): Promise<CapturedPatch> {
  await runHostCommand("git", ["-C", worktree, "add", "-A", "--", ".", ":!.opencode"])
  const [patch, names] = await Promise.all([
    runHostCommand("git", ["-C", worktree, "diff", "--cached", "--binary", "--", ".", ":!.opencode"]),
    runHostCommand("git", ["-C", worktree, "diff", "--cached", "--name-only", "-z", "--", ".", ":!.opencode"]),
  ])
  return {
    patch: patch.stdout,
    changedPaths: names.stdout.split("\0").filter((path) => path.length > 0),
  }
}

function parseJsonl(text: string): readonly JsonObject[] {
  const rows: JsonObject[] = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed)
      if (isObject(parsed)) rows.push(parsed)
    } catch {
      rows.push({ type: "unparsed_stdout_line", text: trimmed })
    }
  }
  return rows
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function writeJsonl(path: string, rows: readonly unknown[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8")
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

export function parseSweBenchProPredictions(value: unknown): readonly SweBenchProPrediction[] {
  if (!Array.isArray(value)) throw new Error("SWE-bench Pro predictions must be a JSON array.")
  if (value.length === 0) throw new Error("SWE-bench Pro predictions must contain at least one row.")

  const instanceIds = new Set<string>()
  return value.map((candidate, index) => {
    if (!isObject(candidate)) throw new Error(`Prediction row ${index + 1} must be an object.`)
    for (const field of ["instance_id", "patch", "prefix"] as const) {
      if (typeof candidate[field] !== "string") {
        throw new Error(`Prediction row ${index + 1} is missing string field "${field}".`)
      }
    }
    const prediction = candidate as unknown as SweBenchProPrediction
    if (prediction.instance_id.length === 0) {
      throw new Error(`Prediction row ${index + 1} has an empty "instance_id".`)
    }
    if (instanceIds.has(prediction.instance_id)) {
      throw new Error(`Duplicate prediction for instance "${prediction.instance_id}".`)
    }
    instanceIds.add(prediction.instance_id)
    return prediction
  })
}

async function readPredictions(predictionsPath: string): Promise<readonly SweBenchProPrediction[]> {
  return parseSweBenchProPredictions(JSON.parse(await readFile(predictionsPath, "utf8")) as unknown)
}

export function buildEvaluationArgs(config: SweBenchProEvaluationConfig): readonly string[] {
  const args = [
    config.evaluatorPath,
    `--raw_sample_path=${config.rawSamplePath}`,
    `--patch_path=${config.patchPath}`,
    `--output_dir=${config.outputDir}`,
    `--scripts_dir=${config.scriptsDir}`,
    `--num_workers=${config.maxWorkers}`,
    `--dockerhub_username=${config.dockerhubUsername}`,
  ]
  if (config.useLocalDocker) args.push("--use_local_docker")
  if (config.dockerPlatform) args.push(`--docker_platform=${config.dockerPlatform}`)
  if (config.blockNetwork) args.push("--block_network")
  if (config.redo) args.push("--redo")
  return args
}

async function runEvaluation(options: CliOptions, paths: BenchmarkPaths): Promise<void> {
  const harnessDir = options.harnessDir
  if (!harnessDir) {
    throw new Error("SWE-bench Pro evaluation requires --harness-dir or SWE_BENCH_PRO_HARNESS_DIR.")
  }
  const evaluator = join(harnessDir, "swe_bench_pro_eval.py")
  const scriptsDir = join(harnessDir, "run_scripts")
  const baseDockerfilesDir = join(harnessDir, "dockerfiles", "base_dockerfile")
  const instanceDockerfilesDir = join(harnessDir, "dockerfiles", "instance_dockerfile")
  await Promise.all([
    access(evaluator),
    access(scriptsDir),
    access(baseDockerfilesDir),
    access(instanceDockerfilesDir),
    access(paths.predictionsPath),
    access(paths.evaluationDatasetPath),
  ])
  await mkdir(paths.evaluationOutput, { recursive: true })

  const args = buildEvaluationArgs({
    evaluatorPath: evaluator,
    rawSamplePath: paths.evaluationDatasetPath,
    patchPath: paths.predictionsPath,
    outputDir: paths.evaluationOutput,
    scriptsDir,
    maxWorkers: options.maxWorkers,
    dockerhubUsername: options.dockerhubUsername,
    useLocalDocker: options.useLocalDocker,
    ...(options.dockerPlatform !== undefined ? { dockerPlatform: options.dockerPlatform } : {}),
    blockNetwork: options.blockNetwork,
    redo: options.redo,
  })

  console.log(`Running SWE-bench Pro evaluation: python ${args.join(" ")}`)
  await runHostCommand("python", args, { cwd: harnessDir })
}

async function validatePredictionFile(predictionsPath: string): Promise<void> {
  await readPredictions(predictionsPath)
}

async function runEvaluationOnly(options: CliOptions, paths: BenchmarkPaths): Promise<void> {
  await validatePredictionFile(paths.predictionsPath)
  console.log(`Evaluating existing SWE-bench Pro predictions: ${paths.predictionsPath}`)
  await runEvaluation(options, paths)
}

function predictionHasPatch(prediction: JsonObject): boolean {
  return typeof prediction.patch === "string" && prediction.patch.trim().length > 0
}

function predictionForFailure(row: SweBenchProRow, options: CliOptions): JsonObject {
  return {
    instance_id: row.instance_id,
    patch: "",
    prefix: predictionPrefix(options),
  }
}

function evaluatorDatasetNotice(paths: BenchmarkPaths): string {
  return `Wrote evaluator instances: ${paths.evaluationDatasetPath}`
}

async function runHostCommand(
  command: string,
  args: readonly string[],
  options: { cwd?: string } = {},
): Promise<ProcessResult> {
  const result = await runProcess(command, args, {
    cwd: options.cwd ?? process.cwd(),
    timeoutMs: 0,
    env: hostEnv(process.env),
  })
  if (result.exitCode !== 0) {
    throw new Error(`Command failed (${command} ${args.join(" ")}):\n${result.stderr || result.stdout}`)
  }
  return result
}

function runProcess(
  command: string,
  args: readonly string[],
  options: { cwd: string; timeoutMs: number; env: Record<string, string | undefined>; stdin?: string },
): Promise<ProcessResult> {
  return new Promise((resolveProcess) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      detached: process.platform !== "win32",
      env: options.env,
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let settled = false
    let timedOut = false
    const childStdout = child.stdout
    const childStderr = child.stderr

    const finish = (exitCode: number): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolveProcess({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode,
      })
    }

    const timer =
      options.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true
            killProcessTree(child)
          }, options.timeoutMs)
        : undefined

    childStdout?.on("data", (chunk: Buffer) => stdout.push(chunk))
    childStderr?.on("data", (chunk: Buffer) => stderr.push(chunk))
    child.stdin?.on("error", () => {
      // The child may exit before reading stdin if argument validation fails.
    })
    if (options.stdin !== undefined) {
      child.stdin?.end(options.stdin)
    }
    child.on("error", (error) => {
      stderr.push(Buffer.from(error.message))
      finish(127)
    })
    child.on("close", (code) => finish(code ?? (timedOut ? 124 : 1)))
  })
}

function killProcessTree(child: ReturnType<typeof spawn>): void {
  if (child.pid === undefined) return
  try {
    if (process.platform === "win32") child.kill("SIGKILL")
    else process.kill(-child.pid, "SIGKILL")
  } catch {
    try {
      child.kill("SIGKILL")
    } catch {
      // Process already exited.
    }
  }
}

function hostEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const keep = [
    "HOME",
    "LANG",
    "LC_ALL",
    "LOGNAME",
    "PATH",
    "SHELL",
    "TEMP",
    "TERM",
    "TMP",
    "TMPDIR",
    "USER",
    "DOCKER_CONTEXT",
    "DOCKER_HOST",
    "MODAL_TOKEN_ID",
    "MODAL_TOKEN_SECRET",
  ]
  const out: Record<string, string | undefined> = {}
  for (const key of keep) {
    if (env[key] !== undefined) out[key] = env[key]
  }
  return out
}

function opencodeEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const stableEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("OPENCODE_EXPERIMENTAL")))
  return {
    ...stableEnv,
    NO_COLOR: env.NO_COLOR ?? "1",
    OPENCODE_PRINT_LOGS: env.OPENCODE_PRINT_LOGS ?? "0",
  }
}

async function recordInstanceFailure(
  row: SweBenchProRow,
  options: CliOptions,
  paths: BenchmarkPaths,
  error: unknown,
): Promise<JsonObject> {
  const instanceRunDir = join(paths.runs, row.instance_id)
  const completedAt = new Date().toISOString()
  const message = error instanceof Error ? error.message : String(error)
  const prediction = predictionForFailure(row, options)
  const summary = {
    instanceId: row.instance_id,
    repo: row.repo,
    completedAt,
    agentCompleted: false,
    predictionProduced: false,
    generationSucceeded: false,
    exitCode: null,
    patchBytes: 0,
    error: message,
    predictionPath: join(instanceRunDir, "prediction.json"),
    runPath: join(instanceRunDir, "run.json"),
  }

  await rm(instanceRunDir, { recursive: true, force: true })
  await mkdir(instanceRunDir, { recursive: true })
  await writeFile(join(instanceRunDir, "prediction.json"), `${JSON.stringify(prediction, null, 2)}\n`, "utf8")
  await writeFile(join(instanceRunDir, "run.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8")
  return summary
}

async function writeRunProgress(
  options: CliOptions,
  paths: BenchmarkPaths,
  selectedCount: number,
  summaries: readonly JsonObject[],
  predictions: readonly JsonObject[],
  complete: boolean,
): Promise<void> {
  await writeJson(paths.predictionsPath, predictions)
  await writeFile(
    paths.summaryPath,
    `${JSON.stringify(
      {
        runId: options.runId,
        dataset: DATASET_NAME,
        datasetConfig: DATASET_CONFIG,
        datasetSplit: DATASET_SPLIT,
        model: options.model,
        agent: options.agent,
        subagentExecution: "foreground",
        selectedCount,
        completedCount: summaries.length,
        generationSucceededCount: summaries.filter((summary) => summary.generationSucceeded === true).length,
        predictionCount: predictions.filter(predictionHasPatch).length,
        complete,
        predictionsPath: paths.predictionsPath,
        selectedInstancesPath: paths.datasetPath,
        evaluationInstancesPath: paths.evaluationDatasetPath,
        evaluationOutput: paths.evaluationOutput,
        summaries,
      },
      null,
      2,
    )}\n`,
    "utf8",
  )
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(usage())
    return
  }

  const paths = buildPaths(options)
  await mkdir(paths.runs, { recursive: true })
  await mkdir(paths.worktrees, { recursive: true })

  if (options.evaluateOnly) {
    await runEvaluationOnly(options, paths)
    return
  }

  console.log(`Fetching ${DATASET_NAME} instances...`)
  const rows = await fetchSweBenchProRows(options)
  await writeJsonl(paths.datasetPath, rows.map(datasetArtifactRow))
  await writeJsonl(paths.evaluationDatasetPath, rows.map(evaluationArtifactRow))
  if (options.listInstances) {
    for (const row of rows) console.log(`${row.instance_id}\t${row.repo}\t${row.repo_language}`)
    console.log(`Wrote selected instances: ${paths.datasetPath}`)
    console.log(evaluatorDatasetNotice(paths))
    return
  }

  const summaries: JsonObject[] = []
  const predictions: JsonObject[] = []
  for (const row of rows) {
    console.log(`\n=== ${row.instance_id} (${row.repo}) ===`)
    let summary: JsonObject
    try {
      summary = await runInstance(row, options, paths)
    } catch (error) {
      console.error(`Instance ${row.instance_id} failed: ${error instanceof Error ? error.message : error}`)
      summary = await recordInstanceFailure(row, options, paths, error)
    }
    summaries.push(summary)
    const prediction = JSON.parse(await readFile(String(summary.predictionPath), "utf8")) as JsonObject
    predictions.push(prediction)
    await writeRunProgress(options, paths, rows.length, summaries, predictions, false)
  }

  await writeRunProgress(options, paths, rows.length, summaries, predictions, true)

  console.log(`\nWrote predictions: ${paths.predictionsPath}`)
  console.log(`Wrote summary: ${paths.summaryPath}`)

  if (options.evaluate) {
    await runEvaluation(options, paths)
  } else {
    console.log("Evaluation skipped. Re-run with --evaluate and an official SWE-bench Pro harness checkout.")
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
