import {
  TRACE_CAPABILITY_CATEGORIES,
  TraceRecorder,
  type CapabilityCategory,
  type CapabilityState,
  type EventFamily,
  type JsonObject,
  type JsonValue,
  type TraceCapability,
  type TraceFinalization,
  type TraceStatus,
  type TraceTiming,
} from "./recorder.ts"

interface ObservedEvent {
  readonly eventId: string
  readonly eventType: string
}

interface PendingSpan {
  readonly spanId: string
  readonly startEventId: string
  readonly startType: string
  readonly endType: string
  readonly family: EventFamily
  readonly sessionId: string
  readonly agentId?: string
  readonly turnId?: string
  readonly startedAt: number
  readonly toolName: string
}

interface SessionState {
  readonly sessionId: string
  readonly spanId: string
  readonly startedAt: number
  agentId?: string
  parentSessionId?: string
  ended: boolean
}

interface ModelState {
  readonly spanId: string
  readonly startEventId: string
  readonly sessionId: string
  readonly agentId?: string
  readonly turnId: string
  readonly startedAt: number
}

interface NativeFrame {
  readonly type: "benchmark_trace.native"
  readonly sequence: number
  readonly timestamp: number
  readonly sessionID: string
  readonly event: JsonObject
}

const TOOL_GROUPS = {
  shell: new Set(["bash", "shell"]),
  fileRead: new Set(["read"]),
  fileWrite: new Set(["write", "edit", "multiedit", "apply_patch", "patch"]),
  search: new Set(["grep", "glob", "codesearch"]),
  browser: new Set(["webfetch", "websearch", "browser"]),
  delegation: new Set(["task"]),
} as const

export class OpenCodeTraceAdapter {
  private readonly recorder: TraceRecorder
  private readonly observed = new Map<CapabilityCategory, Set<string>>()
  private readonly sessions = new Map<string, SessionState>()
  private readonly tools = new Map<string, PendingSpan>()
  private readonly finishedTools = new Set<string>()
  private readonly models = new Map<string, ModelState>()
  private readonly finishedModels = new Set<string>()
  private readonly finishedOutputs = new Set<string>()
  private readonly compactions = new Map<string, PendingSpan>()
  private readonly seenNative = new Set<string>()
  private highestNativeSequence = 0
  private readonly attemptStartedAt: number
  private readonly instanceSpan: string
  private readonly attemptSpan: string
  private readonly startupSpan: string
  private readonly executionSpan: string
  private readonly shutdownSpan: string
  private startupStartedAt: number
  private executionStartedAt?: number
  private executionEndedAt?: number
  private shutdownStartedAt?: number
  private finished?: TraceFinalization

  constructor(recorder: TraceRecorder, options: { readonly delegationEnabled: boolean; readonly startedAt?: number }) {
    this.recorder = recorder
    this.attemptStartedAt = options?.startedAt ?? Date.now()
    this.instanceSpan = `instance-${recorder.identity.traceId}`
    this.attemptSpan = `attempt-${recorder.identity.traceId}`
    this.startupSpan = `opencode-startup-${recorder.identity.traceId}`
    this.executionSpan = `opencode-execution-${recorder.identity.traceId}`
    this.shutdownSpan = `opencode-shutdown-${recorder.identity.traceId}`
    this.startupStartedAt = this.attemptStartedAt
    this.record({
      eventType: "instance.start",
      eventFamily: "instance",
      phase: "start",
      status: "started",
      spanId: this.instanceSpan,
      occurredAt: iso(this.attemptStartedAt),
      origin: harnessOrigin(),
      timing: wallStart(),
      payload: {},
    })
    this.record({
      eventType: "attempt.start",
      eventFamily: "attempt",
      phase: "start",
      status: "started",
      spanId: this.attemptSpan,
      parentSpanId: this.instanceSpan,
      occurredAt: iso(this.attemptStartedAt),
      origin: harnessOrigin(),
      timing: wallStart(),
      payload: {
        agent_configuration: {
          delegation_enabled: options.delegationEnabled,
          coordination_mode: "framework_native",
          delegation_sequence: options.delegationEnabled ? ["navigator", "patcher", "reviewer"] : [],
          sequence_enforcement: "prompt_guided",
        },
      },
    })
    this.record({
      eventType: "harness.startup_start",
      eventFamily: "harness",
      phase: "start",
      status: "started",
      spanId: this.startupSpan,
      parentSpanId: this.attemptSpan,
      occurredAt: iso(this.attemptStartedAt),
      origin: harnessOrigin(),
      timing: { fidelity: "derived" },
      payload: {},
    })
  }

  consume(value: unknown): void {
    const frame = nativeFrame(value)
    if (!frame) {
      if (string(object(value)?.type) === "benchmark_trace.native") {
        this.recorder.reportIssue(
          "opencode.invalid_native_frame",
          "OpenCode emitted a malformed native trace frame",
          "error",
        )
      }
      return
    }
    this.startExecution(frame.timestamp)
    const nativeEventType = string(frame.event.type) ?? "unknown"
    const nativeId = nativeEventId(frame)
    if (this.seenNative.has(nativeId)) return
    this.seenNative.add(nativeId)
    if (frame.sequence !== this.highestNativeSequence + 1) {
      this.recorder.reportIssue(
        "opencode.native_sequence_discontinuity",
        `Expected OpenCode native frame ${this.highestNativeSequence + 1}, observed ${frame.sequence}`,
      )
    }
    this.highestNativeSequence = Math.max(this.highestNativeSequence, frame.sequence)

    try {
      const normalized = this.normalize(frame)
      const retained = this.recorder.recordNative({
        source: `opencode.event-stream.${nativeEventType}`,
        content: frame as unknown as JsonValue,
        eventIds: normalized.map((event) => event.eventId),
        nativeRecordId: nativeId,
      })
      if (retained) {
        for (const event of normalized) this.observe("native.evidence", event.eventType)
      }
    } catch {
      this.recorder.reportIssue(
        "opencode.normalization_failed",
        `OpenCode event normalization failed for ${nativeEventType}`,
        "error",
      )
      this.record({
        eventType: "trace.issue",
        eventFamily: "trace",
        phase: "instant",
        status: "degraded",
        spanId: `opencode-native-${nativeId}`,
        parentSpanId: this.attemptSpan,
        occurredAt: iso(frame.timestamp),
        origin: nativeOrigin(nativeEventType, nativeId),
        payload: { native_event_type: nativeEventType },
      })
    }
  }

  startExecution(startedAt = Date.now(), entered = true): void {
    if (this.executionStartedAt !== undefined) return
    this.record({
      eventType: "harness.startup_end",
      eventFamily: "harness",
      phase: "end",
      status: "completed",
      spanId: this.startupSpan,
      parentSpanId: this.attemptSpan,
      occurredAt: iso(startedAt),
      origin: harnessOrigin(),
      timing: wallDuration(this.startupStartedAt, startedAt),
      payload: {},
    })
    this.executionStartedAt = startedAt
    this.record({
      eventType: "agent.execution_start",
      eventFamily: "agent",
      phase: "start",
      status: "started",
      spanId: this.executionSpan,
      parentSpanId: this.attemptSpan,
      occurredAt: iso(startedAt),
      origin: harnessOrigin(),
      timing: { fidelity: "derived" },
      payload: { entered },
    })
  }

  endExecution(status: TraceStatus, errorMessage?: string, endedAt = Date.now()): void {
    if (this.executionEndedAt !== undefined) return
    if (this.executionStartedAt === undefined) {
      this.record({
        eventType: "harness.startup_end",
        eventFamily: "harness",
        phase: "end",
        status,
        spanId: this.startupSpan,
        parentSpanId: this.attemptSpan,
        occurredAt: iso(endedAt),
        origin: harnessOrigin(),
        timing: wallDuration(this.startupStartedAt, endedAt),
        payload: {},
        ...(status === "completed" ? {} : { error: lifecycleError(errorMessage) }),
      })
      this.executionStartedAt = endedAt
      this.record({
        eventType: "agent.execution_start",
        eventFamily: "agent",
        phase: "start",
        status: "started",
        spanId: this.executionSpan,
        parentSpanId: this.attemptSpan,
        occurredAt: iso(endedAt),
        origin: harnessOrigin(),
        timing: { fidelity: "derived" },
        payload: { entered: false },
      })
    }
    this.closeIncompleteSpans(endedAt)
    const openSessions = [...this.sessions.values()].filter((session) => !session.ended)
    if (openSessions.length > 0) {
      this.recorder.reportIssue(
        "opencode.incomplete_session",
        `${openSessions.length} OpenCode sessions ended without a native idle boundary`,
      )
    }
    for (const session of openSessions) {
      this.endSession(session, status === "completed" ? "degraded" : status, endedAt, "execution_boundary")
    }
    this.record({
      eventType: "agent.execution_end",
      eventFamily: "agent",
      phase: "end",
      status,
      spanId: this.executionSpan,
      parentSpanId: this.attemptSpan,
      occurredAt: iso(endedAt),
      origin: harnessOrigin(),
      timing: wallDuration(this.executionStartedAt, endedAt),
      payload: {},
      ...(status === "completed" ? {} : { error: lifecycleError(errorMessage) }),
    })
    this.executionEndedAt = endedAt
    this.shutdownStartedAt = endedAt
    this.record({
      eventType: "harness.shutdown_start",
      eventFamily: "harness",
      phase: "start",
      status: "started",
      spanId: this.shutdownSpan,
      parentSpanId: this.attemptSpan,
      occurredAt: iso(endedAt),
      origin: harnessOrigin(),
      timing: { fidelity: "derived" },
      payload: {},
    })
  }

  containerObserved(metadata: JsonObject, occurredAt = this.attemptStartedAt): void {
    this.record({
      eventType: "container.observed",
      eventFamily: "container",
      phase: "instant",
      status: "completed",
      spanId: `opencode-container-${this.recorder.identity.traceId}`,
      parentSpanId: this.lifecycleParentSpan,
      occurredAt: iso(occurredAt),
      origin: harnessOrigin(),
      timing: { fidelity: "derived" },
      payload: metadata,
    })
  }

  finish(status: TraceStatus, errorMessage?: string, endedAt = Date.now()): TraceFinalization {
    if (this.finished) return this.finished
    this.endExecution(status, errorMessage, endedAt)
    const error = status === "completed" ? undefined : lifecycleError(errorMessage)
    this.record({
      eventType: "harness.shutdown_end",
      eventFamily: "harness",
      phase: "end",
      status,
      spanId: this.shutdownSpan,
      parentSpanId: this.attemptSpan,
      occurredAt: iso(endedAt),
      origin: harnessOrigin(),
      timing: wallDuration(this.shutdownStartedAt ?? endedAt, endedAt),
      payload: {},
      ...(error ? { error } : {}),
    })
    this.record({
      eventType: "attempt.end",
      eventFamily: "attempt",
      phase: "end",
      status,
      spanId: this.attemptSpan,
      parentSpanId: this.instanceSpan,
      occurredAt: iso(endedAt),
      origin: harnessOrigin(),
      timing: wallDuration(this.attemptStartedAt, endedAt),
      payload: {},
      ...(error ? { error } : {}),
    })
    this.record({
      eventType: "instance.end",
      eventFamily: "instance",
      phase: "end",
      status,
      spanId: this.instanceSpan,
      occurredAt: iso(endedAt),
      origin: harnessOrigin(),
      timing: wallDuration(this.attemptStartedAt, endedAt),
      payload: {},
      ...(error ? { error } : {}),
    })
    this.recorder.updateCapabilities(opencodeCapabilities(this.observed))
    this.finished = this.recorder.finalize()
    return this.finished
  }

  get traceId(): string {
    return this.recorder.identity.traceId
  }

  get attemptDir(): string {
    return this.recorder.attemptDir
  }

  private normalize(frame: NativeFrame): readonly ObservedEvent[] {
    const nativeEventType = string(frame.event.type)
    const properties = object(frame.event.properties)
    if (!nativeEventType || !properties) return []

    if (nativeEventType === "session.created" || nativeEventType === "session.updated") {
      const info = object(properties.info)
      const sessionId = string(info?.id) ?? string(properties.sessionID)
      if (!sessionId) return []
      const session = this.ensureSession(
        sessionId,
        frame.timestamp,
        string(info?.agent),
        string(info?.parentID),
        nativeEventType,
      )
      return session ? [session] : []
    }

    const sessionId =
      string(properties.sessionID) ??
      string(object(properties.info)?.sessionID) ??
      string(object(properties.part)?.sessionID) ??
      frame.sessionID
    const sessionEvent = this.ensureSession(
      sessionId,
      frame.timestamp,
      string(object(properties.info)?.agent),
      undefined,
      nativeEventType,
    )
    const observed: ObservedEvent[] = sessionEvent ? [sessionEvent] : []

    if (nativeEventType === "session.status") {
      const status = object(properties.status)
      if (string(status?.type) === "idle") {
        const session = this.sessions.get(sessionId)
        if (session && !session.ended) {
          const event = this.endSession(session, "completed", frame.timestamp, "native_idle")
          if (event) observed.push(event)
        }
      }
      return observed
    }

    if (nativeEventType === "session.error") {
      const error = object(properties.error)
      const event = this.record({
        eventType: "agent.error",
        eventFamily: "agent",
        phase: "instant",
        status: "failed",
        spanId: `opencode-error-${nativeEventId(frame)}`,
        parentSpanId: this.sessions.get(sessionId)?.spanId ?? this.attemptSpan,
        sessionId,
        occurredAt: iso(frame.timestamp),
        origin: nativeOrigin(nativeEventType, nativeEventId(frame)),
        payload: {},
        error: {
          code: nativeErrorCode(error?.name),
          message: errorMessage(error),
        },
      })
      if (event) observed.push({ eventId: event, eventType: "agent.error" })
      return observed
    }

    if (nativeEventType === "session.compacted") {
      const pending = this.compactions.get(sessionId)
      if (!pending) return observed
      const eventId = this.record({
        eventType: "context.compaction_end",
        eventFamily: "context",
        phase: "end",
        status: "completed",
        spanId: pending.spanId,
        parentSpanId: this.sessions.get(sessionId)?.spanId ?? this.attemptSpan,
        sessionId,
        agentId: pending.agentId,
        occurredAt: iso(frame.timestamp),
        origin: nativeOrigin(nativeEventType, nativeEventId(frame)),
        timing: wallDuration(pending.startedAt, frame.timestamp),
        payload: {},
        relations: [{ type: "caused_by", event_id: pending.startEventId }],
      })
      this.compactions.delete(sessionId)
      if (eventId) observed.push({ eventId, eventType: "context.compaction_end" })
      return observed
    }

    if (nativeEventType === "message.updated") {
      const info = object(properties.info)
      if (string(info?.role) !== "assistant") return observed
      if (!info) return observed
      return [...observed, ...this.modelEvent(frame, sessionId, info)]
    }

    if (nativeEventType !== "message.part.updated") return observed
    const part = object(properties.part)
    const partType = string(part?.type)
    if (partType === "tool") return [...observed, ...this.toolEvent(frame, sessionId, part)]
    if (partType === "compaction") {
      if (this.compactions.has(sessionId)) return observed
      const artifact = this.recorder.storeJsonArtifact(part ?? {}, "context.compaction")
      const spanId = `opencode-compaction-${string(part?.id) ?? nativeEventId(frame)}`
      const eventId = this.record({
        eventType: "context.compaction_start",
        eventFamily: "context",
        phase: "start",
        status: "started",
        spanId,
        parentSpanId: this.sessions.get(sessionId)?.spanId ?? this.attemptSpan,
        sessionId,
        occurredAt: iso(frame.timestamp),
        origin: nativeOrigin(nativeEventType, nativeEventId(frame)),
        payload: {
          automatic: boolean(part?.auto) ?? false,
          overflow: boolean(part?.overflow) ?? false,
        },
        artifacts: artifact ? [artifact] : [],
      })
      if (eventId) {
        this.compactions.set(sessionId, {
          spanId,
          startEventId: eventId,
          startType: "context.compaction_start",
          endType: "context.compaction_end",
          family: "context",
          sessionId,
          agentId: this.sessions.get(sessionId)?.agentId,
          startedAt: frame.timestamp,
          toolName: "compaction",
        })
        observed.push({ eventId, eventType: "context.compaction_start" })
      }
      return observed
    }
    if (partType === "text" && object(part?.time)?.end !== undefined) {
      const outputKey = `${sessionId}:text:${string(part?.id) ?? nativeEventId(frame)}`
      if (this.finishedOutputs.has(outputKey)) return observed
      this.finishedOutputs.add(outputKey)
      const artifact = this.recorder.storeTextArtifact(string(part?.text) ?? "", "model.response", "text/plain")
      const event = this.record({
        eventType: "model.output",
        eventFamily: "model",
        phase: "instant",
        status: "completed",
        spanId: `opencode-text-${string(part?.id) ?? nativeEventId(frame)}`,
        parentSpanId: this.sessions.get(sessionId)?.spanId ?? this.attemptSpan,
        sessionId,
        turnId: string(part?.messageID),
        occurredAt: iso(number(object(part?.time)?.end) ?? frame.timestamp),
        origin: nativeOrigin(nativeEventType, nativeEventId(frame)),
        payload: { content_type: "text" },
        artifacts: artifact ? [artifact] : [],
      })
      if (event) observed.push({ eventId: event, eventType: "model.output" })
    }
    if (partType === "reasoning" && object(part?.time)?.end !== undefined) {
      const outputKey = `${sessionId}:reasoning:${string(part?.id) ?? nativeEventId(frame)}`
      if (this.finishedOutputs.has(outputKey)) return observed
      this.finishedOutputs.add(outputKey)
      const artifact = this.recorder.storeTextArtifact(string(part?.text) ?? "", "model.reasoning", "text/plain")
      const event = this.record({
        eventType: "model.reasoning",
        eventFamily: "model",
        phase: "instant",
        status: "completed",
        spanId: `opencode-reasoning-${string(part?.id) ?? nativeEventId(frame)}`,
        parentSpanId: this.sessions.get(sessionId)?.spanId ?? this.attemptSpan,
        sessionId,
        turnId: string(part?.messageID),
        occurredAt: iso(number(object(part?.time)?.end) ?? frame.timestamp),
        origin: nativeOrigin(nativeEventType, nativeEventId(frame)),
        payload: {},
        artifacts: artifact ? [artifact] : [],
      })
      if (event) observed.push({ eventId: event, eventType: "model.reasoning" })
    }
    return observed
  }

  private modelEvent(frame: NativeFrame, sessionId: string, info: JsonObject): readonly ObservedEvent[] {
    const messageId = string(info.id)
    if (!messageId) return []
    const createdAt = number(object(info.time)?.created) ?? frame.timestamp
    const completedAt = number(object(info.time)?.completed)
    const key = `${sessionId}:${messageId}`
    if (this.finishedModels.has(key)) return []
    const agentId = string(info.agent)
    const observed: ObservedEvent[] = []
    if (!this.models.has(key)) {
      const spanId = `opencode-model-${messageId}`
      const startEventId = this.record({
        eventType: "model.turn_start",
        eventFamily: "model",
        phase: "start",
        status: "started",
        spanId,
        parentSpanId: this.sessions.get(sessionId)?.spanId ?? this.attemptSpan,
        sessionId,
        agentId,
        turnId: messageId,
        occurredAt: iso(createdAt),
        origin: nativeOrigin(string(frame.event.type) ?? "message.updated", nativeEventId(frame)),
        timing: wallStart(),
        payload: {
          model: string(info.modelID) ?? "unknown",
          provider: string(info.providerID) ?? "unknown",
        },
      })
      if (startEventId) {
        observed.push({ eventId: startEventId, eventType: "model.turn_start" })
        this.models.set(key, { spanId, startEventId, sessionId, agentId, turnId: messageId, startedAt: createdAt })
      }
    }
    if (completedAt === undefined) return observed
    const pending = this.models.get(key)
    if (!pending) return observed
    const eventId = this.record({
      eventType: "model.turn_end",
      eventFamily: "model",
      phase: "end",
      status: object(info.error) ? "failed" : "completed",
      spanId: pending.spanId,
      parentSpanId: this.sessions.get(sessionId)?.spanId ?? this.attemptSpan,
      sessionId,
      agentId: pending.agentId,
      turnId: pending.turnId,
      occurredAt: iso(completedAt),
      origin: nativeOrigin(string(frame.event.type) ?? "message.updated", nativeEventId(frame)),
      timing: wallDuration(pending.startedAt, completedAt),
      payload: {
        finish_reason: string(info.finish) ?? "unknown",
      },
      relations: [{ type: "caused_by", event_id: pending.startEventId }],
      ...(object(info.error)
        ? { error: { code: "opencode.model_error", message: errorMessage(object(info.error)) } }
        : {}),
    })
    this.models.delete(key)
    this.finishedModels.add(key)
    if (eventId) observed.push({ eventId, eventType: "model.turn_end" })
    return observed
  }

  private toolEvent(frame: NativeFrame, sessionId: string, part: JsonObject | undefined): readonly ObservedEvent[] {
    if (!part) return []
    const state = object(part.state)
    const stateStatus = string(state?.status)
    const partId = string(part.id)
    const toolName = string(part.tool)
    if (!state || !stateStatus || !partId || !toolName) return []
    if (stateStatus === "pending") return []
    const key = `${sessionId}:${partId}`
    if (this.finishedTools.has(key)) return []
    const classified = classifyTool(toolName, object(state.input))
    const agentId = this.sessions.get(sessionId)?.agentId
    const turnId = string(part.messageID)
    const observed: ObservedEvent[] = []
    const startTime = number(object(state.time)?.start) ?? frame.timestamp
    const model = turnId ? this.models.get(`${sessionId}:${turnId}`) : undefined
    if (model) {
      const eventId = this.record({
        eventType: "model.turn_end",
        eventFamily: "model",
        phase: "end",
        status: "completed",
        spanId: model.spanId,
        parentSpanId: this.sessions.get(sessionId)?.spanId ?? this.rootParentSpan,
        sessionId,
        agentId: model.agentId,
        turnId: model.turnId,
        occurredAt: iso(startTime),
        origin: nativeOrigin(string(frame.event.type) ?? "message.part.updated", nativeEventId(frame)),
        timing: wallDuration(model.startedAt, startTime),
        payload: {
          finish_reason: "tool_calls",
          boundary: "native_tool_start",
        },
        relations: [{ type: "caused_by", event_id: model.startEventId }],
      })
      this.models.delete(`${sessionId}:${turnId}`)
      this.finishedModels.add(`${sessionId}:${turnId}`)
      if (eventId) observed.push({ eventId, eventType: "model.turn_end" })
    }
    let pending = this.tools.get(key)

    if (!pending) {
      const artifact = this.recorder.storeJsonArtifact(object(state.input) ?? {}, "tool.input")
      const spanId = `opencode-tool-${partId}`
      const startEventId = this.record({
        eventType: classified.startType,
        eventFamily: classified.family,
        phase: "start",
        status: "started",
        spanId,
        parentSpanId: this.sessions.get(sessionId)?.spanId ?? this.attemptSpan,
        sessionId,
        agentId,
        turnId,
        occurredAt: iso(startTime),
        origin: nativeOrigin(string(frame.event.type) ?? "message.part.updated", nativeEventId(frame)),
        timing: wallStart(),
        payload: {
          tool: {
            name: toolName,
            call_id: string(part.callID) ?? partId,
            arguments: object(state.input) ?? {},
          },
        },
        artifacts: artifact ? [artifact] : [],
      })
      if (startEventId) {
        pending = {
          spanId,
          startEventId,
          startType: classified.startType,
          endType: classified.endType,
          family: classified.family,
          sessionId,
          agentId,
          turnId,
          startedAt: startTime,
          toolName,
        }
        this.tools.set(key, pending)
        observed.push({ eventId: startEventId, eventType: classified.startType })
      }
    }

    if (stateStatus === "running" || !pending) return observed
    const endedAt = number(object(state.time)?.end) ?? frame.timestamp
    const output =
      stateStatus === "completed" ? (string(state.output) ?? "") : (string(state.error) ?? "OpenCode tool failed")
    const artifact = this.recorder.storeTextArtifact(
      output,
      stateStatus === "completed" ? "tool.output" : "tool.error",
      "text/plain",
    )
    const metadata = object(state.metadata)
    const status = stateStatus === "completed" ? "completed" : "failed"
    const eventId = this.record({
      eventType: pending.endType,
      eventFamily: pending.family,
      phase: "end",
      status,
      spanId: pending.spanId,
      parentSpanId: this.sessions.get(sessionId)?.spanId ?? this.attemptSpan,
      sessionId,
      agentId: pending.agentId,
      turnId: pending.turnId,
      occurredAt: iso(endedAt),
      origin: nativeOrigin(string(frame.event.type) ?? "message.part.updated", nativeEventId(frame)),
      timing: wallDuration(pending.startedAt, endedAt),
      payload: {
        tool: {
          name: toolName,
          call_id: string(part.callID) ?? partId,
        },
        ...(typeof metadata?.exit === "number" ? { exit_code: metadata.exit } : {}),
        ...(classified.family === "delegation" && string(metadata?.sessionId)
          ? { child_session_id: string(metadata?.sessionId)! }
          : {}),
      },
      artifacts: artifact ? [artifact] : [],
      relations: [{ type: "caused_by", event_id: pending.startEventId }],
      ...(stateStatus === "error" ? { error: { code: "opencode.tool_error", message: output } } : {}),
    })
    this.tools.delete(key)
    this.finishedTools.add(key)
    if (eventId) observed.push({ eventId, eventType: pending.endType })
    return observed
  }

  private ensureSession(
    sessionId: string,
    startedAt: number,
    agentId: string | undefined,
    parentSessionId: string | undefined,
    nativeEventType: string,
  ): ObservedEvent | undefined {
    const current = this.sessions.get(sessionId)
    if (current) {
      if (agentId) current.agentId = agentId
      if (parentSessionId) current.parentSessionId = parentSessionId
      return undefined
    }
    const spanId = `opencode-session-${sessionId}`
    const parentSpanId = parentSessionId
      ? (this.sessions.get(parentSessionId)?.spanId ?? this.rootParentSpan)
      : this.rootParentSpan
    const eventId = this.record({
      eventType: "agent.session_start",
      eventFamily: "agent",
      phase: "start",
      status: "started",
      spanId,
      parentSpanId,
      sessionId,
      agentId,
      occurredAt: iso(startedAt),
      origin: nativeOrigin(nativeEventType, `opencode-session-start-${sessionId}`),
      timing: wallStart(),
      payload: {
        role: parentSessionId ? "subagent" : "root",
        ...(parentSessionId ? { parent_session_id: parentSessionId } : {}),
      },
    })
    this.sessions.set(sessionId, {
      sessionId,
      spanId,
      startedAt,
      agentId,
      parentSessionId,
      ended: false,
    })
    return eventId ? { eventId, eventType: "agent.session_start" } : undefined
  }

  private endSession(
    session: SessionState,
    status: TraceStatus,
    endedAt: number,
    reason: string,
  ): ObservedEvent | undefined {
    const eventId = this.record({
      eventType: "agent.session_end",
      eventFamily: "agent",
      phase: "end",
      status,
      spanId: session.spanId,
      parentSpanId: session.parentSessionId
        ? (this.sessions.get(session.parentSessionId)?.spanId ?? this.rootParentSpan)
        : this.rootParentSpan,
      sessionId: session.sessionId,
      agentId: session.agentId,
      occurredAt: iso(endedAt),
      origin: nativeOrigin("session.status", `opencode-session-end-${session.sessionId}`),
      timing: wallDuration(session.startedAt, endedAt),
      payload: { reason },
    })
    session.ended = true
    return eventId ? { eventId, eventType: "agent.session_end" } : undefined
  }

  private closeIncompleteSpans(endedAt: number): void {
    if (this.tools.size > 0 || this.models.size > 0 || this.compactions.size > 0) {
      this.recorder.reportIssue(
        "opencode.incomplete_native_span",
        `${this.tools.size + this.models.size + this.compactions.size} OpenCode activities ended without a native result`,
      )
    }
    for (const pending of this.tools.values()) {
      this.record({
        eventType: pending.endType,
        eventFamily: pending.family,
        phase: "end",
        status: "degraded",
        spanId: pending.spanId,
        parentSpanId: this.sessions.get(pending.sessionId)?.spanId ?? this.attemptSpan,
        sessionId: pending.sessionId,
        agentId: pending.agentId,
        turnId: pending.turnId,
        occurredAt: iso(endedAt),
        origin: adapterOrigin(),
        timing: wallDuration(pending.startedAt, endedAt),
        payload: {
          tool: { name: pending.toolName },
          closure: "adapter_finalization",
        },
        relations: [{ type: "caused_by", event_id: pending.startEventId }],
      })
    }
    this.tools.clear()
    for (const pending of this.models.values()) {
      this.record({
        eventType: "model.turn_end",
        eventFamily: "model",
        phase: "end",
        status: "degraded",
        spanId: pending.spanId,
        parentSpanId: this.sessions.get(pending.sessionId)?.spanId ?? this.attemptSpan,
        sessionId: pending.sessionId,
        agentId: pending.agentId,
        turnId: pending.turnId,
        occurredAt: iso(endedAt),
        origin: adapterOrigin(),
        timing: wallDuration(pending.startedAt, endedAt),
        payload: { closure: "adapter_finalization" },
        relations: [{ type: "caused_by", event_id: pending.startEventId }],
      })
    }
    this.models.clear()
    for (const pending of this.compactions.values()) {
      this.record({
        eventType: pending.endType,
        eventFamily: "context",
        phase: "end",
        status: "degraded",
        spanId: pending.spanId,
        parentSpanId: this.sessions.get(pending.sessionId)?.spanId ?? this.attemptSpan,
        sessionId: pending.sessionId,
        agentId: pending.agentId,
        occurredAt: iso(endedAt),
        origin: adapterOrigin(),
        timing: wallDuration(pending.startedAt, endedAt),
        payload: { closure: "adapter_finalization" },
        relations: [{ type: "caused_by", event_id: pending.startEventId }],
      })
    }
    this.compactions.clear()
  }

  private record(input: Parameters<TraceRecorder["recordEvent"]>[0]): string | undefined {
    const eventId = this.recorder.recordEvent(input)
    if (!eventId) return undefined
    this.observeForEvent(input.eventType, input.eventFamily, input.phase)
    return eventId
  }

  private observeForEvent(eventType: string, family: EventFamily, phase: "start" | "end" | "instant"): void {
    if (eventType.startsWith("agent.session")) this.observe("agent.session", eventType)
    if (family === "model") this.observe("model.turn", eventType)
    if (family === "provider") this.observe("provider.exchange", eventType)
    if (
      family === "tool" ||
      family === "shell" ||
      family === "file" ||
      family === "search" ||
      family === "browser" ||
      family === "delegation"
    ) {
      this.observe(phase === "start" ? "tool.invocation" : "tool.result", eventType)
      if (phase === "end") this.observe("tool.timing", eventType)
    }
    if (
      family === "shell" ||
      family === "file" ||
      family === "search" ||
      family === "browser" ||
      family === "delegation"
    ) {
      this.observe(family, eventType)
    }
    if (family === "context") this.observe("context.compaction", eventType)
    if (family === "harness") this.observe("harness.lifecycle", eventType)
    if (family === "container") this.observe("container.lifecycle", eventType)
    if (family === "evaluator") this.observe("evaluator.lifecycle", eventType)
    if (family === "patch") this.observe("patch", eventType)
    if (eventType === "file.patch") this.observe("patch", eventType)
  }

  private observe(category: CapabilityCategory, eventType: string): void {
    const events = this.observed.get(category) ?? new Set<string>()
    events.add(eventType)
    this.observed.set(category, events)
  }

  private get rootParentSpan(): string {
    return this.executionSpan
  }

  private get lifecycleParentSpan(): string {
    if (this.executionStartedAt === undefined) return this.startupSpan
    if (this.executionEndedAt === undefined) return this.executionSpan
    return this.shutdownSpan
  }
}

export function opencodeCapabilities(
  observed: ReadonlyMap<CapabilityCategory, Set<string>>,
): readonly TraceCapability[] {
  const unavailable = new Set<CapabilityCategory>(["provider.exchange", "memory", "evaluator.lifecycle"])
  if (!observed.has("container.lifecycle")) unavailable.add("container.lifecycle")
  const characteristics: Partial<
    Record<
      CapabilityCategory,
      readonly [CapabilityState, "full" | "partial" | "metadata_only", TraceTiming["fidelity"]]
    >
  > = {
    "agent.session": ["captured", "full", "native_wall"],
    "model.turn": ["derived", "partial", "native_wall"],
    "tool.invocation": ["captured", "full", "native_wall"],
    "tool.result": ["captured", "full", "native_wall"],
    "tool.timing": ["captured", "full", "native_wall"],
    shell: ["captured", "full", "native_wall"],
    file: ["captured", "full", "native_wall"],
    search: ["captured", "full", "native_wall"],
    browser: ["captured", "full", "native_wall"],
    delegation: ["captured", "full", "native_wall"],
    "context.compaction": ["captured", "full", "native_wall"],
    "harness.lifecycle": ["derived", "full", "derived"],
    "container.lifecycle": ["captured", "metadata_only", "derived"],
    patch: ["captured", "full", "native_wall"],
    "native.evidence": ["captured", "full", "native_wall"],
  }
  const limitations: Partial<Record<CapabilityCategory, readonly string[]>> = {
    "model.turn": [
      "Model boundaries are derived from assistant creation and the first native tool-call or message-completion boundary; exact provider request bodies are not exposed.",
    ],
    "provider.exchange": ["Exact provider request and response payloads are not exposed by the OpenCode event stream."],
    "harness.lifecycle": [
      "Startup and shutdown are coarse harness-owned phases; benchmark-specific infrastructure is intentionally not subdivided.",
    ],
    shell: ["Nested operating-system subprocesses are outside the OpenCode shell-tool boundary."],
    memory: ["OpenCode does not expose a distinct durable memory subsystem in this benchmark configuration."],
  }

  return TRACE_CAPABILITY_CATEGORIES.map((category) => {
    const evidence = [...(observed.get(category) ?? [])].sort()
    if (unavailable.has(category)) {
      return {
        category,
        state: "not_exposed",
        coverage: "none",
        timing: "not_available",
        evidence: [],
        limitations: limitations[category] ?? [],
      }
    }
    if (evidence.length === 0) {
      return {
        category,
        state: "not_observed",
        coverage: "none",
        timing: "not_available",
        evidence: [],
        limitations: limitations[category] ?? [],
      }
    }
    const [state, coverage, timing] = characteristics[category] ?? ["captured", "partial", "not_available"]
    return {
      category,
      state,
      coverage,
      timing,
      evidence,
      limitations: limitations[category] ?? [],
    }
  })
}

function classifyTool(toolName: string, input: JsonObject | undefined) {
  const normalized = toolName.toLowerCase()
  if (TOOL_GROUPS.shell.has(normalized))
    return { startType: "shell.start", endType: "shell.end", family: "shell" as const }
  if (TOOL_GROUPS.fileRead.has(normalized))
    return { startType: "file.read", endType: "file.read", family: "file" as const }
  if (TOOL_GROUPS.fileWrite.has(normalized)) {
    const patch = normalized.includes("patch") || typeof input?.patch === "string"
    return {
      startType: patch ? "file.patch" : "file.write",
      endType: patch ? "file.patch" : "file.write",
      family: "file" as const,
    }
  }
  if (TOOL_GROUPS.search.has(normalized))
    return { startType: "search.start", endType: "search.end", family: "search" as const }
  if (TOOL_GROUPS.browser.has(normalized))
    return { startType: "browser.start", endType: "browser.end", family: "browser" as const }
  if (TOOL_GROUPS.delegation.has(normalized)) {
    return { startType: "delegation.start", endType: "delegation.end", family: "delegation" as const }
  }
  return { startType: "tool.start", endType: "tool.end", family: "tool" as const }
}

function nativeFrame(value: unknown): NativeFrame | undefined {
  const frame = object(value)
  if (
    string(frame?.type) !== "benchmark_trace.native" ||
    typeof frame?.sequence !== "number" ||
    !Number.isInteger(frame.sequence) ||
    frame.sequence < 1 ||
    typeof frame?.timestamp !== "number" ||
    !Number.isFinite(frame.timestamp) ||
    frame.timestamp < 0 ||
    frame.timestamp > 253_402_300_799_999 ||
    typeof frame.sessionID !== "string" ||
    !object(frame.event)
  ) {
    return undefined
  }
  return frame as unknown as NativeFrame
}

function nativeEventId(frame: NativeFrame): string {
  return `opencode-native-${String(frame.sequence).padStart(8, "0")}`
}

function nativeOrigin(nativeEventType: string, nativeEventIdValue: string): JsonObject {
  return {
    component: "opencode",
    capture_method: "native_stream",
    native_event_type: nativeEventType,
    native_event_id: nativeEventIdValue,
  }
}

function adapterOrigin(): JsonObject {
  return {
    component: "benchmarks.tracing.opencode",
    capture_method: "derived",
  }
}

function harnessOrigin(): JsonObject {
  return {
    component: "opencode-benchmark-runner",
    capture_method: "generic_harness",
  }
}

function wallStart(): TraceTiming {
  return { fidelity: "native_wall" }
}

function wallDuration(startedAt: number, endedAt: number): TraceTiming {
  return {
    fidelity: "native_wall",
    duration_ms: Math.max(0, endedAt - startedAt),
  }
}

function iso(milliseconds: number): string {
  return new Date(milliseconds).toISOString()
}

function object(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : undefined
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function boolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined
}

function errorMessage(value: JsonObject | undefined): string {
  const data = object(value?.data)
  return string(data?.message) ?? string(value?.message) ?? string(value?.name) ?? "OpenCode reported an error"
}

function nativeErrorCode(value: unknown): string {
  const name = string(value)
  if (!name) return "opencode.session_error"
  const normalized = name
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/^[^a-z]+/, "")
  return normalized ? `opencode.${normalized}` : "opencode.session_error"
}

function lifecycleError(message?: string): JsonObject {
  return {
    code: "agent.session_failed",
    message: message || "OpenCode session did not complete",
  }
}
