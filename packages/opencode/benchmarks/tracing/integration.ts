import { randomUUID } from "node:crypto"
import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { OpenCodeTraceAdapter, opencodeCapabilities } from "./opencode.ts"
import {
  TRACE_CONTRACT_VERSION,
  TraceRecorder,
  assertTraceInsideRoot,
  createTraceIdentity,
  traceAttemptDirectory,
  writeTraceRunIndex,
  type JsonObject,
  type TraceStatus,
} from "./recorder.ts"

export interface OpenCodeTraceRun {
  readonly id: string
  readonly root: string
  readonly createdAt: string
  readonly benchmark: string
}

export function createOpenCodeTraceRun(baseDirectory: string, benchmark: string): OpenCodeTraceRun {
  const id = `trace-run-${randomUUID().replaceAll("-", "")}`
  const base = resolve(baseDirectory)
  const existed = existsSync(base)
  mkdirSync(base, { recursive: true, mode: 0o700 })
  const baseInfo = lstatSync(base)
  if (baseInfo.isSymbolicLink() || !baseInfo.isDirectory()) {
    throw new Error(`Trace base must be a real directory: ${base}`)
  }
  if (!existed) chmodSync(base, 0o700)
  const root = resolve(base, id)
  mkdirSync(root, { recursive: false, mode: 0o700 })
  const info = lstatSync(root)
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Trace root must be a real directory: ${root}`)
  chmodSync(root, 0o700)
  return {
    id,
    root,
    createdAt: new Date().toISOString(),
    benchmark,
  }
}

export function createOpenCodeAttemptTrace(input: {
  readonly run: OpenCodeTraceRun
  readonly instanceId: string
  readonly attempt: number
  readonly frameworkRevision: string
  readonly model: string
  readonly evaluationWorkers: number
  readonly inferenceTimeoutMs: number
  readonly evaluationTimeoutSeconds?: number
  readonly benchmarkRetries: number
  readonly image: string
  readonly harnessRevision?: string
  readonly startedAt?: number
}): OpenCodeTraceAdapter {
  const attemptDir = traceAttemptDirectory(input.run.root, input.instanceId, input.attempt)
  assertTraceInsideRoot(input.run.root, attemptDir)
  const identity = createTraceIdentity({
    runId: input.run.id,
    benchmark: input.run.benchmark,
    framework: "opencode",
    instanceId: input.instanceId,
    attempt: input.attempt,
  })
  return new OpenCodeTraceAdapter(
    new TraceRecorder({
      attemptDir,
      identity,
      producer: {
        name: "opencode.benchmarks.tracing.opencode",
        version: TRACE_CONTRACT_VERSION,
      },
      provenance: {
        benchmark: {
          name: "opencode-benchmarks",
          revision: input.frameworkRevision,
        },
        framework: {
          name: "OpenCode",
          revision: input.frameworkRevision,
        },
        adapter: {
          name: "opencode.benchmarks.tracing.opencode",
          revision: input.frameworkRevision,
        },
        ...(input.harnessRevision
          ? {
              harness: {
                name: "Harbor",
                revision: input.harnessRevision,
              },
            }
          : {}),
        agent_image: input.image,
      },
      execution: {
        model: input.model,
        evaluation_workers: input.evaluationWorkers,
        inference_timeout_seconds: input.inferenceTimeoutMs / 1_000,
        ...(input.evaluationTimeoutSeconds !== undefined
          ? { evaluation_timeout_seconds: input.evaluationTimeoutSeconds }
          : {}),
        benchmark_retries: input.benchmarkRetries,
        provider_attempts: 1,
      },
      capabilities: opencodeCapabilities(new Map()),
    }),
    input.startedAt !== undefined ? { startedAt: input.startedAt } : {},
  )
}

export function finishOpenCodeTrace(
  adapter: OpenCodeTraceAdapter | undefined,
  status: TraceStatus,
  errorMessage?: string,
): JsonObject | undefined {
  if (!adapter) return undefined
  try {
    const result = adapter.finish(status, errorMessage)
    return {
      traceId: result.traceId,
      traceDirectory: result.attemptDir,
      traceHealth: result.health,
      traceComplete: result.complete,
    }
  } catch {
    return {
      traceId: adapter.traceId,
      traceDirectory: adapter.attemptDir,
      traceHealth: "failed",
      traceComplete: false,
    }
  }
}

export function finalizeOpenCodeTraceRun(input: {
  readonly run: OpenCodeTraceRun | undefined
  readonly instanceIds: readonly string[]
  readonly selectionStrategy: "explicit_ids" | "full_dataset" | "ordered_window"
}): string | undefined {
  if (!input.run) return undefined
  try {
    writeTraceRunIndex({
      traceRoot: input.run.root,
      runId: input.run.id,
      benchmark: input.run.benchmark,
      instanceIds: input.instanceIds,
      selectionStrategy: input.selectionStrategy,
      createdAt: input.run.createdAt,
    })
    return undefined
  } catch {
    return "OpenCode benchmark trace run index could not be finalized; benchmark outputs remain valid."
  }
}

export function traceStatus(input: {
  readonly completed: boolean
  readonly timedOut: boolean
  readonly infrastructureError?: string
}): TraceStatus {
  if (input.timedOut) return "timeout"
  if (input.completed && input.infrastructureError === undefined) return "completed"
  return "failed"
}
