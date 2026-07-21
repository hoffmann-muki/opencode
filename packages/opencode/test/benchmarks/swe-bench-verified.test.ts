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
  officialSweBenchImage,
  parseArgs,
  parseSweBenchPredictions,
  parseSweBenchRow,
  verifyPredictionArtifact,
} from "../../benchmarks/swe-bench-verified"

describe("SWE-bench Verified runner", () => {
  test("distinguishes process completion from prediction production", () => {
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

  test("validates the official prediction JSONL schema without requiring a non-empty patch", () => {
    expect(
      parseSweBenchPredictions([
        {
          instance_id: "owner__repo-1",
          model_name_or_path: "opencode:model",
          model_patch: "",
        },
      ]),
    ).toEqual([
      {
        instance_id: "owner__repo-1",
        model_name_or_path: "opencode:model",
        model_patch: "",
      },
    ])

    expect(() => parseSweBenchPredictions([])).toThrow("at least one row")
    expect(() =>
      parseSweBenchPredictions([
        { instance_id: "owner__repo-1", model_name_or_path: "model", model_patch: "" },
        { instance_id: "owner__repo-1", model_name_or_path: "model", model_patch: "" },
      ]),
    ).toThrow('Duplicate prediction for instance "owner__repo-1"')
    expect(() => parseSweBenchPredictions([{ instance_id: "owner__repo-1", model_patch: "" }])).toThrow(
      'missing string field "model_name_or_path"',
    )
  })

  test("builds canonical official SWE-bench harness arguments", () => {
    expect(
      buildEvaluationArgs({
        datasetName: "princeton-nlp/SWE-bench_Verified",
        predictionsPath: "/run/predictions.jsonl",
        maxWorkers: 2,
        runId: "verified-run",
        instanceIds: ["owner__repo-1"],
        namespaceEmpty: true,
      }),
    ).toEqual([
      "-m",
      "swebench.harness.run_evaluation",
      "--dataset_name",
      "princeton-nlp/SWE-bench_Verified",
      "--predictions_path",
      "/run/predictions.jsonl",
      "--max_workers",
      "2",
      "--run_id",
      "verified-run",
      "--instance_ids",
      "owner__repo-1",
      "--namespace",
      "",
    ])
  })

  test("maps instances to official x86_64 SWE-bench images", () => {
    expect(officialSweBenchImage("astropy__astropy-12907")).toBe(
      "docker.io/swebench/sweb.eval.x86_64.astropy_1776_astropy-12907:latest",
    )
    expect(officialSweBenchImage("Django__Django-11333", "registry/{arch}/{repo}/{name}:{instance_id}")).toBe(
      "registry/x86_64/django/django-11333:django__django-11333",
    )
    expect(() => officialSweBenchImage("invalid-instance")).toThrow("Invalid SWE-bench instance id")
    expect(() => officialSweBenchImage("owner__repo-1", "image/{unsupported}")).toThrow("Unsupported placeholder")
  })

  test("starts the official image with an inert container command", () => {
    expect(buildDockerRunArgs("run-instance", "official-image", "linux/amd64")).toEqual([
      "run",
      "--detach",
      "--name",
      "run-instance",
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

  test("runs pinned opencode in /testbed and inherits provider secrets by name", () => {
    const args = buildOpencodeExecArgs(
      "run-instance",
      { instance_id: "owner__repo-1" },
      { agent: "benchmark-coordinator", model: "openrouter/model", pure: true },
      { OPENROUTER_API_KEY: "secret-value" },
    )

    expect(args).toContain("--workdir")
    expect(args).toContain("/testbed")
    expect(args).toContain("--pure")
    expect(args).toContain("benchmark-coordinator")
    expect(args).toContain("OPENROUTER_API_KEY")
    expect(args).toContain("BASH_ENV=/root/.bashrc")
    expect(args.join(" ")).not.toContain("secret-value")
  })

  test("parses only public inference fields and ignores hidden evaluator fields", () => {
    const row = parseSweBenchRow({
      repo: "owner/repo",
      instance_id: "owner__repo-1",
      base_commit: "abc123",
      problem_statement: "Fix the issue.",
      hints_text: "Public hint.",
      patch: "gold patch must not be retained",
      test_patch: "hidden test patch must not be retained",
    })

    expect(row).toEqual({
      repo: "owner/repo",
      instance_id: "owner__repo-1",
      base_commit: "abc123",
      problem_statement: "Fix the issue.",
      hints_text: "Public hint.",
    })
    expect(row).not.toHaveProperty("patch")
    expect(row).not.toHaveProperty("test_patch")
  })

  test("keeps inference and evaluation as separate CLI modes", () => {
    const inference = parseArgs(["--run-id", "sample", "--opencode-version", "1.18.4"], "1.18.4")
    expect(inference.evaluateOnly).toBe(false)
    expect(inference.opencodeVersion).toBe("1.18.4")
    expect(inference.inferenceWorkers).toBe(1)
    expect(inference.maxInfrastructureRetries).toBe(0)

    const parallel = parseArgs(
      ["--inference-workers", "2", "--max-infrastructure-retries", "1", "--retry-base-delay-ms", "0"],
      "1.18.4",
    )
    expect(parallel.inferenceWorkers).toBe(2)
    expect(parallel.maxInfrastructureRetries).toBe(1)
    expect(parallel.retryBaseDelayMs).toBe(0)

    const evaluation = parseArgs(["--run-id", "sample", "--evaluate-only"], "1.18.4")
    expect(evaluation.evaluateOnly).toBe(true)
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
    expect(
      classifyInfrastructureFailure({
        stage: "setup",
        message: "authentication failed: invalid API key",
        patch: "",
        timedOut: false,
        toolUseEventCount: 0,
      }),
    ).toBeUndefined()
  })

  test("recovers attempt-aware infrastructure retry checkpoints", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-swe-checkpoint-"))
    const attemptDirectory = join(directory, "owner__repo-1", "attempts", "attempt-1")
    const paths = {
      root: directory,
      runs: directory,
      predictionsPath: join(directory, "predictions.jsonl"),
      manifestPath: join(directory, "manifest.json"),
      summaryPath: join(directory, "summary.json"),
      datasetPath: join(directory, "instances.jsonl"),
      evaluationManifestPath: join(directory, "evaluation.json"),
    }

    try {
      await mkdir(attemptDirectory, { recursive: true })
      await writeFile(
        join(attemptDirectory, "prediction.json"),
        JSON.stringify({
          instance_id: "owner__repo-1",
          model_name_or_path: "opencode:model",
          model_patch: "",
        }),
      )
      await writeFile(
        join(attemptDirectory, "run.json"),
        JSON.stringify({
          instanceId: "owner__repo-1",
          attempt: 1,
          infrastructureRetry: { category: "transient_network", reason: "connection reset" },
        }),
      )

      const checkpoint = await loadLatestAttemptCheckpoint(
        {
          repo: "owner/repo",
          instance_id: "owner__repo-1",
          base_commit: "abc123",
          problem_statement: "Fix it.",
        },
        paths,
        4,
      )
      expect(checkpoint).toMatchObject({
        attempt: 1,
        outcome: { infrastructureRetry: { category: "transient_network" } },
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("rejects predictions changed after the inference manifest was written", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-swe-artifact-"))
    const predictionsPath = join(directory, "predictions.jsonl")
    const manifestPath = join(directory, "prediction-manifest.json")
    const predictions =
      JSON.stringify({
        instance_id: "owner__repo-1",
        model_name_or_path: "opencode@1.18.4:openrouter/model",
        model_patch: "",
      }) + "\n"

    try {
      await writeFile(predictionsPath, predictions, "utf8")
      await writeFile(
        manifestPath,
        JSON.stringify({
          schemaVersion: 1,
          benchmark: "swe-bench-verified",
          dataset: "princeton-nlp/SWE-bench_Verified",
          datasetConfig: "default",
          datasetSplit: "test",
          runId: "artifact-test",
          model: "openrouter/model",
          agent: "benchmark-coordinator",
          opencodeVersion: "1.18.4",
          inferenceRuntime: "official-swebench-instance-image",
          imageTemplate: "official/{instance_id}",
          dockerPlatform: "linux/amd64",
          includeHints: false,
          selectedInstances: [
            {
              instanceId: "owner__repo-1",
              repo: "owner/repo",
              baseCommit: "abc123",
              image: "official/owner__repo-1",
            },
          ],
          completedInstanceIds: ["owner__repo-1"],
          complete: true,
          predictionCount: 1,
          nonEmptyPatchCount: 0,
          predictionsSha256: createHash("sha256").update(predictions).digest("hex"),
          generatedAt: "2026-07-20T00:00:00.000Z",
        }),
        "utf8",
      )

      expect(await verifyPredictionArtifact(predictionsPath, manifestPath)).toMatchObject({
        digest: createHash("sha256").update(predictions).digest("hex"),
      })
      await writeFile(predictionsPath, `${predictions}\n`, "utf8")
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
})
