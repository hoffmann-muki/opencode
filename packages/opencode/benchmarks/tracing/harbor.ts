import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { encodedInstanceId, traceAttemptDirectory } from "./recorder.ts"
import {
  finalizeTraceRun,
  type TraceHarnessAdapter,
  type TraceRun,
  type TraceSelection,
  type TraceSelectionStrategy,
} from "./coordination.ts"
import { createOpenCodeAttemptTrace } from "./integration.ts"

interface HarborTraceMetadata {
  readonly schemaVersion: 1
  readonly runId: string
  readonly benchmark: string
  readonly instanceId: string
  readonly attempt: number
  readonly traceRoot: string
  readonly createdAt: string
  readonly frameworkRevision: string
  readonly model: string
  readonly evaluationWorkers: number
  readonly inferenceTimeoutSeconds: number
  readonly benchmarkRetries: number
  readonly harborVersion: string
  readonly image: string
  readonly sessionId: string
  readonly startedAt: string
  readonly finishedAt?: string
  readonly status: "running" | "completed" | "failed" | "timeout"
  readonly error?: string
}

export class HarborTraceHarness implements TraceHarnessAdapter {
  constructor(
    private readonly options: {
      readonly jobsDir: string
      readonly jobName: string
      readonly selectedInstanceIds?: readonly string[]
      readonly expectedInstanceCount: number
      readonly expectedAttemptsPerInstance: number
      readonly selectionStrategy: TraceSelectionStrategy
    },
  ) {}

  prepareFinalization(run: TraceRun): void {
    rmSync(join(run.root, ".harbor-attempts.json"), { force: true })
    rmSync(join(run.root, ".harbor-attempts.lock"), { force: true })
    rmSync(join(run.root, ".harbor-staging"), { force: true, recursive: true })
  }

  resolveSelection(_run: TraceRun, _observedInstanceIds: readonly string[]): TraceSelection {
    const instanceIds = this.options.selectedInstanceIds
      ? [...this.options.selectedInstanceIds]
      : parseHarborJobInstanceIds(
          JSON.parse(readFileSync(join(this.options.jobsDir, this.options.jobName, "lock.json"), "utf8")),
        )
    if (instanceIds.length !== this.options.expectedInstanceCount) {
      throw new Error(
        `Trace run index omitted because the resolved instance count ${instanceIds.length} does not match ${this.options.expectedInstanceCount}.`,
      )
    }
    return {
      instanceIds,
      strategy: this.options.selectionStrategy,
      minimumAttemptsPerInstance: this.options.expectedAttemptsPerInstance,
    }
  }
}

export async function collectOpenCodeHarborTraces(input: {
  readonly run: TraceRun
  readonly jobsDir: string
  readonly harborJobName: string
  readonly sourceCommit: string
  readonly taskNames: readonly string[]
  readonly maxTasks?: number
  readonly officialTaskCount: number
  readonly attempts: number
}): Promise<string | undefined> {
  try {
    const metadataPaths = Array.from(
      new Bun.Glob("**/agent/benchmark-trace.json").scanSync({
        cwd: input.jobsDir,
        absolute: true,
        onlyFiles: true,
      }),
    ).sort()

    for (const metadataPath of metadataPaths) {
      const metadata = parseHarborTraceMetadata(await Bun.file(metadataPath).json())
      if (
        metadata.benchmark !== input.run.benchmark ||
        metadata.runId !== input.run.id ||
        resolve(metadata.traceRoot) !== input.run.root ||
        metadata.createdAt !== input.run.createdAt ||
        metadata.frameworkRevision !== input.sourceCommit
      ) {
        throw new Error(`Foreign OpenCode Harbor trace metadata: ${metadataPath}`)
      }
      const stdoutPath = join(dirname(metadataPath), "opencode.txt")
      const stdout = await Bun.file(stdoutPath).text()
      const startedAt = Date.parse(metadata.startedAt)
      const finishedAt = Date.parse(metadata.finishedAt ?? new Date().toISOString())
      if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt)) {
        throw new Error(`Invalid OpenCode Harbor trace timestamps: ${metadataPath}`)
      }
      const attemptDir = traceAttemptDirectory(input.run.root, metadata.instanceId, metadata.attempt)
      if (existsSync(join(attemptDir, "manifest.json"))) {
        assertExistingAttempt(attemptDir, metadata)
        await writeFile(stdoutPath, stripHarborTraceFrames(stdout), "utf8")
        continue
      }
      if (existsSync(attemptDir)) {
        throw new Error(
          `Interrupted OpenCode trace attempt must be recovered before Harbor collection resumes: ${attemptDir}`,
        )
      }
      const stagingRoot = join(
        input.run.root,
        ".harbor-staging",
        encodedInstanceId(metadata.instanceId),
        `attempt-${metadata.attempt}`,
      )
      rmSync(stagingRoot, { force: true, recursive: true })
      const stagingRun = { ...input.run, root: stagingRoot }
      const adapter = createOpenCodeAttemptTrace({
        run: stagingRun,
        instanceId: metadata.instanceId,
        attempt: metadata.attempt,
        frameworkRevision: metadata.frameworkRevision,
        model: metadata.model,
        evaluationWorkers: metadata.evaluationWorkers,
        inferenceTimeoutMs: metadata.inferenceTimeoutSeconds * 1_000,
        benchmarkRetries: metadata.benchmarkRetries,
        delegationEnabled: true,
        image: metadata.image,
        harnessRevision: metadata.harborVersion,
        startedAt,
      })
      adapter.startHarness(
        {
          name: "harbor",
          revision: metadata.harborVersion,
          phase: "agent",
        },
        startedAt,
      )
      adapter.containerObserved(
        {
          image: metadata.image,
          session_id: metadata.sessionId,
        },
        startedAt,
      )
      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue
        let value: unknown
        try {
          value = JSON.parse(line)
        } catch {
          continue
        }
        adapter.consume(value)
      }
      const finalized = adapter.finish(
        metadata.status === "completed" ? "completed" : metadata.status === "timeout" ? "timeout" : "failed",
        metadata.error,
        finishedAt,
      )
      mkdirSync(dirname(attemptDir), { recursive: true, mode: 0o700 })
      renameSync(finalized.attemptDir, attemptDir)
      rmSync(stagingRoot, { force: true, recursive: true })
      await writeFile(stdoutPath, stripHarborTraceFrames(stdout), "utf8")
    }

    const expectedInstanceCount =
      input.taskNames.length > 0 ? input.taskNames.length : (input.maxTasks ?? input.officialTaskCount)
    finalizeTraceRun(
      input.run,
      new HarborTraceHarness({
        jobsDir: input.jobsDir,
        jobName: input.harborJobName,
        ...(input.taskNames.length > 0 ? { selectedInstanceIds: input.taskNames } : {}),
        expectedInstanceCount,
        expectedAttemptsPerInstance: input.attempts,
        selectionStrategy:
          input.taskNames.length > 0
            ? "explicit_ids"
            : input.maxTasks !== undefined
              ? "ordered_window"
              : "full_dataset",
      }),
    )
    return undefined
  } catch {
    return "OpenCode Harbor trace run could not be finalized; benchmark outputs remain valid."
  }
}

function assertExistingAttempt(attemptDir: string, metadata: HarborTraceMetadata): void {
  const value: unknown = JSON.parse(readFileSync(join(attemptDir, "manifest.json"), "utf8"))
  if (
    typeof value !== "object" ||
    value === null ||
    !("run_id" in value) ||
    value.run_id !== metadata.runId ||
    !("benchmark" in value) ||
    value.benchmark !== metadata.benchmark ||
    !("framework" in value) ||
    value.framework !== "opencode" ||
    !("instance_id" in value) ||
    value.instance_id !== metadata.instanceId ||
    !("attempt" in value) ||
    value.attempt !== metadata.attempt
  ) {
    throw new Error(`Existing OpenCode trace attempt conflicts with Harbor metadata: ${attemptDir}`)
  }
}

export function parseHarborJobInstanceIds(value: unknown): string[] {
  if (typeof value !== "object" || value === null || !("trials" in value) || !Array.isArray(value.trials)) {
    throw new Error("Harbor job lock has no resolved trials")
  }
  const instanceIds = value.trials.map((trial) => {
    if (
      typeof trial !== "object" ||
      trial === null ||
      !("task" in trial) ||
      typeof trial.task !== "object" ||
      trial.task === null ||
      !("name" in trial.task) ||
      typeof trial.task.name !== "string" ||
      !trial.task.name
    ) {
      throw new Error("Harbor job lock has a trial without a task name")
    }
    return trial.task.name.replace(/^[^/]*\//, "")
  })
  const unique = instanceIds.filter((instanceId, index) => instanceIds.indexOf(instanceId) === index)
  if (unique.length === 0) throw new Error("Harbor job lock selected no tasks")
  return unique
}

export function stripHarborTraceFrames(output: string): string {
  return output
    .split("\n")
    .filter((line) => !isHarborTraceFrame(line))
    .join("\n")
}

function isHarborTraceFrame(line: string): boolean {
  if (!line.trim()) return false
  try {
    const value: unknown = JSON.parse(line)
    return typeof value === "object" && value !== null && "type" in value && value.type === "benchmark_trace.native"
  } catch {
    return false
  }
}

function parseHarborTraceMetadata(value: unknown): HarborTraceMetadata {
  if (!isHarborTraceMetadata(value)) {
    throw new Error("OpenCode Harbor trace metadata is invalid")
  }
  return value
}

function isHarborTraceMetadata(value: unknown): value is HarborTraceMetadata {
  return (
    typeof value === "object" &&
    value !== null &&
    "schemaVersion" in value &&
    value.schemaVersion === 1 &&
    "benchmark" in value &&
    typeof value.benchmark === "string" &&
    value.benchmark.length > 0 &&
    "runId" in value &&
    typeof value.runId === "string" &&
    value.runId.length > 0 &&
    "instanceId" in value &&
    typeof value.instanceId === "string" &&
    value.instanceId.length > 0 &&
    "attempt" in value &&
    typeof value.attempt === "number" &&
    Number.isInteger(value.attempt) &&
    value.attempt > 0 &&
    "traceRoot" in value &&
    typeof value.traceRoot === "string" &&
    value.traceRoot.length > 0 &&
    "createdAt" in value &&
    typeof value.createdAt === "string" &&
    "frameworkRevision" in value &&
    typeof value.frameworkRevision === "string" &&
    /^[0-9a-f]{40}$/.test(value.frameworkRevision) &&
    "model" in value &&
    typeof value.model === "string" &&
    value.model.length > 0 &&
    "evaluationWorkers" in value &&
    typeof value.evaluationWorkers === "number" &&
    Number.isInteger(value.evaluationWorkers) &&
    value.evaluationWorkers > 0 &&
    "inferenceTimeoutSeconds" in value &&
    typeof value.inferenceTimeoutSeconds === "number" &&
    Number.isFinite(value.inferenceTimeoutSeconds) &&
    value.inferenceTimeoutSeconds > 0 &&
    "benchmarkRetries" in value &&
    typeof value.benchmarkRetries === "number" &&
    Number.isInteger(value.benchmarkRetries) &&
    value.benchmarkRetries >= 0 &&
    "harborVersion" in value &&
    typeof value.harborVersion === "string" &&
    "image" in value &&
    typeof value.image === "string" &&
    value.image.length > 0 &&
    "sessionId" in value &&
    typeof value.sessionId === "string" &&
    value.sessionId.length > 0 &&
    "startedAt" in value &&
    typeof value.startedAt === "string" &&
    (!("finishedAt" in value) || typeof value.finishedAt === "string") &&
    "status" in value &&
    typeof value.status === "string" &&
    ["running", "completed", "failed", "timeout"].includes(value.status) &&
    (!("error" in value) || typeof value.error === "string")
  )
}
