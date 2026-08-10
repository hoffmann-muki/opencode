import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

export const BENCHMARK_COORDINATOR_AGENT = "benchmark-coordinator"
export const BENCHMARK_SINGLE_AGENT = "benchmark-single-agent"
export const BENCHMARK_NAVIGATOR_AGENT = "benchmark-navigator"
export const BENCHMARK_PATCHER_AGENT = "benchmark-patcher"
export const BENCHMARK_REVIEWER_AGENT = "benchmark-reviewer"

export const TERMINAL_BENCHMARK_AGENT_TOPOLOGY = "supervisor-delegation" as const
export const SINGLE_BENCHMARK_AGENT_TOPOLOGY = "single-agent" as const
export const SINGLE_BENCHMARK_DEFAULT_MODEL = "openrouter/poolside/laguna-s-2.1:free"

const AGENT_DIR = join(".opencode", "agent")

const AGENTS: readonly { readonly filename: string; readonly content: string }[] = [
  {
    filename: `${BENCHMARK_SINGLE_AGENT}.md`,
    content: [
      "---",
      "mode: primary",
      "description: Solves a benchmark coding task independently from investigation through final review.",
      "temperature: 0.1",
      "steps: 24",
      "tools:",
      '  "*": true',
      "  task: false",
      "  todowrite: false",
      "---",
      "",
      "You are the sole benchmark coding agent.",
      "",
      "Do not delegate or create child agents. Personally investigate the task using repository evidence, implement the smallest complete fix, run focused verification when feasible, inspect the final diff or generated files, and correct any defects you find before answering.",
      "",
      "The worktree changes—not prose—are the benchmark answer. Report changed paths, verification commands and outcomes, and residual risk. Never seek hidden benchmark tests, gold patches, or external solution artifacts.",
      "",
    ].join("\n"),
  },
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

export function benchmarkAgentWorkflowInstructions(
  topology:
    | typeof TERMINAL_BENCHMARK_AGENT_TOPOLOGY
    | typeof SINGLE_BENCHMARK_AGENT_TOPOLOGY = TERMINAL_BENCHMARK_AGENT_TOPOLOGY,
): string {
  if (topology === SINGLE_BENCHMARK_AGENT_TOPOLOGY) {
    return [
      "## Benchmark agent workflow",
      "You are the sole coding agent. Do not delegate or create child agents.",
      "Personally investigate, implement, verify, inspect the final diff, and correct defects before answering.",
      "",
    ].join("\n")
  }
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

/**
 * Harbor installs opencode inside each Terminal-Bench environment, so the
 * project-local markdown agents used by the SWE runners are not available
 * there. Supply the complete fixed-budget team through opencode's native config.
 */
export function terminalBenchmarkAgentConfig() {
  return {
    default_agent: BENCHMARK_COORDINATOR_AGENT,
    agent: {
      title: {
        disable: true,
      },
      [BENCHMARK_COORDINATOR_AGENT]: {
        mode: "primary",
        description: "Coordinates Terminal-Bench tasks through investigation, execution, and verification subagents.",
        temperature: 0.1,
        steps: 24,
        permission: {
          task: "allow",
        },
        prompt: [
          "You are the primary Terminal-Bench coordinator.",
          "",
          "Solve each task through blocking, foreground delegation while retaining responsibility for the final outcome:",
          `1. Delegate investigation to a fresh ${BENCHMARK_NAVIGATOR_AGENT} subagent. Ask it to inspect the environment, constraints, relevant files, and a practical verification strategy without changing state.`,
          `2. Delegate execution to a fresh ${BENCHMARK_PATCHER_AGENT} subagent. Give it the original task and investigation result, and require it to perform the concrete work in the shared environment.`,
          `3. Delegate independent verification to a fresh ${BENCHMARK_REVIEWER_AGENT} subagent. Give it the original task and prior results, and require it to inspect the final state, run feasible checks, and correct small clear defects when necessary.`,
          "",
          "Run these task calls sequentially in the stated order. Do not use background delegation. Integrate their results, inspect unresolved risks, and only then provide the final answer.",
        ].join("\n"),
      },
      [BENCHMARK_NAVIGATOR_AGENT]: {
        mode: "subagent",
        description: "Read-only Terminal-Bench navigator for environment inspection and execution planning.",
        temperature: 0.1,
        steps: 10,
        tools: {
          "*": false,
          read: true,
          glob: true,
          grep: true,
          list: true,
          bash: true,
        },
        prompt: [
          "You are the Terminal-Bench navigator.",
          "",
          "Investigate the task without changing state. Identify relevant files, environment constraints, likely failure points, and feasible verification commands. Return a concise, evidence-backed handoff for the patcher.",
        ].join("\n"),
      },
      [BENCHMARK_PATCHER_AGENT]: {
        mode: "subagent",
        description: "Executes the concrete Terminal-Bench task in the shared environment.",
        temperature: 0.1,
        steps: 18,
        tools: {
          "*": true,
          task: false,
          todowrite: false,
        },
        prompt: [
          "You are the Terminal-Bench patcher.",
          "",
          "Use the original task and navigator handoff to perform the smallest complete set of changes in the shared environment. Run focused verification and report actions, commands, outcomes, and remaining risk. Do not delegate.",
        ].join("\n"),
      },
      [BENCHMARK_REVIEWER_AGENT]: {
        mode: "subagent",
        description: "Independently verifies the Terminal-Bench result and makes small corrections.",
        temperature: 0.1,
        steps: 12,
        tools: {
          "*": true,
          task: false,
          todowrite: false,
        },
        prompt: [
          "You are the Terminal-Bench reviewer.",
          "",
          "Inspect the original task, current environment, and prior handoffs. Run feasible checks and make only small, clearly necessary corrections. Report concrete findings and residual risk. Do not delegate.",
        ].join("\n"),
      },
    },
  } as const
}

/**
 * Terminal-Bench installs OpenCode inside an isolated task environment. Keep
 * the single-agent definition self-contained so no delegation-capable agents
 * or task permission enter that environment.
 */
export function terminalSingleBenchmarkAgentConfig() {
  return {
    default_agent: BENCHMARK_SINGLE_AGENT,
    agent: {
      title: {
        disable: true,
      },
      [BENCHMARK_SINGLE_AGENT]: {
        mode: "primary",
        description: "Solves a Terminal-Bench task independently from investigation through final verification.",
        temperature: 0.1,
        steps: 24,
        tools: {
          "*": true,
          task: false,
          todowrite: false,
        },
        prompt: [
          "You are the sole Terminal-Bench coding agent.",
          "",
          "Do not delegate or create child agents. Personally inspect the environment and task constraints, implement the smallest complete solution, run focused verification when feasible, and review the final environment state for defects before answering.",
          "",
          "The environment changes—not prose—are the benchmark answer. Report the work performed, verification commands and outcomes, and any residual risk. Never seek hidden benchmark tests or external solution artifacts.",
        ].join("\n"),
      },
    },
  } as const
}

export async function installBenchmarkAgentTeam(
  workspace: string,
  topology:
    | typeof TERMINAL_BENCHMARK_AGENT_TOPOLOGY
    | typeof SINGLE_BENCHMARK_AGENT_TOPOLOGY = TERMINAL_BENCHMARK_AGENT_TOPOLOGY,
): Promise<void> {
  const agentDir = join(workspace, AGENT_DIR)
  await mkdir(agentDir, { recursive: true })

  const agents =
    topology === SINGLE_BENCHMARK_AGENT_TOPOLOGY
      ? AGENTS.filter((agent) => agent.filename === `${BENCHMARK_SINGLE_AGENT}.md`)
      : AGENTS.filter((agent) => agent.filename !== `${BENCHMARK_SINGLE_AGENT}.md`)
  await Promise.all(agents.map((agent) => writeFile(join(agentDir, agent.filename), agent.content, "utf8")))
}
