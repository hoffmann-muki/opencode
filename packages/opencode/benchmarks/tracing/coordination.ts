import { randomUUID } from "node:crypto"
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { writeTraceRunIndex } from "./recorder.ts"

export type TraceSelectionStrategy = "explicit_ids" | "full_dataset" | "ordered_window"

export interface TraceRun {
  readonly id: string
  readonly root: string
  readonly createdAt: string
  readonly benchmark: string
  readonly framework: string
}

export interface TraceSelection {
  readonly instanceIds: readonly string[]
  readonly strategy: TraceSelectionStrategy
  readonly minimumAttemptsPerInstance?: number
}

export interface TraceHarnessAdapter {
  prepareFinalization(run: TraceRun): void
  resolveSelection(run: TraceRun, observedInstanceIds: readonly string[]): TraceSelection
}

export class DirectTraceHarness implements TraceHarnessAdapter {
  constructor(readonly selection: TraceSelection) {}

  prepareFinalization(_run: TraceRun): void {}

  resolveSelection(_run: TraceRun, _observedInstanceIds: readonly string[]): TraceSelection {
    return this.selection
  }
}

export function createTraceRun(baseDirectory: string, benchmark: string, framework: string): TraceRun {
  if (!benchmark.trim() || !framework.trim()) throw new Error("Trace benchmark and framework cannot be empty.")
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
    framework,
  }
}

export function finalizeTraceRun(run: TraceRun, harness: TraceHarnessAdapter): void {
  if (!existsSync(run.root)) throw new Error("Trace run root must be a real directory.")
  const rootInfo = lstatSync(run.root)
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error("Trace run root must be a real directory.")
  }
  harness.prepareFinalization(run)
  const observed = new Map<string, Set<number>>()
  const manifests = Array.from(
    new Bun.Glob("instances/*/attempt-*/manifest.json").scanSync({
      cwd: run.root,
      onlyFiles: true,
    }),
  ).sort()
  for (const path of manifests) {
    const manifest: unknown = JSON.parse(readFileSync(resolve(run.root, path), "utf8"))
    if (
      typeof manifest !== "object" ||
      manifest === null ||
      !("run_id" in manifest) ||
      manifest.run_id !== run.id ||
      !("benchmark" in manifest) ||
      manifest.benchmark !== run.benchmark ||
      !("framework" in manifest) ||
      manifest.framework !== run.framework ||
      !("instance_id" in manifest) ||
      typeof manifest.instance_id !== "string" ||
      !manifest.instance_id ||
      !("attempt" in manifest) ||
      typeof manifest.attempt !== "number" ||
      !Number.isInteger(manifest.attempt) ||
      manifest.attempt < 1
    ) {
      throw new Error(`Trace attempt does not belong to its run: ${path}`)
    }
    const attempts = observed.get(manifest.instance_id) ?? new Set<number>()
    if (attempts.has(manifest.attempt)) {
      throw new Error(`Duplicate trace attempt ${manifest.attempt} for ${manifest.instance_id}`)
    }
    attempts.add(manifest.attempt)
    observed.set(manifest.instance_id, attempts)
  }

  const selection = harness.resolveSelection(run, [...observed.keys()])
  const minimumAttempts = selection.minimumAttemptsPerInstance ?? 1
  if (
    selection.instanceIds.length === 0 ||
    new Set(selection.instanceIds).size !== selection.instanceIds.length ||
    selection.instanceIds.some((instanceId) => !instanceId.trim()) ||
    minimumAttempts < 1 ||
    !Number.isInteger(minimumAttempts)
  ) {
    throw new Error("Trace harness returned an invalid selection.")
  }
  if (
    selection.instanceIds.some((instanceId) => !observed.has(instanceId)) ||
    [...observed.keys()].some((instanceId) => !selection.instanceIds.includes(instanceId))
  ) {
    throw new Error("Trace run index omitted because selected instances lack finalized traces.")
  }
  if (selection.instanceIds.some((instanceId) => observed.get(instanceId)!.size < minimumAttempts)) {
    throw new Error("Trace run index omitted because an instance lacks a requested attempt.")
  }
  writeTraceRunIndex({
    traceRoot: run.root,
    runId: run.id,
    benchmark: run.benchmark,
    framework: run.framework,
    instanceIds: selection.instanceIds,
    selectionStrategy: selection.strategy,
    createdAt: run.createdAt,
  })
}
