import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  assessPrediction,
  capturePatch,
  findProtectedPathOverlap,
  parseSweBenchRow,
  parseUnifiedDiffPaths,
} from "../../benchmarks/swe-bench-verified"

describe("SWE-bench Verified runner", () => {
  test("does not report an empty patch as a successful prediction", () => {
    expect(assessPrediction(0, "")).toEqual({
      agentCompleted: true,
      predictionProduced: false,
      generationSucceeded: false,
    })
    expect(assessPrediction(1, "diff --git a/file b/file\n")).toEqual({
      agentCompleted: false,
      predictionProduced: true,
      generationSucceeded: false,
    })
    expect(assessPrediction(0, "diff --git a/file b/file\n").generationSucceeded).toBe(true)
  })

  test("extracts protected paths from additions, deletions, and quoted diff headers", () => {
    const patch = [
      "diff --git a/tests/existing.py b/tests/existing.py",
      "--- a/tests/existing.py",
      "+++ b/tests/existing.py",
      "@@ -1 +1 @@",
      "diff --git a/tests/deleted.py b/tests/deleted.py",
      "--- a/tests/deleted.py",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      'diff --git "a/tests/space name.py" "b/tests/space name.py"',
      '--- "a/tests/space name.py"',
      '+++ "b/tests/space name.py"',
      "@@ -1 +1 @@",
    ].join("\n")

    expect(parseUnifiedDiffPaths(patch)).toEqual(["tests/deleted.py", "tests/existing.py", "tests/space name.py"])
  })

  test("derives protected paths without retaining the hidden test patch", () => {
    const row = parseSweBenchRow({
      repo: "owner/repo",
      instance_id: "owner__repo-1",
      base_commit: "abc123",
      problem_statement: "Fix the issue.",
      test_patch:
        "diff --git a/tests/test_fix.py b/tests/test_fix.py\n--- a/tests/test_fix.py\n+++ b/tests/test_fix.py",
    })

    expect(row.protectedTestPaths).toEqual(["tests/test_fix.py"])
    expect(row).not.toHaveProperty("test_patch")
  })

  test("detects only exact protected-path overlap", () => {
    expect(
      findProtectedPathOverlap(
        ["src/fix.py", "tests/test_fix.py", "tests/test_fix.py"],
        ["tests/test_fix.py", "tests/test_other.py"],
      ),
    ).toEqual(["tests/test_fix.py"])
  })

  test("captures staged source changes while excluding benchmark agent files", async () => {
    const worktree = await mkdtemp(join(tmpdir(), "opencode-swe-bench-"))
    try {
      await runGit(worktree, "init", "--quiet")
      await writeFile(join(worktree, "source.txt"), "before\n", "utf8")
      await runGit(worktree, "add", "source.txt")
      await runGit(
        worktree,
        "-c",
        "user.name=Benchmark Test",
        "-c",
        "user.email=benchmark@example.com",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--quiet",
        "-m",
        "baseline",
      )

      await writeFile(join(worktree, "source.txt"), "after\n", "utf8")
      await mkdir(join(worktree, ".opencode", "agent"), { recursive: true })
      await writeFile(join(worktree, ".opencode", "agent", "benchmark.md"), "internal\n", "utf8")

      const captured = await capturePatch(worktree)
      expect(captured.changedPaths).toEqual(["source.txt"])
      expect(captured.patch).toContain("source.txt")
      expect(captured.patch).not.toContain(".opencode")
    } finally {
      await rm(worktree, { recursive: true, force: true })
    }
  })

  test("surfaces patch-capture failures", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-swe-bench-not-git-"))
    try {
      await expect(capturePatch(directory)).rejects.toThrow("Command failed (git")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

async function runGit(cwd: string, ...args: string[]): Promise<void> {
  const process = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  const exitCode = await process.exited
  if (exitCode === 0) return
  throw new Error(await new Response(process.stderr).text())
}
