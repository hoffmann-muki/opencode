import { createHash } from "node:crypto"

import type { JsonObject, JsonValue, TraceIdentity } from "./recorder.ts"

export const EXECUTION_TREE_FORMAT = "benchmark-trace/execution-tree-v1"

interface NodeState {
  readonly nodeId: string
  readonly eventType: string
  readonly eventFamily: string
  status: string
  readonly spanId: string
  readonly parentSpanId?: string
  readonly sourceEventIds: string[]
  readonly sourceSequences: number[]
  readonly startedAt?: string
  endedAt?: string
  durationMs?: number
  timingFidelity: string
  completeness: "complete" | "instant" | "start_only" | "end_only"
  readonly actor: JsonObject
  readonly boundaries: JsonObject[]
  readonly input?: JsonObject
  output?: JsonObject
  readonly data?: JsonObject
  overlapsWith: string[]
  concurrencyGroup?: string
  readonly children: NodeState[]
}

export function buildExecutionTree(input: {
  readonly events: readonly JsonObject[]
  readonly identity: TraceIdentity
  readonly schemaDigest: string
  readonly eventsContent: string | Uint8Array
  readonly generatedAt?: string
}): JsonObject {
  if (input.events.length === 0) {
    if (!input.generatedAt || !Number.isFinite(Date.parse(input.generatedAt))) {
      throw new Error("An empty execution tree requires a finalization timestamp")
    }
    return {
      schema_version: "benchmark-trace/v1",
      schema_digest: input.schemaDigest,
      format: EXECUTION_TREE_FORMAT,
      trace_id: input.identity.traceId,
      run_id: input.identity.runId,
      benchmark: input.identity.benchmark,
      framework: input.identity.framework,
      instance_id: input.identity.instanceId,
      attempt: input.identity.attempt,
      generated_at: input.generatedAt,
      complete: true,
      source: {
        path: "events.jsonl",
        sha256: createHash("sha256").update(input.eventsContent).digest("hex"),
        event_count: 0,
        represented_event_count: 0,
      },
      root: {
        node_id: "trace-root",
        started_at: null,
        ended_at: null,
        duration_ms: 0,
        children: [],
      },
      warnings: [],
    }
  }
  const ordered = input.events.toSorted((left, right) => integer(left, "sequence") - integer(right, "sequence"))
  const pending = new Map<string, NodeState[]>()
  const nodes: NodeState[] = []
  const warnings: JsonObject[] = []

  for (const event of ordered) {
    const phase = string(event, "phase")
    const spanId = string(event, "span_id")
    if (phase === "start") {
      const node = startNode(event)
      nodes.push(node)
      const candidates = pending.get(spanId) ?? []
      candidates.push(node)
      pending.set(spanId, candidates)
      continue
    }
    if (phase === "end") {
      const node = pending.get(spanId)?.find((candidate) => candidate.completeness === "start_only")
      if (!node) {
        nodes.push(endNode(event))
        warnings.push(
          warning(
            "projection.unmatched_end",
            "An end event had no matching start boundary",
            string(event, "event_id"),
            spanId,
          ),
        )
        continue
      }
      finishNode(node, event)
      continue
    }
    nodes.push(instantNode(event))
  }

  for (const node of nodes) {
    if (node.completeness !== "start_only") continue
    warnings.push(
      warning(
        "projection.unmatched_start",
        "A start event had no matching end boundary",
        node.sourceEventIds[0]!,
        node.spanId,
      ),
    )
  }

  const roots = attachNodes(nodes, warnings)
  sortNodes(roots)
  markConcurrency(roots, { value: 1 })
  const occurred = ordered.map((event) => timestamp(string(event, "occurred_at")))
  const startedAt = Math.min(...occurred)
  const endedAt = Math.max(...occurred)
  const represented = nodes.flatMap((node) => node.sourceEventIds)
  return {
    schema_version: "benchmark-trace/v1",
    schema_digest: input.schemaDigest,
    format: EXECUTION_TREE_FORMAT,
    trace_id: input.identity.traceId,
    run_id: input.identity.runId,
    benchmark: input.identity.benchmark,
    framework: input.identity.framework,
    instance_id: input.identity.instanceId,
    attempt: input.identity.attempt,
    generated_at: ordered
      .map((event) => string(event, "recorded_at"))
      .sort()
      .at(-1)!,
    complete: warnings.length === 0 && represented.length === ordered.length,
    source: {
      path: "events.jsonl",
      sha256: createHash("sha256").update(input.eventsContent).digest("hex"),
      event_count: ordered.length,
      represented_event_count: represented.length,
    },
    root: {
      node_id: "trace-root",
      started_at: new Date(startedAt).toISOString(),
      ended_at: new Date(endedAt).toISOString(),
      duration_ms: Math.max(0, endedAt - startedAt),
      children: roots.map(nodeDocument),
    },
    warnings,
  }
}

function startNode(event: JsonObject): NodeState {
  return {
    nodeId: string(event, "event_id"),
    eventType: string(event, "event_type"),
    eventFamily: string(event, "event_family"),
    status: string(event, "status"),
    spanId: string(event, "span_id"),
    parentSpanId: optionalString(event, "parent_span_id"),
    sourceEventIds: [string(event, "event_id")],
    sourceSequences: [integer(event, "sequence")],
    startedAt: string(event, "occurred_at"),
    timingFidelity: timingFidelity(event),
    completeness: "start_only",
    actor: actor(event),
    boundaries: [boundary(event)],
    input: content(event),
    overlapsWith: [],
    children: [],
  }
}

function endNode(event: JsonObject): NodeState {
  const endedAt = string(event, "occurred_at")
  return {
    nodeId: string(event, "event_id"),
    eventType: string(event, "event_type"),
    eventFamily: string(event, "event_family"),
    status: string(event, "status"),
    spanId: string(event, "span_id"),
    parentSpanId: optionalString(event, "parent_span_id"),
    sourceEventIds: [string(event, "event_id")],
    sourceSequences: [integer(event, "sequence")],
    endedAt,
    durationMs: eventDuration(event, undefined, endedAt),
    timingFidelity: timingFidelity(event),
    completeness: "end_only",
    actor: actor(event),
    boundaries: [boundary(event)],
    output: content(event),
    overlapsWith: [],
    children: [],
  }
}

function instantNode(event: JsonObject): NodeState {
  const occurredAt = string(event, "occurred_at")
  return {
    nodeId: string(event, "event_id"),
    eventType: string(event, "event_type"),
    eventFamily: string(event, "event_family"),
    status: string(event, "status"),
    spanId: string(event, "span_id"),
    parentSpanId: optionalString(event, "parent_span_id"),
    sourceEventIds: [string(event, "event_id")],
    sourceSequences: [integer(event, "sequence")],
    startedAt: occurredAt,
    endedAt: occurredAt,
    durationMs: 0,
    timingFidelity: timingFidelity(event),
    completeness: "instant",
    actor: actor(event),
    boundaries: [boundary(event)],
    data: content(event),
    overlapsWith: [],
    children: [],
  }
}

function finishNode(node: NodeState, event: JsonObject): void {
  node.sourceEventIds.push(string(event, "event_id"))
  node.sourceSequences.push(integer(event, "sequence"))
  node.endedAt = string(event, "occurred_at")
  node.durationMs = eventDuration(event, node.startedAt, node.endedAt)
  node.timingFidelity = timingFidelity(event)
  node.status = string(event, "status")
  node.completeness = "complete"
  node.boundaries.push(boundary(event))
  node.output = content(event)
}

function attachNodes(nodes: NodeState[], warnings: JsonObject[]): NodeState[] {
  const primaryBySpan = new Map<string, NodeState>()
  for (const node of nodes) {
    const current = primaryBySpan.get(node.spanId)
    if (!current || (current.completeness !== "complete" && node.completeness === "complete")) {
      primaryBySpan.set(node.spanId, node)
    }
  }

  return nodes.filter((node) => {
    if (!node.parentSpanId) return true
    const parent = primaryBySpan.get(node.parentSpanId)
    if (!parent) {
      warnings.push(
        warning(
          "projection.orphan_parent",
          "A node referenced a parent span absent from the event stream",
          node.sourceEventIds[0]!,
          node.spanId,
        ),
      )
      return true
    }
    if (parent === node || wouldCycle(node, parent, primaryBySpan)) {
      warnings.push(
        warning(
          "projection.parent_cycle",
          "A cyclic parent relationship was moved to the trace root",
          node.sourceEventIds[0]!,
          node.spanId,
        ),
      )
      return true
    }
    parent.children.push(node)
    return false
  })
}

function wouldCycle(node: NodeState, parent: NodeState, primaryBySpan: Map<string, NodeState>): boolean {
  const seen = new Set<string>()
  for (let current: NodeState | undefined = parent; current; ) {
    if (current === node || seen.has(current.nodeId)) return true
    seen.add(current.nodeId)
    current = current.parentSpanId ? primaryBySpan.get(current.parentSpanId) : undefined
  }
  return false
}

function sortNodes(nodes: NodeState[]): void {
  nodes.sort(
    (left, right) =>
      timestamp(left.startedAt ?? left.endedAt ?? "1970-01-01T00:00:00Z") -
        timestamp(right.startedAt ?? right.endedAt ?? "1970-01-01T00:00:00Z") ||
      Math.min(...left.sourceSequences) - Math.min(...right.sourceSequences),
  )
  for (const node of nodes) sortNodes(node.children)
}

function markConcurrency(nodes: NodeState[], nextGroup: { value: number }): void {
  const adjacency = new Map(nodes.map((node) => [node.nodeId, new Set<string>()]))
  for (const [index, left] of nodes.entries()) {
    for (const right of nodes.slice(index + 1)) {
      if (!overlap(left, right)) continue
      adjacency.get(left.nodeId)!.add(right.nodeId)
      adjacency.get(right.nodeId)!.add(left.nodeId)
    }
  }

  const visited = new Set<string>()
  const byId = new Map(nodes.map((node) => [node.nodeId, node]))
  for (const node of nodes) {
    if (visited.has(node.nodeId) || adjacency.get(node.nodeId)!.size === 0) continue
    const component: NodeState[] = []
    const pending = [node.nodeId]
    while (pending.length > 0) {
      const nodeId = pending.pop()!
      if (visited.has(nodeId)) continue
      visited.add(nodeId)
      component.push(byId.get(nodeId)!)
      pending.push(...[...adjacency.get(nodeId)!].sort().reverse())
    }
    const group = `concurrency-${String(nextGroup.value).padStart(6, "0")}`
    nextGroup.value += 1
    for (const member of component) {
      member.concurrencyGroup = group
      member.overlapsWith = [...adjacency.get(member.nodeId)!].sort(
        (left, right) => Math.min(...byId.get(left)!.sourceSequences) - Math.min(...byId.get(right)!.sourceSequences),
      )
    }
  }
  for (const node of nodes) markConcurrency(node.children, nextGroup)
}

function overlap(left: NodeState, right: NodeState): boolean {
  if (!left.startedAt || !left.endedAt || !right.startedAt || !right.endedAt) return false
  const leftStart = timestamp(left.startedAt)
  const leftEnd = timestamp(left.endedAt)
  const rightStart = timestamp(right.startedAt)
  const rightEnd = timestamp(right.endedAt)
  return leftEnd > leftStart && rightEnd > rightStart && leftStart < rightEnd && rightStart < leftEnd
}

function nodeDocument(node: NodeState): JsonObject {
  return {
    node_id: node.nodeId,
    kind: node.completeness === "complete" ? "activity" : node.completeness,
    event_type: node.eventType,
    event_family: node.eventFamily,
    status: node.status,
    span_id: node.spanId,
    ...(node.parentSpanId ? { parent_span_id: node.parentSpanId } : {}),
    source_event_ids: node.sourceEventIds,
    source_sequences: node.sourceSequences,
    started_at: node.startedAt ?? null,
    ended_at: node.endedAt ?? null,
    duration_ms: node.durationMs ?? null,
    timing_fidelity: node.timingFidelity,
    completeness: node.completeness,
    actor: node.actor,
    boundaries: node.boundaries,
    ...(node.input ? { input: node.input } : {}),
    ...(node.output ? { output: node.output } : {}),
    ...(node.data ? { data: node.data } : {}),
    ...(node.concurrencyGroup ? { concurrency_group: node.concurrencyGroup } : {}),
    overlaps_with: node.overlapsWith,
    children: node.children.map(nodeDocument),
  }
}

function boundary(event: JsonObject): JsonObject {
  const relations = event.relations
  return {
    event_id: string(event, "event_id"),
    sequence: integer(event, "sequence"),
    event_type: string(event, "event_type"),
    phase: string(event, "phase"),
    status: string(event, "status"),
    occurred_at: string(event, "occurred_at"),
    recorded_at: string(event, "recorded_at"),
    origin: object(event, "origin"),
    timing: object(event, "timing"),
    ...(Array.isArray(relations) ? { relations } : {}),
  }
}

function content(event: JsonObject): JsonObject {
  const error = event.error
  return {
    payload: object(event, "payload"),
    artifacts: array(event, "artifacts"),
    ...(typeof error === "object" && error !== null && !Array.isArray(error) ? { error } : {}),
  }
}

function actor(event: JsonObject): JsonObject {
  return Object.fromEntries(
    ["session_id", "agent_id", "parent_agent_id", "turn_id"].flatMap((key) => {
      const value = event[key]
      return typeof value === "string" ? [[key, value]] : []
    }),
  )
}

function eventDuration(event: JsonObject, startedAt: string | undefined, endedAt: string): number | undefined {
  const duration = object(event, "timing").duration_ms
  if (typeof duration === "number" && Number.isFinite(duration) && duration >= 0) return duration
  if (!startedAt) return undefined
  return Math.max(0, timestamp(endedAt) - timestamp(startedAt))
}

function timingFidelity(event: JsonObject): string {
  return string(object(event, "timing"), "fidelity")
}

function warning(code: string, message: string, eventId: string, spanId: string): JsonObject {
  return { code, message, event_id: eventId, span_id: spanId }
}

function timestamp(value: string): number {
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw new Error("Execution tree contains an invalid timestamp")
  return parsed
}

function string(value: JsonObject, key: string): string {
  const item = value[key]
  if (typeof item !== "string") throw new Error(`Execution tree source field ${key} is not a string`)
  return item
}

function optionalString(value: JsonObject, key: string): string | undefined {
  const item = value[key]
  if (item === undefined) return undefined
  if (typeof item !== "string") throw new Error(`Execution tree source field ${key} is invalid`)
  return item
}

function integer(value: JsonObject, key: string): number {
  const item = value[key]
  if (typeof item !== "number" || !Number.isInteger(item)) {
    throw new Error(`Execution tree source field ${key} is not an integer`)
  }
  return item
}

function object(value: JsonObject, key: string): JsonObject {
  const item = value[key]
  if (typeof item !== "object" || item === null || Array.isArray(item)) {
    throw new Error(`Execution tree source field ${key} is not an object`)
  }
  return item as JsonObject
}

function array(value: JsonObject, key: string): readonly JsonValue[] {
  const item = value[key]
  if (!Array.isArray(item)) throw new Error(`Execution tree source field ${key} is not an array`)
  return item
}
