import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OpenCodeTraceAdapter, opencodeCapabilities } from "../../benchmarks/tracing/opencode.ts"
import {
  TRACE_CAPABILITY_CATEGORIES,
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

    const finalized = trace.adapter.finish("completed")
    expect(finalized.health).toBe("healthy")
    expect(finalized.complete).toBe(true)

    const events = jsonl(join(trace.attemptDir, "events.jsonl"))
    expect(events.map((event) => event.event_type)).toEqual([
      "instance.start",
      "attempt.start",
      "agent.session_start",
      "model.turn_start",
      "shell.start",
      "shell.end",
      "model.turn_end",
      "agent.session_end",
      "attempt.end",
      "instance.end",
    ])
    expect(events.find((event) => event.event_type === "shell.end")?.timing).toEqual({
      fidelity: "native_wall",
      duration_ms: 25,
    })

    const retained = Array.from(new Bun.Glob("**/*").scanSync({ cwd: trace.attemptDir, onlyFiles: true }))
      .map((path) => readFileSync(join(trace.attemptDir, path), "utf8"))
      .join("\n")
    expect(retained).not.toContain("synthetic000000000000000000000")
    expect(readFileSync(join(trace.attemptDir, "events.jsonl"), "utf8")).not.toContain('"tokens"')
    expect(
      readFileSync(join(trace.attemptDir, "native", "index.jsonl"), "utf8")
        .trim()
        .split("\n"),
    ).toHaveLength(5)

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
  return {
    attemptDir,
    identity,
    adapter: new OpenCodeTraceAdapter(
      new TraceRecorder({
        attemptDir,
        identity,
        producer: { name: "test-recorder", version: "1.0.0" },
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
      }),
    ),
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
