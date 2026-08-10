import { SINGLE_BENCHMARK_AGENT_TOPOLOGY } from "./opencode-benchmark-agents.ts"
import { SWE_BENCH_VERIFIED, runClassicSweBench } from "./swe-bench-verified.ts"

if (import.meta.main) {
  runClassicSweBench(SWE_BENCH_VERIFIED, SINGLE_BENCHMARK_AGENT_TOPOLOGY).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
