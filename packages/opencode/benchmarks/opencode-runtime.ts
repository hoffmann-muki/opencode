import { createHash, randomUUID } from "node:crypto"
import { chmod, copyFile, mkdir, rename, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const OPENCODE_PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const REPO_ROOT = resolve(OPENCODE_PACKAGE_ROOT, "../..")
const BUILD_BINARY_PATH = join(OPENCODE_PACKAGE_ROOT, "dist", "opencode-linux-x64", "bin", "opencode")
const RUNTIME_CACHE_ROOT = join(homedir(), ".cache", "opencode-benchmarks", "runtimes")

export interface BenchmarkSourceIdentity {
  readonly version: string
  readonly commit: string
}

export interface BenchmarkRuntime extends BenchmarkSourceIdentity {
  readonly binaryPath: string
  readonly binarySha256: string
}

async function run(command: readonly string[], cwd = REPO_ROOT, env?: Record<string, string>) {
  const child = Bun.spawn([...command], {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed: ${stderr.trim() || stdout.trim()}`)
  }
  return stdout.trim()
}

export async function benchmarkSourceIdentity(): Promise<BenchmarkSourceIdentity> {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("The local Docker benchmark runtime currently requires a Linux x64 host.")
  }

  const [commit, status] = await Promise.all([
    run(["git", "rev-parse", "HEAD"]),
    run(["git", "status", "--porcelain", "--untracked-files=all"]),
  ])
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`Invalid opencode source revision: ${commit}`)
  if (status) {
    throw new Error(
      "The opencode worktree has uncommitted changes; commit them before inference so the runtime is reproducible.",
    )
  }
  return { version: `0.0.0-benchmark-${commit.slice(0, 12)}`, commit }
}

export async function ensureBenchmarkRuntime(identity: BenchmarkSourceIdentity): Promise<BenchmarkRuntime> {
  const current = await benchmarkSourceIdentity()
  if (current.commit !== identity.commit || current.version !== identity.version) {
    throw new Error("The opencode source revision changed while preparing the benchmark runtime.")
  }

  const binaryPath = join(RUNTIME_CACHE_ROOT, identity.commit, "opencode")
  if (await Bun.file(binaryPath).exists()) {
    const cachedVersion = await run([binaryPath, "--version"]).catch(() => undefined)
    if (cachedVersion !== identity.version) await rm(binaryPath, { force: true })
  }
  if (!(await Bun.file(binaryPath).exists())) {
    const temporary = `${binaryPath}.${process.pid}.${randomUUID()}.tmp`
    await mkdir(dirname(binaryPath), { recursive: true })
    try {
      await run(["bun", "run", "build", "--single", "--skip-install", "--skip-embed-web-ui"], OPENCODE_PACKAGE_ROOT, {
        OPENCODE_CHANNEL: "benchmark",
        OPENCODE_VERSION: identity.version,
      })
      await copyFile(BUILD_BINARY_PATH, temporary)
      await chmod(temporary, 0o755)
      await rename(temporary, binaryPath)
    } finally {
      await rm(temporary, { force: true })
    }
  }

  return {
    ...identity,
    binaryPath,
    binarySha256: createHash("sha256")
      .update(await Bun.file(binaryPath).bytes())
      .digest("hex"),
  }
}
