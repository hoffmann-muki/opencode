import { SINGLE_BENCHMARK_AGENT_TOPOLOGY } from "./opencode-benchmark-agents.ts"
import { runSweBenchPro } from "./swe-bench-pro.ts"

if (import.meta.main) {
  runSweBenchPro(SINGLE_BENCHMARK_AGENT_TOPOLOGY).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
