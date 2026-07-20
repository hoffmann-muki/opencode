export interface InfrastructureRetry {
  readonly category: string
  readonly reason: string
}

export const MAX_RETRY_DELAY_MS = 60_000

export interface EvaluationAttempt<T> {
  readonly value: T
  readonly retry?: InfrastructureRetry
}

export interface EvaluationAttemptContext {
  readonly attempt: number
  readonly maxAttempts: number
}

export interface EvaluationWorkItem<T> {
  readonly item: T
  readonly initialAttempt?: number
}

export interface EvaluationCompletion<T> {
  readonly value: T
  readonly attemptsUsed: number
  readonly retryExhausted: boolean
}

export interface EvaluationOrchestratorOptions<TItem, TResult> {
  readonly items: readonly EvaluationWorkItem<TItem>[]
  readonly concurrency: number
  readonly maxInfrastructureRetries: number
  readonly retryBaseDelayMs: number
  readonly runAttempt: (item: TItem, context: EvaluationAttemptContext) => Promise<EvaluationAttempt<TResult>>
  readonly onRetry?: (
    item: TItem,
    retry: InfrastructureRetry,
    context: EvaluationAttemptContext,
    nextDelayMs: number,
  ) => Promise<void> | void
  readonly onComplete?: (item: TItem, completion: EvaluationCompletion<TResult>) => Promise<void> | void
}

export async function runEvaluationOrchestrator<TItem, TResult>(
  options: EvaluationOrchestratorOptions<TItem, TResult>,
): Promise<readonly EvaluationCompletion<TResult>[]> {
  assertPositiveInteger(options.concurrency, "concurrency")
  assertNonNegativeInteger(options.maxInfrastructureRetries, "maxInfrastructureRetries")
  assertNonNegativeInteger(options.retryBaseDelayMs, "retryBaseDelayMs")

  if (options.items.length === 0) return []
  const maxAttempts = options.maxInfrastructureRetries + 1
  const completions: Array<EvaluationCompletion<TResult> | undefined> = Array(options.items.length)
  let cursor = 0
  let callbackQueue = Promise.resolve()
  let fatalError: unknown

  const serializeCompletion = async (callback: () => Promise<void>): Promise<void> => {
    const current = callbackQueue.then(callback)
    callbackQueue = current.catch(() => undefined)
    await current
  }

  const worker = async (): Promise<void> => {
    while (fatalError === undefined) {
      const index = cursor
      cursor += 1
      const work = options.items[index]
      if (!work) return

      try {
        const initialAttempt = work.initialAttempt ?? 1
        if (!Number.isInteger(initialAttempt) || initialAttempt < 1 || initialAttempt > maxAttempts) {
          throw new Error(`initialAttempt must be between 1 and ${maxAttempts}.`)
        }

        let attempt = initialAttempt
        while (true) {
          const context = { attempt, maxAttempts }
          const outcome = await options.runAttempt(work.item, context)
          const retryExhausted = outcome.retry !== undefined && attempt >= maxAttempts

          if (outcome.retry !== undefined && !retryExhausted) {
            const nextDelayMs = retryDelayMs(options.retryBaseDelayMs, attempt)
            await options.onRetry?.(work.item, outcome.retry, context, nextDelayMs)
            if (nextDelayMs > 0) await delay(nextDelayMs)
            attempt += 1
            continue
          }

          const completion = {
            value: outcome.value,
            attemptsUsed: attempt,
            retryExhausted,
          }
          completions[index] = completion
          if (options.onComplete) {
            await serializeCompletion(() => Promise.resolve(options.onComplete?.(work.item, completion)))
          }
          break
        }
      } catch (error) {
        fatalError = error
        return
      }
    }
  }

  const workerCount = Math.min(options.concurrency, options.items.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  await callbackQueue
  if (fatalError !== undefined) throw fatalError

  return completions.map((completion, index) => {
    if (!completion) throw new Error(`Evaluation item ${index} did not produce a completion.`)
    return completion
  })
}

export function retryDelayMs(baseDelayMs: number, failedAttempt: number): number {
  assertNonNegativeInteger(baseDelayMs, "baseDelayMs")
  assertPositiveInteger(failedAttempt, "failedAttempt")
  return Math.min(baseDelayMs * 2 ** (failedAttempt - 1), MAX_RETRY_DELAY_MS)
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`)
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer.`)
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}
