/**
 * Run opencode on SWE-bench Verified.
 *
 * Inference and evaluation are intentionally separate:
 * - inference runs opencode inside the official per-instance SWE-bench image;
 * - evaluation consumes the immutable predictions artifact with the official
 *   SWE-bench Docker harness on a Docker-capable machine.
 */

import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { StringDecoder } from "node:string_decoder"
import { fileURLToPath } from "node:url"
import {
  BENCHMARK_COORDINATOR_AGENT,
  benchmarkAgentWorkflowInstructions,
  installBenchmarkAgentTeam,
} from "./opencode-benchmark-agents.ts"
import {
  runEvaluationOrchestrator,
  type EvaluationAttempt,
  type EvaluationCompletion,
  type InfrastructureRetry,
} from "./evaluation-orchestrator.ts"
import { benchmarkSourceIdentity, ensureBenchmarkRuntime, type BenchmarkRuntime } from "./opencode-runtime.ts"
import { DirectTraceHarness, createTraceRun, finalizeTraceRun, type TraceRun } from "./tracing/coordination.ts"
import { createOpenCodeAttemptTrace, finishOpenCodeTrace, traceStatus } from "./tracing/integration.ts"

const DATASET_NAME = "princeton-nlp/SWE-bench_Verified"
const DATASET_CONFIG = "default"
const DATASET_SPLIT = "test"
const HUGGING_FACE_ROWS_URL = "https://datasets-server.huggingface.co/rows"
const DEFAULT_RUN_ROOT = ".benchmark-runs/swe-bench-verified"
const DEFAULT_SMOKE_INSTANCE_ID = "scikit-learn__scikit-learn-13439"
const DEFAULT_MAX_INSTANCES = 1
const DEFAULT_MAX_WORKERS = 1
const DEFAULT_EVALUATION_TIMEOUT_SECONDS = 60 * 60
const DEFAULT_INFERENCE_WORKERS = 1
const DEFAULT_MAX_INFRASTRUCTURE_RETRIES = 0
const DEFAULT_RETRY_BASE_DELAY_MS = 2_000
const MAX_INFRASTRUCTURE_RETRIES = 10
const DEFAULT_MODEL = "openrouter/qwen/qwen3-coder-next"
const DEFAULT_AGENT = BENCHMARK_COORDINATOR_AGENT
const DEFAULT_OPENCODE_TIMEOUT_MS = 30 * 60 * 1000
const DEFAULT_SETUP_TIMEOUT_MS = 10 * 60 * 1000
const DEFAULT_DOCKER_COMMAND_TIMEOUT_MS = 60_000
const DEFAULT_DOCKER_PLATFORM = "linux/amd64"
const DEFAULT_IMAGE_TEMPLATE = "docker.io/swebench/sweb.eval.x86_64.{repo}_1776_{name}:latest"
const RECOMMENDED_SWEBENCH_VERSION = "4.1.0"
const CONTAINER_WORKDIR = "/testbed"
const DATASET_PAGE_SIZE = 100
const DATASET_FETCH_ATTEMPTS = 3
const DATASET_FETCH_RETRY_MS = 1_000
const MANIFEST_SCHEMA_VERSION = 3
const OPENCODE_PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const REPO_ROOT = resolve(OPENCODE_PACKAGE_ROOT, "../..")
const DEFAULT_TRACE_ROOT = resolve(REPO_ROOT, ".benchmark-traces")
const PACKAGE_JSON_PATH = join(OPENCODE_PACKAGE_ROOT, "package.json")
const PROVIDER_ENV_KEYS = [
  "OPENROUTER_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "XAI_API_KEY",
  "CEREBRAS_API_KEY",
] as const

type JsonObject = Record<string, unknown>

interface SweBenchRow {
  readonly repo: string
  readonly instance_id: string
  readonly base_commit: string
  readonly problem_statement: string
  readonly hints_text?: string
  readonly difficulty?: string
}

interface CliOptions {
  readonly maxInstances: number
  readonly offset: number
  readonly instanceIds: readonly string[]
  readonly outputDir: string
  readonly runId: string
  readonly includeHints: boolean
  readonly evaluateOnly: boolean
  readonly maxWorkers: number
  readonly evaluationTimeoutSeconds: number
  readonly inferenceWorkers: number
  readonly maxInfrastructureRetries: number
  readonly retryBaseDelayMs: number
  readonly namespaceEmpty: boolean
  readonly listInstances: boolean
  readonly predictionsPath?: string
  readonly manifestPath?: string
  readonly model: string
  readonly agent: string
  readonly timeoutMs: number
  readonly setupTimeoutMs: number
  readonly opencodeVersion: string
  readonly runtime?: BenchmarkRuntime
  readonly dockerPlatform: string
  readonly imageTemplate: string
  readonly keepFailedContainers: boolean
  readonly restart: boolean
  readonly pure: boolean
  readonly pythonExecutable: string
  readonly traceDir?: string
  readonly traceRun?: TraceRun
  readonly dryRun: boolean
  readonly help: boolean
}

interface BenchmarkPaths {
  readonly root: string
  readonly runs: string
  readonly predictionsPath: string
  readonly manifestPath: string
  readonly summaryPath: string
  readonly datasetPath: string
  readonly evaluationManifestPath: string
}

interface ProcessResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
  readonly timedOut: boolean
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

interface InstanceOutcome {
  readonly summary: JsonObject
  readonly prediction: SweBenchPrediction
  readonly infrastructureRetry?: InfrastructureRetry
}

interface ExistingProgress {
  readonly summaries: readonly JsonObject[]
  readonly predictions: readonly SweBenchPrediction[]
  readonly initialAttempts: ReadonlyMap<string, number>
}

export interface PredictionManifest {
  readonly schemaVersion: number
  readonly benchmark: "swe-bench-verified"
  readonly dataset: string
  readonly datasetConfig: string
  readonly datasetSplit: string
  readonly runId: string
  readonly model: string
  readonly agent: string
  readonly opencodeVersion: string
  readonly opencodeCommit: string
  readonly opencodeBinarySha256: string
  readonly providerAttemptsPerTurn: number
  readonly inferenceRuntime: "official-swebench-instance-image"
  readonly imageTemplate: string
  readonly dockerPlatform: string
  readonly includeHints: boolean
  readonly inferenceWorkers: number
  readonly maxInfrastructureRetries: number
  readonly retryBaseDelayMs: number
  readonly selectedInstances: readonly {
    readonly instanceId: string
    readonly repo: string
    readonly baseCommit: string
    readonly image: string
  }[]
  readonly completedInstanceIds: readonly string[]
  readonly complete: boolean
  readonly predictionCount: number
  readonly nonEmptyPatchCount: number
  readonly predictionsSha256: string
  readonly generatedAt: string
}

export interface SweBenchPrediction {
  readonly instance_id: string
  readonly model_name_or_path: string
  readonly model_patch: string
}

export interface SweBenchEvaluationConfig {
  readonly datasetName: string
  readonly predictionsPath: string
  readonly maxWorkers: number
  readonly timeoutSeconds: number
  readonly runId: string
  readonly instanceIds: readonly string[]
  readonly namespaceEmpty: boolean
}

function usage(): string {
  return [
    "Run opencode on SWE-bench Verified.",
    "",
    "Inference:",
    "  bun run bench:swe-verified:infer -- [flags]",
    "",
    "Official Docker evaluation:",
    "  bun run bench:swe-verified:eval -- --run-id ID [flags]",
    "",
    "Flags:",
    `  --max-instances N          Dataset-window size; overrides the default smoke instance. Default: ${DEFAULT_MAX_INSTANCES}.`,
    "  --offset N                 Dataset offset; overrides the default smoke instance.",
    `  --instance-id ID           Specific instance; repeatable. Inference default: ${DEFAULT_SMOKE_INSTANCE_ID}.`,
    "  --run-id ID                Stable inference/evaluation run id.",
    "  --output-dir DIR           Output directory. Default: .benchmark-runs/swe-bench-verified.",
    "  --include-hints            Include public hints_text in the opencode prompt.",
    "  --evaluate-only            Evaluate a completed predictions artifact and exit.",
    "  --predictions-path PATH    Existing predictions JSONL to evaluate.",
    "  --manifest-path PATH       Matching prediction manifest for external predictions.",
    "  --max-workers N            Official evaluation workers. Default: 1.",
    `  --evaluation-timeout-seconds N  Official per-test timeout. Default: ${DEFAULT_EVALUATION_TIMEOUT_SECONDS}.`,
    "  --inference-workers N      Concurrent inference instances. Default: 1.",
    `  --max-infrastructure-retries N  Fresh retries for transient infrastructure failures. Default: ${DEFAULT_MAX_INFRASTRUCTURE_RETRIES}; max: ${MAX_INFRASTRUCTURE_RETRIES}.`,
    `  --retry-base-delay-ms N    Exponential retry base delay. Default: ${DEFAULT_RETRY_BASE_DELAY_MS}.`,
    '  --namespace-empty          Pass --namespace "" to the official harness.',
    "  --list-instances           Print selected instances without running inference.",
    "  --model MODEL              opencode model in provider/model format.",
    `  --agent AGENT              Primary opencode agent. Default: ${DEFAULT_AGENT}.`,
    `  --timeout-ms N             Per-instance agent timeout. Default: ${DEFAULT_OPENCODE_TIMEOUT_MS}.`,
    `  --setup-timeout-ms N       Per-instance runtime setup timeout. Default: ${DEFAULT_SETUP_TIMEOUT_MS}.`,
    "  The agent runtime is built from the exact clean opencode checkout and cached by commit.",
    `  --docker-platform VALUE    Inference image platform. Default: ${DEFAULT_DOCKER_PLATFORM}.`,
    "  --image-template VALUE     Official image template override.",
    "  --keep-failed-containers   Keep failed inference containers for debugging.",
    "  --restart                  Replace existing artifacts for this run id.",
    "  --no-pure                  Allow external opencode plugins.",
    "  --python PATH              Python executable for official evaluation. Default: python.",
    `  --trace-dir DIR           Override trace output base. Default: ${DEFAULT_TRACE_ROOT}.`,
    "  --no-trace                Disable benchmark tracing for this inference run.",
    "  --dry-run                  Validate and print planned work without running Docker/harness.",
    "  --help                     Print this message.",
    "",
    "Environment:",
    "  OPENCODE_BENCH_MODEL or OPENCODE_MODEL can set the default model.",
    "  OPENROUTER_MODEL is accepted and normalized to openrouter/<model>.",
    "  OPENCODE_SWEBENCH_IMAGE_TEMPLATE can override the official image template.",
    "  Provider credentials, such as OPENROUTER_API_KEY, are forwarded to opencode.",
    "",
    "Inference never reads the gold patch or hidden test patch. Evaluation is a",
    "separate operation and requires Docker plus swebench==4.1.0.",
  ].join("\n")
}

export function parseArgs(argv: readonly string[], defaultOpencodeVersion = "latest"): CliOptions {
  let maxInstances = DEFAULT_MAX_INSTANCES
  let offset = 0
  const instanceIds: string[] = []
  let datasetSelectionWasSet = false
  let outputDir = DEFAULT_RUN_ROOT
  let runId = `swe-verified-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`
  let includeHints = false
  let evaluateOnly = false
  let maxWorkers = DEFAULT_MAX_WORKERS
  let evaluationTimeoutSeconds = DEFAULT_EVALUATION_TIMEOUT_SECONDS
  let inferenceWorkers = DEFAULT_INFERENCE_WORKERS
  let maxInfrastructureRetries = DEFAULT_MAX_INFRASTRUCTURE_RETRIES
  let retryBaseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS
  let namespaceEmpty = false
  let listInstances = false
  let predictionsPath: string | undefined
  let manifestPath: string | undefined
  let model = resolveDefaultModel()
  let agent = DEFAULT_AGENT
  let timeoutMs = DEFAULT_OPENCODE_TIMEOUT_MS
  let setupTimeoutMs = DEFAULT_SETUP_TIMEOUT_MS
  const opencodeVersion = defaultOpencodeVersion
  let dockerPlatform = DEFAULT_DOCKER_PLATFORM
  let imageTemplate = process.env.OPENCODE_SWEBENCH_IMAGE_TEMPLATE ?? DEFAULT_IMAGE_TEMPLATE
  let keepFailedContainers = false
  let restart = false
  let pure = true
  let pythonExecutable = "python"
  let traceDir: string | undefined = DEFAULT_TRACE_ROOT
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
    } else if (arg === "--max-instances") {
      maxInstances = parsePositiveInt(nextValue(i, arg), arg)
      datasetSelectionWasSet = true
      i += 1
    } else if (arg === "--offset") {
      offset = parseNonNegativeInt(nextValue(i, arg), arg)
      datasetSelectionWasSet = true
      i += 1
    } else if (arg === "--instance-id") {
      instanceIds.push(nextValue(i, arg))
      datasetSelectionWasSet = true
      i += 1
    } else if (arg === "--output-dir") {
      outputDir = nextValue(i, arg)
      i += 1
    } else if (arg === "--run-id") {
      runId = nextValue(i, arg)
      i += 1
    } else if (arg === "--include-hints") {
      includeHints = true
    } else if (arg === "--evaluate-only") {
      evaluateOnly = true
    } else if (arg === "--predictions-path") {
      predictionsPath = nextValue(i, arg)
      i += 1
    } else if (arg === "--manifest-path") {
      manifestPath = nextValue(i, arg)
      i += 1
    } else if (arg === "--max-workers") {
      maxWorkers = parsePositiveInt(nextValue(i, arg), arg)
      i += 1
    } else if (arg === "--evaluation-timeout-seconds") {
      evaluationTimeoutSeconds = parsePositiveInt(nextValue(i, arg), arg)
      i += 1
    } else if (arg === "--inference-workers") {
      inferenceWorkers = parsePositiveInt(nextValue(i, arg), arg)
      i += 1
    } else if (arg === "--max-infrastructure-retries") {
      maxInfrastructureRetries = parseNonNegativeInt(nextValue(i, arg), arg)
      if (maxInfrastructureRetries > MAX_INFRASTRUCTURE_RETRIES) {
        throw new Error(`${arg} cannot exceed ${MAX_INFRASTRUCTURE_RETRIES}.`)
      }
      i += 1
    } else if (arg === "--retry-base-delay-ms") {
      retryBaseDelayMs = parseNonNegativeInt(nextValue(i, arg), arg)
      i += 1
    } else if (arg === "--namespace-empty") {
      namespaceEmpty = true
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
    } else if (arg === "--setup-timeout-ms") {
      setupTimeoutMs = parsePositiveInt(nextValue(i, arg), arg)
      i += 1
    } else if (arg === "--docker-platform") {
      dockerPlatform = nextValue(i, arg)
      i += 1
    } else if (arg === "--image-template") {
      imageTemplate = nextValue(i, arg)
      i += 1
    } else if (arg === "--keep-failed-containers") {
      keepFailedContainers = true
    } else if (arg === "--restart") {
      restart = true
    } else if (arg === "--no-pure") {
      pure = false
    } else if (arg === "--python") {
      pythonExecutable = nextValue(i, arg)
      i += 1
    } else if (arg === "--trace-dir") {
      traceDir = nextValue(i, arg)
      i += 1
    } else if (arg === "--no-trace") {
      traceDir = undefined
    } else if (arg === "--dry-run") {
      dryRun = true
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  if (new Set(instanceIds).size !== instanceIds.length) {
    throw new Error("Duplicate --instance-id values are not allowed.")
  }
  if (argv.includes("--trace-dir") && argv.includes("--no-trace")) {
    throw new Error("--trace-dir cannot be combined with --no-trace.")
  }
  if (evaluateOnly && argv.includes("--trace-dir")) {
    throw new Error("--trace-dir is available only during inference.")
  }
  const effectiveTraceDir = evaluateOnly ? undefined : traceDir
  officialSweBenchImage("owner__repo-1", imageTemplate)

  return {
    maxInstances,
    offset,
    instanceIds: !evaluateOnly && !datasetSelectionWasSet ? [DEFAULT_SMOKE_INSTANCE_ID] : instanceIds,
    outputDir,
    runId,
    includeHints,
    evaluateOnly,
    maxWorkers,
    evaluationTimeoutSeconds,
    inferenceWorkers,
    maxInfrastructureRetries,
    retryBaseDelayMs,
    namespaceEmpty,
    listInstances,
    ...(predictionsPath !== undefined ? { predictionsPath } : {}),
    ...(manifestPath !== undefined ? { manifestPath } : {}),
    model,
    agent,
    timeoutMs,
    setupTimeoutMs,
    opencodeVersion,
    dockerPlatform,
    imageTemplate,
    keepFailedContainers,
    restart,
    pure,
    pythonExecutable,
    ...(effectiveTraceDir !== undefined ? { traceDir: effectiveTraceDir } : {}),
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

async function readLocalOpencodeVersion(): Promise<string> {
  const parsed: unknown = JSON.parse(await readFile(PACKAGE_JSON_PATH, "utf8"))
  if (!isObject(parsed)) throw new Error(`Package metadata at ${PACKAGE_JSON_PATH} must be an object.`)
  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error(`Could not read opencode version from ${PACKAGE_JSON_PATH}.`)
  }
  return parsed.version
}

function buildPaths(options: CliOptions): BenchmarkPaths {
  const root =
    options.outputDir === DEFAULT_RUN_ROOT
      ? resolve(REPO_ROOT, DEFAULT_RUN_ROOT)
      : resolvePathFromRepoRoot(options.outputDir)
  const runs = join(root, "runs", options.runId)
  const predictionsPath =
    options.predictionsPath === undefined
      ? join(runs, "predictions.jsonl")
      : resolvePathFromRepoRoot(options.predictionsPath)
  const manifestPath =
    options.manifestPath === undefined
      ? join(runs, "prediction-manifest.json")
      : resolvePathFromRepoRoot(options.manifestPath)
  return {
    root,
    runs,
    predictionsPath,
    manifestPath,
    summaryPath: join(runs, "summary.json"),
    datasetPath: join(runs, "instances.jsonl"),
    evaluationManifestPath: join(runs, "evaluation-manifest.json"),
  }
}

function resolvePathFromRepoRoot(path: string): string {
  return resolve(isAbsolute(path) ? path : join(REPO_ROOT, path))
}

async function fetchSweBenchRows(options: CliOptions): Promise<readonly SweBenchRow[]> {
  if (options.instanceIds.length > 0) return fetchSpecificRows(options.instanceIds)
  const rows = await fetchRowsPage(options.offset, options.maxInstances)
  return rows.slice(0, options.maxInstances)
}

async function fetchSpecificRows(instanceIds: readonly string[]): Promise<readonly SweBenchRow[]> {
  const wanted = new Set(instanceIds)
  const found = new Map<string, SweBenchRow>()

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

async function fetchRowsPage(offset: number, length: number): Promise<readonly SweBenchRow[]> {
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
      const parsed: unknown = await response.json()
      if (!isObject(parsed) || !Array.isArray(parsed.rows)) {
        throw new Error("SWE-bench dataset response is missing its rows array.")
      }
      return parsed.rows.map((item, index) => {
        if (!isObject(item)) throw new Error(`SWE-bench dataset row ${index + 1} is malformed.`)
        return parseSweBenchRow(item.row)
      })
    }

    const message = `Failed to fetch SWE-bench rows (${response.status}): ${await response.text()}`
    const retryable = response.status === 429 || response.status >= 500
    if (!retryable || attempt === DATASET_FETCH_ATTEMPTS) throw new Error(message)
    await delay(DATASET_FETCH_RETRY_MS * attempt)
  }

  throw new Error("SWE-bench dataset fetch exhausted without a response.")
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

type InfrastructureStage = "setup" | "agent"

export function classifyInfrastructureFailure(input: {
  readonly stage: InfrastructureStage
  readonly message: string
  readonly patch: string
  readonly timedOut: boolean
  readonly toolUseEventCount: number
}): InfrastructureRetry | undefined {
  if (input.timedOut || input.patch.trim().length > 0) return undefined
  if (input.stage === "agent" && input.toolUseEventCount > 0) return undefined

  const message = input.message.trim()
  if (!message) return undefined
  const reason = message.slice(0, 2_000)
  if (input.stage === "setup" && /timed? out|timeout|context deadline exceeded/i.test(message)) {
    return { category: "infrastructure_timeout", reason }
  }
  if (/\b429\b|rate[ -]?limit|too many requests|temporarily overloaded|capacity exceeded/i.test(message)) {
    return { category: "provider_rate_limit", reason }
  }
  if (/\b(?:500|502|503|504)\b|internal server error|bad gateway|service unavailable|gateway timeout/i.test(message)) {
    return { category: "transient_service_error", reason }
  }
  if (
    /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|EAI_AGAIN|socket hang up|connection reset|network is unreachable|temporary failure (?:in name resolution|resolving)|TLS handshake timeout|i\/o timeout|unexpected EOF|fetch failed/i.test(
      message,
    )
  ) {
    return { category: "transient_network", reason }
  }
  if (
    /cannot connect to the docker daemon|error during connect|container .* is not running|no such container|OCI runtime .* failed|containerd.*(?:unavailable|timeout)/i.test(
      message,
    )
  ) {
    return { category: "container_runtime", reason }
  }
  return undefined
}

export function parseSweBenchRow(value: unknown): SweBenchRow {
  if (!isObject(value)) throw new Error("SWE-bench row must be an object.")
  const repo = requireStringField(value, "repo", "SWE-bench row")
  const instanceId = requireStringField(value, "instance_id", "SWE-bench row")
  const baseCommit = requireStringField(value, "base_commit", "SWE-bench row")
  const problemStatement = requireStringField(value, "problem_statement", "SWE-bench row")

  return {
    repo,
    instance_id: instanceId,
    base_commit: baseCommit,
    problem_statement: problemStatement,
    ...(typeof value.hints_text === "string" ? { hints_text: value.hints_text } : {}),
    ...(typeof value.difficulty === "string" ? { difficulty: value.difficulty } : {}),
  }
}

function datasetArtifactRow(row: SweBenchRow): JsonObject {
  return {
    repo: row.repo,
    instance_id: row.instance_id,
    base_commit: row.base_commit,
    problem_statement: row.problem_statement,
    ...(row.hints_text !== undefined ? { hints_text: row.hints_text } : {}),
    ...(row.difficulty !== undefined ? { difficulty: row.difficulty } : {}),
  }
}

function buildPrompt(row: SweBenchRow, includeHints: boolean): string {
  const hints = includeHints && row.hints_text?.trim() ? ["## Hints", row.hints_text.trim(), ""].join("\n") : ""

  return [
    "Resolve this SWE-bench Verified issue using opencode.",
    "",
    `You are running inside the official SWE-bench task image at ${CONTAINER_WORKDIR}.`,
    "Edit repository files directly; do not merely describe a patch.",
    "Do not seek or use gold patches, hidden tests, or benchmark answer artifacts.",
    "Do not modify tests or benchmark metadata unless the issue explicitly requires it.",
    "",
    benchmarkAgentWorkflowInstructions(),
    "## Repository",
    `Worktree: ${CONTAINER_WORKDIR}`,
    `Repo: ${row.repo}`,
    `Base commit: ${row.base_commit}`,
    `Instance id: ${row.instance_id}`,
    row.difficulty ? `Difficulty: ${row.difficulty}` : undefined,
    "",
    hints,
    "## Issue",
    row.problem_statement.trim(),
    "",
    "## Completion requirements",
    "- Leave the final source changes in the worktree.",
    "- Run relevant lightweight verification when feasible.",
    "- Inspect the final diff before answering.",
    "- Summarize changed files, verification commands, and residual risk.",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n")
}

export function officialSweBenchImage(instanceId: string, template = DEFAULT_IMAGE_TEMPLATE): string {
  const parts = instanceId.split("__")
  const repo = parts[0]
  const name = parts[1]
  if (parts.length !== 2 || !repo || !name) {
    throw new Error(`Invalid SWE-bench instance id: ${instanceId}`)
  }
  const image = template
    .replaceAll("{instance_id}", instanceId)
    .replaceAll("{repo}", repo)
    .replaceAll("{name}", name)
    .replaceAll("{arch}", "x86_64")
    .toLowerCase()
  if (/\{[^}]+\}/.test(image)) throw new Error(`Unsupported placeholder in image template: ${template}`)
  return image
}

export function buildDockerRunArgs(
  containerName: string,
  image: string,
  platform = DEFAULT_DOCKER_PLATFORM,
): readonly string[] {
  return [
    "run",
    "--detach",
    "--name",
    containerName,
    "--platform",
    platform,
    "--user",
    "root",
    "--entrypoint",
    "/bin/bash",
    image,
    "-lc",
    "trap : TERM INT; sleep infinity & wait",
  ]
}

export function buildOpencodeExecArgs(
  containerName: string,
  row: Pick<SweBenchRow, "instance_id">,
  options: Pick<CliOptions, "agent" | "model" | "pure" | "traceRun">,
  env: Record<string, string | undefined>,
): readonly string[] {
  const args = ["exec", "-i", "--workdir", CONTAINER_WORKDIR]
  for (const key of PROVIDER_ENV_KEYS) {
    const value = env[key]
    if (value !== undefined) args.push("--env", key)
  }
  args.push(
    "--env",
    "NO_COLOR=1",
    "--env",
    "OPENCODE_PRINT_LOGS=0",
    "--env",
    "OPENCODE_DISABLE_PROVIDER_RETRIES=1",
    "--env",
    "BASH_ENV=/root/.bashrc",
    containerName,
    "opencode",
    ...(options.pure ? ["--pure"] : []),
    "run",
    "--format",
    "json",
    ...(options.traceRun ? ["--benchmark-trace"] : []),
    "--dir",
    CONTAINER_WORKDIR,
    "--agent",
    options.agent,
    "--model",
    options.model,
    "--title",
    `SWE-bench ${row.instance_id}`,
    "--thinking",
    "--dangerously-skip-permissions",
  )
  return args
}

function containerName(runId: string, instanceId: string, attempt: number): string {
  const safe = `opencode-swe-${runId}-${instanceId}-attempt-${attempt}`.toLowerCase().replaceAll(/[^a-z0-9_.-]+/g, "-")
  return safe.slice(0, 120).replaceAll(/[-_.]+$/g, "") || "opencode-swe-instance"
}

function setupScript(): string {
  return [
    "set -euo pipefail",
    "export DEBIAN_FRONTEND=noninteractive",
    "apt-get update",
    "apt-get install -y --no-install-recommends ca-certificates git",
    "rm -rf /var/lib/apt/lists/*",
    "chmod 755 /usr/local/bin/opencode",
    "opencode --version",
  ].join(" && ")
}

async function ensureOfficialImage(image: string, instanceRunDir: string, setupTimeoutMs: number): Promise<JsonObject> {
  let fetchResult = await runProcess("docker", ["image", "inspect", image], {
    cwd: REPO_ROOT,
    timeoutMs: setupTimeoutMs,
    env: hostEnv(process.env),
  })
  let action = "cached"
  if (fetchResult.exitCode !== 0) {
    action = "pulled"
    fetchResult = await runProcess("docker", ["pull", image], {
      cwd: REPO_ROOT,
      timeoutMs: setupTimeoutMs,
      env: hostEnv(process.env),
    })
  }
  await writeProcessArtifacts(instanceRunDir, "image", fetchResult)
  assertProcessSucceeded(fetchResult, `acquire official image ${image}`)

  const inspect = await runHostCommand(
    "docker",
    ["image", "inspect", "--format", '{{.Id}}|{{join .RepoDigests ","}}', image],
    { timeoutMs: setupTimeoutMs },
  )
  const [imageId = "", repoDigests = ""] = inspect.stdout.trim().split("|", 2)
  return {
    image,
    imageId,
    repoDigests: repoDigests ? repoDigests.split(",").filter(Boolean) : [],
    action,
  }
}

async function prepareContainer(
  row: SweBenchRow,
  options: CliOptions,
  instanceRunDir: string,
  image: string,
  name: string,
): Promise<JsonObject> {
  const runtime = requireBenchmarkRuntime(options)
  const imageMetadata = await ensureOfficialImage(image, instanceRunDir, options.setupTimeoutMs)
  const staleCleanup = await runProcess("docker", ["rm", "--force", name], {
    cwd: REPO_ROOT,
    timeoutMs: 30_000,
    env: hostEnv(process.env),
  })
  await writeProcessArtifacts(instanceRunDir, "stale-container-cleanup", staleCleanup)
  if (staleCleanup.exitCode !== 0 && !/no such container/i.test(staleCleanup.stderr)) {
    assertProcessSucceeded(staleCleanup, `remove stale inference container ${name}`)
  }
  const started = await runProcess("docker", buildDockerRunArgs(name, image, options.dockerPlatform), {
    cwd: REPO_ROOT,
    timeoutMs: options.setupTimeoutMs,
    env: hostEnv(process.env),
  })
  await writeProcessArtifacts(instanceRunDir, "container-start", started)
  assertProcessSucceeded(started, `start inference container ${name}`)

  try {
    const runtimeDirectory = await runProcess("docker", ["exec", name, "mkdir", "-p", "/usr/local/bin"], {
      cwd: REPO_ROOT,
      timeoutMs: options.setupTimeoutMs,
      env: hostEnv(process.env),
    })
    await writeProcessArtifacts(instanceRunDir, "runtime-directory", runtimeDirectory)
    assertProcessSucceeded(runtimeDirectory, "create opencode runtime directory")

    const runtimeCopy = await runProcess("docker", ["cp", runtime.binaryPath, `${name}:/usr/local/bin/opencode`], {
      cwd: REPO_ROOT,
      timeoutMs: options.setupTimeoutMs,
      env: hostEnv(process.env),
    })
    await writeProcessArtifacts(instanceRunDir, "runtime-copy", runtimeCopy)
    assertProcessSucceeded(runtimeCopy, `copy opencode runtime ${runtime.commit}`)

    const setup = await runProcess("docker", ["exec", name, "/bin/bash", "-lc", setupScript()], {
      cwd: REPO_ROOT,
      timeoutMs: options.setupTimeoutMs,
      env: hostEnv(process.env),
    })
    await writeProcessArtifacts(instanceRunDir, "runtime-setup", setup)
    assertProcessSucceeded(setup, "verify exact opencode runtime")

    const reset = await runProcess(
      "docker",
      [
        "exec",
        name,
        "/bin/bash",
        "-lc",
        `set -euo pipefail; git config --global --add safe.directory ${CONTAINER_WORKDIR}; git -C ${CONTAINER_WORKDIR} reset --hard ${shellQuote(row.base_commit)}`,
      ],
      {
        cwd: REPO_ROOT,
        timeoutMs: options.setupTimeoutMs,
        env: hostEnv(process.env),
      },
    )
    await writeProcessArtifacts(instanceRunDir, "repository-reset", reset)
    assertProcessSucceeded(reset, `reset repository to ${row.base_commit}`)

    const stagingDir = await mkdtemp(join(tmpdir(), "opencode-swe-agents-"))
    try {
      await installBenchmarkAgentTeam(stagingDir)
      await runHostCommand("docker", ["exec", name, "mkdir", "-p", `${CONTAINER_WORKDIR}/.opencode`], {
        timeoutMs: options.setupTimeoutMs,
      })
      await runHostCommand(
        "docker",
        ["cp", `${join(stagingDir, ".opencode")}/.`, `${name}:${CONTAINER_WORKDIR}/.opencode`],
        { timeoutMs: options.setupTimeoutMs },
      )
    } finally {
      await rm(stagingDir, { recursive: true, force: true })
    }
  } catch (error) {
    await removeContainer(name, instanceRunDir)
    throw error
  }

  return imageMetadata
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

async function captureContainerPatch(name: string): Promise<CapturedPatch> {
  await runHostCommand(
    "docker",
    ["exec", "--workdir", CONTAINER_WORKDIR, name, "git", "add", "-A", "--", ".", ":(exclude).opencode"],
    { timeoutMs: DEFAULT_DOCKER_COMMAND_TIMEOUT_MS },
  )
  const [patch, names] = await Promise.all([
    runHostCommand(
      "docker",
      [
        "exec",
        "--workdir",
        CONTAINER_WORKDIR,
        name,
        "git",
        "diff",
        "--cached",
        "--binary",
        "--",
        ".",
        ":(exclude).opencode",
      ],
      { timeoutMs: DEFAULT_DOCKER_COMMAND_TIMEOUT_MS },
    ),
    runHostCommand(
      "docker",
      [
        "exec",
        "--workdir",
        CONTAINER_WORKDIR,
        name,
        "git",
        "diff",
        "--cached",
        "--name-only",
        "-z",
        "--",
        ".",
        ":(exclude).opencode",
      ],
      { timeoutMs: DEFAULT_DOCKER_COMMAND_TIMEOUT_MS },
    ),
  ])
  return {
    patch: patch.stdout,
    changedPaths: names.stdout.split("\0").filter((path) => path.length > 0),
  }
}

function requireBenchmarkRuntime(options: CliOptions): BenchmarkRuntime {
  if (!options.runtime) throw new Error("The exact opencode benchmark runtime has not been prepared.")
  return options.runtime
}

async function stopTimedOutWork(name: string, instanceRunDir: string): Promise<void> {
  const stopped = await runProcess("docker", ["stop", "--time", "1", name], {
    cwd: REPO_ROOT,
    timeoutMs: 30_000,
    env: hostEnv(process.env),
  })
  await writeProcessArtifacts(instanceRunDir, "timeout-stop", stopped)
  if (stopped.exitCode !== 0) return
  const restarted = await runProcess("docker", ["start", name], {
    cwd: REPO_ROOT,
    timeoutMs: 30_000,
    env: hostEnv(process.env),
  })
  await writeProcessArtifacts(instanceRunDir, "timeout-restart", restarted)
}

async function removeContainer(name: string, instanceRunDir: string): Promise<void> {
  const result = await runProcess("docker", ["rm", "--force", name], {
    cwd: REPO_ROOT,
    timeoutMs: 30_000,
    env: hostEnv(process.env),
  })
  await writeProcessArtifacts(instanceRunDir, "container-cleanup", result)
}

async function exportRootSession(
  name: string,
  sessionId: string,
  pure: boolean,
  instanceRunDir: string,
): Promise<boolean> {
  const result = await runProcess(
    "docker",
    ["exec", "--workdir", CONTAINER_WORKDIR, name, "opencode", ...(pure ? ["--pure"] : []), "export", sessionId],
    {
      cwd: REPO_ROOT,
      timeoutMs: 60_000,
      env: hostEnv(process.env),
    },
  )
  await writeProcessArtifacts(instanceRunDir, "session-export", result, "json")
  return result.exitCode === 0
}

function rootSessionId(events: readonly JsonObject[]): string | undefined {
  for (const event of events) {
    if (typeof event.sessionID === "string") return event.sessionID
  }
  return undefined
}

async function runInstanceAttempt(
  row: SweBenchRow,
  options: CliOptions,
  paths: BenchmarkPaths,
  context: { readonly attempt: number; readonly maxAttempts: number },
): Promise<EvaluationAttempt<InstanceOutcome>> {
  const runtime = requireBenchmarkRuntime(options)
  const instanceRunDir = join(paths.runs, row.instance_id)
  const attemptRunDir = join(instanceRunDir, "attempts", `attempt-${context.attempt}`)
  await rm(attemptRunDir, { recursive: true, force: true })
  await mkdir(instanceRunDir, { recursive: true })
  await mkdir(attemptRunDir, { recursive: true })

  const prompt = buildPrompt(row, options.includeHints)
  const image = officialSweBenchImage(row.instance_id, options.imageTemplate)
  const name = containerName(options.runId, row.instance_id, context.attempt)
  const startedAt = new Date().toISOString()
  let completedAt = startedAt
  let imageMetadata: JsonObject = { image }
  let containerStarted = false
  let agentResult: ProcessResult | undefined
  let captured: CapturedPatch = { patch: "", changedPaths: [] }
  let infrastructureError: string | undefined
  let captureError: string | undefined
  let keptContainer = false
  let events: readonly JsonObject[] = []
  let sessionId: string | undefined
  let sessionExported = false
  let failureStage: InfrastructureStage = "setup"
  const trace = options.traceRun
    ? createOpenCodeAttemptTrace({
        run: options.traceRun,
        instanceId: row.instance_id,
        attempt: context.attempt,
        frameworkRevision: runtime.commit,
        model: options.model,
        evaluationWorkers: options.maxWorkers,
        inferenceTimeoutMs: options.timeoutMs,
        evaluationTimeoutSeconds: options.evaluationTimeoutSeconds,
        benchmarkRetries: options.maxInfrastructureRetries,
        delegationEnabled: true,
        image,
      })
    : undefined

  await writeFileAtomic(join(attemptRunDir, "prompt.txt"), prompt)
  await writeJsonAtomic(join(attemptRunDir, "instance.json"), {
    ...datasetArtifactRow(row),
    image,
    containerWorkdir: CONTAINER_WORKDIR,
    attempt: context.attempt,
    maxAttempts: context.maxAttempts,
  })

  try {
    imageMetadata = await prepareContainer(row, options, attemptRunDir, image, name)
    containerStarted = true
    failureStage = "agent"
    const args = buildOpencodeExecArgs(name, row, options, process.env)
    console.log(
      `Running opencode for ${row.instance_id} in ${image} (attempt ${context.attempt}/${context.maxAttempts}).`,
    )
    agentResult = await runProcess("docker", args, {
      cwd: REPO_ROOT,
      timeoutMs: options.timeoutMs,
      env: dockerClientEnv(process.env),
      stdin: prompt,
      onStdoutLine: (line) => {
        if (!trace) return
        const parsed = parseJsonLine(line)
        if (parsed) trace.consume(parsed)
      },
    })
    const retainedAgentResult = {
      ...agentResult,
      stdout: stripBenchmarkTraceFrames(agentResult.stdout),
    }
    await writeProcessArtifacts(attemptRunDir, "opencode", retainedAgentResult, "jsonl")
    if (agentResult.timedOut) await stopTimedOutWork(name, attemptRunDir)
    events = parseJsonl(retainedAgentResult.stdout)
    sessionId = rootSessionId(events)
    if (sessionId) sessionExported = await exportRootSession(name, sessionId, options.pure, attemptRunDir)
  } catch (error) {
    infrastructureError = errorMessage(error)
  }

  if (containerStarted) {
    try {
      captured = await captureContainerPatch(name)
    } catch (error) {
      captureError = errorMessage(error)
    }
  }

  const agentCompleted = agentResult?.exitCode === 0 && infrastructureError === undefined
  const toolUseEventCount = events.filter((event) => event.type === "tool_use").length
  const eventErrors = events
    .filter((event) => event.type === "error")
    .map((event) => JSON.stringify(event))
    .join("\n")
  const failureMessage = [infrastructureError, agentResult?.stderr, eventErrors].filter(Boolean).join("\n")
  const infrastructureRetry = classifyInfrastructureFailure({
    stage: failureStage,
    message: failureMessage,
    patch: captured.patch,
    timedOut: agentResult?.timedOut ?? false,
    toolUseEventCount,
  })
  const failed = !agentCompleted || captured.patch.trim().length === 0 || captureError !== undefined
  const retryPending = infrastructureRetry !== undefined && context.attempt < context.maxAttempts
  if (containerStarted && options.keepFailedContainers && failed && !retryPending) {
    keptContainer = true
  } else if (containerStarted) {
    await removeContainer(name, attemptRunDir)
  }

  completedAt = new Date().toISOString()
  const assessed = assessPrediction(agentResult?.exitCode ?? 1, captured.patch)
  const status = {
    ...assessed,
    agentCompleted,
    generationSucceeded: agentCompleted && assessed.predictionProduced && captureError === undefined,
  }
  const traceResult = finishOpenCodeTrace(
    trace,
    traceStatus({
      completed: agentCompleted && captureError === undefined,
      timedOut: agentResult?.timedOut ?? false,
      infrastructureError: infrastructureError ?? captureError,
    }),
    infrastructureError ?? captureError,
  )
  const prediction: SweBenchPrediction = {
    instance_id: row.instance_id,
    model_name_or_path: `opencode@${runtime.commit}:${options.model}`,
    model_patch: captured.patch,
  }
  const summary: JsonObject = {
    instanceId: row.instance_id,
    repo: row.repo,
    baseCommit: row.base_commit,
    startedAt,
    completedAt,
    attempt: context.attempt,
    maxAttempts: context.maxAttempts,
    model: options.model,
    agent: options.agent,
    opencodeVersion: options.opencodeVersion,
    opencodeCommit: runtime.commit,
    opencodeBinarySha256: runtime.binarySha256,
    providerAttemptsPerTurn: 1,
    inferenceRuntime: "official-swebench-instance-image",
    containerName: name,
    containerWorkdir: CONTAINER_WORKDIR,
    keptContainer,
    ...imageMetadata,
    exitCode: agentResult?.exitCode ?? null,
    timedOut: agentResult?.timedOut ?? false,
    ...status,
    patchBytes: Buffer.byteLength(captured.patch, "utf8"),
    changedPaths: captured.changedPaths,
    eventCount: events.length,
    toolUseEventCount,
    sessionId: sessionId ?? null,
    sessionExported,
    ...(traceResult ?? {}),
    ...(infrastructureError !== undefined ? { infrastructureError } : {}),
    ...(captureError !== undefined ? { captureError } : {}),
    ...(infrastructureRetry !== undefined ? { infrastructureRetry } : {}),
    predictionPath: join(attemptRunDir, "prediction.json"),
    runPath: join(attemptRunDir, "run.json"),
  }

  await writeFileAtomic(join(attemptRunDir, "patch.diff"), captured.patch)
  await writeJsonAtomic(join(attemptRunDir, "events.json"), events)
  await writeJsonAtomic(join(attemptRunDir, "prediction.json"), prediction)
  await writeJsonAtomic(join(attemptRunDir, "run.json"), summary)

  const value = {
    summary,
    prediction,
    ...(infrastructureRetry !== undefined ? { infrastructureRetry } : {}),
  }
  return {
    value,
    ...(infrastructureRetry !== undefined ? { retry: infrastructureRetry } : {}),
  }
}

async function finalizeInstanceOutcome(
  row: SweBenchRow,
  paths: BenchmarkPaths,
  completion: EvaluationCompletion<InstanceOutcome>,
): Promise<InstanceOutcome> {
  const instanceRunDir = join(paths.runs, row.instance_id)
  const finalAttemptDir = join(instanceRunDir, "attempts", `attempt-${completion.attemptsUsed}`)
  const attemptHistory = await loadAttemptHistory(instanceRunDir, completion.attemptsUsed)
  const summary = {
    ...completion.value.summary,
    attemptsUsed: completion.attemptsUsed,
    infrastructureRetriesUsed: completion.attemptsUsed - 1,
    infrastructureRetryExhausted: completion.retryExhausted,
    semanticRetriesUsed: 0,
    attemptHistory,
    finalAttemptDirectory: finalAttemptDir,
    predictionPath: join(instanceRunDir, "prediction.json"),
    runPath: join(instanceRunDir, "run.json"),
  }

  await mkdir(instanceRunDir, { recursive: true })
  await Promise.all([
    writeFileAtomic(join(instanceRunDir, "patch.diff"), completion.value.prediction.model_patch),
    writeJsonAtomic(join(instanceRunDir, "prediction.json"), completion.value.prediction),
    writeJsonAtomic(join(instanceRunDir, "run.json"), summary),
    writeJsonAtomic(join(instanceRunDir, "final-attempt.json"), {
      attempt: completion.attemptsUsed,
      attemptDirectory: finalAttemptDir,
      retryExhausted: completion.retryExhausted,
    }),
  ])

  return {
    summary,
    prediction: completion.value.prediction,
    ...(completion.value.infrastructureRetry !== undefined
      ? { infrastructureRetry: completion.value.infrastructureRetry }
      : {}),
  }
}

async function loadAttemptHistory(instanceRunDir: string, attemptsUsed: number): Promise<readonly JsonObject[]> {
  const history: JsonObject[] = []
  for (let attempt = 1; attempt <= attemptsUsed; attempt += 1) {
    const runPath = join(instanceRunDir, "attempts", `attempt-${attempt}`, "run.json")
    const value: unknown = JSON.parse(await readFile(runPath, "utf8"))
    if (!isObject(value) || value.attempt !== attempt) {
      throw new Error(`Attempt history is invalid for ${instanceRunDir} attempt ${attempt}.`)
    }
    history.push({
      attempt,
      startedAt: value.startedAt ?? null,
      completedAt: value.completedAt ?? null,
      exitCode: value.exitCode ?? null,
      timedOut: value.timedOut ?? false,
      agentCompleted: value.agentCompleted ?? false,
      predictionProduced: value.predictionProduced ?? false,
      toolUseEventCount: value.toolUseEventCount ?? 0,
      infrastructureRetry: value.infrastructureRetry ?? null,
    })
  }
  return history
}

interface AttemptCheckpoint {
  readonly attempt: number
  readonly outcome?: InstanceOutcome
}

export async function loadLatestAttemptCheckpoint(
  row: SweBenchRow,
  paths: BenchmarkPaths,
  maxAttempts: number,
): Promise<AttemptCheckpoint | undefined> {
  const attemptsDir = join(paths.runs, row.instance_id, "attempts")
  if (!(await pathExists(attemptsDir))) return undefined
  const attemptNumbers = (await readdir(attemptsDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => /^attempt-(\d+)$/.exec(entry.name)?.[1])
    .filter((value): value is string => value !== undefined)
    .map(Number)
    .sort((left, right) => left - right)
  if (attemptNumbers.length === 0) return undefined
  for (let index = 0; index < attemptNumbers.length; index += 1) {
    if (attemptNumbers[index] !== index + 1) {
      throw new Error(`Attempt checkpoints for ${row.instance_id} are not contiguous.`)
    }
  }
  const attempt = attemptNumbers.at(-1)!
  if (attempt > maxAttempts) {
    throw new Error(`Attempt checkpoint for ${row.instance_id} exceeds the configured retry policy.`)
  }
  const attemptDir = join(attemptsDir, `attempt-${attempt}`)
  const predictionPath = join(attemptDir, "prediction.json")
  const runPath = join(attemptDir, "run.json")
  if (!(await pathExists(predictionPath)) || !(await pathExists(runPath))) return { attempt }

  const [predictionValue, summaryValue] = await Promise.all([
    readFile(predictionPath, "utf8").then((content) => JSON.parse(content) as unknown),
    readFile(runPath, "utf8").then((content) => JSON.parse(content) as unknown),
  ])
  const prediction = parseSweBenchPredictions([predictionValue])[0]
  if (!prediction || prediction.instance_id !== row.instance_id) {
    throw new Error(`Attempt prediction does not match instance ${row.instance_id}.`)
  }
  if (!isObject(summaryValue) || summaryValue.instanceId !== row.instance_id || summaryValue.attempt !== attempt) {
    throw new Error(`Attempt summary does not match instance ${row.instance_id} attempt ${attempt}.`)
  }
  const infrastructureRetry = parseInfrastructureRetry(summaryValue.infrastructureRetry)
  return {
    attempt,
    outcome: {
      summary: summaryValue,
      prediction,
      ...(infrastructureRetry !== undefined ? { infrastructureRetry } : {}),
    },
  }
}

function parseInfrastructureRetry(value: unknown): InfrastructureRetry | undefined {
  if (value === undefined) return undefined
  if (!isObject(value) || typeof value.category !== "string" || typeof value.reason !== "string") {
    throw new Error("Attempt checkpoint has invalid infrastructure retry metadata.")
  }
  return { category: value.category, reason: value.reason }
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

function parseJsonLine(line: string): JsonObject | undefined {
  try {
    const parsed: unknown = JSON.parse(line)
    return isObject(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

export function stripBenchmarkTraceFrames(output: string): string {
  return output
    .split(/\r?\n/)
    .filter((line) => parseJsonLine(line)?.type !== "benchmark_trace.native")
    .join("\n")
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requireStringField(value: JsonObject, field: string, description: string): string {
  const candidate = value[field]
  if (typeof candidate !== "string") throw new Error(`${description} is missing string field "${field}".`)
  return candidate
}

function encodeJsonl(rows: readonly unknown[]): string {
  if (rows.length === 0) return ""
  return rows.map((row) => JSON.stringify(row)).join("\n") + "\n"
}

async function writeJsonlAtomic(path: string, rows: readonly unknown[]): Promise<void> {
  await writeFileAtomic(path, encodeJsonl(rows))
}

async function readJsonl(path: string): Promise<readonly unknown[]> {
  const text = await readFile(path, "utf8")
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown)
}

async function writeFileAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, content, "utf8")
  await rename(temporary, path)
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`)
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex")
}

export function parseSweBenchPredictions(value: unknown): readonly SweBenchPrediction[] {
  if (!Array.isArray(value)) throw new Error("SWE-bench predictions must be provided as parsed JSONL rows.")
  if (value.length === 0) throw new Error("SWE-bench predictions must contain at least one row.")

  const instanceIds = new Set<string>()
  return value.map((candidate, index) => {
    if (!isObject(candidate)) throw new Error(`Prediction row ${index + 1} must be an object.`)
    const description = `Prediction row ${index + 1}`
    const instanceId = requireStringField(candidate, "instance_id", description)
    const modelName = requireStringField(candidate, "model_name_or_path", description)
    const modelPatch = requireStringField(candidate, "model_patch", description)
    if (instanceId.length === 0) {
      throw new Error(`Prediction row ${index + 1} has an empty "instance_id".`)
    }
    if (modelName.length === 0) {
      throw new Error(`Prediction row ${index + 1} has an empty "model_name_or_path".`)
    }
    if (instanceIds.has(instanceId)) {
      throw new Error(`Duplicate prediction for instance "${instanceId}".`)
    }
    instanceIds.add(instanceId)
    return {
      instance_id: instanceId,
      model_name_or_path: modelName,
      model_patch: modelPatch,
    }
  })
}

export function buildEvaluationArgs(config: SweBenchEvaluationConfig): readonly string[] {
  const args = [
    "-m",
    "swebench.harness.run_evaluation",
    "--dataset_name",
    config.datasetName,
    "--predictions_path",
    config.predictionsPath,
    "--max_workers",
    String(config.maxWorkers),
    "--timeout",
    String(config.timeoutSeconds),
    "--run_id",
    config.runId,
  ]
  if (config.instanceIds.length > 0) args.push("--instance_ids", ...config.instanceIds)
  if (config.namespaceEmpty) args.push("--namespace", "")
  return args
}

function buildPredictionManifest(
  options: CliOptions,
  rows: readonly SweBenchRow[],
  predictions: readonly SweBenchPrediction[],
  complete: boolean,
): PredictionManifest {
  const runtime = requireBenchmarkRuntime(options)
  const content = encodeJsonl(predictions)
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    benchmark: "swe-bench-verified",
    dataset: DATASET_NAME,
    datasetConfig: DATASET_CONFIG,
    datasetSplit: DATASET_SPLIT,
    runId: options.runId,
    model: options.model,
    agent: options.agent,
    opencodeVersion: options.opencodeVersion,
    opencodeCommit: runtime.commit,
    opencodeBinarySha256: runtime.binarySha256,
    providerAttemptsPerTurn: 1,
    inferenceRuntime: "official-swebench-instance-image",
    imageTemplate: options.imageTemplate,
    dockerPlatform: options.dockerPlatform,
    includeHints: options.includeHints,
    inferenceWorkers: options.inferenceWorkers,
    maxInfrastructureRetries: options.maxInfrastructureRetries,
    retryBaseDelayMs: options.retryBaseDelayMs,
    selectedInstances: rows.map((row) => ({
      instanceId: row.instance_id,
      repo: row.repo,
      baseCommit: row.base_commit,
      image: officialSweBenchImage(row.instance_id, options.imageTemplate),
    })),
    completedInstanceIds: predictions.map((prediction) => prediction.instance_id),
    complete,
    predictionCount: predictions.length,
    nonEmptyPatchCount: predictions.filter((prediction) => prediction.model_patch.trim().length > 0).length,
    predictionsSha256: sha256(content),
    generatedAt: new Date().toISOString(),
  }
}

async function writeRunProgress(
  options: CliOptions,
  paths: BenchmarkPaths,
  rows: readonly SweBenchRow[],
  summaries: readonly JsonObject[],
  predictions: readonly SweBenchPrediction[],
  complete: boolean,
): Promise<void> {
  const predictionContent = encodeJsonl(predictions)
  const manifest = buildPredictionManifest(options, rows, predictions, complete)
  if (manifest.predictionsSha256 !== sha256(predictionContent)) {
    throw new Error("Internal prediction manifest digest mismatch.")
  }

  await writeFileAtomic(paths.predictionsPath, predictionContent)
  await writeJsonAtomic(paths.manifestPath, manifest)
  await writeJsonAtomic(paths.summaryPath, {
    runId: options.runId,
    dataset: DATASET_NAME,
    datasetConfig: DATASET_CONFIG,
    datasetSplit: DATASET_SPLIT,
    model: options.model,
    agent: options.agent,
    opencodeVersion: options.opencodeVersion,
    opencodeCommit: manifest.opencodeCommit,
    opencodeBinarySha256: manifest.opencodeBinarySha256,
    providerAttemptsPerTurn: manifest.providerAttemptsPerTurn,
    inferenceRuntime: "official-swebench-instance-image",
    inferenceWorkers: options.inferenceWorkers,
    maxInfrastructureRetries: options.maxInfrastructureRetries,
    retryBaseDelayMs: options.retryBaseDelayMs,
    selectedCount: rows.length,
    completedCount: summaries.length,
    generationSucceededCount: summaries.filter((summary) => summary.generationSucceeded === true).length,
    infrastructureRetryCount: summaries.reduce(
      (total, summary) =>
        total + (typeof summary.infrastructureRetriesUsed === "number" ? summary.infrastructureRetriesUsed : 0),
      0,
    ),
    infrastructureRetryExhaustedCount: summaries.filter((summary) => summary.infrastructureRetryExhausted === true)
      .length,
    predictionCount: predictions.filter((prediction) => prediction.model_patch.trim().length > 0).length,
    complete,
    predictionsPath: paths.predictionsPath,
    predictionManifestPath: paths.manifestPath,
    predictionsSha256: manifest.predictionsSha256,
    selectedInstancesPath: paths.datasetPath,
    summaries,
  })
}

async function loadExistingProgress(
  options: CliOptions,
  paths: BenchmarkPaths,
  rows: readonly SweBenchRow[],
): Promise<ExistingProgress> {
  const manifestExists = await pathExists(paths.manifestPath)
  const summaryExists = await pathExists(paths.summaryPath)
  const predictionsExist = await pathExists(paths.predictionsPath)
  if (!manifestExists && !summaryExists && !predictionsExist) {
    return { summaries: [], predictions: [], initialAttempts: new Map() }
  }
  if (!manifestExists) {
    throw new Error(`Run ${options.runId} has incomplete checkpoint metadata. Use --restart to replace it.`)
  }

  const manifest = parsePredictionManifest(JSON.parse(await readFile(paths.manifestPath, "utf8")))
  assertManifestMatchesRun(manifest, options, rows)
  if (manifest.complete) {
    if (!summaryExists || !predictionsExist) {
      throw new Error("Completed run is missing its summary or predictions artifact.")
    }
    const predictionContent = await readFile(paths.predictionsPath, "utf8")
    if (sha256(predictionContent) !== manifest.predictionsSha256) {
      throw new Error("Existing predictions do not match their completed manifest.")
    }
    throw new Error(`Run ${options.runId} is already complete. Use a new --run-id or --restart.`)
  }

  const summaries: JsonObject[] = []
  const predictions: SweBenchPrediction[] = []
  const initialAttempts = new Map<string, number>()
  const maxAttempts = options.maxInfrastructureRetries + 1
  for (const row of rows) {
    const instanceRunDir = join(paths.runs, row.instance_id)
    const predictionPath = join(instanceRunDir, "prediction.json")
    const runPath = join(instanceRunDir, "run.json")
    if ((await pathExists(predictionPath)) && (await pathExists(runPath))) {
      const [predictionValue, summaryValue] = await Promise.all([
        readFile(predictionPath, "utf8").then((content) => JSON.parse(content) as unknown),
        readFile(runPath, "utf8").then((content) => JSON.parse(content) as unknown),
      ])
      const prediction = parseSweBenchPredictions([predictionValue])[0]
      if (!prediction || prediction.instance_id !== row.instance_id) {
        throw new Error(`Checkpoint prediction does not match instance ${row.instance_id}.`)
      }
      if (!isObject(summaryValue) || summaryValue.instanceId !== row.instance_id) {
        throw new Error(`Checkpoint summary does not match instance ${row.instance_id}.`)
      }
      predictions.push(prediction)
      summaries.push(summaryValue)
      continue
    }

    const checkpoint = await loadLatestAttemptCheckpoint(row, paths, maxAttempts)
    if (!checkpoint) {
      initialAttempts.set(row.instance_id, 1)
      continue
    }
    if (!checkpoint.outcome) {
      initialAttempts.set(row.instance_id, checkpoint.attempt)
      continue
    }
    if (checkpoint.outcome.infrastructureRetry !== undefined && checkpoint.attempt < maxAttempts) {
      initialAttempts.set(row.instance_id, checkpoint.attempt + 1)
      continue
    }

    const finalized = await finalizeInstanceOutcome(row, paths, {
      value: checkpoint.outcome,
      attemptsUsed: checkpoint.attempt,
      retryExhausted: checkpoint.outcome.infrastructureRetry !== undefined,
    })
    predictions.push(finalized.prediction)
    summaries.push(finalized.summary)
  }
  return { summaries, predictions, initialAttempts }
}

function parsePredictionManifest(value: unknown): PredictionManifest {
  if (!isObject(value)) throw new Error("Prediction manifest must be an object.")
  const benchmark = requireStringField(value, "benchmark", "Prediction manifest")
  const dataset = requireStringField(value, "dataset", "Prediction manifest")
  const datasetConfig = requireStringField(value, "datasetConfig", "Prediction manifest")
  const datasetSplit = requireStringField(value, "datasetSplit", "Prediction manifest")
  const runId = requireStringField(value, "runId", "Prediction manifest")
  const model = requireStringField(value, "model", "Prediction manifest")
  const agent = requireStringField(value, "agent", "Prediction manifest")
  const opencodeVersion = requireStringField(value, "opencodeVersion", "Prediction manifest")
  const opencodeCommit =
    value.schemaVersion === MANIFEST_SCHEMA_VERSION
      ? requireStringField(value, "opencodeCommit", "Prediction manifest")
      : "legacy-unrecorded"
  const opencodeBinarySha256 =
    value.schemaVersion === MANIFEST_SCHEMA_VERSION
      ? requireStringField(value, "opencodeBinarySha256", "Prediction manifest")
      : "legacy-unrecorded"
  const providerAttemptsPerTurn =
    value.schemaVersion === MANIFEST_SCHEMA_VERSION && typeof value.providerAttemptsPerTurn === "number"
      ? value.providerAttemptsPerTurn
      : 0
  const inferenceRuntime = requireStringField(value, "inferenceRuntime", "Prediction manifest")
  const imageTemplate = requireStringField(value, "imageTemplate", "Prediction manifest")
  const dockerPlatform = requireStringField(value, "dockerPlatform", "Prediction manifest")
  const predictionsSha256 = requireStringField(value, "predictionsSha256", "Prediction manifest")
  const generatedAt = requireStringField(value, "generatedAt", "Prediction manifest")
  if (value.schemaVersion !== 1 && value.schemaVersion !== 2 && value.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new Error(`Unsupported prediction manifest schema: ${String(value.schemaVersion)}`)
  }
  if (benchmark !== "swe-bench-verified" || dataset !== DATASET_NAME) {
    throw new Error("Prediction manifest does not describe this SWE-bench Verified runner.")
  }
  if (datasetConfig !== DATASET_CONFIG || datasetSplit !== DATASET_SPLIT) {
    throw new Error("Prediction manifest has an unexpected dataset config or split.")
  }
  if (inferenceRuntime !== "official-swebench-instance-image") {
    throw new Error("Prediction manifest was not produced in the official SWE-bench instance runtime.")
  }
  if (
    typeof value.complete !== "boolean" ||
    typeof value.includeHints !== "boolean" ||
    typeof value.predictionCount !== "number" ||
    typeof value.nonEmptyPatchCount !== "number" ||
    !Array.isArray(value.selectedInstances)
  ) {
    throw new Error("Prediction manifest is missing completion or selected-instance metadata.")
  }
  if (
    !Number.isInteger(value.predictionCount) ||
    value.predictionCount < 0 ||
    !Number.isInteger(value.nonEmptyPatchCount) ||
    value.nonEmptyPatchCount < 0
  ) {
    throw new Error("Prediction manifest has invalid prediction counts.")
  }
  const inferenceWorkers = value.schemaVersion === 1 ? 1 : value.inferenceWorkers
  const maxInfrastructureRetries = value.schemaVersion === 1 ? 0 : value.maxInfrastructureRetries
  const retryBaseDelayMs = value.schemaVersion === 1 ? 0 : value.retryBaseDelayMs
  if (
    typeof inferenceWorkers !== "number" ||
    !Number.isInteger(inferenceWorkers) ||
    inferenceWorkers < 1 ||
    typeof maxInfrastructureRetries !== "number" ||
    !Number.isInteger(maxInfrastructureRetries) ||
    maxInfrastructureRetries < 0 ||
    typeof retryBaseDelayMs !== "number" ||
    !Number.isInteger(retryBaseDelayMs) ||
    retryBaseDelayMs < 0
  ) {
    throw new Error("Prediction manifest has invalid inference orchestration metadata.")
  }
  if (!/^[a-f0-9]{64}$/.test(predictionsSha256)) {
    throw new Error("Prediction manifest has an invalid SHA-256 digest.")
  }
  if (
    value.schemaVersion === MANIFEST_SCHEMA_VERSION &&
    (!/^[a-f0-9]{40}$/.test(opencodeCommit) ||
      !/^[a-f0-9]{64}$/.test(opencodeBinarySha256) ||
      providerAttemptsPerTurn !== 1)
  ) {
    throw new Error("Prediction manifest has invalid agent provenance or provider-attempt metadata.")
  }
  const selectedInstances = value.selectedInstances.map((candidate, index) => {
    const description = `Prediction manifest instance ${index + 1}`
    if (!isObject(candidate)) throw new Error(`${description} must be an object.`)
    return {
      instanceId: requireStringField(candidate, "instanceId", description),
      repo: requireStringField(candidate, "repo", description),
      baseCommit: requireStringField(candidate, "baseCommit", description),
      image: requireStringField(candidate, "image", description),
    }
  })
  if (
    !Array.isArray(value.completedInstanceIds) ||
    !value.completedInstanceIds.every((item) => typeof item === "string")
  ) {
    throw new Error("Prediction manifest has invalid completedInstanceIds.")
  }
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    benchmark: "swe-bench-verified",
    dataset: DATASET_NAME,
    datasetConfig,
    datasetSplit,
    runId,
    model,
    agent,
    opencodeVersion,
    opencodeCommit,
    opencodeBinarySha256,
    providerAttemptsPerTurn,
    inferenceRuntime: "official-swebench-instance-image",
    imageTemplate,
    dockerPlatform,
    includeHints: value.includeHints,
    inferenceWorkers,
    maxInfrastructureRetries,
    retryBaseDelayMs,
    selectedInstances,
    completedInstanceIds: value.completedInstanceIds,
    complete: value.complete,
    predictionCount: value.predictionCount,
    nonEmptyPatchCount: value.nonEmptyPatchCount,
    predictionsSha256,
    generatedAt,
  }
}

function assertManifestMatchesRun(
  manifest: PredictionManifest,
  options: CliOptions,
  rows: readonly SweBenchRow[],
): void {
  const expectedIds = rows.map((row) => row.instance_id)
  const actualIds = manifest.selectedInstances.map((item) => item.instanceId)
  const mismatches = [
    manifest.runId !== options.runId ? "run id" : undefined,
    manifest.model !== options.model ? "model" : undefined,
    manifest.agent !== options.agent ? "agent" : undefined,
    manifest.opencodeVersion !== options.opencodeVersion ? "opencode version" : undefined,
    options.runtime && manifest.opencodeCommit !== options.runtime.commit ? "opencode commit" : undefined,
    options.runtime && manifest.opencodeBinarySha256 !== options.runtime.binarySha256
      ? "opencode binary digest"
      : undefined,
    options.runtime && manifest.providerAttemptsPerTurn !== 1 ? "provider attempt policy" : undefined,
    manifest.imageTemplate !== options.imageTemplate ? "image template" : undefined,
    manifest.dockerPlatform !== options.dockerPlatform ? "Docker platform" : undefined,
    manifest.includeHints !== options.includeHints ? "hint policy" : undefined,
    manifest.inferenceWorkers !== options.inferenceWorkers ? "inference workers" : undefined,
    manifest.maxInfrastructureRetries !== options.maxInfrastructureRetries ? "infrastructure retry policy" : undefined,
    manifest.retryBaseDelayMs !== options.retryBaseDelayMs ? "infrastructure retry delay" : undefined,
    JSON.stringify(actualIds) !== JSON.stringify(expectedIds) ? "selected instances" : undefined,
  ].filter((item): item is string => item !== undefined)
  if (mismatches.length > 0) {
    throw new Error(`Existing run configuration differs in ${mismatches.join(", ")}. Use --restart or a new run id.`)
  }
}

export async function verifyPredictionArtifact(
  predictionsPath: string,
  manifestPath: string,
): Promise<{ manifest: PredictionManifest; predictions: readonly SweBenchPrediction[]; digest: string }> {
  const manifest = parsePredictionManifest(JSON.parse(await readFile(manifestPath, "utf8")))
  if (!manifest.complete) throw new Error("Prediction manifest is incomplete; resume inference before evaluation.")
  const content = await readFile(predictionsPath, "utf8")
  const digest = sha256(content)
  if (digest !== manifest.predictionsSha256) {
    throw new Error("Predictions have changed since inference; refusing to evaluate a mismatched artifact.")
  }
  const predictions = parseSweBenchPredictions(await readJsonl(predictionsPath))
  const predictionIds = predictions.map((prediction) => prediction.instance_id)
  if (JSON.stringify(predictionIds) !== JSON.stringify(manifest.completedInstanceIds)) {
    throw new Error("Prediction rows do not match the manifest's completed instance ids.")
  }
  const selectedIds = manifest.selectedInstances.map((instance) => instance.instanceId)
  if (JSON.stringify(predictionIds) !== JSON.stringify(selectedIds)) {
    throw new Error("A complete prediction artifact must contain exactly its selected instances.")
  }
  if (manifest.predictionCount !== predictions.length) {
    throw new Error("Prediction count does not match the manifest.")
  }
  const nonEmptyPatchCount = predictions.filter((prediction) => prediction.model_patch.trim().length > 0).length
  if (manifest.nonEmptyPatchCount !== nonEmptyPatchCount) {
    throw new Error("Non-empty patch count does not match the manifest.")
  }
  return { manifest, predictions, digest }
}

async function installedSweBenchVersion(pythonExecutable: string): Promise<string> {
  const result = await runHostCommand(pythonExecutable, [
    "-c",
    "import importlib.metadata; print(importlib.metadata.version('swebench'))",
  ])
  return result.stdout.trim()
}

async function runEvaluation(options: CliOptions, paths: BenchmarkPaths): Promise<void> {
  const artifact = await verifyPredictionArtifact(paths.predictionsPath, paths.manifestPath)
  if (artifact.manifest.runId !== options.runId) {
    throw new Error(
      `Prediction manifest run id "${artifact.manifest.runId}" does not match requested run id "${options.runId}".`,
    )
  }
  const requestedIds =
    options.instanceIds.length > 0
      ? options.instanceIds
      : artifact.predictions.map((prediction) => prediction.instance_id)
  const available = new Set(artifact.predictions.map((prediction) => prediction.instance_id))
  const missing = requestedIds.filter((instanceId) => !available.has(instanceId))
  if (missing.length > 0) throw new Error(`Prediction artifact does not contain: ${missing.join(", ")}`)

  const args = buildEvaluationArgs({
    datasetName: DATASET_NAME,
    predictionsPath: paths.predictionsPath,
    maxWorkers: options.maxWorkers,
    timeoutSeconds: options.evaluationTimeoutSeconds,
    runId: options.runId,
    instanceIds: requestedIds,
    namespaceEmpty: options.namespaceEmpty,
  })
  if (options.dryRun) {
    console.log(
      JSON.stringify(
        {
          mode: "evaluation",
          predictionsPath: paths.predictionsPath,
          manifestPath: paths.manifestPath,
          predictionsSha256: artifact.digest,
          instanceIds: requestedIds,
          testTimeoutSeconds: options.evaluationTimeoutSeconds,
          command: [options.pythonExecutable, ...args],
        },
        null,
        2,
      ),
    )
    return
  }

  const harnessVersion = await installedSweBenchVersion(options.pythonExecutable)
  if (harnessVersion !== RECOMMENDED_SWEBENCH_VERSION) {
    throw new Error(
      `Expected swebench==${RECOMMENDED_SWEBENCH_VERSION}, found ${harnessVersion}. Install the pinned official harness version before evaluation.`,
    )
  }

  const startedAt = new Date().toISOString()
  await writeJsonAtomic(paths.evaluationManifestPath, {
    schemaVersion: 1,
    benchmark: "swe-bench-verified",
    status: "running",
    dataset: DATASET_NAME,
    runId: options.runId,
    predictionsPath: paths.predictionsPath,
    predictionManifestPath: paths.manifestPath,
    predictionsSha256: artifact.digest,
    swebenchVersion: harnessVersion,
    instanceIds: requestedIds,
    testTimeoutSeconds: options.evaluationTimeoutSeconds,
    command: [options.pythonExecutable, ...args],
    startedAt,
  })
  console.log(`Running official SWE-bench evaluation for ${requestedIds.length} predictions.`)
  const result = await runProcess(options.pythonExecutable, args, {
    cwd: paths.runs,
    timeoutMs: 0,
    env: hostEnv(process.env),
  })
  await writeProcessArtifacts(paths.runs, "evaluation", result)
  await writeJsonAtomic(paths.evaluationManifestPath, {
    schemaVersion: 1,
    benchmark: "swe-bench-verified",
    status: result.exitCode === 0 ? "completed" : "failed",
    dataset: DATASET_NAME,
    runId: options.runId,
    predictionsPath: paths.predictionsPath,
    predictionManifestPath: paths.manifestPath,
    predictionsSha256: artifact.digest,
    swebenchVersion: harnessVersion,
    instanceIds: requestedIds,
    testTimeoutSeconds: options.evaluationTimeoutSeconds,
    command: [options.pythonExecutable, ...args],
    startedAt,
    completedAt: new Date().toISOString(),
    exitCode: result.exitCode,
  })
  assertProcessSucceeded(result, "official SWE-bench evaluation")
}

async function runHostCommand(
  command: string,
  args: readonly string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<ProcessResult> {
  const result = await runProcess(command, args, {
    cwd: options.cwd ?? process.cwd(),
    timeoutMs: options.timeoutMs ?? 0,
    env: hostEnv(process.env),
  })
  if (result.exitCode !== 0) {
    const timeout = result.timedOut ? " (timed out)" : ""
    throw new Error(
      `Command failed${timeout} (${command} ${redactArgs(args).join(" ")}):\n${result.stderr || result.stdout}`,
    )
  }
  return result
}

function runProcess(
  command: string,
  args: readonly string[],
  options: {
    cwd: string
    timeoutMs: number
    env: Record<string, string | undefined>
    stdin?: string
    onStdoutLine?: (line: string) => void
  },
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
    let pendingStdout = ""
    const stdoutDecoder = options.onStdoutLine ? new StringDecoder("utf8") : undefined

    const finish = (exitCode: number): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      pendingStdout += stdoutDecoder?.end() ?? ""
      if (pendingStdout) options.onStdoutLine?.(pendingStdout)
      resolveProcess({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode,
        timedOut,
      })
    }

    const timer =
      options.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true
            killProcessTree(child)
          }, options.timeoutMs)
        : undefined

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout.push(chunk)
      if (!options.onStdoutLine) return
      pendingStdout += stdoutDecoder?.write(chunk) ?? ""
      const lines = pendingStdout.split(/\r?\n/)
      pendingStdout = lines.pop() ?? ""
      for (const line of lines) {
        if (line) options.onStdoutLine(line)
      }
    })
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk))
    child.stdin?.on("error", () => {
      // The child may exit before consuming stdin.
    })
    if (options.stdin !== undefined) child.stdin?.end(options.stdin)
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

function assertProcessSucceeded(result: ProcessResult, operation: string): void {
  if (result.exitCode === 0) return
  const timeout = result.timedOut ? " (timed out)" : ""
  throw new Error(`Failed to ${operation}${timeout}: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`)
}

async function writeProcessArtifacts(
  directory: string,
  prefix: string,
  result: ProcessResult,
  stdoutExtension = "txt",
): Promise<void> {
  await Promise.all([
    writeFileAtomic(join(directory, `${prefix}.stdout.${stdoutExtension}`), result.stdout),
    writeFileAtomic(join(directory, `${prefix}.stderr.txt`), result.stderr),
  ])
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
  ]
  const out: Record<string, string | undefined> = {}
  for (const key of keep) {
    if (env[key] !== undefined) out[key] = env[key]
  }
  return out
}

function dockerClientEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const out = hostEnv(env)
  for (const key of PROVIDER_ENV_KEYS) {
    if (env[key] !== undefined) out[key] = env[key]
  }
  return out
}

function redactArgs(args: readonly string[]): readonly string[] {
  return args.map((arg) => {
    const key = PROVIDER_ENV_KEYS.find((candidate) => arg.startsWith(`${candidate}=`))
    return key ? `${key}=<redacted>` : arg
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function preflightInference(options: CliOptions): Promise<void> {
  if (options.model.startsWith("openrouter/") && !process.env.OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is required for the selected OpenRouter model.")
  }
  await runHostCommand("docker", ["version", "--format", "{{.Server.Version}}"], {
    timeoutMs: DEFAULT_DOCKER_COMMAND_TIMEOUT_MS,
  })
}

async function runInference(options: CliOptions, paths: BenchmarkPaths): Promise<void> {
  console.log(`Fetching ${DATASET_NAME} instances...`)
  const rows = await fetchSweBenchRows(options)
  if (options.listInstances || options.dryRun) {
    const plan = rows.map((row) => ({
      instanceId: row.instance_id,
      repo: row.repo,
      baseCommit: row.base_commit,
      image: officialSweBenchImage(row.instance_id, options.imageTemplate),
    }))
    if (options.listInstances) {
      for (const row of rows) console.log(`${row.instance_id}\t${row.repo}\t${row.difficulty ?? "unknown"}`)
    }
    if (options.dryRun) {
      console.log(
        JSON.stringify(
          {
            mode: "inference",
            runId: options.runId,
            model: options.model,
            opencodeVersion: options.opencodeVersion,
            dockerPlatform: options.dockerPlatform,
            inferenceWorkers: options.inferenceWorkers,
            maxInfrastructureRetries: options.maxInfrastructureRetries,
            retryBaseDelayMs: options.retryBaseDelayMs,
            instances: plan,
          },
          null,
          2,
        ),
      )
    }
    return
  }

  await preflightInference(options)
  if (options.restart) await rm(paths.runs, { recursive: true, force: true })
  await mkdir(paths.runs, { recursive: true })

  const progress = await loadExistingProgress(options, paths, rows)
  if (options.traceDir && progress.summaries.length > 0) {
    throw new Error("Tracing requires a fresh benchmark run; use --restart or a new --run-id instead of resuming.")
  }
  const traceRun = options.traceDir ? createTraceRun(options.traceDir, "swe-bench-verified", "opencode") : undefined
  const effectiveOptions = traceRun ? { ...options, traceRun } : options
  await writeJsonlAtomic(paths.datasetPath, rows.map(datasetArtifactRow))
  const summariesById = new Map<string, JsonObject>()
  for (const summary of progress.summaries) {
    if (typeof summary.instanceId !== "string") throw new Error("Checkpoint summary is missing its instance id.")
    summariesById.set(summary.instanceId, summary)
  }
  const predictionsById = new Map(progress.predictions.map((prediction) => [prediction.instance_id, prediction]))
  const orderedProgress = (): { summaries: JsonObject[]; predictions: SweBenchPrediction[] } => ({
    summaries: rows.flatMap((row) => {
      const summary = summariesById.get(row.instance_id)
      return summary ? [summary] : []
    }),
    predictions: rows.flatMap((row) => {
      const prediction = predictionsById.get(row.instance_id)
      return prediction ? [prediction] : []
    }),
  })
  let ordered = orderedProgress()
  await writeRunProgress(effectiveOptions, paths, rows, ordered.summaries, ordered.predictions, false)

  const work = rows
    .filter((row) => !predictionsById.has(row.instance_id))
    .map((row) => ({ item: row, initialAttempt: progress.initialAttempts.get(row.instance_id) ?? 1 }))
  for (const row of rows) {
    if (predictionsById.has(row.instance_id)) console.log(`Skipping completed instance ${row.instance_id}.`)
  }

  await runEvaluationOrchestrator({
    items: work,
    concurrency: options.inferenceWorkers,
    maxInfrastructureRetries: options.maxInfrastructureRetries,
    retryBaseDelayMs: options.retryBaseDelayMs,
    runAttempt: async (row, context) => {
      console.log(`\n=== ${row.instance_id} (${row.repo}) ===`)
      return runInstanceAttempt(row, effectiveOptions, paths, context)
    },
    onRetry: async (row, retry, context, nextDelayMs) => {
      console.warn(
        `Retrying ${row.instance_id} after ${retry.category} on attempt ${context.attempt}/${context.maxAttempts}; waiting ${nextDelayMs}ms.`,
      )
      await writeJsonAtomic(join(paths.runs, row.instance_id, "retry-state.json"), {
        instanceId: row.instance_id,
        failedAttempt: context.attempt,
        maxAttempts: context.maxAttempts,
        category: retry.category,
        reason: retry.reason,
        nextDelayMs,
        recordedAt: new Date().toISOString(),
      })
    },
    onComplete: async (row, completion) => {
      const finalized = await finalizeInstanceOutcome(row, paths, completion)
      summariesById.set(row.instance_id, finalized.summary)
      predictionsById.set(row.instance_id, finalized.prediction)
      await rm(join(paths.runs, row.instance_id, "retry-state.json"), { force: true })
      ordered = orderedProgress()
      await writeRunProgress(effectiveOptions, paths, rows, ordered.summaries, ordered.predictions, false)
    },
  })

  ordered = orderedProgress()
  await writeRunProgress(effectiveOptions, paths, rows, ordered.summaries, ordered.predictions, true)
  if (traceRun) {
    try {
      finalizeTraceRun(
        traceRun,
        new DirectTraceHarness({
          instanceIds: rows.map((row) => row.instance_id),
          strategy: effectiveOptions.instanceIds.length > 0 ? "explicit_ids" : "ordered_window",
        }),
      )
    } catch {
      console.warn("OpenCode benchmark trace run index could not be finalized; benchmark outputs remain valid.")
    }
  }
  if (traceRun) console.log(`Wrote benchmark traces: ${traceRun.root}`)
  console.log(`\nWrote predictions: ${paths.predictionsPath}`)
  console.log(`Wrote immutable prediction manifest: ${paths.manifestPath}`)
  console.log(`Wrote summary: ${paths.summaryPath}`)
  console.log("Inference is complete. Run bench:swe-verified:eval separately on a Docker-capable machine.")
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2), await readLocalOpencodeVersion())
  if (options.help) {
    console.log(usage())
    return
  }

  const paths = buildPaths(options)
  if (options.evaluateOnly) {
    await mkdir(paths.runs, { recursive: true })
    await runEvaluation(options, paths)
    return
  }
  const identity = await benchmarkSourceIdentity()
  if (options.dryRun || options.listInstances) {
    console.log(`Exact opencode source revision: ${identity.commit}`)
    await runInference({ ...options, opencodeVersion: identity.version }, paths)
    return
  }
  const runtime = await ensureBenchmarkRuntime(identity)
  await runInference({ ...options, opencodeVersion: runtime.version, runtime }, paths)
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(errorMessage(error))
    process.exitCode = 1
  })
}
