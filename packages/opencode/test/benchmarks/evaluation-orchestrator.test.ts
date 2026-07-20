import { describe, expect, test } from "bun:test"
import { retryDelayMs, runEvaluationOrchestrator } from "../../benchmarks/evaluation-orchestrator"

describe("benchmark evaluation orchestrator", () => {
  test("caps exponential backoff at one minute", () => {
    expect(retryDelayMs(2_000, 1)).toBe(2_000)
    expect(retryDelayMs(2_000, 6)).toBe(60_000)
  })

  test("retries only explicitly classified infrastructure failures", async () => {
    const attempts: number[] = []
    const completions = await runEvaluationOrchestrator({
      items: [{ item: "instance" }],
      concurrency: 1,
      maxInfrastructureRetries: 2,
      retryBaseDelayMs: 0,
      runAttempt: async (_item, context) => {
        attempts.push(context.attempt)
        return context.attempt === 1
          ? { value: "transient", retry: { category: "network", reason: "connection reset" } }
          : { value: "finished" }
      },
    })

    expect(attempts).toEqual([1, 2])
    expect(completions).toEqual([{ value: "finished", attemptsUsed: 2, retryExhausted: false }])
  })

  test("does not retry an ordinary unsuccessful result", async () => {
    let attempts = 0
    const completions = await runEvaluationOrchestrator({
      items: [{ item: "instance" }],
      concurrency: 1,
      maxInfrastructureRetries: 3,
      retryBaseDelayMs: 0,
      runAttempt: async () => {
        attempts += 1
        return { value: { patch: "", agentCompleted: false } }
      },
    })

    expect(attempts).toBe(1)
    expect(completions[0]).toEqual({
      value: { patch: "", agentCompleted: false },
      attemptsUsed: 1,
      retryExhausted: false,
    })
  })

  test("marks a classified failure exhausted after the bounded attempts", async () => {
    const completions = await runEvaluationOrchestrator({
      items: [{ item: "instance", initialAttempt: 2 }],
      concurrency: 1,
      maxInfrastructureRetries: 2,
      retryBaseDelayMs: 0,
      runAttempt: async (_item, context) => ({
        value: context.attempt,
        retry: { category: "service", reason: "unavailable" },
      }),
    })

    expect(completions).toEqual([{ value: 3, attemptsUsed: 3, retryExhausted: true }])
  })

  test("bounds concurrent work and serializes completion callbacks", async () => {
    let activeAttempts = 0
    let maxActiveAttempts = 0
    let activeCallbacks = 0
    let maxActiveCallbacks = 0
    const completions = await runEvaluationOrchestrator({
      items: [1, 2, 3, 4].map((item) => ({ item })),
      concurrency: 2,
      maxInfrastructureRetries: 0,
      retryBaseDelayMs: 0,
      runAttempt: async (item) => {
        activeAttempts += 1
        maxActiveAttempts = Math.max(maxActiveAttempts, activeAttempts)
        await Bun.sleep(5)
        activeAttempts -= 1
        return { value: item }
      },
      onComplete: async () => {
        activeCallbacks += 1
        maxActiveCallbacks = Math.max(maxActiveCallbacks, activeCallbacks)
        await Bun.sleep(5)
        activeCallbacks -= 1
      },
    })

    expect(maxActiveAttempts).toBe(2)
    expect(maxActiveCallbacks).toBe(1)
    expect(completions.map((completion) => completion.value)).toEqual([1, 2, 3, 4])
  })
})
