import { describe, expect, test } from "bun:test"
import {
  assessPrediction,
  buildEvaluationArgs,
  formatProblemStatement,
  parseSweBenchProPredictions,
  parseSweBenchProRow,
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
