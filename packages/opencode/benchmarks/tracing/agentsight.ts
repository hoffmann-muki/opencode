import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"

const PROFILE_SCHEMA = "benchmark-agentsight-profile/v1"
const HEALTH_SCHEMA = "benchmark-agentsight-health/v1"
const DEFAULT_IMAGE = "agentsight:play"
const DEFAULT_READY_TIMEOUT_MS = 30_000
const DEFAULT_STOP_TIMEOUT_SECONDS = 15

type JsonObject = Record<string, unknown>

export interface AgentSightDockerTarget {
  readonly attemptDir: string
  readonly profileId: string
  readonly containerName: string
  readonly binaryPath?: string
  readonly captureTls?: boolean
  readonly scopeId?: string
}

export interface AgentSightProfileHandle {
  readonly directory: string
  finish(): Promise<void>
}

interface ProcessResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

interface AgentSightSettings {
  readonly image: string
  readonly strict: boolean
  readonly readyTimeoutMs: number
  readonly stopTimeoutSeconds: number
}

export async function startAgentSightDockerProfile(
  target: AgentSightDockerTarget,
  env: Record<string, string | undefined> = process.env,
): Promise<AgentSightProfileHandle> {
  const directory = resolve(target.attemptDir, "profiles", "agentsight")
  const settings = agentSightSettings(env)
  const startedAt = Date.now()
  try {
    return await startDockerProfile(target, env, directory, settings, startedAt)
  } catch (error) {
    const sidecar = sidecarName(target.profileId, target.scopeId ?? "task-container")
    await stopSidecar(sidecar, settings.stopTimeoutSeconds).catch(() => undefined)
    await runDocker(["rm", "--force", sidecar]).catch(() => undefined)
    const reason = `profiler initialization failed: ${errorName(error)}`
    if ((await readJson(join(directory, "health.json")))?.profileId !== target.profileId) {
      await writeUnavailableProfile(directory, target, settings.image, startedAt, reason).catch(() => undefined)
    }
    if (settings.strict) {
      if (error instanceof Error) throw error
      throw new Error(`AgentSight ${reason}`, { cause: error })
    }
    console.warn(`[agentsight] ${reason}`)
    return completedHandle(directory)
  }
}

async function startDockerProfile(
  target: AgentSightDockerTarget,
  env: Record<string, string | undefined>,
  directory: string,
  settings: AgentSightSettings,
  startedAt: number,
): Promise<AgentSightProfileHandle> {
  const sourceDirectory = join(directory, "sources", target.scopeId ?? "task-container")
  await mkdir(sourceDirectory, { recursive: true, mode: 0o700 })
  if (disabled(env)) {
    await writeUnavailableProfile(directory, target, settings.image, startedAt, "disabled")
    return completedHandle(directory)
  }
  const image = await runDocker(["image", "inspect", "--format", "{{.Id}}", settings.image])
  if (image.exitCode !== 0) {
    const reason = `image unavailable: ${settings.image}; build the AgentSight play image or set AGENTSIGHT_IMAGE`
    await writeUnavailableProfile(directory, target, settings.image, startedAt, reason)
    if (settings.strict) throw new Error(`AgentSight ${reason}`)
    return completedHandle(directory)
  }

  const inspected = await runDocker(["inspect", "--format", "{{.State.Pid}}", target.containerName])
  const initPid = Number.parseInt(inspected.stdout.trim(), 10)
  if (inspected.exitCode !== 0 || !Number.isSafeInteger(initPid) || initPid <= 0) {
    const reason = `could not resolve container init PID: ${inspected.stderr.trim() || inspected.stdout.trim()}`
    await writeUnavailableProfile(directory, target, settings.image, startedAt, reason)
    if (settings.strict) throw new Error(`AgentSight ${reason}`)
    return completedHandle(directory)
  }

  const sidecar = sidecarName(target.profileId, target.scopeId ?? "task-container")
  await runDocker(["rm", "--force", sidecar])
  const readyPath = join(sourceDirectory, "ready.json")
  await rm(readyPath, { force: true })
  const args = buildAgentSightSidecarArgs({
    image: settings.image,
    sidecar,
    sourceDirectory,
    profileId: target.profileId,
    scopeId: target.scopeId ?? "task-container",
    initPid,
    binaryPath: target.binaryPath,
    captureTls: target.captureTls ?? true,
    stopTimeoutSeconds: settings.stopTimeoutSeconds,
  })
  const launched = await runDocker(args)
  if (launched.exitCode !== 0) {
    const reason = `sidecar failed to start: ${launched.stderr.trim() || launched.stdout.trim()}`
    await writeUnavailableProfile(directory, target, settings.image, startedAt, reason)
    if (settings.strict) throw new Error(`AgentSight ${reason}`)
    return completedHandle(directory)
  }

  const ready = await waitForReady(
    readyPath,
    target.profileId,
    target.scopeId ?? "task-container",
    settings.readyTimeoutMs,
  )
  if (!ready) {
    await stopSidecar(sidecar, settings.stopTimeoutSeconds)
    const logs = await runDocker(["logs", sidecar])
    await runDocker(["rm", "--force", sidecar])
    const reason = `sidecar did not become ready within ${settings.readyTimeoutMs} ms`
    await writeUnavailableProfile(directory, target, settings.image, startedAt, reason, logs)
    if (settings.strict) throw new Error(`AgentSight ${reason}`)
    return completedHandle(directory)
  }

  await writeRootProfile(directory, {
    schema: PROFILE_SCHEMA,
    profileId: target.profileId,
    status: "capturing",
    topology: "docker-pid-host-sidecar",
    targetContainer: target.containerName,
    sourceScopes: [target.scopeId ?? "task-container"],
    image: settings.image,
    imageId: image.stdout.trim(),
    startedAt: new Date(startedAt).toISOString(),
    readyAt: new Date().toISOString(),
  })

  let finished = false
  return {
    directory,
    async finish() {
      if (finished) return
      finished = true
      try {
        const stoppedAt = Date.now()
        const stopped = await stopSidecar(sidecar, settings.stopTimeoutSeconds)
        const logs = await runDocker(["logs", sidecar])
        await runDocker(["rm", "--force", sidecar])
        await writeFileAtomic(join(directory, "collector.log"), `${logs.stdout}${logs.stderr}`)
        const sourceHealth = await readJson(join(sourceDirectory, "health.json"))
        const status = stopped.exitCode === 0 && sourceHealth?.complete === true ? "completed" : "degraded"
        await writeRootProfile(directory, {
          schema: PROFILE_SCHEMA,
          profileId: target.profileId,
          status,
          topology: "docker-pid-host-sidecar",
          targetContainer: target.containerName,
          sourceScopes: [target.scopeId ?? "task-container"],
          image: settings.image,
          imageId: image.stdout.trim(),
          startedAt: new Date(startedAt).toISOString(),
          stoppedAt: new Date(stoppedAt).toISOString(),
        })
        await writeJsonAtomic(join(directory, "health.json"), {
          schema: HEALTH_SCHEMA,
          profileId: target.profileId,
          status,
          complete: status === "completed",
          sources: {
            [target.scopeId ?? "task-container"]: sourceHealth ?? {
              status: "missing",
              complete: false,
            },
          },
          sidecarExitCode: stopped.exitCode,
        })
        await writeJsonAtomic(join(directory, "summary.json"), summarize(sourceHealth))
        if (settings.strict && status !== "completed") {
          throw new Error(`AgentSight profile ${target.profileId} completed with status ${status}`)
        }
      } catch (error) {
        await stopSidecar(sidecar, settings.stopTimeoutSeconds).catch(() => undefined)
        await runDocker(["rm", "--force", sidecar]).catch(() => undefined)
        if (settings.strict) throw error
        console.warn(`[agentsight] profile finalization failed: ${errorName(error)}`)
      }
    },
  }
}

export function buildAgentSightSidecarArgs(input: {
  readonly image: string
  readonly sidecar: string
  readonly sourceDirectory: string
  readonly profileId: string
  readonly scopeId: string
  readonly initPid: number
  readonly binaryPath?: string
  readonly captureTls: boolean
  readonly stopTimeoutSeconds: number
}): readonly string[] {
  const profileDirectory = "/output"
  const record = [
    "record",
    "--pidns-filter",
    `/proc/${input.initPid}/ns/pid`,
    "--capture-level",
    "research",
    "--profile-dir",
    profileDirectory,
    "--profile-id",
    input.profileId,
    "--scope-id",
    input.scopeId,
    "--ready-file",
    `${profileDirectory}/ready.json`,
    "--no-server",
    "--no-stdio",
  ]
  if (!input.captureTls) record.push("--no-ssl")
  if (input.binaryPath) {
    record.push("--binary-path", `/proc/${input.initPid}/root/${input.binaryPath.replace(/^\/+/, "")}`)
    record.push("--tls-binary-only")
  }
  return [
    "run",
    "--detach",
    "--name",
    input.sidecar,
    "--privileged",
    "--pid",
    "host",
    "--network",
    "none",
    "--stop-timeout",
    String(input.stopTimeoutSeconds),
    "--volume",
    "/sys:/sys:ro",
    "--volume",
    `${resolve(input.sourceDirectory)}:${profileDirectory}`,
    input.image,
    ...record,
  ]
}

function agentSightSettings(env: Record<string, string | undefined>): AgentSightSettings {
  const readyTimeoutMs = env.AGENTSIGHT_READY_TIMEOUT_SECONDS
    ? positiveSeconds(env.AGENTSIGHT_READY_TIMEOUT_SECONDS, DEFAULT_READY_TIMEOUT_MS)
    : positiveInteger(env.AGENTSIGHT_READY_TIMEOUT_MS, DEFAULT_READY_TIMEOUT_MS)
  return {
    image: env.AGENTSIGHT_IMAGE?.trim() || DEFAULT_IMAGE,
    strict: env.BENCHMARK_AGENTSIGHT_STRICT === "1",
    readyTimeoutMs,
    stopTimeoutSeconds: positiveInteger(env.AGENTSIGHT_STOP_TIMEOUT_SECONDS, DEFAULT_STOP_TIMEOUT_SECONDS),
  }
}

function positiveSeconds(value: string | undefined, fallbackMs: number): number {
  const parsed = Number.parseFloat(value ?? "")
  return Number.isFinite(parsed) && parsed > 0 ? Math.ceil(parsed * 1_000) : fallbackMs
}

function disabled(env: Record<string, string | undefined>): boolean {
  return ["0", "false", "off", "disabled"].includes(env.BENCHMARK_AGENTSIGHT?.trim().toLowerCase() ?? "")
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown error"
}

function sidecarName(profileId: string, scopeId: string): string {
  const value = `agentsight-${profileId}-${scopeId}`.toLowerCase().replaceAll(/[^a-z0-9_.-]+/g, "-")
  return value.slice(0, 120).replaceAll(/[-_.]+$/g, "") || "agentsight-profile"
}

async function waitForReady(path: string, profileId: string, scopeId: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await readJson(path)
    if (value?.schema === "agentsight-capture-ready/v1" && value.profile_id === profileId && value.scope_id === scopeId)
      return true
    await Bun.sleep(100)
  }
  return false
}

async function stopSidecar(sidecar: string, timeoutSeconds: number): Promise<ProcessResult> {
  return runDocker(["stop", "--time", String(timeoutSeconds), sidecar])
}

async function runDocker(args: readonly string[]): Promise<ProcessResult> {
  const process = Bun.spawn(["docker", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...Bun.env,
      DOCKER_BUILDKIT: Bun.env.DOCKER_BUILDKIT ?? "1",
    },
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  return { stdout, stderr, exitCode }
}

async function writeUnavailableProfile(
  directory: string,
  target: AgentSightDockerTarget,
  image: string,
  startedAt: number,
  reason: string,
  logs?: ProcessResult,
): Promise<void> {
  await writeRootProfile(directory, {
    schema: PROFILE_SCHEMA,
    profileId: target.profileId,
    status: "unavailable",
    topology: "docker-pid-host-sidecar",
    targetContainer: target.containerName,
    sourceScopes: [],
    image,
    startedAt: new Date(startedAt).toISOString(),
    stoppedAt: new Date().toISOString(),
    reason,
  })
  await writeJsonAtomic(join(directory, "health.json"), {
    schema: HEALTH_SCHEMA,
    profileId: target.profileId,
    status: "unavailable",
    complete: false,
    reason,
  })
  await writeJsonAtomic(join(directory, "summary.json"), { status: "unavailable", reason })
  if (logs) await writeFileAtomic(join(directory, "collector.log"), `${logs.stdout}${logs.stderr}`)
}

function completedHandle(directory: string): AgentSightProfileHandle {
  return { directory, finish: async () => undefined }
}

function summarize(health: JsonObject | undefined): JsonObject {
  const evidence = object(health?.evidence)
  return {
    status: health?.status ?? "missing",
    complete: health?.complete === true,
    events: evidence?.events_written ?? 0,
    writeErrors: evidence?.write_errors ?? 0,
    eventsBySource: evidence?.events_by_source ?? {},
    diagnosticsByType: evidence?.diagnostics_by_type ?? {},
  }
}

function object(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : undefined
}

async function readJson(path: string): Promise<JsonObject | undefined> {
  try {
    return object(JSON.parse(await readFile(path, "utf8")))
  } catch {
    return undefined
  }
}

async function writeRootProfile(directory: string, value: JsonObject): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await writeJsonAtomic(join(directory, "profile.json"), value)
}

async function writeJsonAtomic(path: string, value: JsonObject): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`)
}

async function writeFileAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`)
  await writeFile(temp, content, { mode: 0o600 })
  await rename(temp, path)
  await chmod(path, 0o600)
}
