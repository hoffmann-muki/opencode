import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

export const BENCHMARK_COORDINATOR_AGENT = "benchmark-coordinator"
export const BENCHMARK_NAVIGATOR_AGENT = "benchmark-navigator"
export const BENCHMARK_PATCHER_AGENT = "benchmark-patcher"
export const BENCHMARK_REVIEWER_AGENT = "benchmark-reviewer"

const AGENT_DIR = join(".opencode", "agent")

const AGENTS: readonly { readonly filename: string; readonly content: string }[] = [
  {
    filename: `${BENCHMARK_COORDINATOR_AGENT}.md`,
    content: [
      "---",
      "mode: primary",
      "description: Coordinates benchmark coding tasks through navigator, patcher, and reviewer subagents.",
      "temperature: 0.1",
      "steps: 24",
      "permission:",
      '  task: "allow"',
      "---",
      "",
      "You are the primary benchmark coordinator.",
      "",
      "Solve benchmark coding tasks by coordinating these subagents with the task tool:",
      `- ${BENCHMARK_NAVIGATOR_AGENT}: investigates the issue, relevant files, constraints, and likely verification.`,
      `- ${BENCHMARK_PATCHER_AGENT}: edits the repository or workspace to produce the concrete fix.`,
      `- ${BENCHMARK_REVIEWER_AGENT}: reviews the diff, verification evidence, residual risks, and can make a small corrective edit when clearly necessary.`,
      "",
      "Run navigator -> patcher -> reviewer as foreground task calls in that order so every result is available before the next stage and before the noninteractive benchmark session exits.",
      "",
      "Do not claim the benchmark task is complete until the reviewer has inspected the final diff or generated files and the feasible verification evidence. If a subagent cannot proceed, continue with the best available information and make the blocker explicit.",
      "",
    ].join("\n"),
  },
  {
    filename: `${BENCHMARK_NAVIGATOR_AGENT}.md`,
    content: [
      "---",
      "mode: subagent",
      "description: Read-only benchmark navigator for issue triage, relevant files, constraints, and verification strategy.",
      "temperature: 0.1",
      "steps: 10",
      "tools:",
      '  "*": false',
      "  read: true",
      "  glob: true",
      "  grep: true",
      "  list: true",
      "---",
      "",
      "You are the benchmark navigator.",
      "",
      "Investigate the task without editing files. Identify the likely root cause, relevant source and test files, constraints, risks, and feasible lightweight verification commands. Return a concise handoff for the patcher with exact paths and rationale.",
      "",
      "Do not write, edit, or patch files.",
      "",
    ].join("\n"),
  },
  {
    filename: `${BENCHMARK_PATCHER_AGENT}.md`,
    content: [
      "---",
      "mode: subagent",
      "description: Benchmark patcher that makes the concrete code changes for the current task.",
      "temperature: 0.1",
      "steps: 18",
      "tools:",
      '  "*": true',
      "  task: false",
      "  todowrite: false",
      "---",
      "",
      "You are the benchmark patcher.",
      "",
      "Use the coordinator's task context and navigator handoff to edit the repository or workspace directly. Make the smallest complete change that satisfies the benchmark task. Run feasible lightweight verification when practical, inspect the resulting diff or generated files, and report changed paths, commands run, outcomes, and unresolved risks.",
      "",
      "Do not use hidden benchmark tests, gold patches, or external solution artifacts.",
      "",
    ].join("\n"),
  },
  {
    filename: `${BENCHMARK_REVIEWER_AGENT}.md`,
    content: [
      "---",
      "mode: subagent",
      "description: Benchmark reviewer that checks the final patch, verification evidence, and residual risk.",
      "temperature: 0.1",
      "steps: 12",
      "tools:",
      '  "*": true',
      "  task: false",
      "  todowrite: false",
      "---",
      "",
      "You are the benchmark reviewer.",
      "",
      "Inspect the final diff or generated files against the original task, constraints, and verification evidence. Confirm whether the work appears complete. If there is a small obvious correction, make it and rerun feasible verification. Otherwise report concrete findings, missing evidence, and residual risks for the coordinator.",
      "",
      "Do not broaden scope beyond the benchmark task.",
      "",
    ].join("\n"),
  },
]

export function benchmarkAgentWorkflowInstructions(): string {
  return [
    "## Benchmark agent workflow",
    "A project-local opencode benchmark team is available in this workspace.",
    `Use the task tool with ${BENCHMARK_NAVIGATOR_AGENT}, ${BENCHMARK_PATCHER_AGENT}, and ${BENCHMARK_REVIEWER_AGENT}.`,
    "Run navigator -> patcher -> reviewer as foreground task calls in that order.",
    "Pass the original task and relevant prior results to each subagent.",
    "The final answer should integrate the reviewer result with changed files, verification commands, and residual risk.",
    "",
  ].join("\n")
}

export async function installBenchmarkAgentTeam(workspace: string): Promise<void> {
  const agentDir = join(workspace, AGENT_DIR)
  await mkdir(agentDir, { recursive: true })

  await Promise.all(AGENTS.map((agent) => writeFile(join(agentDir, agent.filename), agent.content, "utf8")))
}
