import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  assessPrediction,
  buildDockerRunArgs,
  buildEvaluationArgs,
  buildOpencodeExecArgs,
  classifyInfrastructureFailure,
  loadLatestAttemptCheckpoint,
  officialSweBenchProImage,
  parseArgs,
  parseSweBenchProPredictions,
  parseSweBenchProRow,
  verifyPredictionArtifact,
} from "../../benchmarks/swe-bench-pro"

describe("SWE-bench Pro runner", () => {
  test("retains only public inference fields and the official image tag", () => {
    const row = parseSweBenchProRow(proRow())

    expect(row).toEqual({
      repo: "owner/repo",
      instance_id: "instance_owner__repo-1",
      base_commit: "abc123",
      problem_statement: "Fix the issue.",
      requirements: "Preserve compatibility.",
      interface: "Add solve(value).",
      repo_language: "Python",
      dockerhub_tag: "owner.repo-instance_owner__repo-1",
    })
    expect(row).not.toHaveProperty("patch")
    expect(row).not.toHaveProperty("test_patch")
    expect(row).not.toHaveProperty("fail_to_pass")
    expect(row).not.toHaveProperty("pass_to_pass")
  })

  test("formats the public issue exactly like the official dataset helper", () => {
    const row = parseSweBenchProRow(proRow())
    expect(
      `${row.problem_statement}\n\nRequirements:\n${row.requirements}\n\nNew interfaces introduced:\n${row.interface}`,
    ).toBe("Fix the issue.\n\nRequirements:\nPreserve compatibility.\n\nNew interfaces introduced:\nAdd solve(value).")
  })

  test("maps dockerhub_tag to the official SWE-bench Pro image", () => {
    expect(officialSweBenchProImage("nodebb.nodebb-instance_demo")).toBe(
      "docker.io/jefzda/sweap-images:nodebb.nodebb-instance_demo",
    )
    expect(officialSweBenchProImage("task-tag", "registry.example/swe-pro")).toBe("registry.example/swe-pro:task-tag")
    expect(() => officialSweBenchProImage("bad/tag")).toThrow("Invalid SWE-bench Pro dockerhub_tag")
  })

  test("starts official images with an inert container command", () => {
    expect(buildDockerRunArgs("pro-instance", "official-image", "linux/amd64")).toEqual([
      "run",
      "--detach",
      "--name",
      "pro-instance",
      "--platform",
      "linux/amd64",
      "--user",
      "root",
      "--entrypoint",
      "/bin/bash",
      "official-image",
      "-lc",
      "trap : TERM INT; sleep infinity & wait",
    ])
  })

  test("runs pinned opencode in /app and forwards provider secrets by name", () => {
    const args = buildOpencodeExecArgs(
      "pro-instance",
      { instance_id: "instance_owner__repo-1" },
      { agent: "benchmark-coordinator", model: "openrouter/model", pure: true },
      { OPENROUTER_API_KEY: "secret-value" },
    )
    expect(args).toContain("--workdir")
    expect(args).toContain("/app")
    expect(args).toContain("--pure")
    expect(args).toContain("OPENROUTER_API_KEY")
    expect(args).toContain("BASH_ENV=/root/.bashrc")
    expect(args.join(" ")).not.toContain("secret-value")
  })

  test("keeps inference and official evaluation as separate modes", () => {
    const inference = parseArgs(["--run-id", "sample", "--opencode-version", "1.18.4"], "1.18.4")
    expect(inference.evaluateOnly).toBe(false)
    expect(inference.inferenceWorkers).toBe(1)
    expect(inference.maxInfrastructureRetries).toBe(0)
    expect(inference.opencodeVersion).toBe("1.18.4")

    const parallel = parseArgs(
      ["--inference-workers", "2", "--max-infrastructure-retries", "1", "--retry-base-delay-ms", "0"],
      "1.18.4",
    )
    expect(parallel.inferenceWorkers).toBe(2)
    expect(parallel.maxInfrastructureRetries).toBe(1)
    expect(parallel.retryBaseDelayMs).toBe(0)

    expect(parseArgs(["--run-id", "sample", "--evaluate-only"], "1.18.4").evaluateOnly).toBe(true)
    expect(() => parseArgs(["--evaluate"], "1.18.4")).toThrow("Unknown argument")
    expect(() => parseArgs(["--opencode-version", "1.2.3;rm"], "1.18.4")).toThrow("without shell metacharacters")
  })

  test("classifies only pre-action transient infrastructure failures for retry", () => {
    expect(
      classifyInfrastructureFailure({
        stage: "setup",
        message: "registry returned 503 Service Unavailable",
        patch: "",
        timedOut: false,
        toolUseEventCount: 0,
      }),
    ).toMatchObject({ category: "transient_service_error" })
    expect(
      classifyInfrastructureFailure({
        stage: "agent",
        message: "OpenRouter returned 429 Too Many Requests",
        patch: "",
        timedOut: false,
        toolUseEventCount: 0,
      }),
    ).toMatchObject({ category: "provider_rate_limit" })

    for (const guarded of [
      { patch: "diff --git a/file b/file\n", timedOut: false, toolUseEventCount: 0 },
      { patch: "", timedOut: true, toolUseEventCount: 0 },
      { patch: "", timedOut: false, toolUseEventCount: 1 },
    ]) {
      expect(
        classifyInfrastructureFailure({
          stage: "agent",
          message: "OpenRouter returned 429 Too Many Requests",
          ...guarded,
        }),
      ).toBeUndefined()
    }
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
    ).toHaveLength(1)
    expect(() => parseSweBenchProPredictions([])).toThrow("at least one row")
    expect(() =>
      parseSweBenchProPredictions([
        { instance_id: "instance_owner__repo-1", patch: "", prefix: "sample1" },
        { instance_id: "instance_owner__repo-1", patch: "", prefix: "sample1" },
      ]),
    ).toThrow('Duplicate prediction for instance "instance_owner__repo-1"')
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

  test("recovers attempt-aware infrastructure retry checkpoints", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-swe-pro-checkpoint-"))
    const attemptDirectory = join(directory, "instance_owner__repo-1", "attempts", "attempt-1")
    const paths = testPaths(directory)
    try {
      await mkdir(attemptDirectory, { recursive: true })
      await writeFile(
        join(attemptDirectory, "prediction.json"),
        JSON.stringify({ instance_id: "instance_owner__repo-1", patch: "", prefix: "sample" }),
      )
      await writeFile(
        join(attemptDirectory, "run.json"),
        JSON.stringify({
          instanceId: "instance_owner__repo-1",
          attempt: 1,
          infrastructureRetry: { category: "transient_network", reason: "connection reset" },
        }),
      )

      const checkpoint = await loadLatestAttemptCheckpoint(parseSweBenchProRow(proRow()), paths, 4)
      expect(checkpoint).toMatchObject({
        attempt: 1,
        outcome: { infrastructureRetry: { category: "transient_network" } },
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("rejects predictions changed after the inference manifest was written", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-swe-pro-artifact-"))
    const predictionsPath = join(directory, "predictions.json")
    const manifestPath = join(directory, "prediction-manifest.json")
    const predictions = `${JSON.stringify(
      [{ instance_id: "instance_owner__repo-1", patch: "", prefix: "sample" }],
      null,
      2,
    )}\n`

    try {
      await writeFile(predictionsPath, predictions)
      await writeFile(
        manifestPath,
        JSON.stringify({
          schemaVersion: 1,
          benchmark: "swe-bench-pro",
          dataset: "ScaleAI/SWE-bench_Pro",
          datasetConfig: "default",
          datasetSplit: "test",
          runId: "artifact-test",
          model: "openrouter/model",
          agent: "benchmark-coordinator",
          opencodeVersion: "1.18.4",
          inferenceRuntime: "official-swebench-pro-instance-image",
          imagePrefix: "docker.io/jefzda/sweap-images",
          dockerPlatform: "linux/amd64",
          inferenceWorkers: 1,
          maxInfrastructureRetries: 3,
          retryBaseDelayMs: 2000,
          selectedInstances: [
            {
              instanceId: "instance_owner__repo-1",
              repo: "owner/repo",
              baseCommit: "abc123",
              image: "docker.io/jefzda/sweap-images:owner.repo-instance_owner__repo-1",
            },
          ],
          completedInstanceIds: ["instance_owner__repo-1"],
          complete: true,
          predictionCount: 1,
          nonEmptyPatchCount: 0,
          predictionsSha256: createHash("sha256").update(predictions).digest("hex"),
          generatedAt: "2026-07-20T00:00:00.000Z",
        }),
      )

      expect(await verifyPredictionArtifact(predictionsPath, manifestPath)).toMatchObject({
        digest: createHash("sha256").update(predictions).digest("hex"),
      })
      await writeFile(predictionsPath, `${predictions}\n`)
      let verificationError: unknown
      try {
        await verifyPredictionArtifact(predictionsPath, manifestPath)
      } catch (error) {
        verificationError = error
      }
      expect(verificationError).toBeInstanceOf(Error)
      if (!(verificationError instanceof Error)) throw new Error("Expected prediction verification to fail.")
      expect(verificationError.message).toContain("Predictions have changed since inference")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
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
    test_patch: "diff --git a/tests/test_fix.py b/tests/test_fix.py",
    problem_statement: "Fix the issue.",
    requirements: "Preserve compatibility.",
    interface: "Add solve(value).",
    repo_language: "Python",
    fail_to_pass: "['tests/test_fix.py::test_fix']",
    pass_to_pass: "[]",
    before_repo_set_cmd: "git reset --hard abc123",
    selected_test_files_to_run: "['tests/test_fix.py']",
    dockerhub_tag: "owner.repo-instance_owner__repo-1",
  }
}

function testPaths(directory: string) {
  return {
    root: directory,
    runs: directory,
    predictionsPath: join(directory, "predictions.json"),
    manifestPath: join(directory, "prediction-manifest.json"),
    summaryPath: join(directory, "summary.json"),
    datasetPath: join(directory, "instances.jsonl"),
    evaluationDatasetPath: join(directory, "evaluation-instances.jsonl"),
    evaluationOutput: join(directory, "evaluation"),
    evaluationManifestPath: join(directory, "evaluation-manifest.json"),
  }
}
