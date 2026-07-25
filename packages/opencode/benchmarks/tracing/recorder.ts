import { createHash, randomUUID } from "node:crypto"
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { gzipSync } from "node:zlib"

export const TRACE_SCHEMA_VERSION = "benchmark-trace/v1"
export const TRACE_CONTRACT_VERSION = "1.1.0"
export const TRACE_SCHEMA_DIGEST = "12121cb7fbdb81b1637954eefab17b1faaf39ecdff1ed4fe0d67065941ca4b17"
export const TRACE_NATIVE_CHUNK_MEDIA_TYPE = "application/vnd.benchmark-trace.native-records+jsonl+gzip"

const NATIVE_JOURNAL_FORMAT = "benchmark-trace/native-journal-v1"
const NATIVE_CHUNK_TARGET_BYTES = 1024 * 1024

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

interface NativeChunkMember extends JsonObject {
  readonly native_record_id: string
  readonly content_sha256: string
  readonly size_bytes: number
  readonly media_type: string
  readonly encoding: "utf-8" | "binary"
  readonly role: string
  readonly redaction: {
    readonly status: "applied" | "not_required"
    readonly matches: number
    readonly rules: readonly string[]
  }
  readonly content_base64: string
}

interface NativeJournalRecord extends JsonObject {
  readonly format: typeof NATIVE_JOURNAL_FORMAT
  readonly native_record_id: string
  readonly sequence: number
  readonly trace_id: string
  readonly framework: string
  readonly recorded_at: string
  readonly source: string
  readonly event_ids: readonly string[]
  readonly member: NativeChunkMember
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
  severity: "warning" | "error"
  readonly code: string
  message: string
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
const CREDENTIAL_FIELD_SUFFIXES = [
  "apikey",
  "accesskey",
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
  "secretaccesskey",
  "secretkey",
  "signedcredential",
] as const

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
const ACCOUNTING_FIELD_SUFFIXES = [...ACCOUNTING_FIELDS]

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
    /(?<![A-Za-z0-9_])(--?)?((?:[A-Za-z_][A-Za-z0-9_-]*?)?(?:api[_-]?key|access[_-]?key|access[_-]?token|auth[_-]?token|authorization(?:[_-]?header)?|client[_-]?secret|cookie|credentials|github[_-]?token|password|private[_-]?key|refresh[_-]?token|secret(?:[_-]?access)?[_-]?key|secret|signed[_-]?credential))\s*(?:=|\s)\s*(?!<redacted:)(['"]?)([^\s'"]{4,})\3/gi
  const assignmentMatches = sanitized.match(assignment)?.length ?? 0
  if (assignmentMatches > 0) {
    sanitized = sanitized.replace(assignment, "$1$2=<redacted:assignment>")
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
      if (matchesTraceField(normalized, CREDENTIAL_FIELDS, CREDENTIAL_FIELD_SUFFIXES)) {
        matches += 1
        if (!rules.includes("field.credential")) rules.push("field.credential")
        continue
      }
      if (matchesTraceField(normalized, ACCOUNTING_FIELDS, ACCOUNTING_FIELD_SUFFIXES)) {
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

function matchesTraceField(normalized: string, exact: ReadonlySet<string>, suffixes: readonly string[]): boolean {
  return exact.has(normalized) || suffixes.some((suffix) => normalized !== suffix && normalized.endsWith(suffix))
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
  private readonly artifacts = new Map<string, ArtifactReference>()
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
    this.writePreflight()
    const descriptors = openTraceJournals(this.journalPath, this.nativeIndexPath)
    this.journalFd = descriptors.journal
    this.nativeIndexFd = descriptors.nativeIndex
  }

  recordEvent(input: RecordEventInput): string | undefined {
    if (this.finalized) return undefined
    try {
      const identifiers = sanitizeTraceJson({
        ...(input.sessionId ? { session_id: input.sessionId } : {}),
        ...(input.agentId ? { agent_id: input.agentId } : {}),
        ...(input.parentAgentId ? { parent_agent_id: input.parentAgentId } : {}),
        ...(input.turnId ? { turn_id: input.turnId } : {}),
        ...(input.parentSpanId ? { parent_span_id: input.parentSpanId } : {}),
        span_id: input.spanId,
      })
      if (identifiers.matches > 0) throw new Error("Trace event identity is sensitive")
      for (const reference of input.artifacts ?? []) {
        if (!Bun.deepEquals(this.artifacts.get(reference.path), reference)) {
          throw new Error("Trace event references an artifact not owned by this recorder")
        }
      }
      const origin = sanitizeTraceJson(input.origin)
      const timing = sanitizeTraceJson(input.timing ? { ...input.timing } : { fidelity: "not_available" })
      const payload = sanitizeTraceJson(input.payload ?? {})
      const error = input.error ? sanitizeTraceJson(input.error) : undefined
      const relations = input.relations?.map((relation) => sanitizeTraceJson(relation))
      this.counters.redactionsApplied +=
        origin.matches +
        timing.matches +
        payload.matches +
        (error?.matches ?? 0) +
        (relations?.reduce((total, relation) => total + relation.matches, 0) ?? 0)
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
        origin: origin.value,
        timing: timing.value,
        payload: payload.value,
        artifacts: input.artifacts ?? [],
        ...(error ? { error: error.value } : {}),
        ...(relations ? { relations: relations.map((relation) => relation.value) } : {}),
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
      const nativeRecordId = input.nativeRecordId ?? `native-${String(this.nativeSequence + 1).padStart(8, "0")}`
      const source = sanitizeTraceText(input.source)
      if (
        !source.value ||
        source.value.length > 256 ||
        !nativeRecordId ||
        nativeRecordId.length > 512 ||
        input.eventIds.some((eventId) => !eventId || eventId.length > 512) ||
        sanitizeTraceJson([nativeRecordId, ...input.eventIds]).matches > 0
      ) {
        throw new Error("Native trace identity is invalid or sensitive")
      }
      const content = sanitizeTraceJson(input.content)
      const retained = new TextEncoder().encode(canonicalJson(content.value))
      const member = {
        native_record_id: nativeRecordId,
        content_sha256: createHash("sha256").update(retained).digest("hex"),
        size_bytes: retained.byteLength,
        media_type: "application/json",
        encoding: "utf-8",
        role: "native.opencode.event",
        redaction: {
          status: content.matches > 0 ? "applied" : "not_required",
          matches: content.matches,
          rules: content.rules,
        },
        content_base64: Buffer.from(retained).toString("base64"),
      } satisfies NativeChunkMember
      const entry = {
        format: NATIVE_JOURNAL_FORMAT,
        native_record_id: nativeRecordId,
        sequence: this.nativeSequence + 1,
        trace_id: this.identity.traceId,
        framework: this.identity.framework,
        recorded_at: input.recordedAt ?? now(),
        source: source.value,
        event_ids: [...new Set(input.eventIds)],
        member,
      } satisfies NativeJournalRecord
      appendDurable(this.nativeIndexFd, `${JSON.stringify(entry)}\n`)
      this.nativeSequence += 1
      this.counters.redactionsApplied += source.matches + content.matches
      return nativeRecordId
    } catch {
      this.reportIssue("trace.native_write_failed", "Native OpenCode evidence could not be persisted", "error")
      return undefined
    }
  }

  updateCapabilities(capabilities: readonly TraceCapability[]): void {
    const previous = this.capabilities
    try {
      assertCapabilities(capabilities)
      this.capabilities = capabilities
      this.writePreflight()
    } catch {
      this.capabilities = previous
      this.reportIssue("trace.capability_update_failed", "The capability report could not be updated", "error")
    }
  }

  reportIssue(code: string, message: string, severity: "warning" | "error" = "warning"): void {
    const timestamp = now()
    const sanitized = sanitizeTraceText(message)
    this.counters.redactionsApplied += sanitized.matches
    const current = this.issues.get(code)
    if (current) {
      current.lastSeenAt = timestamp
      current.count += 1
      current.message = sanitized.value
      if (severity === "error") current.severity = "error"
      return
    }
    this.issues.set(code, {
      severity,
      code,
      message: sanitized.value,
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
    const native = this.packNativeJournal(readNativeJournal(this.nativeIndexPath))
    const health = this.healthStatus()
    const complete = health === "healthy"
    atomicWrite(join(this.attemptDir, "events.jsonl"), journal)
    replaceWithHardLink(join(this.attemptDir, "events.jsonl"), this.journalPath)
    atomicWrite(
      this.nativeIndexPath,
      native.length > 0 ? `${native.map((record) => JSON.stringify(record)).join("\n")}\n` : "",
    )
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
          status: health,
          finalization: health === "healthy" ? "clean" : "partial",
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
      health,
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
    this.counters.redactionsApplied += matches
    return this.persistRetainedArtifact(content, role, mediaType, encoding, matches, rules)
  }

  private persistRetainedArtifact(
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
    const reference = {
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
    } satisfies ArtifactReference
    this.artifacts.set(relativePath, reference)
    return reference
  }

  private packNativeJournal(records: readonly NativeJournalRecord[]): readonly JsonObject[] {
    const chunks = records.reduce<Array<{ records: NativeJournalRecord[]; bytes: number }>>((result, record) => {
      requireNativeJournalRecord(record)
      const size = new TextEncoder().encode(`${canonicalJson(record.member)}\n`).byteLength
      const current = result.at(-1)
      if (!current || (current.records.length > 0 && current.bytes + size > NATIVE_CHUNK_TARGET_BYTES)) {
        result.push({ records: [record], bytes: size })
        return result
      }
      current.records.push(record)
      current.bytes += size
      return result
    }, [])

    return chunks.flatMap((chunk) => {
      const content = gzipSync(chunk.records.map((record) => `${canonicalJson(record.member)}\n`).join(""), {
        level: 6,
      })
      const rules = [...new Set(chunk.records.flatMap((record) => record.member.redaction.rules))]
      const matches = chunk.records.reduce((total, record) => total + record.member.redaction.matches, 0)
      const artifact = this.persistRetainedArtifact(
        content,
        "native.chunk",
        TRACE_NATIVE_CHUNK_MEDIA_TYPE,
        "binary",
        matches,
        rules,
      )
      return chunk.records.map((record) => ({
        schema_version: TRACE_SCHEMA_VERSION,
        schema_digest: TRACE_SCHEMA_DIGEST,
        native_record_id: record.native_record_id,
        sequence: record.sequence,
        trace_id: record.trace_id,
        framework: record.framework,
        recorded_at: record.recorded_at,
        source: record.source,
        artifact,
        event_ids: [...record.event_ids],
      }))
    })
  }

  private healthStatus(): "healthy" | "degraded" | "failed" {
    if ([...this.issues.values()].some((issue) => issue.severity === "error")) return "failed"
    if (this.issues.size > 0 || this.counters.droppedEvents > 0) return "degraded"
    return "healthy"
  }

  private writePreflight(): void {
    atomicWrite(
      join(this.attemptDir, "preflight.json"),
      `${JSON.stringify(
        {
          format: "benchmark-trace/preflight-v1",
          created_at: this.createdAt,
          identity: identityFields(this.identity),
          producer: this.config.producer,
          provenance: this.config.provenance,
          execution: this.config.execution,
          capabilities: this.capabilities.map(capabilityDocument),
        },
        null,
        2,
      )}\n`,
    )
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
        const events = readFileSync(join(instanceDir, dirname(manifestPath), "events.jsonl"), "utf8")
        const terminal = events
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { event_type?: string; status?: string })
          .findLast((event) => event.event_type === "attempt.end")
        const status = isTraceStatus(terminal?.status) ? terminal.status : ("degraded" as const)
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
  if (sanitizeTraceJson(identityFields(config.identity)).matches > 0) {
    throw new Error("Trace identity must not contain credential-like material.")
  }
  assertCapabilities(config.capabilities)
  if (config.capabilities.some((capability) => sanitizeTraceJson(capabilityDocument(capability)).matches > 0)) {
    throw new Error("Trace capabilities must not contain credential-like material.")
  }
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

function replaceWithHardLink(source: string, target: string): void {
  const info = lstatSync(source)
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`Trace link source must be a regular file: ${source}`)
  }
  const temporary = `${target}.${process.pid}.${randomUUID()}.link`
  try {
    linkSync(source, temporary)
    chmodSync(temporary, 0o600)
    renameSync(temporary, target)
    chmodSync(target, 0o600)
    const directory = openSync(dirname(target), "r")
    try {
      fsyncSync(directory)
    } finally {
      closeSync(directory)
    }
  } catch {
    rmSync(temporary, { force: true })
    atomicWriteBytes(target, readFileSync(source))
  }
}

function readNativeJournal(path: string): NativeJournalRecord[] {
  const content = readFileSync(path, "utf8")
  if (!content) return []
  if (!content.endsWith("\n")) throw new Error(`Native trace journal has a torn final line: ${path}`)
  return content
    .trimEnd()
    .split("\n")
    .map((line) => requireNativeJournalRecord(JSON.parse(line)))
}

function requireNativeJournalRecord(value: unknown): NativeJournalRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Native trace journal record must be an object.")
  }
  const format = Reflect.get(value, "format")
  const nativeRecordID = Reflect.get(value, "native_record_id")
  const sequence = Reflect.get(value, "sequence")
  const traceID = Reflect.get(value, "trace_id")
  const framework = Reflect.get(value, "framework")
  const recordedAt = Reflect.get(value, "recorded_at")
  const source = Reflect.get(value, "source")
  const eventIDs = Reflect.get(value, "event_ids")
  const member = Reflect.get(value, "member")
  if (!member || typeof member !== "object" || Array.isArray(member)) {
    throw new Error("Native trace journal member must be an object.")
  }
  const memberRecordID = Reflect.get(member, "native_record_id")
  const contentSha256 = Reflect.get(member, "content_sha256")
  const sizeBytes = Reflect.get(member, "size_bytes")
  const mediaType = Reflect.get(member, "media_type")
  const encoding = Reflect.get(member, "encoding")
  const role = Reflect.get(member, "role")
  const contentBase64 = Reflect.get(member, "content_base64")
  const redaction = Reflect.get(member, "redaction")
  if (!redaction || typeof redaction !== "object" || Array.isArray(redaction)) {
    throw new Error("Native trace journal redaction metadata must be an object.")
  }
  const status = Reflect.get(redaction, "status")
  const matches = Reflect.get(redaction, "matches")
  const rules = Reflect.get(redaction, "rules")
  if (
    format !== NATIVE_JOURNAL_FORMAT ||
    typeof nativeRecordID !== "string" ||
    !nativeRecordID ||
    nativeRecordID.length > 512 ||
    !Number.isInteger(sequence) ||
    Number(sequence) < 1 ||
    typeof traceID !== "string" ||
    !traceID ||
    traceID.length > 512 ||
    typeof framework !== "string" ||
    !/^[a-z][a-z0-9._-]*$/.test(framework) ||
    typeof recordedAt !== "string" ||
    !recordedAt ||
    typeof source !== "string" ||
    !source ||
    source.length > 256 ||
    !Array.isArray(eventIDs) ||
    eventIDs.some((item) => typeof item !== "string" || !item || item.length > 512) ||
    memberRecordID !== nativeRecordID ||
    typeof contentSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(contentSha256) ||
    !Number.isInteger(sizeBytes) ||
    Number(sizeBytes) < 0 ||
    typeof mediaType !== "string" ||
    !mediaType ||
    mediaType.length > 128 ||
    (encoding !== "utf-8" && encoding !== "binary") ||
    typeof role !== "string" ||
    !/^[a-z][a-z0-9._-]*$/.test(role) ||
    role.length > 128 ||
    (status !== "applied" && status !== "not_required") ||
    !Number.isInteger(matches) ||
    Number(matches) < 0 ||
    !Array.isArray(rules) ||
    rules.some((item) => typeof item !== "string") ||
    (status === "applied") !== Number(matches) > 0 ||
    Number(matches) > 0 !== rules.length > 0 ||
    typeof contentBase64 !== "string"
  ) {
    throw new Error("Native trace journal record is malformed.")
  }
  const bytes = Buffer.from(contentBase64, "base64")
  if (
    bytes.toString("base64") !== contentBase64 ||
    bytes.byteLength !== sizeBytes ||
    createHash("sha256").update(bytes).digest("hex") !== contentSha256
  ) {
    throw new Error("Native trace journal content is corrupt.")
  }
  return {
    format: NATIVE_JOURNAL_FORMAT,
    native_record_id: nativeRecordID,
    sequence: Number(sequence),
    trace_id: traceID,
    framework,
    recorded_at: recordedAt,
    source,
    event_ids: eventIDs.map(String),
    member: {
      native_record_id: nativeRecordID,
      content_sha256: contentSha256,
      size_bytes: Number(sizeBytes),
      media_type: mediaType,
      encoding,
      role,
      redaction: {
        status,
        matches: Number(matches),
        rules: rules.map(String),
      },
      content_base64: contentBase64,
    },
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
