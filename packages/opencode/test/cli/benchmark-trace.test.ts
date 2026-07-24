import { describe, expect, test } from "bun:test"
import { sanitizeBenchmarkTrace } from "../../src/cli/benchmark-trace"

describe("benchmark trace transport sanitization", () => {
  test("removes credentials and accounting before native frames reach stdout", () => {
    const secret = `sk-${"x".repeat(24)}`
    const value = sanitizeBenchmarkTrace({
      type: "tool.completed",
      properties: {
        api_key: secret,
        usage: {
          total_tokens: 42,
          cost: 1,
        },
        metrics: {
          tokens: { input: 42, output: 10 },
          duration_ms: 25,
        },
        OPENROUTER_API_KEY: "synthetic-secret-value",
        provider_usage: { input_tokens: 42 },
        output: "OPENROUTER_API_KEY=synthetic-secret-value --custom-access-token synthetic-token-value",
        nested: [{ authorization: `Bearer ${"a".repeat(24)}` }],
      },
    })
    const retained = JSON.stringify(value)

    expect(retained).toContain("<redacted:")
    expect(retained).not.toContain(secret)
    expect(retained).not.toContain("authorization")
    expect(retained).not.toContain("total_tokens")
    expect(retained).not.toContain('"cost"')
    expect(retained).not.toContain('"tokens"')
    expect(retained).not.toContain("synthetic-secret-value")
    expect(retained).not.toContain("synthetic-token-value")
    expect(retained).not.toContain("provider_usage")
    expect(retained).toContain('"duration_ms":25')
  })
})
