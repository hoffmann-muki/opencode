import { describe, expect, test } from "bun:test"
import { buildAgentSightSidecarArgs } from "../../benchmarks/tracing/agentsight"

describe("AgentSight benchmark profiler", () => {
  test("builds a research sidecar scoped to the task container", () => {
    const args = buildAgentSightSidecarArgs({
      image: "agentsight:play",
      sidecar: "agentsight-run",
      sourceDirectory: "/tmp/profile/sources/task-container",
      profileId: "trace-1",
      scopeId: "task-container",
      initPid: 4242,
      binaryPath: "/usr/local/bin/opencode",
      captureTls: true,
      stopTimeoutSeconds: 15,
    })

    expect(args).toContain("--privileged")
    expect(args).toContain("host")
    expect(args).toContain("research")
    expect(args).toContain("--tls-binary-only")
    expect(args).toContain("/proc/4242/ns/pid")
    expect(args).toContain("/proc/4242/root/usr/local/bin/opencode")
    expect(args).toContain("--no-stdio")
    expect(args).not.toContain("--no-ssl")
  })

  test("can profile a non-networking task container without TLS capture", () => {
    const args = buildAgentSightSidecarArgs({
      image: "agentsight:play",
      sidecar: "agentsight-run",
      sourceDirectory: "/tmp/profile/sources/task-container",
      profileId: "trace-1",
      scopeId: "task-container",
      initPid: 4242,
      captureTls: false,
      stopTimeoutSeconds: 15,
    })

    expect(args).toContain("--no-ssl")
    expect(args).not.toContain("--tls-binary-only")
  })
})
