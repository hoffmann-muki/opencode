import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gunzipSync } from "node:zlib"
import { createTraceRun, finalizeTraceRun, type TraceHarnessAdapter } from "../../benchmarks/tracing/coordination.ts"
import { createOpenCodeAttemptTrace } from "../../benchmarks/tracing/integration.ts"
import { OpenCodeTraceAdapter, opencodeCapabilities } from "../../benchmarks/tracing/opencode.ts"
import { HarborTraceHarness } from "../../benchmarks/tracing/harbor.ts"
import {
  TRACE_CAPABILITY_CATEGORIES,
  TRACE_NATIVE_CHUNK_MEDIA_TYPE,
  TRACE_SCHEMA_DIGEST,
  TraceRecorder,
  createTraceIdentity,
  sanitizeTraceJson,
  traceAttemptDirectory,
  writeTraceRunIndex,
} from "../../benchmarks/tracing/recorder.ts"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("benchmark tracing recorder", () => {
  test("redacts credentials and removes accounting before persistence", () => {
    const result = sanitizeTraceJson({
      authorization: "Bearer synthetic-token",
      usage: { total_tokens: 99 },
      output: "OPENAI_API_KEY=sk-synthetic000000000000000000000",
    })

    expect(result.matches).toBe(3)
    expect(result.value).toEqual({
      output: "OPENAI_API_KEY=<redacted:model_api_key>",
    })
  })

  test("redacts provider-prefixed secret names and accounting fields", () => {
    const result = sanitizeTraceJson({
      OPENROUTER_API_KEY: "synthetic-secret-value",
      aws_secret_access_key: "synthetic-cloud-secret",
      provider_usage: { input_tokens: 99 },
      output: "export OPENROUTER_API_KEY=synthetic-secret-value --custom-access-token synthetic-token-value",
      duration_ms: 25,
    })

    expect(result.matches).toBe(5)
    expect(result.value).toEqual({
      output: "export OPENROUTER_API_KEY=<redacted:assignment> --custom-access-token=<redacted:assignment>",
      duration_ms: 25,
    })
  })

  test("marks error-level observability defects as failed and partial", () => {
    const trace = createAdapter(temporaryRoot(), "owner/project__health")
    trace.recorder.reportIssue("trace.synthetic_failure", "synthetic failure", "error")

    const finalized = trace.adapter.finish("completed")
    const health = JSON.parse(readFileSync(join(trace.attemptDir, "health.json"), "utf8")) as {
      status: string
      finalization: string
    }

    expect(finalized.health).toBe("failed")
    expect(finalized.complete).toBe(false)
    expect(health.status).toBe("failed")
    expect(health.finalization).toBe("partial")
  })

  test("normalizes native tools, timing, model turns, and session lifecycle", () => {
    const root = temporaryRoot()
    const trace = createAdapter(root, "owner/project__issue-1")

    trace.adapter.consume(
      frame(1, 1_000, "session-root", {
        type: "message.updated",
        properties: {
          sessionID: "session-root",
          info: {
            id: "message-1",
            sessionID: "session-root",
            role: "assistant",
            agent: "benchmark",
            modelID: "model",
            providerID: "provider",
            time: { created: 1_000 },
            cost: 1.5,
            tokens: { input: 5, output: 8 },
          },
        },
      }),
    )
    trace.adapter.consume(
      frame(2, 1_100, "session-root", {
        type: "message.part.updated",
        properties: {
          sessionID: "session-root",
          part: {
            id: "part-1",
            messageID: "message-1",
            sessionID: "session-root",
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "running",
              input: { command: "ls -1" },
              time: { start: 1_100 },
            },
          },
        },
      }),
    )
    trace.adapter.consume(
      frame(3, 1_125, "session-root", {
        type: "message.part.updated",
        properties: {
          sessionID: "session-root",
          part: {
            id: "part-1",
            messageID: "message-1",
            sessionID: "session-root",
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "completed",
              input: { command: "ls -1" },
              output: "README.md\nOPENROUTER_API_KEY=sk-synthetic000000000000000000000",
              title: "ls -1",
              metadata: { exit: 0, usage: { total_tokens: 5 } },
              time: { start: 1_100, end: 1_125 },
            },
          },
        },
      }),
    )
    trace.adapter.consume(
      frame(4, 1_200, "session-root", {
        type: "message.updated",
        properties: {
          sessionID: "session-root",
          info: {
            id: "message-1",
            sessionID: "session-root",
            role: "assistant",
            agent: "benchmark",
            modelID: "model",
            providerID: "provider",
            time: { created: 1_000, completed: 1_200 },
            finish: "stop",
            cost: 1.5,
            tokens: { input: 5, output: 8 },
          },
        },
      }),
    )
    trace.adapter.consume(
      frame(5, 1_250, "session-root", {
        type: "session.status",
        properties: {
          sessionID: "session-root",
          status: { type: "idle" },
        },
      }),
    )

    const finalized = trace.adapter.finish("completed", undefined, 1_300)
    expect(finalized.health).toBe("healthy")
    expect(finalized.complete).toBe(true)

    const events = jsonl(join(trace.attemptDir, "events.jsonl"))
    expect(events.map((event) => event.event_type)).toEqual([
      "instance.start",
      "attempt.start",
      "harness.startup_start",
      "harness.startup_end",
      "agent.execution_start",
      "agent.session_start",
      "model.turn_start",
      "model.turn_end",
      "shell.start",
      "shell.end",
      "agent.session_end",
      "agent.execution_end",
      "harness.shutdown_start",
      "harness.shutdown_end",
      "attempt.end",
      "instance.end",
    ])
    expect(events.find((event) => event.event_type === "attempt.start")?.payload).toEqual({
      agent_configuration: {
        delegation_enabled: true,
        coordination_mode: "framework_native",
        delegation_sequence: ["navigator", "patcher", "reviewer"],
        sequence_enforcement: "prompt_guided",
      },
    })
    expect(events.find((event) => event.event_type === "shell.end")?.timing).toEqual({
      fidelity: "native_wall",
      duration_ms: 25,
    })
    expect(events.find((event) => event.event_type === "model.turn_end")?.timing).toEqual({
      fidelity: "native_wall",
      duration_ms: 100,
    })

    const retained = Array.from(new Bun.Glob("**/*").scanSync({ cwd: trace.attemptDir, onlyFiles: true }))
      .map((path) => readFileSync(join(trace.attemptDir, path), "utf8"))
      .join("\n")
    expect(retained).not.toContain("synthetic000000000000000000000")
    expect(retained).not.toContain('"tokens"')
    expect(readFileSync(join(trace.attemptDir, "events.jsonl"), "utf8")).not.toContain('"tokens"')
    const native = nativeIndex(join(trace.attemptDir, "native", "index.jsonl"))
    expect(native).toHaveLength(5)
    expect(new Set(native.map((record) => record.artifact.path))).toHaveLength(1)
    expect(native[0]?.artifact.media_type).toBe(TRACE_NATIVE_CHUNK_MEDIA_TYPE)
    const firstNative = native[0]
    if (!firstNative) throw new Error("Native trace index is empty")
    const members = nativeMembers(join(trace.attemptDir, firstNative.artifact.path))
    expect(members).toHaveLength(5)
    expect(new Set(members.map((member) => member.native_record_id))).toHaveLength(5)
    expect(
      members.map((member) => Buffer.from(member.content_base64, "base64").toString("utf8")).join("\n"),
    ).not.toContain("synthetic000000000000000000000")
    if (process.platform !== "win32") {
      expect(statSync(join(trace.attemptDir, "events.jsonl")).ino).toBe(
        statSync(join(trace.attemptDir, "journal.jsonl")).ino,
      )
    }

    const capabilities = JSON.parse(readFileSync(join(trace.attemptDir, "capabilities.json"), "utf8")) as {
      schema_digest: string
      capabilities: Array<{ category: string; state: string }>
    }
    expect(capabilities.schema_digest).toBe(TRACE_SCHEMA_DIGEST)
    expect(capabilities.capabilities).toHaveLength(TRACE_CAPABILITY_CATEGORIES.length)
    expect(capabilities.capabilities.find((item) => item.category === "shell")?.state).toBe("captured")
    expect(capabilities.capabilities.find((item) => item.category === "provider.exchange")?.state).toBe("not_exposed")

    writeTraceRunIndex({
      traceRoot: root,
      runId: trace.identity.runId,
      benchmark: trace.identity.benchmark,
      instanceIds: [trace.identity.instanceId],
      selectionStrategy: "explicit_ids",
      createdAt: new Date(0).toISOString(),
    })
    const run = JSON.parse(readFileSync(join(root, "run.json"), "utf8")) as {
      attempts: Array<{
        trace_id: string
        instance_id: string
        attempt: number
        status: string
        path: string
      }>
    }
    expect(run.attempts).toEqual([
      {
        trace_id: trace.identity.traceId,
        instance_id: trace.identity.instanceId,
        attempt: 1,
        path: "instances/owner%2Fproject__issue-1/attempt-1",
        status: "completed",
      },
    ])
  })

  test("preserves native subagent delegation and compaction boundaries", () => {
    const trace = createAdapter(temporaryRoot(), "owner/project__issue-2")

    trace.adapter.consume(
      frame(1, 1_000, "session-root", {
        type: "session.created",
        properties: {
          info: { id: "session-root", agent: "benchmark" },
        },
      }),
    )
    trace.adapter.consume(
      frame(2, 1_100, "session-root", {
        type: "message.part.updated",
        properties: {
          sessionID: "session-root",
          part: {
            id: "task-part",
            messageID: "root-message",
            sessionID: "session-root",
            type: "tool",
            callID: "task-call",
            tool: "task",
            state: {
              status: "running",
              input: { subagent_type: "navigator", prompt: "Inspect the repository." },
              time: { start: 1_100 },
            },
          },
        },
      }),
    )
    trace.adapter.consume(
      frame(3, 1_125, "session-root", {
        type: "session.created",
        properties: {
          info: { id: "session-child", parentID: "session-root", agent: "navigator" },
        },
      }),
    )
    trace.adapter.consume(
      frame(4, 1_150, "session-child", {
        type: "message.part.updated",
        properties: {
          sessionID: "session-child",
          part: {
            id: "compaction-part",
            messageID: "child-message",
            sessionID: "session-child",
            type: "compaction",
            auto: true,
            overflow: false,
          },
        },
      }),
    )
    trace.adapter.consume(
      frame(5, 1_175, "session-child", {
        type: "session.compacted",
        properties: { sessionID: "session-child" },
      }),
    )
    trace.adapter.consume(
      frame(6, 1_200, "session-child", {
        type: "session.status",
        properties: {
          sessionID: "session-child",
          status: { type: "idle" },
        },
      }),
    )
    trace.adapter.consume(
      frame(7, 1_225, "session-root", {
        type: "message.part.updated",
        properties: {
          sessionID: "session-root",
          part: {
            id: "task-part",
            messageID: "root-message",
            sessionID: "session-root",
            type: "tool",
            callID: "task-call",
            tool: "task",
            state: {
              status: "completed",
              input: { subagent_type: "navigator", prompt: "Inspect the repository." },
              output: "Repository inspected.",
              metadata: { sessionId: "session-child" },
              time: { start: 1_100, end: 1_225 },
            },
          },
        },
      }),
    )
    trace.adapter.consume(
      frame(8, 1_250, "session-root", {
        type: "session.status",
        properties: {
          sessionID: "session-root",
          status: { type: "idle" },
        },
      }),
    )

    expect(trace.adapter.finish("completed").health).toBe("healthy")
    const events = jsonl(join(trace.attemptDir, "events.jsonl"))
    const childStart = events.find(
      (event) => event.event_type === "agent.session_start" && event.session_id === "session-child",
    )
    expect(childStart?.parent_span_id).toBe("opencode-session-session-root")
    expect(childStart?.payload).toEqual({
      role: "subagent",
      parent_session_id: "session-root",
    })
    expect(events.find((event) => event.event_type === "delegation.end")?.payload).toEqual({
      tool: { name: "task", call_id: "task-call" },
      child_session_id: "session-child",
    })
    expect(events.find((event) => event.event_type === "context.compaction_end")?.timing).toEqual({
      fidelity: "native_wall",
      duration_ms: 25,
    })
  })

  test("records generic harness lifecycle and container metadata without evaluator claims", () => {
    const root = temporaryRoot()
    const trace = createAdapter(root, "terminal-task")

    trace.adapter.containerObserved({ image: "example/task:latest" }, 1_010)
    trace.adapter.finish("completed", undefined, 1_100)

    const capabilities = JSON.parse(readFileSync(join(trace.attemptDir, "capabilities.json"), "utf8")) as {
      capabilities: Array<{ category: string; state: string }>
    }
    const states = Object.fromEntries(capabilities.capabilities.map((item) => [item.category, item.state]))
    expect(states["harness.lifecycle"]).toBe("derived")
    expect(states["container.lifecycle"]).toBe("captured")
    expect(states["evaluator.lifecycle"]).toBe("not_exposed")
  })

  test("coordinates an arbitrary benchmark through a pluggable harness", () => {
    const root = temporaryRoot()
    const run = createTraceRun(root, "custom-benchmark", "opencode")
    createOpenCodeAttemptTrace({
      run,
      instanceId: "custom-instance",
      attempt: 1,
      frameworkRevision: "a".repeat(40),
      model: "test/model",
      evaluationWorkers: 1,
      inferenceTimeoutMs: 1_000,
      benchmarkRetries: 0,
      delegationEnabled: true,
      image: "custom/image:latest",
    }).finish("completed")
    let prepared = false
    const harness: TraceHarnessAdapter = {
      prepareFinalization(value) {
        expect(value).toBe(run)
        prepared = true
      },
      resolveSelection(value, observedInstanceIds) {
        expect(value).toBe(run)
        expect(observedInstanceIds).toEqual(["custom-instance"])
        return {
          instanceIds: ["custom-instance"],
          strategy: "explicit_ids",
        }
      },
    }

    finalizeTraceRun(run, harness)

    expect(prepared).toBe(true)
    expect(JSON.parse(readFileSync(join(run.root, "run.json"), "utf8"))).toMatchObject({
      benchmark: "custom-benchmark",
      framework: "opencode",
      selection: {
        strategy: "explicit_ids",
        instance_ids: ["custom-instance"],
      },
    })
  })

  test("resolves Harbor topology independently of benchmark identity", () => {
    const root = temporaryRoot()
    const job = join(root, "jobs", "custom")
    mkdirSync(job, { recursive: true })
    writeFileSync(
      join(job, "lock.json"),
      JSON.stringify({
        trials: [{ task: { name: "custom/task-a" } }],
      }),
    )
    const run = createTraceRun(join(root, "traces"), "custom-harbor-benchmark", "opencode")
    const harness = new HarborTraceHarness({
      jobsDir: join(root, "jobs"),
      jobName: "custom",
      expectedInstanceCount: 1,
      expectedAttemptsPerInstance: 1,
      selectionStrategy: "full_dataset",
    })

    expect(harness.resolveSelection(run, [])).toEqual({
      instanceIds: ["task-a"],
      strategy: "full_dataset",
      minimumAttemptsPerInstance: 1,
    })
  })
})

function temporaryRoot(): string {
  if (process.env.OPENCODE_TRACE_TEST_ROOT) {
    mkdirSync(process.env.OPENCODE_TRACE_TEST_ROOT, { recursive: true })
    return process.env.OPENCODE_TRACE_TEST_ROOT
  }
  const root = mkdtempSync(join(tmpdir(), "opencode-tracing-"))
  roots.push(root)
  return root
}

function createAdapter(root: string, instanceId: string) {
  const attemptDir = traceAttemptDirectory(root, instanceId, 1)
  const identity = createTraceIdentity({
    runId: "trace-run-test",
    benchmark: "swe-bench-verified",
    framework: "opencode",
    instanceId,
    attempt: 1,
  })
  const recorder = new TraceRecorder({
    attemptDir,
    identity,
    producer: { name: "test-recorder", version: "1.1.0" },
    provenance: {
      benchmark: { name: "test", revision: "a".repeat(40) },
      framework: { name: "OpenCode", revision: "a".repeat(40) },
      adapter: { name: "test", revision: "a".repeat(40) },
    },
    execution: {
      model: "test/model",
      evaluation_workers: 1,
      inference_timeout_seconds: 1800,
      benchmark_retries: 0,
      provider_attempts: 1,
    },
    capabilities: opencodeCapabilities(new Map()),
  })
  return {
    attemptDir,
    identity,
    recorder,
    adapter: new OpenCodeTraceAdapter(recorder, { delegationEnabled: true, startedAt: 900 }),
  }
}

function frame(sequence: number, timestamp: number, sessionID: string, event: object) {
  return {
    type: "benchmark_trace.native",
    sequence,
    timestamp,
    sessionID,
    event,
  }
}

function jsonl(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

function nativeIndex(path: string) {
  return jsonl(path).map((record) => {
    const artifact = record.artifact
    if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
      throw new Error("Native trace artifact reference is malformed")
    }
    const artifactPath = Reflect.get(artifact, "path")
    const mediaType = Reflect.get(artifact, "media_type")
    if (typeof artifactPath !== "string" || typeof mediaType !== "string") {
      throw new Error("Native trace artifact reference is incomplete")
    }
    return {
      artifact: {
        path: artifactPath,
        media_type: mediaType,
      },
    }
  })
}

function nativeMembers(path: string) {
  return gunzipSync(readFileSync(path))
    .toString("utf8")
    .trim()
    .split("\n")
    .map((line) => {
      const value: unknown = JSON.parse(line)
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Native trace chunk member is malformed")
      }
      const nativeRecordID = Reflect.get(value, "native_record_id")
      const contentBase64 = Reflect.get(value, "content_base64")
      if (typeof nativeRecordID !== "string" || typeof contentBase64 !== "string") {
        throw new Error("Native trace chunk member is incomplete")
      }
      return {
        native_record_id: nativeRecordID,
        content_base64: contentBase64,
      }
    })
}
