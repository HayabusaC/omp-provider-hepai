import { describe, expect, test } from "bun:test";
import {
  buildProbeBody,
  chooseSupportedTransport,
  classifyProbe,
  orderedTransports,
  shouldFallbackStatus,
} from "../capabilities.ts";

describe("HepAI capability classification", () => {
  test("distinguishes auth, missing endpoint, model policy, and upstream errors", () => {
    expect(classifyProbe("responses", 401, "bad key").kind).toBe("auth-failed");
    expect(classifyProbe("responses", 404, "missing").kind).toBe("endpoint-missing");
    expect(classifyProbe("responses", 404, "model is not available").kind).toBe("model-unsupported");
    expect(classifyProbe("responses", 400, "model is not supported").kind).toBe("model-unsupported");
    expect(classifyProbe("responses", 502, "upstream").kind).toBe("upstream-error");
  });

  test("does not fallback on credentials or upstream failures", () => {
    expect(shouldFallbackStatus(400, "unsupported model")).toBe(true);
    expect(shouldFallbackStatus(401, "unauthorized")).toBe(false);
    expect(shouldFallbackStatus(500, "internal")).toBe(false);
  });

  test("uses a viable minimal output allowance for both live probes", () => {
    expect(buildProbeBody("responses", "model-a")).toMatchObject({ max_output_tokens: 16 });
    expect(buildProbeBody("chat/completions", "model-a")).toMatchObject({ max_tokens: 16 });
    expect(buildProbeBody("anthropic/v1/messages", "model-a")).toMatchObject({ max_tokens: 16 });
  });

  test("prefers the native Anthropic transport for Claude while retaining deterministic fallbacks", () => {
    expect(orderedTransports("anthropic/claude-sonnet-4-6")).toEqual(["anthropic", "responses", "chat"]);
    expect(orderedTransports("openai/gpt-5.6-sol")).toEqual(["responses", "chat", "anthropic"]);
    expect(chooseSupportedTransport("anthropic/claude-sonnet-4-6", [
      classifyProbe("responses", 200, {}),
      classifyProbe("anthropic/v1/messages", 200, {}),
    ])).toBe("anthropic");
  });
});
