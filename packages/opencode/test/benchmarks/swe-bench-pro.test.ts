import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  assessPrediction,
  buildEvaluationArgs,
  capturePatch,
  findProtectedPathOverlap,
  formatProblemStatement,
  parseSweBenchProPredictions,
  parseSweBenchProRow,
  parseUnifiedDiffPaths,
} from "../../benchmarks/swe-bench-pro"

describe("SWE-bench Pro runner", () => {
  test("derives protected paths without retaining hidden benchmark patches", () => {
    const row = parseSweBenchProRow(proRow())

    expect(row.protectedTestPaths).toEqual(["tests/test_fix.py"])
    expect(row).not.toHaveProperty("patch")
    expect(row).not.toHaveProperty("test_patch")
  })

  test("formats the public issue exactly like the official dataset helper", () => {
    const row = parseSweBenchProRow(proRow())

    expect(formatProblemStatement(row)).toBe(
      "Fix the issue.\n\nRequirements:\nPreserve compatibility.\n\nNew interfaces introduced:\nAdd solve(value).",
    )
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

  test("detects only exact protected-path overlap", () => {
    expect(
      findProtectedPathOverlap(
        ["src/fix.py", "tests/test_fix.py", "tests/test_fix.py"],
        ["tests/test_fix.py", "tests/test_other.py"],
      ),
    ).toEqual(["tests/test_fix.py"])
  })

  test("validates the official prediction array schema", () => {
    expect(
      parseSweBenchProPredictions([
        {
          instance_id: "instance_owner__repo-1",
          patch: "diff --git a/source.py b/source.py\n",
          prefix: "sample1",
        },
      ]),
    ).toEqual([
      {
        instance_id: "instance_owner__repo-1",
        patch: "diff --git a/source.py b/source.py\n",
        prefix: "sample1",
      },
    ])

    expect(() => parseSweBenchProPredictions([])).toThrow("at least one row")
    expect(() =>
      parseSweBenchProPredictions([
        { instance_id: "instance_owner__repo-1", patch: "", prefix: "sample1" },
        { instance_id: "instance_owner__repo-1", patch: "", prefix: "sample1" },
      ]),
    ).toThrow('Duplicate prediction for instance "instance_owner__repo-1"')
    expect(() => parseSweBenchProPredictions([{ instance_id: "instance_owner__repo-1", patch: "" }])).toThrow(
      'missing string field "prefix"',
    )
  })

  test("builds official evaluator arguments for Modal and local Docker", () => {
    const base = {
      evaluatorPath: "/harness/swe_bench_pro_eval.py",
      rawSamplePath: "/run/evaluation-instances.jsonl",
      patchPath: "/run/predictions.json",
      outputDir: "/run/evaluation",
      scriptsDir: "/harness/run_scripts",
      maxWorkers: 2,
      dockerhubUsername: "jefzda",
      useLocalDocker: false,
      blockNetwork: false,
      redo: false,
    } as const

    expect(buildEvaluationArgs(base)).toEqual([
      "/harness/swe_bench_pro_eval.py",
      "--raw_sample_path=/run/evaluation-instances.jsonl",
      "--patch_path=/run/predictions.json",
      "--output_dir=/run/evaluation",
      "--scripts_dir=/harness/run_scripts",
      "--num_workers=2",
      "--dockerhub_username=jefzda",
    ])

    expect(
      buildEvaluationArgs({
        ...base,
        useLocalDocker: true,
        dockerPlatform: "linux/amd64",
        blockNetwork: true,
        redo: true,
      }).slice(-4),
    ).toEqual(["--use_local_docker", "--docker_platform=linux/amd64", "--block_network", "--redo"])
  })

  test("does not report an empty patch as a successful prediction", () => {
    expect(assessPrediction(0, "")).toEqual({
      agentCompleted: true,
      predictionProduced: false,
      generationSucceeded: false,
    })
  })

  test("captures staged source changes while excluding benchmark agent files", async () => {
    const worktree = await mkdtemp(join(tmpdir(), "opencode-swe-pro-"))
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
    const directory = await mkdtemp(join(tmpdir(), "opencode-swe-pro-not-git-"))
    try {
      await expect(capturePatch(directory)).rejects.toThrow("Command failed (git")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

function proRow(): Record<string, string> {
  return {
    repo: "owner/repo",
    instance_id: "instance_owner__repo-1",
    base_commit: "abc123",
    patch: "diff --git a/source.py b/source.py",
    test_patch: "diff --git a/tests/test_fix.py b/tests/test_fix.py\n--- a/tests/test_fix.py\n+++ b/tests/test_fix.py",
    problem_statement: "Fix the issue.",
    requirements: "Preserve compatibility.",
    interface: "Add solve(value).",
    repo_language: "Python",
    fail_to_pass: "['tests/test_fix.py::test_fix']",
    pass_to_pass: "[]",
    before_repo_set_cmd: "git reset --hard abc123",
    selected_test_files_to_run: "['tests/test_fix.py']",
    issue_specificity: "1",
    issue_categories: "[]",
    dockerhub_tag: "jefzda/repo:latest",
  }
}

async function runGit(cwd: string, ...args: string[]): Promise<void> {
  const process = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  const exitCode = await process.exited
  if (exitCode === 0) return
  throw new Error(await new Response(process.stderr).text())
}
