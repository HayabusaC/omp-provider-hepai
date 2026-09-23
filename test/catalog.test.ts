import { describe, expect, test } from "bun:test";
import { calculateUsageCost } from "@oh-my-pi/pi-catalog";
import {
  catalogRecordToModelConfig,
  fetchHepAICatalog,
  indexCatalog,
  REQUIRED_CONTEXT_FALLBACK,
  REQUIRED_OUTPUT_FALLBACK,
} from "../catalog.ts";

describe("HepAI catalog mapping", () => {
  test("maps verified per-million prices and model limits into OMP fields", () => {
    const model = catalogRecordToModelConfig("anthropic/claude-sonnet-4-6", {
      id: "anthropic/claude-sonnet-4-6",
      display_label: "Anthropic: Claude Sonnet 4.6",
      context_window: 1_000_000,
      max_output_tokens: 128_000,
      is_reasoning: { mandatory: false, supported_efforts: ["low", "high"] },
      input_modalities: ["text", "image"],
      input_price_per_mtoken: 22.68,
      output_price_per_mtoken: 113.4,
    });

    expect(model).toMatchObject({
      name: "Anthropic: Claude Sonnet 4.6",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      cost: { input: 22.68 * 0.143, output: 113.4 * 0.143, cacheRead: 0, cacheWrite: 0 },
    });
  });

  test("maps cache prices only when the server explicitly supplies them", () => {
    const model = catalogRecordToModelConfig("model-a", {
      model_pricing: {
        pricing_details: {
          input_cost_per_million_tokens: "3",
          output_cost_per_million_tokens: 15,
          cache_creation_cost_per_million_tokens: 3.75,
          cache_read_input_cost_per_million_tokens: 0.3,
        },
      },
    });
    expect(model.cost).toEqual({
      input: 3 * 0.143,
      output: 15 * 0.143,
      cacheRead: 0.3 * 0.143,
      cacheWrite: 3.75 * 0.143,
    });
  });

  test("uses safe execution fallbacks without inventing unknown prices", () => {
    const model = catalogRecordToModelConfig("model-a", {
      context_window: null,
      max_output_tokens: "unknown",
      input_price_per_mtoken: -1,
    });
    expect(model.contextWindow).toBe(REQUIRED_CONTEXT_FALLBACK);
    expect(model.maxTokens).toBe(REQUIRED_OUTPUT_FALLBACK);
    expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  test("feeds OMP's native per-million-token cost calculator", () => {
    const model = catalogRecordToModelConfig("model-a", {
      input_price_per_mtoken: 22.68,
      output_price_per_mtoken: 113.4,
    });
    const usage = {
      input: 3,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 8,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const cost = calculateUsageCost(model.cost, usage);
    expect(cost.input).toBeCloseTo(0.00006804 * 0.143, 16);
    expect(cost.output).toBeCloseTo(0.000567 * 0.143, 16);
    expect(cost.cacheRead).toBe(0);
    expect(cost.cacheWrite).toBe(0);
    expect(cost.total).toBeCloseTo(0.00063504 * 0.143, 16);
  });

  test("fetches Portal-JWT-protected details for exact original model IDs", async () => {
    const requests: string[] = [];
    const authorizations: (string | null)[] = [];
    const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      requests.push(url);
      authorizations.push(new Headers(init?.headers).get("Authorization"));
      const id = new URL(url).searchParams.get("model_name");
      return Response.json({ data: [{ model_name: id, limitations: { context_window: 200_000 } }] });
    }) as typeof fetch;
    const records = await fetchHepAICatalog(["openai/gpt-5.6-sol", "zhipu/glm-5.1"], "portal-jwt", fetcher);
    expect(requests).toHaveLength(2);
    expect(requests.every(url => url.includes("/portal/model/cloud_models_details?"))).toBe(true);
    expect(requests.map(url => new URL(url).searchParams.get("model_name"))).toEqual([
      "openai/gpt-5.6-sol",
      "zhipu/glm-5.1",
    ]);
    expect(authorizations).toEqual(["Bearer portal-jwt", "Bearer portal-jwt"]);
    expect(indexCatalog(records).has("openai/gpt-5.6-sol")).toBe(true);
  });

  test("maps nested detail limitations", () => {
    const model = catalogRecordToModelConfig("zhipu/glm-5.1", {
      limitations: { context_window: 200_000, max_output_tokens: 32_000 },
    });
    expect(model.contextWindow).toBe(200_000);
    expect(model.maxTokens).toBe(32_000);
  });
});
