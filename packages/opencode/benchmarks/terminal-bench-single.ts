import { SINGLE_BENCHMARK_AGENT_TOPOLOGY } from "./opencode-benchmark-agents.ts"
import { runTerminalBench } from "./terminal-bench.ts"

if (import.meta.main) {
  runTerminalBench(SINGLE_BENCHMARK_AGENT_TOPOLOGY).catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
