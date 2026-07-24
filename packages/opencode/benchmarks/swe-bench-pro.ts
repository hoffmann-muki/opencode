/**
 * Benchmark opencode on SWE-bench Pro.
 *
 * Inference and evaluation are intentionally separate:
 * - inference runs opencode inside the official per-instance SWE-bench Pro image;
 * - evaluation consumes an immutable predictions artifact with Scale's pinned
 *   official harness on a Docker-capable machine.
 */

import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
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

const DATASET_NAME = "ScaleAI/SWE-bench_Pro"
const DATASET_CONFIG = "default"
const DATASET_SPLIT = "test"
const HUGGING_FACE_ROWS_URL = "https://datasets-server.huggingface.co/rows"
const DEFAULT_RUN_ROOT = ".benchmark-runs/swe-bench-pro"
const DEFAULT_SMOKE_INSTANCE_ID =
  "instance_qutebrowser__qutebrowser-5fdc83e5da6222fe61163395baaad7ae57fa2cb4-v363c8a7e5ccdf6968fc7ab84a2053ac78036691d"
const DEFAULT_MAX_INSTANCES = 1
const DEFAULT_MAX_WORKERS = 1
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
const DEFAULT_DOCKERHUB_USERNAME = "jefzda"
const DEFAULT_IMAGE_PREFIX = `docker.io/${DEFAULT_DOCKERHUB_USERNAME}/sweap-images`
const OFFICIAL_HARNESS_REPOSITORY = "https://github.com/scaleapi/SWE-bench_Pro-os.git"
const OFFICIAL_HARNESS_REF = "0c64e26f00b9c190432de7fc520c8ceed5c25518"
const CONTAINER_WORKDIR = "/app"
const DATASET_PAGE_SIZE = 100
const DATASET_FETCH_ATTEMPTS = 3
const DATASET_FETCH_RETRY_MS = 1_000
const MANIFEST_SCHEMA_VERSION = 2
const OPENCODE_PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const REPO_ROOT = resolve(OPENCODE_PACKAGE_ROOT, "../..")
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

export interface SweBenchProRow {
  readonly repo: string
  readonly instance_id: string
  readonly base_commit: string
  readonly problem_statement: string
  readonly requirements: string
  readonly interface: string
  readonly repo_language: string
  readonly dockerhub_tag: string
}

interface CliOptions {
  readonly maxInstances: number
  readonly offset: number
  readonly instanceIds: readonly string[]
  readonly outputDir: string
  readonly runId: string
  readonly evaluateOnly: boolean
  readonly maxWorkers: number
  readonly inferenceWorkers: number
  readonly maxInfrastructureRetries: number
  readonly retryBaseDelayMs: number
  readonly harnessDir?: string
  readonly evaluationInstancesPath?: string
  readonly useLocalDocker: boolean
  readonly dockerPlatform: string
  readonly dockerhubUsername: string
  readonly blockNetwork: boolean
  readonly redo: boolean
  readonly listInstances: boolean
  readonly predictionsPath?: string
  readonly manifestPath?: string
  readonly model: string
  readonly agent: string
  readonly timeoutMs: number
  readonly setupTimeoutMs: number
  readonly opencodeVersion: string
  readonly runtime?: BenchmarkRuntime
  readonly imagePrefix: string
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
  readonly evaluationDatasetPath: string
  readonly evaluationOutput: string
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
  readonly prediction: SweBenchProPrediction
  readonly infrastructureRetry?: InfrastructureRetry
}

interface ExistingProgress {
  readonly summaries: readonly JsonObject[]
  readonly predictions: readonly SweBenchProPrediction[]
  readonly initialAttempts: ReadonlyMap<string, number>
}

export interface SweBenchProPredictionManifest {
  readonly schemaVersion: number
  readonly benchmark: "swe-bench-pro"
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
  readonly inferenceRuntime: "official-swebench-pro-instance-image"
  readonly imagePrefix: string
  readonly dockerPlatform: string
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
    "Run opencode on SWE-bench Pro.",
    "",
    "Inference:",
    "  bun run bench:swe-pro:infer -- [flags]",
    "",
    "Official local Docker/Modal evaluation:",
    "  bun run bench:swe-pro:eval -- --run-id ID [flags]",
    "",
    "Flags:",
    `  --max-instances N          Dataset-window size; overrides the default smoke instance. Default: ${DEFAULT_MAX_INSTANCES}.`,
    "  --offset N                 Dataset offset; overrides the default smoke instance.",
    `  --instance-id ID           Specific instance; repeatable. Inference default: ${DEFAULT_SMOKE_INSTANCE_ID}.`,
    "  --run-id ID                Stable inference/evaluation run id.",
    "  --output-dir DIR           Output directory. Default: .benchmark-runs/swe-bench-pro.",
    "  --evaluate-only            Evaluate a completed predictions artifact and exit.",
    "  --predictions-path PATH    Existing Pro predictions JSON array to evaluate.",
    "  --manifest-path PATH       Matching prediction manifest for external predictions.",
    "  --evaluation-instances-path PATH  Evaluator JSONL; defaults to the run artifact.",
    "  --harness-dir DIR          Pinned checkout of scaleapi/SWE-bench_Pro-os.",
    "  --max-workers N            Official evaluation workers. Default: 1.",
    "  --inference-workers N      Concurrent local inference instances. Default: 1.",
    `  --max-infrastructure-retries N  Fresh retries for transient infrastructure failures. Default: ${DEFAULT_MAX_INFRASTRUCTURE_RETRIES}; max: ${MAX_INFRASTRUCTURE_RETRIES}.`,
    `  --retry-base-delay-ms N   Exponential retry base delay. Default: ${DEFAULT_RETRY_BASE_DELAY_MS}.`,
    "  --use-local-docker         Use the evaluator's local Docker mode. Default.",
    "  --no-use-local-docker      Use the evaluator's Modal mode instead.",
    `  --docker-platform NAME     Inference/evaluator platform. Default: ${DEFAULT_DOCKER_PLATFORM}.`,
    `  --dockerhub-username ID    Official evaluator image owner. Default: ${DEFAULT_DOCKERHUB_USERNAME}.`,
    "  --image-prefix VALUE       Official inference image prefix override.",
    "  --block-network            Block network access inside evaluation containers.",
    "  --redo                     Re-run evaluator outputs that already exist.",
    "  --list-instances           Print selected instances without running inference.",
    "  --model MODEL              opencode model in provider/model format.",
    `  --agent AGENT              Primary opencode agent. Default: ${DEFAULT_AGENT}.`,
    `  --timeout-ms N             Per-instance agent timeout. Default: ${DEFAULT_OPENCODE_TIMEOUT_MS}.`,
    `  --setup-timeout-ms N       Per-instance runtime setup timeout. Default: ${DEFAULT_SETUP_TIMEOUT_MS}.`,
    "  The agent runtime is built from the exact clean opencode checkout and cached by commit.",
    "  --keep-failed-containers   Keep failed inference containers for debugging.",
    "  --restart                  Replace existing artifacts for this run id.",
    "  --no-pure                  Allow external opencode plugins.",
    "  --python PATH              Python executable for official evaluation. Default: python.",
    "  --trace-dir DIR           Opt-in benchmark-trace/v1 output base; each invocation creates a private trace run.",
    "  --dry-run                  Validate and print planned work without running Docker/harness.",
    "  --help                     Print this message.",
    "",
    "Environment:",
    "  OPENCODE_BENCH_MODEL or OPENCODE_MODEL can set the default model.",
    "  OPENROUTER_MODEL is accepted and normalized to openrouter/<model>.",
    "  OPENCODE_SWEBENCH_PRO_IMAGE_PREFIX can override the official image prefix.",
    "  Provider credentials, such as OPENROUTER_API_KEY, are forwarded to opencode.",
    "  SWE_BENCH_PRO_HARNESS_DIR can set the official evaluator checkout.",
    "",
    "Inference never reads the gold patch, hidden test patch, or evaluator-only",
    "fields. Evaluation is a separate operation over the frozen prediction artifact.",
  ].join("\n")
}

export function parseArgs(argv: readonly string[], defaultOpencodeVersion = "latest"): CliOptions {
  let maxInstances = DEFAULT_MAX_INSTANCES
  let offset = 0
  const instanceIds: string[] = []
  let datasetSelectionWasSet = false
  let outputDir = DEFAULT_RUN_ROOT
  let runId = `swe-pro-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`
  let evaluateOnly = false
  let maxWorkers = DEFAULT_MAX_WORKERS
  let inferenceWorkers = DEFAULT_INFERENCE_WORKERS
  let maxInfrastructureRetries = DEFAULT_MAX_INFRASTRUCTURE_RETRIES
  let retryBaseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS
  let harnessDir = process.env.SWE_BENCH_PRO_HARNESS_DIR
  let evaluationInstancesPath: string | undefined
  let useLocalDocker = true
  let dockerPlatform = DEFAULT_DOCKER_PLATFORM
  let dockerhubUsername = DEFAULT_DOCKERHUB_USERNAME
  let imagePrefix = process.env.OPENCODE_SWEBENCH_PRO_IMAGE_PREFIX ?? DEFAULT_IMAGE_PREFIX
  let blockNetwork = false
  let redo = false
  let listInstances = false
  let predictionsPath: string | undefined
  let manifestPath: string | undefined
  let model = resolveDefaultModel()
  let agent = DEFAULT_AGENT
  let timeoutMs = DEFAULT_OPENCODE_TIMEOUT_MS
  let setupTimeoutMs = DEFAULT_SETUP_TIMEOUT_MS
  const opencodeVersion = defaultOpencodeVersion
  let keepFailedContainers = false
  let restart = false
  let pure = true
  let pythonExecutable = "python"
  let traceDir: string | undefined
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
    } else if (arg === "--evaluate-only") {
      evaluateOnly = true
    } else if (arg === "--predictions-path") {
      predictionsPath = nextValue(i, arg)
      i += 1
    } else if (arg === "--manifest-path") {
      manifestPath = nextValue(i, arg)
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
    } else if (arg === "--use-local-docker") {
      useLocalDocker = true
    } else if (arg === "--no-use-local-docker") {
      useLocalDocker = false
    } else if (arg === "--docker-platform") {
      dockerPlatform = nextValue(i, arg)
      i += 1
    } else if (arg === "--dockerhub-username") {
      dockerhubUsername = nextValue(i, arg)
      i += 1
    } else if (arg === "--image-prefix") {
      imagePrefix = nextValue(i, arg)
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
    } else if (arg === "--setup-timeout-ms") {
      setupTimeoutMs = parsePositiveInt(nextValue(i, arg), arg)
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
    } else if (arg === "--dry-run") {
      dryRun = true
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  if (new Set(instanceIds).size !== instanceIds.length) {
    throw new Error("Duplicate --instance-id values are not allowed.")
  }
  if (evaluateOnly && traceDir) throw new Error("--trace-dir is available only during inference.")
  officialSweBenchProImage("sample-tag", imagePrefix)

  return {
    maxInstances,
    offset,
    instanceIds: !evaluateOnly && !datasetSelectionWasSet ? [DEFAULT_SMOKE_INSTANCE_ID] : instanceIds,
    outputDir,
    runId,
    evaluateOnly,
    maxWorkers,
    inferenceWorkers,
    maxInfrastructureRetries,
    retryBaseDelayMs,
    ...(harnessDir !== undefined ? { harnessDir: resolvePathFromRepoRoot(harnessDir) } : {}),
    ...(evaluationInstancesPath !== undefined ? { evaluationInstancesPath } : {}),
    useLocalDocker,
    dockerPlatform,
    dockerhubUsername,
    imagePrefix,
    blockNetwork,
    redo,
    listInstances,
    ...(predictionsPath !== undefined ? { predictionsPath } : {}),
    ...(manifestPath !== undefined ? { manifestPath } : {}),
    model,
    agent,
    timeoutMs,
    setupTimeoutMs,
    opencodeVersion,
    keepFailedContainers,
    restart,
    pure,
    pythonExecutable,
    ...(traceDir !== undefined ? { traceDir } : {}),
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
  const manifestPath =
    options.manifestPath === undefined
      ? join(runs, "prediction-manifest.json")
      : resolvePathFromRepoRoot(options.manifestPath)
  const evaluationDatasetPath =
    options.evaluationInstancesPath === undefined
      ? join(runs, "evaluation-instances.jsonl")
      : resolvePathFromRepoRoot(options.evaluationInstancesPath)
  return {
    root,
    runs,
    predictionsPath,
    manifestPath,
    summaryPath: join(runs, "summary.json"),
    datasetPath: join(runs, "instances.jsonl"),
    evaluationDatasetPath,
    evaluationOutput: join(runs, "evaluation"),
    evaluationManifestPath: join(runs, "evaluation-manifest.json"),
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
  return (await fetchRawRowsPage(offset, length)).map(parseSweBenchProRow)
}

async function fetchRawRowsPage(offset: number, length: number): Promise<readonly JsonObject[]> {
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
        throw new Error("SWE-bench Pro dataset response is missing its rows array.")
      }
      return parsed.rows.map((item, index) => {
        if (!isObject(item) || !isObject(item.row)) {
          throw new Error(`SWE-bench Pro dataset row ${index + 1} is malformed.`)
        }
        return item.row
      })
    }

    const message = `Failed to fetch SWE-bench Pro rows (${response.status}): ${await response.text()}`
    const retryable = response.status === 429 || response.status >= 500
    if (!retryable || attempt === DATASET_FETCH_ATTEMPTS) throw new Error(message)
    await delay(DATASET_FETCH_RETRY_MS * attempt)
  }

  throw new Error("SWE-bench Pro dataset fetch exhausted without a response.")
}

async function fetchEvaluationRows(instanceIds: readonly string[]): Promise<readonly JsonObject[]> {
  const wanted = new Set(instanceIds)
  const found = new Map<string, JsonObject>()

  for (let offset = 0; found.size < wanted.size; offset += DATASET_PAGE_SIZE) {
    const rows = await fetchRawRowsPage(offset, DATASET_PAGE_SIZE)
    if (rows.length === 0) break
    for (const row of rows) {
      if (typeof row.instance_id === "string" && wanted.has(row.instance_id)) found.set(row.instance_id, row)
    }
  }

  const missing = instanceIds.filter((id) => !found.has(id))
  if (missing.length > 0) throw new Error(`Could not fetch evaluator row(s): ${missing.join(", ")}`)
  return instanceIds.map((id) => found.get(id)!)
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

export function parseSweBenchProRow(value: unknown): SweBenchProRow {
  if (!isObject(value)) throw new Error("SWE-bench Pro row must be an object.")
  return {
    repo: requireStringField(value, "repo", "SWE-bench Pro row"),
    instance_id: requireStringField(value, "instance_id", "SWE-bench Pro row"),
    base_commit: requireStringField(value, "base_commit", "SWE-bench Pro row"),
    problem_statement: requireStringField(value, "problem_statement", "SWE-bench Pro row"),
    requirements: requireStringField(value, "requirements", "SWE-bench Pro row"),
    interface: requireStringField(value, "interface", "SWE-bench Pro row"),
    repo_language: requireStringField(value, "repo_language", "SWE-bench Pro row"),
    dockerhub_tag: requireStringField(value, "dockerhub_tag", "SWE-bench Pro row"),
  }
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
    dockerhub_tag: row.dockerhub_tag,
  }
}

export function formatProblemStatement(
  row: Pick<SweBenchProRow, "problem_statement" | "requirements" | "interface">,
): string {
  return `${row.problem_statement}\n\nRequirements:\n${row.requirements}\n\nNew interfaces introduced:\n${row.interface}`
}

function buildPrompt(row: SweBenchProRow): string {
  return [
    "Resolve this SWE-bench Pro issue using opencode.",
    "",
    `You are running inside the official SWE-bench Pro task image at ${CONTAINER_WORKDIR}.`,
    "Edit the repository files directly; do not merely describe a patch.",
    "Do not seek or use gold patches, hidden tests, or benchmark answer artifacts.",
    "Do not modify tests or benchmark metadata unless the issue explicitly requires it.",
    "",
    benchmarkAgentWorkflowInstructions(),
    "## Repository",
    `Worktree: ${CONTAINER_WORKDIR}`,
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

export function officialSweBenchProImage(dockerhubTag: string, imagePrefix = DEFAULT_IMAGE_PREFIX): string {
  const tag = dockerhubTag.trim()
  if (!tag || /[\s/]/.test(tag)) throw new Error(`Invalid SWE-bench Pro dockerhub_tag: ${dockerhubTag}`)
  const prefix = imagePrefix.trim().replace(/:+$/, "")
  if (!prefix || /\s/.test(prefix)) throw new Error(`Invalid SWE-bench Pro image prefix: ${imagePrefix}`)
  return `${prefix}:${tag}`
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
  row: Pick<SweBenchProRow, "instance_id">,
  options: Pick<CliOptions, "agent" | "model" | "pure" | "traceRun">,
  env: Record<string, string | undefined>,
): readonly string[] {
  const args = ["exec", "-i", "--workdir", CONTAINER_WORKDIR]
  for (const key of PROVIDER_ENV_KEYS) {
    if (env[key] !== undefined) args.push("--env", key)
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
    `SWE-bench Pro ${row.instance_id}`,
    "--thinking",
    "--dangerously-skip-permissions",
  )
  return args
}

function containerName(runId: string, instanceId: string, attempt: number): string {
  const safe = `opencode-swe-pro-${runId}-${instanceId}-attempt-${attempt}`
    .toLowerCase()
    .replaceAll(/[^a-z0-9_.-]+/g, "-")
  return safe.slice(0, 120).replaceAll(/[-_.]+$/g, "") || "opencode-swe-pro-instance"
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

async function ensureOfficialImage(image: string, attemptRunDir: string, setupTimeoutMs: number): Promise<JsonObject> {
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
  await writeProcessArtifacts(attemptRunDir, "image", fetchResult)
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
  row: SweBenchProRow,
  options: CliOptions,
  attemptRunDir: string,
  image: string,
  name: string,
): Promise<JsonObject> {
  const runtime = requireBenchmarkRuntime(options)
  const imageMetadata = await ensureOfficialImage(image, attemptRunDir, options.setupTimeoutMs)
  const staleCleanup = await runProcess("docker", ["rm", "--force", name], {
    cwd: REPO_ROOT,
    timeoutMs: 30_000,
    env: hostEnv(process.env),
  })
  await writeProcessArtifacts(attemptRunDir, "stale-container-cleanup", staleCleanup)
  if (staleCleanup.exitCode !== 0 && !/no such container/i.test(staleCleanup.stderr)) {
    assertProcessSucceeded(staleCleanup, `remove stale inference container ${name}`)
  }

  const started = await runProcess("docker", buildDockerRunArgs(name, image, options.dockerPlatform), {
    cwd: REPO_ROOT,
    timeoutMs: options.setupTimeoutMs,
    env: hostEnv(process.env),
  })
  await writeProcessArtifacts(attemptRunDir, "container-start", started)
  assertProcessSucceeded(started, `start inference container ${name}`)

  try {
    const runtimeDirectory = await runProcess("docker", ["exec", name, "mkdir", "-p", "/usr/local/bin"], {
      cwd: REPO_ROOT,
      timeoutMs: options.setupTimeoutMs,
      env: hostEnv(process.env),
    })
    await writeProcessArtifacts(attemptRunDir, "runtime-directory", runtimeDirectory)
    assertProcessSucceeded(runtimeDirectory, "create opencode runtime directory")

    const runtimeCopy = await runProcess("docker", ["cp", runtime.binaryPath, `${name}:/usr/local/bin/opencode`], {
      cwd: REPO_ROOT,
      timeoutMs: options.setupTimeoutMs,
      env: hostEnv(process.env),
    })
    await writeProcessArtifacts(attemptRunDir, "runtime-copy", runtimeCopy)
    assertProcessSucceeded(runtimeCopy, `copy opencode runtime ${runtime.commit}`)

    const setup = await runProcess("docker", ["exec", name, "/bin/bash", "-lc", setupScript()], {
      cwd: REPO_ROOT,
      timeoutMs: options.setupTimeoutMs,
      env: hostEnv(process.env),
    })
    await writeProcessArtifacts(attemptRunDir, "runtime-setup", setup)
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
      { cwd: REPO_ROOT, timeoutMs: options.setupTimeoutMs, env: hostEnv(process.env) },
    )
    await writeProcessArtifacts(attemptRunDir, "repository-reset", reset)
    assertProcessSucceeded(reset, `reset repository to ${row.base_commit}`)

    const stagingDir = await mkdtemp(join(tmpdir(), "opencode-swe-pro-agents-"))
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
    await removeContainer(name, attemptRunDir)
    throw error
  }

  return imageMetadata
}

function requireBenchmarkRuntime(options: CliOptions): BenchmarkRuntime {
  if (!options.runtime) throw new Error("The exact opencode benchmark runtime has not been prepared.")
  return options.runtime
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

export async function captureContainerPatch(name: string): Promise<CapturedPatch> {
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

async function stopTimedOutWork(name: string, attemptRunDir: string): Promise<void> {
  const stopped = await runProcess("docker", ["stop", "--time", "1", name], {
    cwd: REPO_ROOT,
    timeoutMs: 30_000,
    env: hostEnv(process.env),
  })
  await writeProcessArtifacts(attemptRunDir, "timeout-stop", stopped)
  if (stopped.exitCode !== 0) return
  const restarted = await runProcess("docker", ["start", name], {
    cwd: REPO_ROOT,
    timeoutMs: 30_000,
    env: hostEnv(process.env),
  })
  await writeProcessArtifacts(attemptRunDir, "timeout-restart", restarted)
}

async function removeContainer(name: string, attemptRunDir: string): Promise<void> {
  const result = await runProcess("docker", ["rm", "--force", name], {
    cwd: REPO_ROOT,
    timeoutMs: 30_000,
    env: hostEnv(process.env),
  })
  await writeProcessArtifacts(attemptRunDir, "container-cleanup", result)
}

async function exportRootSession(
  name: string,
  sessionId: string,
  pure: boolean,
  attemptRunDir: string,
): Promise<boolean> {
  const result = await runProcess(
    "docker",
    ["exec", "--workdir", CONTAINER_WORKDIR, name, "opencode", ...(pure ? ["--pure"] : []), "export", sessionId],
    { cwd: REPO_ROOT, timeoutMs: 60_000, env: hostEnv(process.env) },
  )
  await writeProcessArtifacts(attemptRunDir, "session-export", result, "json")
  return result.exitCode === 0
}

function rootSessionId(events: readonly JsonObject[]): string | undefined {
  for (const event of events) {
    if (typeof event.sessionID === "string") return event.sessionID
  }
  return undefined
}

async function runInstanceAttempt(
  row: SweBenchProRow,
  options: CliOptions,
  paths: BenchmarkPaths,
  context: { readonly attempt: number; readonly maxAttempts: number },
): Promise<EvaluationAttempt<InstanceOutcome>> {
  const runtime = requireBenchmarkRuntime(options)
  const instanceRunDir = join(paths.runs, row.instance_id)
  const attemptRunDir = join(instanceRunDir, "attempts", `attempt-${context.attempt}`)
  await rm(attemptRunDir, { recursive: true, force: true })
  await mkdir(attemptRunDir, { recursive: true })

  const prompt = buildPrompt(row)
  const image = officialSweBenchProImage(row.dockerhub_tag, options.imagePrefix)
  const name = containerName(options.runId, row.instance_id, context.attempt)
  const startedAt = new Date().toISOString()
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
        benchmarkRetries: options.maxInfrastructureRetries,
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

  const completedAt = new Date().toISOString()
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
  const prediction: SweBenchProPrediction = {
    instance_id: row.instance_id,
    patch: captured.patch,
    prefix: predictionPrefix(options),
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
    inferenceRuntime: "official-swebench-pro-instance-image",
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

  await writeJsonAtomic(join(attemptRunDir, "prediction.json"), prediction)
  await writeJsonAtomic(join(attemptRunDir, "run.json"), summary)
  await writeJsonAtomic(join(instanceRunDir, "latest-attempt.json"), {
    attempt: context.attempt,
    predictionPath: join(attemptRunDir, "prediction.json"),
    runPath: join(attemptRunDir, "run.json"),
  })

  return {
    value: {
      summary,
      prediction,
      ...(infrastructureRetry !== undefined ? { infrastructureRetry } : {}),
    },
    ...(infrastructureRetry !== undefined ? { retry: infrastructureRetry } : {}),
  }
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

function requireNonNegativeIntegerField(value: JsonObject, field: string, description: string): number {
  const candidate = value[field]
  if (typeof candidate !== "number" || !Number.isInteger(candidate) || candidate < 0) {
    throw new Error(`${description} has invalid integer field "${field}".`)
  }
  return candidate
}

function encodeJsonl(rows: readonly unknown[]): string {
  return rows.map((row) => JSON.stringify(row)).join("\n") + "\n"
}

async function writeFileAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, content, "utf8")
  await rename(temporary, path)
}

async function writeJsonlAtomic(path: string, rows: readonly unknown[]): Promise<void> {
  await writeFileAtomic(path, encodeJsonl(rows))
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`)
}

function encodePredictions(predictions: readonly SweBenchProPrediction[]): string {
  return `${JSON.stringify(predictions, null, 2)}\n`
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex")
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
    const prediction: SweBenchProPrediction = {
      instance_id: requireStringField(candidate, "instance_id", `Prediction row ${index + 1}`),
      patch: requireStringField(candidate, "patch", `Prediction row ${index + 1}`),
      prefix: requireStringField(candidate, "prefix", `Prediction row ${index + 1}`),
    }
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

function buildPredictionManifest(
  options: CliOptions,
  rows: readonly SweBenchProRow[],
  predictions: readonly SweBenchProPrediction[],
  completedInstanceIds: readonly string[],
  complete: boolean,
  predictionsContent: string,
): SweBenchProPredictionManifest {
  const runtime = requireBenchmarkRuntime(options)
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    benchmark: "swe-bench-pro",
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
    inferenceRuntime: "official-swebench-pro-instance-image",
    imagePrefix: options.imagePrefix,
    dockerPlatform: options.dockerPlatform,
    inferenceWorkers: options.inferenceWorkers,
    maxInfrastructureRetries: options.maxInfrastructureRetries,
    retryBaseDelayMs: options.retryBaseDelayMs,
    selectedInstances: rows.map((row) => ({
      instanceId: row.instance_id,
      repo: row.repo,
      baseCommit: row.base_commit,
      image: officialSweBenchProImage(row.dockerhub_tag, options.imagePrefix),
    })),
    completedInstanceIds,
    complete,
    predictionCount: predictions.length,
    nonEmptyPatchCount: predictions.filter((prediction) => prediction.patch.trim().length > 0).length,
    predictionsSha256: sha256(predictionsContent),
    generatedAt: new Date().toISOString(),
  }
}

function parsePredictionManifest(value: unknown): SweBenchProPredictionManifest {
  if (!isObject(value)) throw new Error("SWE-bench Pro prediction manifest must be an object.")
  const requiredStrings = [
    "benchmark",
    "dataset",
    "datasetConfig",
    "datasetSplit",
    "runId",
    "model",
    "agent",
    "opencodeVersion",
    "inferenceRuntime",
    "imagePrefix",
    "dockerPlatform",
    "predictionsSha256",
    "generatedAt",
  ] as const
  for (const field of requiredStrings) {
    if (typeof value[field] !== "string") throw new Error(`Prediction manifest is missing string field "${field}".`)
  }
  const schemaVersion = requireNonNegativeIntegerField(value, "schemaVersion", "Prediction manifest")
  const inferenceWorkers = requireNonNegativeIntegerField(value, "inferenceWorkers", "Prediction manifest")
  const maxInfrastructureRetries = requireNonNegativeIntegerField(
    value,
    "maxInfrastructureRetries",
    "Prediction manifest",
  )
  const retryBaseDelayMs = requireNonNegativeIntegerField(value, "retryBaseDelayMs", "Prediction manifest")
  const predictionCount = requireNonNegativeIntegerField(value, "predictionCount", "Prediction manifest")
  const nonEmptyPatchCount = requireNonNegativeIntegerField(value, "nonEmptyPatchCount", "Prediction manifest")
  if (schemaVersion !== 1 && schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new Error(`Unsupported SWE-bench Pro prediction manifest schema: ${schemaVersion}.`)
  }
  const opencodeCommit =
    schemaVersion === MANIFEST_SCHEMA_VERSION
      ? requireStringField(value, "opencodeCommit", "Prediction manifest")
      : "legacy-unrecorded"
  const opencodeBinarySha256 =
    schemaVersion === MANIFEST_SCHEMA_VERSION
      ? requireStringField(value, "opencodeBinarySha256", "Prediction manifest")
      : "legacy-unrecorded"
  const providerAttemptsPerTurn =
    schemaVersion === MANIFEST_SCHEMA_VERSION && typeof value.providerAttemptsPerTurn === "number"
      ? value.providerAttemptsPerTurn
      : 0
  if (
    schemaVersion === MANIFEST_SCHEMA_VERSION &&
    (!/^[a-f0-9]{40}$/.test(opencodeCommit) ||
      !/^[a-f0-9]{64}$/.test(opencodeBinarySha256) ||
      providerAttemptsPerTurn !== 1)
  ) {
    throw new Error("Prediction manifest has invalid agent provenance or provider-attempt metadata.")
  }
  if (
    value.benchmark !== "swe-bench-pro" ||
    value.dataset !== DATASET_NAME ||
    value.datasetConfig !== DATASET_CONFIG ||
    value.datasetSplit !== DATASET_SPLIT ||
    value.inferenceRuntime !== "official-swebench-pro-instance-image"
  ) {
    throw new Error("Prediction manifest does not describe this SWE-bench Pro runner.")
  }
  if (typeof value.complete !== "boolean") throw new Error('Prediction manifest is missing boolean field "complete".')
  if (!Array.isArray(value.completedInstanceIds) || !value.completedInstanceIds.every((id) => typeof id === "string")) {
    throw new Error("Prediction manifest has invalid completedInstanceIds.")
  }
  if (!Array.isArray(value.selectedInstances)) throw new Error("Prediction manifest has invalid selectedInstances.")
  const selectedInstances = value.selectedInstances.map((candidate, index) => {
    if (!isObject(candidate)) throw new Error(`Selected instance ${index + 1} must be an object.`)
    for (const field of ["instanceId", "repo", "baseCommit", "image"] as const) {
      if (typeof candidate[field] !== "string") {
        throw new Error(`Selected instance ${index + 1} is missing string field "${field}".`)
      }
    }
    return {
      instanceId: requireStringField(candidate, "instanceId", `Selected instance ${index + 1}`),
      repo: requireStringField(candidate, "repo", `Selected instance ${index + 1}`),
      baseCommit: requireStringField(candidate, "baseCommit", `Selected instance ${index + 1}`),
      image: requireStringField(candidate, "image", `Selected instance ${index + 1}`),
    }
  })
  const selectedIds = selectedInstances.map((item) => item.instanceId)
  if (new Set(selectedIds).size !== selectedIds.length)
    throw new Error("Prediction manifest has duplicate selected instances.")
  const completedIds = value.completedInstanceIds
  if (new Set(completedIds).size !== completedIds.length) {
    throw new Error("Prediction manifest has duplicate completed instances.")
  }
  if (completedIds.some((id) => !selectedIds.includes(id))) {
    throw new Error("Prediction manifest completes an instance outside its selected set.")
  }
  return {
    schemaVersion,
    benchmark: "swe-bench-pro",
    dataset: DATASET_NAME,
    datasetConfig: DATASET_CONFIG,
    datasetSplit: DATASET_SPLIT,
    runId: requireStringField(value, "runId", "Prediction manifest"),
    model: requireStringField(value, "model", "Prediction manifest"),
    agent: requireStringField(value, "agent", "Prediction manifest"),
    opencodeVersion: requireStringField(value, "opencodeVersion", "Prediction manifest"),
    opencodeCommit,
    opencodeBinarySha256,
    providerAttemptsPerTurn,
    inferenceRuntime: "official-swebench-pro-instance-image",
    imagePrefix: requireStringField(value, "imagePrefix", "Prediction manifest"),
    dockerPlatform: requireStringField(value, "dockerPlatform", "Prediction manifest"),
    inferenceWorkers,
    maxInfrastructureRetries,
    retryBaseDelayMs,
    selectedInstances,
    completedInstanceIds: completedIds,
    complete: value.complete,
    predictionCount,
    nonEmptyPatchCount,
    predictionsSha256: requireStringField(value, "predictionsSha256", "Prediction manifest"),
    generatedAt: requireStringField(value, "generatedAt", "Prediction manifest"),
  }
}

export async function verifyPredictionArtifact(
  predictionsPath: string,
  manifestPath: string,
): Promise<{
  readonly predictions: readonly SweBenchProPrediction[]
  readonly manifest: SweBenchProPredictionManifest
  readonly digest: string
}> {
  const [predictionsContent, manifestContent] = await Promise.all([
    readFile(predictionsPath, "utf8"),
    readFile(manifestPath, "utf8"),
  ])
  const manifest = parsePredictionManifest(JSON.parse(manifestContent) as unknown)
  if (!manifest.complete) throw new Error("Prediction manifest is incomplete; finish inference before evaluation.")
  const predictions = parseSweBenchProPredictions(JSON.parse(predictionsContent) as unknown)
  const digest = sha256(predictionsContent)
  if (digest !== manifest.predictionsSha256) {
    throw new Error("Predictions have changed since inference; refusing to evaluate a mutable artifact.")
  }
  if (manifest.predictionCount !== predictions.length)
    throw new Error("Prediction manifest count does not match predictions.")
  const nonEmptyCount = predictions.filter((prediction) => prediction.patch.trim().length > 0).length
  if (manifest.nonEmptyPatchCount !== nonEmptyCount) {
    throw new Error("Prediction manifest non-empty patch count does not match predictions.")
  }
  const predictionIds = predictions.map((prediction) => prediction.instance_id)
  if (predictionIds.join("\n") !== manifest.completedInstanceIds.join("\n")) {
    throw new Error("Prediction order does not match the completed instance manifest.")
  }
  if (manifest.completedInstanceIds.length !== manifest.selectedInstances.length) {
    throw new Error("Completed prediction artifact does not cover every selected instance.")
  }
  return { predictions, manifest, digest }
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

async function validatePinnedHarness(harnessDir: string): Promise<void> {
  const evaluator = join(harnessDir, "swe_bench_pro_eval.py")
  const scriptsDir = join(harnessDir, "run_scripts")
  await Promise.all([access(evaluator), access(scriptsDir)])
  const head = await runHostCommand("git", ["-C", harnessDir, "rev-parse", "HEAD"])
  if (head.stdout.trim() !== OFFICIAL_HARNESS_REF) {
    throw new Error(
      `SWE-bench Pro harness must be pinned to ${OFFICIAL_HARNESS_REF}; found ${head.stdout.trim() || "unknown"}.`,
    )
  }
}

async function ensurePinnedHarness(options: CliOptions): Promise<string> {
  if (options.harnessDir) {
    await validatePinnedHarness(options.harnessDir)
    return options.harnessDir
  }

  const harnessDir = join(homedir(), ".cache", "opencode-benchmarks", "swe-bench-pro", OFFICIAL_HARNESS_REF)
  if (await pathExists(harnessDir)) {
    try {
      await validatePinnedHarness(harnessDir)
      return harnessDir
    } catch {
      await rm(harnessDir, { recursive: true, force: true })
    }
  }

  const parent = dirname(harnessDir)
  await mkdir(parent, { recursive: true })
  const temporaryRoot = await mkdtemp(join(parent, ".harness-"))
  const temporaryCheckout = join(temporaryRoot, "checkout")
  try {
    await runHostCommand("git", [
      "clone",
      "--quiet",
      "--filter=blob:none",
      OFFICIAL_HARNESS_REPOSITORY,
      temporaryCheckout,
    ])
    await runHostCommand("git", ["-C", temporaryCheckout, "checkout", "--quiet", "--detach", OFFICIAL_HARNESS_REF])
    await validatePinnedHarness(temporaryCheckout)
    await rename(temporaryCheckout, harnessDir)
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
  return harnessDir
}

async function runEvaluation(
  options: CliOptions,
  paths: BenchmarkPaths,
  artifact: Awaited<ReturnType<typeof verifyPredictionArtifact>>,
): Promise<void> {
  const harnessDir = await ensurePinnedHarness(options)
  const evaluator = join(harnessDir, "swe_bench_pro_eval.py")
  const scriptsDir = join(harnessDir, "run_scripts")
  const instanceIds = artifact.manifest.selectedInstances.map((instance) => instance.instanceId)
  const evaluationRows = await fetchEvaluationRows(instanceIds)
  await writeJsonlAtomic(paths.evaluationDatasetPath, evaluationRows)
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
    dockerPlatform: options.dockerPlatform,
    blockNetwork: options.blockNetwork,
    redo: options.redo,
  })

  const evaluationRecord = {
    benchmark: "swe-bench-pro",
    runId: artifact.manifest.runId,
    predictionsPath: paths.predictionsPath,
    predictionManifestPath: paths.manifestPath,
    predictionsSha256: artifact.digest,
    officialHarnessRepository: OFFICIAL_HARNESS_REPOSITORY,
    officialHarnessRef: OFFICIAL_HARNESS_REF,
    officialHarnessDir: harnessDir,
    evaluationInstancesPath: paths.evaluationDatasetPath,
    evaluationInstancesSha256: sha256(await readFile(paths.evaluationDatasetPath, "utf8")),
    evaluationOutput: paths.evaluationOutput,
    evaluatorArgs: args,
    plannedAt: new Date().toISOString(),
  }
  await writeJsonAtomic(paths.evaluationManifestPath, {
    ...evaluationRecord,
    status: options.dryRun ? "dry-run" : "running",
  })

  console.log(`Running SWE-bench Pro evaluation: ${options.pythonExecutable} ${args.join(" ")}`)
  if (options.dryRun) return

  const result = await runProcess(options.pythonExecutable, args, {
    cwd: harnessDir,
    timeoutMs: 0,
    env: hostEnv(process.env),
  })
  await writeProcessArtifacts(paths.runs, "official-evaluation", result)
  await writeJsonAtomic(paths.evaluationManifestPath, {
    ...evaluationRecord,
    status: result.exitCode === 0 ? "completed" : "failed",
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    completedAt: new Date().toISOString(),
    stdoutPath: join(paths.runs, "official-evaluation.stdout.txt"),
    stderrPath: join(paths.runs, "official-evaluation.stderr.txt"),
  })
  assertProcessSucceeded(result, "official SWE-bench Pro evaluation")
}

async function runEvaluationOnly(options: CliOptions, paths: BenchmarkPaths): Promise<void> {
  const artifact = await verifyPredictionArtifact(paths.predictionsPath, paths.manifestPath)
  if (options.runId !== artifact.manifest.runId) {
    throw new Error(
      `Requested run id ${options.runId} does not match prediction manifest run id ${artifact.manifest.runId}.`,
    )
  }
  console.log(`Evaluating existing SWE-bench Pro predictions: ${paths.predictionsPath}`)
  await runEvaluation(options, paths, artifact)
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
    throw new Error(`Command failed (${command} ${args.join(" ")}):\n${result.stderr || result.stdout}`)
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
    const childStdout = child.stdout
    const childStderr = child.stderr

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

    childStdout?.on("data", (chunk: Buffer) => {
      stdout.push(chunk)
      if (!options.onStdoutLine) return
      pendingStdout += stdoutDecoder?.write(chunk) ?? ""
      const lines = pendingStdout.split(/\r?\n/)
      pendingStdout = lines.pop() ?? ""
      for (const line of lines) {
        if (line) options.onStdoutLine(line)
      }
    })
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

function dockerClientEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const out = hostEnv(env)
  for (const key of PROVIDER_ENV_KEYS) {
    if (env[key] !== undefined) out[key] = env[key]
  }
  return out
}

function assertProcessSucceeded(result: ProcessResult, operation: string): void {
  if (result.exitCode === 0) return
  const timeout = result.timedOut ? " (timed out)" : ""
  throw new Error(`${operation} failed${timeout}:\n${result.stderr || result.stdout}`)
}

async function writeProcessArtifacts(
  directory: string,
  name: string,
  result: ProcessResult,
  stdoutExtension = "txt",
): Promise<void> {
  await Promise.all([
    writeFileAtomic(join(directory, `${name}.stdout.${stdoutExtension}`), result.stdout),
    writeFileAtomic(join(directory, `${name}.stderr.txt`), result.stderr),
    writeJsonAtomic(join(directory, `${name}.process.json`), {
      exitCode: result.exitCode,
      timedOut: result.timedOut,
    }),
  ])
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

async function loadAttemptHistory(instanceRunDir: string, attemptsUsed: number): Promise<readonly JsonObject[]> {
  const history: JsonObject[] = []
  for (let attempt = 1; attempt <= attemptsUsed; attempt += 1) {
    const path = join(instanceRunDir, "attempts", `attempt-${attempt}`, "run.json")
    if (!(await pathExists(path))) continue
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"))
    if (isObject(parsed)) history.push(parsed)
  }
  return history
}

async function finalizeInstanceOutcome(
  row: SweBenchProRow,
  paths: BenchmarkPaths,
  completion: EvaluationCompletion<InstanceOutcome>,
): Promise<InstanceOutcome> {
  const instanceRunDir = join(paths.runs, row.instance_id)
  const attemptHistory = await loadAttemptHistory(instanceRunDir, completion.attemptsUsed)
  const summary: JsonObject = {
    ...completion.value.summary,
    attemptsUsed: completion.attemptsUsed,
    infrastructureRetriesUsed: completion.attemptsUsed - 1,
    infrastructureRetryExhausted: completion.retryExhausted,
    attemptHistory,
    predictionPath: join(instanceRunDir, "prediction.json"),
    runPath: join(instanceRunDir, "run.json"),
  }
  await writeJsonAtomic(join(instanceRunDir, "prediction.json"), completion.value.prediction)
  await writeJsonAtomic(join(instanceRunDir, "run.json"), summary)
  return {
    summary,
    prediction: completion.value.prediction,
    ...(completion.value.infrastructureRetry !== undefined
      ? { infrastructureRetry: completion.value.infrastructureRetry }
      : {}),
  }
}

interface AttemptCheckpoint {
  readonly attempt: number
  readonly outcome: InstanceOutcome
}

export async function loadLatestAttemptCheckpoint(
  row: SweBenchProRow,
  paths: BenchmarkPaths,
  maxAttempts: number,
): Promise<AttemptCheckpoint | undefined> {
  const attemptsDir = join(paths.runs, row.instance_id, "attempts")
  if (!(await pathExists(attemptsDir))) return undefined
  const attempts = (await readdir(attemptsDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^attempt-\d+$/.test(entry.name))
    .map((entry) => Number(entry.name.slice("attempt-".length)))
    .filter((attempt) => Number.isInteger(attempt) && attempt >= 1 && attempt <= maxAttempts)
    .sort((left, right) => right - left)

  for (const attempt of attempts) {
    const attemptDir = join(attemptsDir, `attempt-${attempt}`)
    const predictionPath = join(attemptDir, "prediction.json")
    const runPath = join(attemptDir, "run.json")
    if (!(await pathExists(predictionPath)) || !(await pathExists(runPath))) continue
    const [predictionValue, summaryValue] = await Promise.all([
      readFile(predictionPath, "utf8").then((content) => JSON.parse(content) as unknown),
      readFile(runPath, "utf8").then((content) => JSON.parse(content) as unknown),
    ])
    const prediction = parseSweBenchProPredictions([predictionValue])[0]
    if (prediction.instance_id !== row.instance_id) {
      throw new Error(`Attempt checkpoint prediction does not belong to ${row.instance_id}.`)
    }
    if (!isObject(summaryValue) || summaryValue.instanceId !== row.instance_id || summaryValue.attempt !== attempt) {
      throw new Error(`Attempt checkpoint metadata is invalid for ${row.instance_id}.`)
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
  return undefined
}

function parseInfrastructureRetry(value: unknown): InfrastructureRetry | undefined {
  if (value === undefined) return undefined
  if (!isObject(value) || typeof value.category !== "string" || typeof value.reason !== "string") {
    throw new Error("Attempt checkpoint has invalid infrastructure retry metadata.")
  }
  return { category: value.category, reason: value.reason }
}

function assertManifestMatchesRun(
  manifest: SweBenchProPredictionManifest,
  options: CliOptions,
  rows: readonly SweBenchProRow[],
): void {
  const expected = rows.map((row) => ({
    instanceId: row.instance_id,
    repo: row.repo,
    baseCommit: row.base_commit,
    image: officialSweBenchProImage(row.dockerhub_tag, options.imagePrefix),
  }))
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
    manifest.imagePrefix !== options.imagePrefix ? "image prefix" : undefined,
    manifest.dockerPlatform !== options.dockerPlatform ? "Docker platform" : undefined,
    manifest.inferenceWorkers !== options.inferenceWorkers ? "inference worker count" : undefined,
    manifest.maxInfrastructureRetries !== options.maxInfrastructureRetries ? "infrastructure retry policy" : undefined,
    manifest.retryBaseDelayMs !== options.retryBaseDelayMs ? "infrastructure retry delay" : undefined,
    JSON.stringify(manifest.selectedInstances) !== JSON.stringify(expected) ? "selected instances" : undefined,
  ].filter((item): item is string => item !== undefined)
  if (mismatches.length > 0) {
    throw new Error(`Existing SWE-bench Pro run differs in ${mismatches.join(", ")}; use --restart.`)
  }
}

async function loadExistingProgress(
  rows: readonly SweBenchProRow[],
  options: CliOptions,
  paths: BenchmarkPaths,
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

  const manifest = parsePredictionManifest(JSON.parse(await readFile(paths.manifestPath, "utf8")) as unknown)
  assertManifestMatchesRun(manifest, options, rows)
  if (manifest.complete) {
    if (!summaryExists || !predictionsExist) {
      throw new Error("Completed SWE-bench Pro run is missing its summary or predictions artifact.")
    }
    const predictionsContent = await readFile(paths.predictionsPath, "utf8")
    if (sha256(predictionsContent) !== manifest.predictionsSha256) {
      throw new Error("Existing predictions do not match their completed manifest.")
    }
    throw new Error(`Run ${options.runId} is already complete. Use a new --run-id or --restart.`)
  }

  const recoveredSummaries: JsonObject[] = []
  const recoveredPredictions: SweBenchProPrediction[] = []
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
      const prediction = parseSweBenchProPredictions([predictionValue])[0]
      if (!prediction || prediction.instance_id !== row.instance_id) {
        throw new Error(`Checkpoint prediction does not match instance ${row.instance_id}.`)
      }
      if (!isObject(summaryValue) || summaryValue.instanceId !== row.instance_id) {
        throw new Error(`Checkpoint summary does not match instance ${row.instance_id}.`)
      }
      recoveredPredictions.push(prediction)
      recoveredSummaries.push(summaryValue)
      continue
    }

    const checkpoint = await loadLatestAttemptCheckpoint(row, paths, maxAttempts)
    if (!checkpoint) {
      initialAttempts.set(row.instance_id, 1)
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
    recoveredSummaries.push(finalized.summary)
    recoveredPredictions.push(finalized.prediction)
  }
  return { summaries: recoveredSummaries, predictions: recoveredPredictions, initialAttempts }
}

async function writeRunProgress(
  options: CliOptions,
  paths: BenchmarkPaths,
  rows: readonly SweBenchProRow[],
  summaries: readonly JsonObject[],
  predictions: readonly SweBenchProPrediction[],
  complete: boolean,
): Promise<void> {
  const order = new Map(rows.map((row, index) => [row.instance_id, index]))
  const sortedPredictions = [...predictions].sort(
    (left, right) => (order.get(left.instance_id) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.instance_id) ?? 0),
  )
  const summaryById = new Map<string, JsonObject>()
  for (const summary of summaries) {
    if (typeof summary.instanceId === "string") summaryById.set(summary.instanceId, summary)
  }
  const sortedSummaries = sortedPredictions
    .map((prediction) => summaryById.get(prediction.instance_id))
    .filter((summary): summary is JsonObject => summary !== undefined)
  if (sortedSummaries.length !== sortedPredictions.length) {
    throw new Error("Cannot checkpoint SWE-bench Pro predictions without matching instance summaries.")
  }
  if (complete && sortedPredictions.length !== rows.length) {
    throw new Error("Cannot mark SWE-bench Pro inference complete before every selected instance has a prediction.")
  }
  if (sortedPredictions.length > 0) parseSweBenchProPredictions(sortedPredictions)
  const predictionsContent = encodePredictions(sortedPredictions)
  const completedInstanceIds = sortedPredictions.map((prediction) => prediction.instance_id)
  const manifest = buildPredictionManifest(
    options,
    rows,
    sortedPredictions,
    completedInstanceIds,
    complete,
    predictionsContent,
  )

  await writeFileAtomic(paths.predictionsPath, predictionsContent)
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
    inferenceRuntime: "official-swebench-pro-instance-image",
    inferenceWorkers: options.inferenceWorkers,
    maxInfrastructureRetries: options.maxInfrastructureRetries,
    selectedCount: rows.length,
    completedCount: sortedSummaries.length,
    generationSucceededCount: sortedSummaries.filter((summary) => summary.generationSucceeded === true).length,
    predictionCount: manifest.nonEmptyPatchCount,
    infrastructureRetryCount: sortedSummaries.reduce(
      (total, summary) =>
        total + (typeof summary.infrastructureRetriesUsed === "number" ? summary.infrastructureRetriesUsed : 0),
      0,
    ),
    infrastructureRetryExhaustedCount: sortedSummaries.filter(
      (summary) => summary.infrastructureRetryExhausted === true,
    ).length,
    complete,
    predictionsPath: paths.predictionsPath,
    predictionManifestPath: paths.manifestPath,
    selectedInstancesPath: paths.datasetPath,
    evaluationOutput: paths.evaluationOutput,
    summaries: sortedSummaries,
  })
  // The manifest is the commit marker for the predictions/summary checkpoint.
  await writeJsonAtomic(paths.manifestPath, manifest)
}

async function preflightInference(options: CliOptions): Promise<void> {
  if (options.dryRun) return
  const docker = await runProcess("docker", ["info"], {
    cwd: REPO_ROOT,
    timeoutMs: 30_000,
    env: hostEnv(process.env),
  })
  assertProcessSucceeded(docker, "Docker preflight")
}

async function runInference(options: CliOptions, paths: BenchmarkPaths): Promise<void> {
  if (options.restart) await rm(paths.runs, { recursive: true, force: true })
  await mkdir(paths.runs, { recursive: true })

  console.log(`Fetching ${DATASET_NAME} instances...`)
  const rows = await fetchSweBenchProRows(options)
  await writeJsonlAtomic(paths.datasetPath, rows.map(datasetArtifactRow))
  if (options.listInstances || options.dryRun) {
    for (const row of rows) {
      console.log(
        `${row.instance_id}\t${row.repo}\t${row.repo_language}\t${officialSweBenchProImage(row.dockerhub_tag, options.imagePrefix)}`,
      )
    }
    console.log(`Wrote selected public instances: ${paths.datasetPath}`)
    return
  }

  await preflightInference(options)
  const progress = await loadExistingProgress(rows, options, paths)
  if (options.traceDir && progress.summaries.length > 0) {
    throw new Error("Tracing requires a fresh benchmark run; use --restart or a new --run-id instead of resuming.")
  }
  const traceRun = options.traceDir ? createTraceRun(options.traceDir, "swe-bench-pro", "opencode") : undefined
  const effectiveOptions = traceRun ? { ...options, traceRun } : options
  const summaries = [...progress.summaries]
  const predictions = [...progress.predictions]
  const completed = new Set(predictions.map((prediction) => prediction.instance_id))
  const pending = rows.filter((row) => !completed.has(row.instance_id))

  if (pending.length === 0) {
    await writeRunProgress(effectiveOptions, paths, rows, summaries, predictions, true)
    console.log(`SWE-bench Pro run ${options.runId} is already complete.`)
    return
  }

  await writeRunProgress(effectiveOptions, paths, rows, summaries, predictions, false)
  await runEvaluationOrchestrator({
    items: pending.map((row) => ({
      item: row,
      ...(progress.initialAttempts.has(row.instance_id)
        ? { initialAttempt: progress.initialAttempts.get(row.instance_id)! }
        : {}),
    })),
    concurrency: options.inferenceWorkers,
    maxInfrastructureRetries: options.maxInfrastructureRetries,
    retryBaseDelayMs: options.retryBaseDelayMs,
    runAttempt: (row, context) => runInstanceAttempt(row, effectiveOptions, paths, context),
    onRetry: async (row, retry, context, nextDelayMs) => {
      console.warn(
        `Retrying ${row.instance_id} after ${retry.category} on attempt ${context.attempt}/${context.maxAttempts}; waiting ${nextDelayMs}ms.`,
      )
      await writeJsonAtomic(join(paths.runs, row.instance_id, "retry-state.json"), {
        instanceId: row.instance_id,
        failedAttempt: context.attempt,
        nextAttempt: context.attempt + 1,
        category: retry.category,
        reason: retry.reason,
        nextDelayMs,
        recordedAt: new Date().toISOString(),
      })
    },
    onComplete: async (row, completion) => {
      const finalized = await finalizeInstanceOutcome(row, paths, completion)
      summaries.push(finalized.summary)
      predictions.push(finalized.prediction)
      await rm(join(paths.runs, row.instance_id, "retry-state.json"), { force: true })
      await writeRunProgress(effectiveOptions, paths, rows, summaries, predictions, false)
    },
  })

  await writeRunProgress(effectiveOptions, paths, rows, summaries, predictions, true)
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
  console.log(`Wrote prediction manifest: ${paths.manifestPath}`)
  console.log(`Wrote summary: ${paths.summaryPath}`)
}

async function main(): Promise<void> {
  const localVersion = await readLocalOpencodeVersion()
  const options = parseArgs(process.argv.slice(2), localVersion)
  if (options.help) {
    console.log(usage())
    return
  }

  const paths = buildPaths(options)
  if (options.evaluateOnly) {
    await mkdir(paths.runs, { recursive: true })
    await runEvaluationOnly(options, paths)
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
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
