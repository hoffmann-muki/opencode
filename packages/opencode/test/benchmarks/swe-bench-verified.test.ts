import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
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
  stripBenchmarkTraceFrames,
  verifyPredictionArtifact,
  SWE_BENCH_LITE,
} from "../../benchmarks/swe-bench-verified"
import { SINGLE_BENCHMARK_AGENT_TOPOLOGY, installBenchmarkAgentTeam } from "../../benchmarks/opencode-benchmark-agents"

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
        timeoutSeconds: 3600,
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
      "--timeout",
      "3600",
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
    expect(args).toContain("OPENCODE_DISABLE_PROVIDER_RETRIES=1")
    expect(args).toContain("BASH_ENV=/root/.bashrc")
    expect(args.join(" ")).not.toContain("secret-value")
    expect(args).not.toContain("--benchmark-trace")
    expect(
      buildOpencodeExecArgs(
        "run-instance",
        { instance_id: "owner__repo-1" },
        {
          agent: "benchmark-coordinator",
          model: "openrouter/model",
          pure: true,
          traceRun: {
            id: "trace-run-test",
            root: "/tmp/traces/trace-run-test",
            createdAt: new Date(0).toISOString(),
            benchmark: "swe-bench-verified",
            framework: "opencode",
          },
        },
        {},
      ),
    ).toContain("--benchmark-trace")
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
    const inference = parseArgs(["--run-id", "sample"], "1.18.4")
    expect(inference.evaluateOnly).toBe(false)
    expect(inference.instanceIds).toEqual(["scikit-learn__scikit-learn-13439"])
    expect(inference.model).toBe("openrouter/qwen/qwen3-coder-next")
    expect(inference.timeoutMs).toBe(15 * 60 * 1000)
    expect(inference.maxWorkers).toBe(1)
    expect(inference.opencodeVersion).toBe("1.18.4")
    expect(inference.inferenceWorkers).toBe(1)
    expect(inference.maxInfrastructureRetries).toBe(0)
    expect(inference.traceDir).toBe(resolve(import.meta.dir, "../../../..", ".benchmark-traces"))
    expect(parseArgs(["--trace-dir", "/tmp/traces"], "1.18.4").traceDir).toBe("/tmp/traces")
    expect(parseArgs(["--no-trace"], "1.18.4").traceDir).toBeUndefined()
    expect(() => parseArgs(["--trace-dir", "/tmp/traces", "--no-trace"], "1.18.4")).toThrow("cannot be combined")
    expect(() => parseArgs(["--evaluate-only", "--trace-dir", "/tmp/traces"], "1.18.4")).toThrow(
      "available only during inference",
    )

    const parallel = parseArgs(
      ["--inference-workers", "2", "--max-infrastructure-retries", "1", "--retry-base-delay-ms", "0"],
      "1.18.4",
    )
    expect(parallel.inferenceWorkers).toBe(2)
    expect(parallel.maxInfrastructureRetries).toBe(1)
    expect(parallel.retryBaseDelayMs).toBe(0)

    const evaluation = parseArgs(["--run-id", "sample", "--evaluate-only"], "1.18.4")
    expect(evaluation.evaluateOnly).toBe(true)
    expect(evaluation.instanceIds).toEqual([])
    expect(evaluation.traceDir).toBeUndefined()
    expect(evaluation.evaluationTimeoutSeconds).toBe(60 * 60)

    const evaluationTimeout = parseArgs(["--evaluate-only", "--evaluation-timeout-seconds", "1800"], "1.18.4")
    expect(evaluationTimeout.evaluationTimeoutSeconds).toBe(1800)
    expect(() => parseArgs(["--evaluate"], "1.18.4")).toThrow("Unknown argument")
    expect(() => parseArgs(["--opencode-version", "1.18.4"], "1.18.4")).toThrow("Unknown argument")
  })

  test("configures Lite and Verified single-agent runs without delegation", async () => {
    const lite = parseArgs([], "1.18.4", SWE_BENCH_LITE, SINGLE_BENCHMARK_AGENT_TOPOLOGY)
    expect(lite.instanceIds).toEqual(["astropy__astropy-12907"])
    expect(lite.variant.datasetName).toBe("princeton-nlp/SWE-bench_Lite")
    expect(lite.agent).toBe("benchmark-single-agent")
    expect(lite.agentTopology).toBe("single-agent")
    expect(lite.model).toBe("openrouter/poolside/laguna-s-2.1:free")
    expect(lite.timeoutMs).toBe(15 * 60 * 1000)
    expect(lite.inferenceWorkers).toBe(1)
    expect(lite.maxInfrastructureRetries).toBe(0)
    expect(lite.traceDir).toBe(resolve(import.meta.dir, "../../../..", ".benchmark-traces"))
    expect(() => parseArgs(["--agent", "build"], "1.18.4", SWE_BENCH_LITE, SINGLE_BENCHMARK_AGENT_TOPOLOGY)).toThrow(
      "fixes --agent",
    )

    const directory = await mkdtemp(join(tmpdir(), "opencode-single-agent-"))
    try {
      await installBenchmarkAgentTeam(directory, SINGLE_BENCHMARK_AGENT_TOPOLOGY)
      const agentDirectory = join(directory, ".opencode", "agent")
      expect(await readdir(agentDirectory)).toEqual(["benchmark-single-agent.md"])
      const definition = await readFile(join(agentDirectory, "benchmark-single-agent.md"), "utf8")
      expect(definition).toContain("steps: 24")
      expect(definition).toContain("task: false")
      expect(definition).toContain("Do not delegate")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("keeps private native trace frames out of legacy run artifacts", () => {
    expect(
      stripBenchmarkTraceFrames(
        [
          '{"type":"text","sessionID":"root"}',
          '{"type":"benchmark_trace.native","event":{"type":"message.updated"}}',
          "unparsed output",
        ].join("\n"),
      ),
    ).toBe('{"type":"text","sessionID":"root"}\nunparsed output')
  })

  test("lets explicit selection flags replace the default smoke instance", () => {
    expect(parseArgs(["--instance-id", "astropy__astropy-12907"], "1.18.4").instanceIds).toEqual([
      "astropy__astropy-12907",
    ])
    expect(parseArgs(["--max-instances", "3"], "1.18.4").instanceIds).toEqual([])
    expect(parseArgs(["--offset", "2"], "1.18.4").instanceIds).toEqual([])
    expect(() =>
      parseArgs(["--instance-id", "astropy__astropy-12907", "--instance-id", "astropy__astropy-12907"], "1.18.4"),
    ).toThrow("Duplicate --instance-id values are not allowed")
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

  test("verifies current Lite single-agent manifests against the selected variant", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-swe-lite-artifact-"))
    const predictionsPath = join(directory, "predictions.jsonl")
    const manifestPath = join(directory, "prediction-manifest.json")
    const predictions = `${JSON.stringify({
      instance_id: "astropy__astropy-12907",
      model_name_or_path: "opencode@source:openrouter/model",
      model_patch: "",
    })}\n`

    try {
      await writeFile(predictionsPath, predictions, "utf8")
      await writeFile(
        manifestPath,
        JSON.stringify({
          schemaVersion: 4,
          benchmark: "swe-bench-lite",
          dataset: "princeton-nlp/SWE-bench_Lite",
          datasetConfig: "default",
          datasetSplit: "test",
          runId: "lite-single",
          model: "openrouter/model",
          agent: "benchmark-single-agent",
          agentTopology: "single-agent",
          delegationEnabled: false,
          opencodeVersion: "1.2.3",
          opencodeCommit: "a".repeat(40),
          opencodeBinarySha256: "b".repeat(64),
          providerAttemptsPerTurn: 1,
          inferenceRuntime: "official-swebench-instance-image",
          imageTemplate: "official/{instance_id}",
          dockerPlatform: "linux/amd64",
          includeHints: false,
          inferenceWorkers: 1,
          maxInfrastructureRetries: 0,
          retryBaseDelayMs: 2_000,
          selectedInstances: [
            {
              instanceId: "astropy__astropy-12907",
              repo: "astropy/astropy",
              baseCommit: "abc123",
              image: "official/astropy__astropy-12907",
            },
          ],
          completedInstanceIds: ["astropy__astropy-12907"],
          complete: true,
          predictionCount: 1,
          nonEmptyPatchCount: 0,
          predictionsSha256: createHash("sha256").update(predictions).digest("hex"),
          generatedAt: "2026-08-09T00:00:00.000Z",
        }),
        "utf8",
      )

      const artifact = await verifyPredictionArtifact(predictionsPath, manifestPath, SWE_BENCH_LITE)
      expect(artifact.manifest).toMatchObject({
        benchmark: "swe-bench-lite",
        agentTopology: "single-agent",
        delegationEnabled: false,
      })
      await expect(verifyPredictionArtifact(predictionsPath, manifestPath)).rejects.toThrow("SWE-bench Verified")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
