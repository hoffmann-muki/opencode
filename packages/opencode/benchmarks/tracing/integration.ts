import {
  DirectTraceHarness,
  createTraceRun,
  finalizeTraceRun,
  type TraceRun,
  type TraceSelectionStrategy,
} from "./coordination.ts"
import { OpenCodeTraceAdapter, opencodeCapabilities } from "./opencode.ts"
import {
  TRACE_CONTRACT_VERSION,
  TraceRecorder,
  assertTraceInsideRoot,
  createTraceIdentity,
  traceAttemptDirectory,
  type JsonObject,
  type TraceStatus,
} from "./recorder.ts"

export type OpenCodeTraceRun = TraceRun

export function createOpenCodeTraceRun(baseDirectory: string, benchmark: string): TraceRun {
  return createTraceRun(baseDirectory, benchmark, "opencode")
}

export function createOpenCodeAttemptTrace(input: {
  readonly run: TraceRun
  readonly instanceId: string
  readonly attempt: number
  readonly frameworkRevision: string
  readonly model: string
  readonly evaluationWorkers: number
  readonly inferenceTimeoutMs: number
  readonly evaluationTimeoutSeconds?: number
  readonly benchmarkRetries: number
  readonly delegationEnabled: boolean
  readonly image: string
  readonly harnessRevision?: string
  readonly startedAt?: number
}): OpenCodeTraceAdapter {
  if (input.run.framework !== "opencode") {
    throw new Error("OpenCode trace adapter requires framework='opencode'.")
  }
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
    {
      delegationEnabled: input.delegationEnabled,
      ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
    },
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
  readonly run: TraceRun | undefined
  readonly instanceIds: readonly string[]
  readonly selectionStrategy: TraceSelectionStrategy
}): string | undefined {
  if (!input.run) return undefined
  try {
    finalizeTraceRun(
      input.run,
      new DirectTraceHarness({
        instanceIds: input.instanceIds,
        strategy: input.selectionStrategy,
      }),
    )
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
