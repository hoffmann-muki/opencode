import { createHash, randomUUID } from "node:crypto"
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  writeSync,
} from "node:fs"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

export const TRACE_SCHEMA_VERSION = "benchmark-trace/v1"
export const TRACE_CONTRACT_VERSION = "1.0.0"
export const TRACE_SCHEMA_DIGEST = "ac1a30ab8981f4dd0f0260bedc48fde8b8bd3d6627c167e7ab29331fac897cb7"

export const TRACE_CAPABILITY_CATEGORIES = [
  "agent.session",
  "model.turn",
  "provider.exchange",
  "tool.invocation",
  "tool.result",
  "tool.timing",
  "shell",
  "file",
  "search",
  "browser",
  "delegation",
  "context.compaction",
  "memory",
  "harness.lifecycle",
  "container.lifecycle",
  "evaluator.lifecycle",
  "patch",
  "native.evidence",
] as const

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }
export type TraceStatus = "completed" | "failed" | "cancelled" | "timeout" | "degraded"
export type EventStatus = "started" | TraceStatus | "unknown"
export type EventPhase = "start" | "end" | "instant"
export type EventFamily =
  | "run"
  | "instance"
  | "attempt"
  | "harness"
  | "container"
  | "evaluator"
  | "agent"
  | "model"
  | "provider"
  | "tool"
  | "shell"
  | "file"
  | "search"
  | "browser"
  | "delegation"
  | "context"
  | "memory"
  | "patch"
  | "trace"
export type CapabilityCategory = (typeof TRACE_CAPABILITY_CATEGORIES)[number]
export type CapabilityState = "captured" | "derived" | "not_exposed" | "disabled" | "not_observed"
export type CapabilityCoverage = "full" | "partial" | "metadata_only" | "none"
export type TimingFidelity = "native_monotonic" | "native_wall" | "derived" | "not_available" | "not_applicable"

export interface TraceIdentity {
  readonly traceId: string
  readonly runId: string
  readonly benchmark: string
  readonly framework: string
  readonly instanceId: string
  readonly attempt: number
}

export interface TraceCapability {
  readonly category: CapabilityCategory
  readonly state: CapabilityState
  readonly coverage: CapabilityCoverage
  readonly timing: TimingFidelity
  readonly evidence: readonly string[]
  readonly limitations: readonly string[]
}

export interface TraceConfig {
  readonly attemptDir: string
  readonly identity: TraceIdentity
  readonly producer: {
    readonly name: string
    readonly version: string
  }
  readonly provenance: JsonObject
  readonly execution: JsonObject
  readonly capabilities: readonly TraceCapability[]
}

export interface ArtifactReference extends JsonObject {
  readonly sha256: string
  readonly path: string
  readonly size_bytes: number
  readonly media_type: string
  readonly encoding: "utf-8" | "binary"
  readonly role: string
  readonly redaction: {
    readonly status: "applied" | "not_required"
    readonly matches: number
    readonly rules: readonly string[]
  }
}

export interface TraceTiming {
  readonly fidelity: Exclude<TimingFidelity, "not_applicable">
  readonly clock_id?: string
  readonly started_monotonic_ns?: number
  readonly ended_monotonic_ns?: number
  readonly duration_ms?: number
}

export interface RecordEventInput {
  readonly eventType: string
  readonly eventFamily: EventFamily
  readonly phase: EventPhase
  readonly status: EventStatus
  readonly spanId: string
  readonly occurredAt?: string
  readonly sessionId?: string
  readonly agentId?: string
  readonly parentAgentId?: string
  readonly turnId?: string
  readonly parentSpanId?: string
  readonly origin: JsonObject
  readonly timing?: TraceTiming
  readonly payload?: JsonObject
  readonly artifacts?: readonly ArtifactReference[]
  readonly error?: JsonObject
  readonly relations?: readonly JsonObject[]
}

export interface TraceFinalization {
  readonly traceId: string
  readonly attemptDir: string
  readonly health: "healthy" | "degraded" | "failed"
  readonly complete: boolean
}

interface RedactionResult<T> {
  readonly value: T
  readonly matches: number
  readonly rules: readonly string[]
}

interface TraceCounters {
  eventsWritten: number
  artifactsWritten: number
  artifactBytesWritten: number
  redactionsApplied: number
  droppedEvents: number
  sequenceGaps: number
}

interface TraceIssue {
  readonly severity: "warning" | "error"
  readonly code: string
  readonly message: string
  readonly firstSeenAt: string
  lastSeenAt: string
  count: number
}

const CREDENTIAL_FIELDS = new Set([
  "apikey",
  "accesstoken",
  "authorization",
  "authorizationheader",
  "authtoken",
  "clientsecret",
  "cookie",
  "credentials",
  "githubtoken",
  "password",
  "privatekey",
  "refreshtoken",
  "secret",
  "secretkey",
  "signedcredential",
])

const ACCOUNTING_FIELDS = new Set([
  "accumulatedcost",
  "accumulatedtokenusage",
  "cachereadtokens",
  "cachewritetokens",
  "cachedtokens",
  "completiontokens",
  "cost",
  "costusd",
  "currency",
  "estimatedcost",
  "estimatedcostusd",
  "inputtokens",
  "outputtokens",
  "price",
  "prompttokens",
  "reasoningtokens",
  "tokencount",
  "tokens",
  "totalcost",
  "totalcostusd",
  "totaltokens",
  "usage",
  "usagesummary",
  "usagetometrics",
])

const TEXT_RULES = [
  {
    name: "credential.private_key",
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gs,
    replacement: "<redacted:private_key>",
  },
  {
    name: "credential.authorization",
    pattern: /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    replacement: "<redacted:authorization>",
  },
  {
    name: "credential.model_api_key",
    pattern: /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9])/g,
    replacement: "<redacted:model_api_key>",
  },
  {
    name: "credential.github_token",
    pattern: /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{20,}(?![A-Za-z0-9])/g,
    replacement: "<redacted:github_token>",
  },
  {
    name: "credential.cloud_access_key",
    pattern: /(?<![A-Z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Z0-9])/g,
    replacement: "<redacted:cloud_access_key>",
  },
] as const

export function createTraceIdentity(input: Omit<TraceIdentity, "traceId">): TraceIdentity {
  if (
    !input.runId ||
    !input.benchmark ||
    !input.framework ||
    !input.instanceId ||
    !Number.isInteger(input.attempt) ||
    input.attempt < 1
  ) {
    throw new Error("Trace identity fields must be non-empty and attempt must be positive.")
  }
  return {
    traceId: `trace-${randomUUID().replaceAll("-", "")}`,
    ...input,
  }
}

export function encodedInstanceId(instanceId: string): string {
  const bytes = new TextEncoder().encode(instanceId)
  return [...bytes]
    .map((byte) => {
      const char = String.fromCharCode(byte)
      if (/^[A-Za-z0-9._~-]$/.test(char)) return char
      return `%${byte.toString(16).toUpperCase().padStart(2, "0")}`
    })
    .join("")
}

export function traceAttemptDirectory(root: string, instanceId: string, attempt: number): string {
  return join(root, "instances", encodedInstanceId(instanceId), `attempt-${attempt}`)
}

export function traceAttemptPath(instanceId: string, attempt: number): string {
  return `instances/${encodedInstanceId(instanceId)}/attempt-${attempt}`
}

export function sanitizeTraceText(value: string): RedactionResult<string> {
  let sanitized = value
  let matches = 0
  const rules: string[] = []

  for (const rule of TEXT_RULES) {
    const found = sanitized.match(rule.pattern)?.length ?? 0
    if (found === 0) continue
    sanitized = sanitized.replace(rule.pattern, rule.replacement)
    matches += found
    rules.push(rule.name)
  }

  let uriMatches = 0
  sanitized = sanitized.replace(
    /([a-z][a-z0-9+.-]*:\/\/)([^:/@\s]+):([^/@\s]+)@/gi,
    (_match, scheme: string, username: string) => {
      uriMatches += 1
      return `${scheme}${username}:<redacted:uri_password>@`
    },
  )
  if (uriMatches > 0) {
    matches += uriMatches
    rules.push("credential.uri_password")
  }

  const assignment =
    /\b(api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|github[_-]?token|password|private[_-]?key|refresh[_-]?token|secret[_-]?key)\s*=\s*(?!<redacted:)(['"]?)([^\s'"]{4,})\2/gi
  const assignmentMatches = sanitized.match(assignment)?.length ?? 0
  if (assignmentMatches > 0) {
    sanitized = sanitized.replace(assignment, "$1=<redacted:assignment>")
    matches += assignmentMatches
    rules.push("credential.assignment")
  }

  return { value: sanitized, matches, rules }
}

export function sanitizeTraceJson(value: JsonValue): RedactionResult<JsonValue> {
  const rules: string[] = []
  let matches = 0
  const add = (result: RedactionResult<JsonValue>) => {
    matches += result.matches
    for (const rule of result.rules) {
      if (!rules.includes(rule)) rules.push(rule)
    }
    return result.value
  }

  if (Array.isArray(value)) {
    return {
      value: value.map((item) => add(sanitizeTraceJson(item))),
      matches,
      rules,
    }
  }
  if (typeof value === "object" && value !== null) {
    const sanitized: JsonObject = {}
    for (const [key, item] of Object.entries(value)) {
      const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/g, "")
      if (CREDENTIAL_FIELDS.has(normalized)) {
        matches += 1
        if (!rules.includes("field.credential")) rules.push("field.credential")
        continue
      }
      if (ACCOUNTING_FIELDS.has(normalized)) {
        matches += 1
        if (!rules.includes("field.accounting")) rules.push("field.accounting")
        continue
      }
      sanitized[key] = add(sanitizeTraceJson(item))
    }
    return { value: sanitized, matches, rules }
  }
  if (typeof value === "string") {
    const result = sanitizeTraceText(value)
    return { value: result.value, matches: result.matches, rules: result.rules }
  }
  return { value, matches, rules }
}

export class TraceRecorder {
  readonly identity: TraceIdentity
  readonly attemptDir: string

  private readonly config: TraceConfig
  private readonly journalPath: string
  private readonly nativeIndexPath: string
  private readonly createdAt: string
  private readonly journalFd: number
  private readonly nativeIndexFd: number
  private readonly counters: TraceCounters = {
    eventsWritten: 0,
    artifactsWritten: 0,
    artifactBytesWritten: 0,
    redactionsApplied: 0,
    droppedEvents: 0,
    sequenceGaps: 0,
  }
  private readonly issues = new Map<string, TraceIssue>()
  private capabilities: readonly TraceCapability[]
  private sequence = 0
  private nativeSequence = 0
  private finalized = false

  constructor(config: TraceConfig) {
    assertTraceConfig(config)
    const provenance = sanitizeTraceJson(config.provenance)
    const execution = sanitizeTraceJson(config.execution)
    const producerName = sanitizeTraceText(config.producer.name)
    const producerVersion = sanitizeTraceText(config.producer.version)
    this.counters.redactionsApplied +=
      provenance.matches + execution.matches + producerName.matches + producerVersion.matches
    this.config = {
      ...config,
      producer: {
        name: producerName.value,
        version: producerVersion.value,
      },
      provenance: provenance.value as JsonObject,
      execution: execution.value as JsonObject,
    }
    this.identity = config.identity
    this.attemptDir = resolve(config.attemptDir)
    this.createdAt = now()
    this.capabilities = config.capabilities

    ensurePrivateDirectory(this.attemptDir)
    ensurePrivateDirectory(join(this.attemptDir, "native"))
    ensurePrivateDirectory(join(this.attemptDir, "artifacts", "sha256"))
    this.journalPath = join(this.attemptDir, "journal.jsonl")
    this.nativeIndexPath = join(this.attemptDir, "native", "index.jsonl")
    assertWritableRegularPath(this.journalPath)
    assertWritableRegularPath(this.nativeIndexPath)
    const descriptors = openTraceJournals(this.journalPath, this.nativeIndexPath)
    this.journalFd = descriptors.journal
    this.nativeIndexFd = descriptors.nativeIndex
  }

  recordEvent(input: RecordEventInput): string | undefined {
    if (this.finalized) return undefined
    try {
      const payload = sanitizeTraceJson(input.payload ?? {})
      const error = input.error ? sanitizeTraceJson(input.error) : undefined
      this.counters.redactionsApplied += payload.matches + (error?.matches ?? 0)
      const eventId = `event-${String(this.sequence + 1).padStart(8, "0")}`
      const event = {
        schema_version: TRACE_SCHEMA_VERSION,
        schema_digest: TRACE_SCHEMA_DIGEST,
        event_id: eventId,
        sequence: this.sequence + 1,
        ...identityFields(this.identity),
        ...(input.sessionId ? { session_id: input.sessionId } : {}),
        ...(input.agentId ? { agent_id: input.agentId } : {}),
        ...(input.parentAgentId ? { parent_agent_id: input.parentAgentId } : {}),
        ...(input.turnId ? { turn_id: input.turnId } : {}),
        span_id: input.spanId,
        ...(input.parentSpanId ? { parent_span_id: input.parentSpanId } : {}),
        occurred_at: input.occurredAt ?? now(),
        recorded_at: now(),
        event_type: input.eventType,
        event_family: input.eventFamily,
        phase: input.phase,
        status: input.status,
        origin: input.origin,
        timing: input.timing ?? { fidelity: "not_available" },
        payload: payload.value,
        artifacts: input.artifacts ?? [],
        ...(error ? { error: error.value } : {}),
        ...(input.relations ? { relations: input.relations } : {}),
      }
      appendDurable(this.journalFd, `${JSON.stringify(event)}\n`)
      this.sequence += 1
      this.counters.eventsWritten += 1
      return eventId
    } catch {
      this.counters.droppedEvents += 1
      this.reportIssue("trace.event_write_failed", "A normalized trace event could not be persisted", "error")
      return undefined
    }
  }

  storeTextArtifact(value: string, role: string, mediaType = "text/plain"): ArtifactReference | undefined {
    if (this.finalized) return undefined
    try {
      const sanitized = sanitizeTraceText(value)
      return this.persistArtifact(
        new TextEncoder().encode(sanitized.value),
        role,
        mediaType,
        "utf-8",
        sanitized.matches,
        sanitized.rules,
      )
    } catch {
      this.reportIssue("trace.artifact_write_failed", "A text artifact could not be persisted", "error")
      return undefined
    }
  }

  storeJsonArtifact(value: JsonValue, role: string): ArtifactReference | undefined {
    if (this.finalized) return undefined
    try {
      const sanitized = sanitizeTraceJson(value)
      return this.persistArtifact(
        new TextEncoder().encode(canonicalJson(sanitized.value)),
        role,
        "application/json",
        "utf-8",
        sanitized.matches,
        sanitized.rules,
      )
    } catch {
      this.reportIssue("trace.artifact_write_failed", "A JSON artifact could not be persisted", "error")
      return undefined
    }
  }

  recordNative(input: {
    readonly source: string
    readonly content: JsonValue
    readonly eventIds: readonly string[]
    readonly recordedAt?: string
    readonly nativeRecordId?: string
  }): string | undefined {
    if (this.finalized) return undefined
    try {
      const artifact = this.storeJsonArtifact(input.content, "native.opencode.event")
      if (!artifact) return undefined
      const nativeRecordId = input.nativeRecordId ?? `native-${String(this.nativeSequence + 1).padStart(8, "0")}`
      const entry: JsonObject = {
        schema_version: TRACE_SCHEMA_VERSION,
        schema_digest: TRACE_SCHEMA_DIGEST,
        native_record_id: nativeRecordId,
        sequence: this.nativeSequence + 1,
        trace_id: this.identity.traceId,
        framework: this.identity.framework,
        recorded_at: input.recordedAt ?? now(),
        source: input.source,
        artifact,
        event_ids: [...new Set(input.eventIds)],
      }
      appendDurable(this.nativeIndexFd, `${JSON.stringify(entry)}\n`)
      this.nativeSequence += 1
      return nativeRecordId
    } catch {
      this.reportIssue("trace.native_write_failed", "Native OpenCode evidence could not be persisted", "error")
      return undefined
    }
  }

  updateCapabilities(capabilities: readonly TraceCapability[]): void {
    try {
      assertCapabilities(capabilities)
      this.capabilities = capabilities
    } catch {
      this.reportIssue("trace.capability_update_failed", "The capability report could not be updated", "error")
    }
  }

  reportIssue(code: string, message: string, severity: "warning" | "error" = "warning"): void {
    const timestamp = now()
    const current = this.issues.get(code)
    if (current) {
      current.lastSeenAt = timestamp
      current.count += 1
      return
    }
    this.issues.set(code, {
      severity,
      code,
      message: sanitizeTraceText(message).value,
      firstSeenAt: timestamp,
      lastSeenAt: timestamp,
      count: 1,
    })
  }

  finalize(): TraceFinalization {
    if (this.finalized) {
      return {
        traceId: this.identity.traceId,
        attemptDir: this.attemptDir,
        health: this.healthStatus(),
        complete: this.healthStatus() === "healthy",
      }
    }
    this.finalized = true
    closeSync(this.journalFd)
    closeSync(this.nativeIndexFd)

    const finalizedAt = now()
    const journal = readFileSync(this.journalPath, "utf8")
    const complete = this.issues.size === 0 && this.counters.droppedEvents === 0
    atomicWrite(join(this.attemptDir, "events.jsonl"), journal)
    atomicWrite(
      join(this.attemptDir, "capabilities.json"),
      `${JSON.stringify(
        {
          schema_version: TRACE_SCHEMA_VERSION,
          schema_digest: TRACE_SCHEMA_DIGEST,
          trace_id: this.identity.traceId,
          framework: this.identity.framework,
          generated_at: finalizedAt,
          capabilities: this.capabilities.map(capabilityDocument),
        },
        null,
        2,
      )}\n`,
    )
    atomicWrite(
      join(this.attemptDir, "health.json"),
      `${JSON.stringify(
        {
          schema_version: TRACE_SCHEMA_VERSION,
          schema_digest: TRACE_SCHEMA_DIGEST,
          trace_id: this.identity.traceId,
          generated_at: finalizedAt,
          status: this.healthStatus(),
          finalization: "clean",
          failure_policy: "continue_agent_without_retry",
          agent_outcome_affected: false,
          benchmark_retry_triggered: false,
          counters: {
            events_written: this.counters.eventsWritten,
            artifacts_written: this.counters.artifactsWritten,
            artifact_bytes_written: this.counters.artifactBytesWritten,
            redactions_applied: this.counters.redactionsApplied,
            dropped_events: this.counters.droppedEvents,
            sequence_gaps: this.counters.sequenceGaps,
          },
          issues: [...this.issues.values()].map((issue) => ({
            severity: issue.severity,
            code: issue.code,
            message: issue.message,
            first_seen_at: issue.firstSeenAt,
            last_seen_at: issue.lastSeenAt,
            count: issue.count,
          })),
        },
        null,
        2,
      )}\n`,
    )
    atomicWrite(
      join(this.attemptDir, "manifest.json"),
      `${JSON.stringify(
        {
          schema_version: TRACE_SCHEMA_VERSION,
          contract: contractHeader(),
          trace_id: this.identity.traceId,
          run_id: this.identity.runId,
          benchmark: this.identity.benchmark,
          framework: this.identity.framework,
          instance_id: this.identity.instanceId,
          attempt: this.identity.attempt,
          created_at: this.createdAt,
          finalized_at: finalizedAt,
          complete,
          producer: this.config.producer,
          provenance: this.config.provenance,
          execution: this.config.execution,
          files: {
            journal: "journal.jsonl",
            events: "events.jsonl",
            capabilities: "capabilities.json",
            health: "health.json",
            native_index: "native/index.jsonl",
            artifacts: "artifacts/sha256",
          },
        },
        null,
        2,
      )}\n`,
    )

    return {
      traceId: this.identity.traceId,
      attemptDir: this.attemptDir,
      health: this.healthStatus(),
      complete,
    }
  }

  private persistArtifact(
    content: Uint8Array,
    role: string,
    mediaType: string,
    encoding: "utf-8" | "binary",
    matches: number,
    rules: readonly string[],
  ): ArtifactReference {
    const digest = createHash("sha256").update(content).digest("hex")
    const relativePath = `artifacts/sha256/${digest.slice(0, 2)}/${digest}`
    const path = join(this.attemptDir, relativePath)
    ensurePrivateDirectory(dirname(path))
    let created = false
    if (existsSync(path)) {
      if (!Bun.deepEquals(readFileSync(path), Buffer.from(content))) {
        throw new Error(`Trace artifact digest collision at ${relativePath}`)
      }
      chmodSync(path, 0o600)
    } else {
      atomicWriteBytes(path, content)
      created = true
    }
    if (created) {
      this.counters.artifactsWritten += 1
      this.counters.artifactBytesWritten += content.byteLength
    }
    this.counters.redactionsApplied += matches
    return {
      sha256: digest,
      path: relativePath,
      size_bytes: content.byteLength,
      media_type: mediaType,
      encoding,
      role,
      redaction: {
        status: matches > 0 ? "applied" : "not_required",
        matches,
        rules,
      },
    }
  }

  private healthStatus(): "healthy" | "degraded" | "failed" {
    if ([...this.issues.values()].some((issue) => issue.severity === "error")) return "failed"
    if (this.issues.size > 0 || this.counters.droppedEvents > 0) return "degraded"
    return "healthy"
  }
}

export function writeTraceRunIndex(input: {
  readonly traceRoot: string
  readonly runId: string
  readonly benchmark: string
  readonly framework?: string
  readonly instanceIds: readonly string[]
  readonly selectionStrategy: "explicit_ids" | "full_dataset" | "ordered_window"
  readonly createdAt: string
}): void {
  const attempts = input.instanceIds.flatMap((instanceId) => {
    const instanceDir = join(input.traceRoot, "instances", encodedInstanceId(instanceId))
    if (!existsSync(instanceDir)) return []
    return Array.from(new Bun.Glob("attempt-*/manifest.json").scanSync({ cwd: instanceDir }))
      .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
      .map((manifestPath) => {
        const manifest = JSON.parse(readFileSync(join(instanceDir, manifestPath), "utf8")) as {
          trace_id: string
          attempt: number
        }
        const health = JSON.parse(readFileSync(join(instanceDir, dirname(manifestPath), "health.json"), "utf8")) as {
          status: string
        }
        const events = readFileSync(join(instanceDir, dirname(manifestPath), "events.jsonl"), "utf8")
        const terminal = events
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { event_type?: string; status?: string })
          .findLast((event) => event.event_type === "attempt.end")
        const status =
          health.status === "healthy" && isTraceStatus(terminal?.status) ? terminal.status : ("degraded" as const)
        return {
          trace_id: manifest.trace_id,
          instance_id: instanceId,
          attempt: manifest.attempt,
          path: traceAttemptPath(instanceId, manifest.attempt),
          status,
        }
      })
  })
  ensurePrivateDirectory(input.traceRoot)
  atomicWrite(
    join(input.traceRoot, "run.json"),
    `${JSON.stringify(
      {
        schema_version: TRACE_SCHEMA_VERSION,
        contract: contractHeader(),
        run_id: input.runId,
        benchmark: input.benchmark,
        framework: input.framework ?? "opencode",
        created_at: input.createdAt,
        finalized_at: now(),
        selection: {
          strategy: input.selectionStrategy,
          requested_count: input.instanceIds.length,
          instance_ids: input.instanceIds,
        },
        attempts,
      },
      null,
      2,
    )}\n`,
  )
}

function assertTraceConfig(config: TraceConfig): void {
  if (!config.attemptDir || !config.producer.name || !config.producer.version) {
    throw new Error("Trace recorder paths and producer identity must not be empty.")
  }
  if (
    !config.identity.traceId ||
    !config.identity.runId ||
    !config.identity.benchmark ||
    !config.identity.framework ||
    !config.identity.instanceId ||
    !Number.isInteger(config.identity.attempt) ||
    config.identity.attempt < 1
  ) {
    throw new Error("Trace identity fields must be non-empty and attempt must be positive.")
  }
  assertCapabilities(config.capabilities)
}

function assertCapabilities(capabilities: readonly TraceCapability[]): void {
  if (
    capabilities.length !== TRACE_CAPABILITY_CATEGORIES.length ||
    TRACE_CAPABILITY_CATEGORIES.some((category) => !capabilities.some((capability) => capability.category === category))
  ) {
    throw new Error("Trace capability matrix must contain every contract category exactly once.")
  }
  if (new Set(capabilities.map((capability) => capability.category)).size !== capabilities.length) {
    throw new Error("Trace capability matrix contains duplicate categories.")
  }
}

function identityFields(identity: TraceIdentity): JsonObject {
  return {
    trace_id: identity.traceId,
    run_id: identity.runId,
    benchmark: identity.benchmark,
    framework: identity.framework,
    instance_id: identity.instanceId,
    attempt: identity.attempt,
  }
}

function capabilityDocument(capability: TraceCapability): JsonObject {
  return {
    category: capability.category,
    state: capability.state,
    coverage: capability.coverage,
    timing: capability.timing,
    evidence: [...capability.evidence],
    limitations: [...capability.limitations],
  }
}

function contractHeader(): JsonObject {
  return {
    name: "benchmark-trace",
    version: TRACE_CONTRACT_VERSION,
    schema_digest: TRACE_SCHEMA_DIGEST,
  }
}

function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (typeof value === "object" && value !== null) {
    const objectValue = value as { readonly [key: string]: JsonValue }
    return `{${Object.keys(objectValue)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(objectValue[key]!)}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  const info = lstatSync(path)
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`Trace path must be a real directory: ${path}`)
  }
  chmodSync(path, 0o700)
}

function assertWritableRegularPath(path: string): void {
  if (!existsSync(path)) return
  const info = lstatSync(path)
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Trace path must be a regular file: ${path}`)
  if (info.size > 0) throw new Error(`Trace preflight refuses to append to an existing non-empty file: ${path}`)
}

function openTraceJournals(journalPath: string, nativeIndexPath: string) {
  const descriptors: number[] = []
  try {
    descriptors.push(openSync(journalPath, "a", 0o600))
    descriptors.push(openSync(nativeIndexPath, "a", 0o600))
    chmodSync(journalPath, 0o600)
    chmodSync(nativeIndexPath, 0o600)
    return {
      journal: descriptors[0]!,
      nativeIndex: descriptors[1]!,
    }
  } catch (error) {
    descriptors.forEach((descriptor) => closeSync(descriptor))
    throw error
  }
}

function appendDurable(fd: number, value: string): void {
  writeSync(fd, value, undefined, "utf8")
  fsyncSync(fd)
}

function atomicWrite(path: string, value: string): void {
  atomicWriteBytes(path, new TextEncoder().encode(value))
}

function atomicWriteBytes(path: string, value: Uint8Array): void {
  ensurePrivateDirectory(dirname(path))
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  const fd = openSync(temporary, "wx", 0o600)
  try {
    writeFileSync(fd, value)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temporary, path)
  chmodSync(path, 0o600)
  const directory = openSync(dirname(path), "r")
  try {
    fsyncSync(directory)
  } finally {
    closeSync(directory)
  }
}

function isTraceStatus(value: string | undefined): value is TraceStatus {
  return (
    value === "completed" || value === "failed" || value === "cancelled" || value === "timeout" || value === "degraded"
  )
}

function now(): string {
  return new Date().toISOString()
}

export function assertTraceInsideRoot(traceRoot: string, attemptDir: string): void {
  const path = relative(resolve(traceRoot), resolve(attemptDir))
  if (!path || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new Error("Trace attempt directory must be a strict descendant of the trace root.")
  }
}
