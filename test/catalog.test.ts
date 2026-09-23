import { describe, expect, test } from "bun:test";
import { calculateUsageCost } from "@oh-my-pi/pi-catalog";
import {
  catalogRecordToModelConfig,
  excludeAgentModels,
  excludeDemoModels,
  excludeSpecificModels,
  excludeUnqualifiedAliases,
  fetchHepAICatalog,
  fetchHepAICloudModels,
  hasDisplayName,
  indexCatalog,
  mergeCatalogRecords,
  REQUIRED_CONTEXT_FALLBACK,
  REQUIRED_OUTPUT_FALLBACK,
  sortHepAIModels,
  isSpecificModel,
  isAgentModel,
} from "../catalog.ts";

describe("HepAI catalog mapping", () => {
  test("requires a non-empty display_name or display_label", () => {
    expect(hasDisplayName({ display_name: "Model" })).toBe(true);
    expect(hasDisplayName({ display_name: ["", "Model"] })).toBe(true);
    expect(hasDisplayName({ display_name: null, display_label: "Model label" })).toBe(true);
    expect(hasDisplayName({ display_name: "" })).toBe(false);
    expect(hasDisplayName({ display_name: [] })).toBe(false);
    expect(hasDisplayName({ display_label: "" })).toBe(false);
    expect(hasDisplayName({ display_name: ["{}"], display_label: " null " })).toBe(false);
    expect(hasDisplayName({ display_name: "[]" })).toBe(false);
    expect(hasDisplayName({ display_label: "UNDEFINED" })).toBe(false);
    expect(catalogRecordToModelConfig("model-a", { display_name: ["{}", "Usable"] }).name).toBe("Usable");
  });

  test("exempts exact model IDs and uses the suffix after the slash as their display name", () => {
    expect(hasDisplayName({ display_name: "{}" }, "aliyun/qwen3.8-max")).toBe(true);
    expect(hasDisplayName({ display_label: "null" }, "moonshot/kimi-k3")).toBe(true);
    expect(catalogRecordToModelConfig("aliyun/qwen3.8-max", { display_name: "{}" }).name).toBe("qwen3.8-max");
    expect(catalogRecordToModelConfig("moonshot/kimi-k3", { display_label: "null" }).name).toBe("kimi-k3");
    expect(hasDisplayName({ display_name: "{}" }, "Metadata_completion_model")).toBe(true);
    expect(catalogRecordToModelConfig("Metadata_completion_model", { display_name: "{}" }).name).toBe("Metadata_completion_model");
    expect(hasDisplayName({ display_name: "{}" }, "other/kimi-k3")).toBe(false);
  });

  test("excludes an unqualified B when an exact A/B model ID exists", () => {
    expect(excludeUnqualifiedAliases([
      "gpt-5.6-sol",
      "openai/gpt-5.6-sol",
      "other/gpt-5.6-sol",
      "GPT-5.6-sol",
      "standalone",
    ])).toEqual([
      "openai/gpt-5.6-sol",
      "other/gpt-5.6-sol",
      "GPT-5.6-sol",
      "standalone",
    ]);
  });

  test("keeps exact global exemptions through demo and duplicate filtering", () => {
    expect(excludeDemoModels(["Metadata_completion_model", "demo-model"])).toEqual(["Metadata_completion_model"]);
    expect(excludeUnqualifiedAliases([
      "Metadata_completion_model",
      "HepAI/Metadata_completion_model",
    ])).toEqual([
      "Metadata_completion_model",
      "HepAI/Metadata_completion_model",
    ]);
  });

  test("excludes model IDs containing demo case-insensitively", () => {
    expect(excludeDemoModels([
      "hepai/demo-model",
      "vendor/DeMoPreview",
      "vendor/model",
    ])).toEqual(["vendor/model"]);
  });

  test("classifies Specific models by case-insensitive ID keywords", () => {
    expect(isSpecificModel("hepai/code-worker-v2-BOSS-8")).toBe(true);
    expect(isSpecificModel("OClimax_Analysis_Agent")).toBe(true);
    expect(isSpecificModel("hepai/Materials_Project_API")).toBe(true);
    expect(isSpecificModel("hepai/add_number_tool")).toBe(true);
    expect(isSpecificModel("hepai/ai-protein")).toBe(true);
    expect(isSpecificModel("hepai/AlgorithmGeneration")).toBe(true);
    expect(isSpecificModel("hepai/particle-spelling-variants")).toBe(true);
    expect(isSpecificModel("Metadata_completion_model")).toBe(true);
    expect(isSpecificModel("HepAI/Metadata_completion_model")).toBe(true);
    expect(isSpecificModel("openai/gpt-5.6-sol")).toBe(false);
  });

  test("filters Specific models only when the plugin switch is enabled", () => {
    const ids = ["hepai/BESIIIEventSelector", "openai/gpt-5.6-sol", "XRD Sensor", "Metadata_completion_model"];
    expect(excludeSpecificModels(ids, false)).toEqual(ids);
    expect(excludeSpecificModels(ids, true)).toEqual(["openai/gpt-5.6-sol"]);
  });

  test("classifies Agent models by case-insensitive ID keywords", () => {
    expect(isAgentModel("DataAgent")).toBe(true);
    expect(isAgentModel("DocMaster")).toBe(true);
    expect(isAgentModel("hepai/drsai")).toBe(true);
    expect(isAgentModel("Your Explorer")).toBe(true);
    expect(isAgentModel("openai/gpt-5.6-sol")).toBe(false);
  });

  test("filters Agent models only when the plugin switch is enabled", () => {
    const ids = ["DataAgent", "openai/gpt-5.6-sol", "Your Explorer"];
    expect(excludeAgentModels(ids, false)).toEqual(ids);
    expect(excludeAgentModels(ids, true)).toEqual(["openai/gpt-5.6-sol"]);
  });

  test("applies display-name filtering before unqualified-alias filtering", () => {
    const ids = ["model", "vendor/model"];
    const catalog = indexCatalog([
      { id: "model", display_name: "Usable model" },
      { id: "vendor/model", display_name: "{}" },
    ]);
    const named = ids.filter(id => hasDisplayName(catalog.get(id), id));
    expect(excludeUnqualifiedAliases(named)).toEqual(["model"]);
  });

  test("applies demo filtering before unqualified-alias filtering", () => {
    expect(excludeUnqualifiedAliases(excludeDemoModels(["model", "vendor/demo-model"]))).toEqual(["model"]);
  });

  test("groups registered models by catalog provider, then sorts names naturally", () => {
    const records = indexCatalog([
      { id: "openai/model-10", provider: "OpenAI", display_label: "Model 10" },
      { id: "openai/model-2", provider: "OpenAI", display_label: "Model 2" },
      { id: "deepseek-ai/model", provider: "DeepSeek", display_label: "Model" },
    ]);
    const ids = ["openai/model-10", "other/model-b", "gpt-5", "openai/model-2", "deepseek-ai/model", "other/model-a"];
    const models = ids.map(id => catalogRecordToModelConfig(id, records.get(id)));
    const sorted = sortHepAIModels(models, records);
    expect(sorted.map(model => model.id)).toEqual([
      "deepseek-ai/model", "openai/model-2", "openai/model-10", "gpt-5", "other/model-a", "other/model-b",
    ]);
    expect(models.map(model => model.id)).toEqual(ids);
  });

  test("uses the cloud provider when website details have no provider", () => {
    const cloud = { id: "zhipu/glm-5", provider: "Zhipu", display_label: "GLM 5" };
    const details = { id: "zhipu/glm-5", provider: null, display_name: "GLM 5.1" };
    const catalog = mergeCatalogRecords([cloud], [details], []);
    const models = [
      catalogRecordToModelConfig("zhipu/glm-5", catalog.get("zhipu/glm-5")),
      catalogRecordToModelConfig("other/model", { provider: "Other" }),
    ];
    expect(sortHepAIModels(models, catalog).map(model => model.id)).toEqual(["other/model", "zhipu/glm-5"]);
    expect(models[0]?.name).toBe("GLM 5.1");
  });

  test("prefers API-key model metadata over website details and cloud fallback", () => {
    const id = "vendor/model";
    const catalog = mergeCatalogRecords(
      [{ id, provider: "Cloud", display_label: "Cloud name", context_window: 32_000 }],
      [{ id, provider: "Website", display_name: "Website name", context_window: 64_000 }],
      [{ id, provider: "API", display_label: "API name", context_window: null }],
    );
    expect(catalog.get(id)).toMatchObject({ provider: "API", display_label: "API name", context_window: 64_000 });
    expect(catalogRecordToModelConfig(id, catalog.get(id)).name).toBe("API name");
  });

  test("does not let placeholder display names erase a valid lower-priority name", () => {
    const id = "vendor/model";
    const catalog = mergeCatalogRecords(
      [{ id, display_label: "Cloud name" }],
      [{ id, display_name: "Website name" }],
      [{ id, display_name: "{}", display_label: " null " }],
    );
    expect(catalogRecordToModelConfig(id, catalog.get(id)).name).toBe("Website name");
  });

  test("uses model ID to break display-name ties within a provider", () => {
    const records = indexCatalog([
      { id: "vendor/z", provider: "Vendor", display_label: "Same name" },
      { id: "vendor/a", provider: "Vendor", display_label: "Same name" },
    ]);
    const models = ["vendor/z", "vendor/a"].map(id => catalogRecordToModelConfig(id, records.get(id)));
    expect(sortHepAIModels(models, records).map(model => model.id)).toEqual(["vendor/a", "vendor/z"]);
  });

  test("loads the complete public cloud model list in one request", async () => {
    const requests: URL[] = [];
    const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push(url);
      expect(new Headers(init?.headers).has("Authorization")).toBe(false);
      return Response.json({ data: [
        { id: "model-0", display_label: "Model 0" },
        { id: "model-1", context_window: 200_000 },
      ], total: 2, page: 1, page_size: -1, total_pages: 1 });
    }) as unknown as typeof fetch;
    const records = await fetchHepAICloudModels(fetcher);
    expect(requests.map(url => `${url.pathname}?${url.searchParams}`)).toEqual([
      "/apiv2/portal/model/list_cloud_models?page=1&page_size=-1",
    ]);
    expect(records).toHaveLength(2);
    expect(records[1]).toMatchObject({ id: "model-1", context_window: 200_000 });
  });

  test("deduplicates model IDs in the full-list response", async () => {
    let calls = 0;
    const fetcher = (async () => {
      calls++;
      return Response.json({ data: [{ id: "model-0" }, { id: "model-0" }, { model_name: "model-1" }] });
    }) as unknown as typeof fetch;
    expect((await fetchHepAICloudModels(fetcher)).map(record => record.id)).toEqual(["model-0", "model-1"]);
    expect(calls).toBe(1);
  });

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
      cost: { input: 3.24324, output: 16.2162, cacheRead: 0, cacheWrite: 0 },
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
      input: 0.429,
      output: 2.145,
      cacheRead: 0.0429,
      cacheWrite: 0.53625,
    });
  });

  test("uses safe execution fallbacks without inventing unknown prices", () => {
    const model = catalogRecordToModelConfig("model-a", {
      context_window: null,
      max_output_tokens: "unknown",
      input_price_per_mtoken: -1,
    });
    expect(model.contextWindow).toBe(REQUIRED_CONTEXT_FALLBACK);
    expect(model.maxTokens).toBe(32_768);
    expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  test("repairs placeholder limits after the effective five-stage filter", () => {
    const placeholder = catalogRecordToModelConfig("vendor/model-without-catalog-reference", {
      context_window: 8_192,
      max_output_tokens: 2_048,
    });
    expect(placeholder.contextWindow).toBe(128_000);
    expect(placeholder.maxTokens).toBe(32_768);

    const catalogFallback = catalogRecordToModelConfig("moonshot/kimi-k3", {
      context_window: 8_192,
      max_output_tokens: 2_048,
    });
    expect(catalogFallback.contextWindow).toBe(1_048_576);
    expect(catalogFallback.maxTokens).toBe(131_072);

    const missingContext = catalogRecordToModelConfig("moonshot/kimi-k3", {
      max_output_tokens: 2_048,
    });
    expect(missingContext.contextWindow).toBe(1_048_576);
    expect(missingContext.maxTokens).toBe(131_072);

    const missingContextWithoutReference = catalogRecordToModelConfig("vendor/model-without-catalog-reference", {
      max_output_tokens: 2_048,
    });
    expect(missingContextWithoutReference.contextWindow).toBe(128_000);
    expect(missingContextWithoutReference.maxTokens).toBe(32_768);

    const thousands = catalogRecordToModelConfig("vendor/model", {
      context_window: 128,
      max_output_tokens: 64,
    });
    expect(thousands.contextWindow).toBe(128_000);
    expect(thousands.maxTokens).toBe(64_000);

    const inclusiveThousands = catalogRecordToModelConfig("vendor/model", {
      context_window: 1_024,
      max_output_tokens: 384,
    });
    expect(inclusiveThousands.contextWindow).toBe(1_024_000);
    expect(inclusiveThousands.maxTokens).toBe(384_000);

    const mixedUnits = catalogRecordToModelConfig("vendor/model", {
      context_window: 2_048,
      max_output_tokens: 384,
    });
    expect(mixedUnits.contextWindow).toBe(2_048);
    expect(mixedUnits.maxTokens).toBe(384);

    const filteredClassVisibleByOverride = catalogRecordToModelConfig("hepai/DataAgent", {
      context_window: 8_192,
      max_output_tokens: 2_048,
    }, false);
    expect(filteredClassVisibleByOverride.contextWindow).toBe(8_192);
    expect(filteredClassVisibleByOverride.maxTokens).toBe(2_048);
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

  test("fetches website-SSO-protected details for exact original model IDs", async () => {
    const requests: string[] = [];
    const authorizations: (string | null)[] = [];
    const cookies: (string | null)[] = [];
    const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      requests.push(url);
      authorizations.push(new Headers(init?.headers).get("Authorization"));
      cookies.push(new Headers(init?.headers).get("Cookie"));
      const id = new URL(url).searchParams.get("model_name");
      return Response.json({ data: [{ model_name: id, limitations: { context_window: 200_000 } }] });
    }) as typeof fetch;
    const records = await fetchHepAICatalog(["openai/gpt-5.6-sol", "zhipu/glm-5.1"], "website-token", fetcher);
    expect(requests).toHaveLength(2);
    expect(requests.every(url => url.startsWith("https://ai.ihep.ac.cn/apiv2/portal/model/cloud_models_details?"))).toBe(true);
    expect(requests.map(url => new URL(url).searchParams.get("model_name"))).toEqual([
      "openai/gpt-5.6-sol",
      "zhipu/glm-5.1",
    ]);
    expect(authorizations).toEqual(["Bearer website-token", "Bearer website-token"]);
    expect(cookies).toEqual(["token=website-token", "token=website-token"]);
    expect(indexCatalog(records).has("openai/gpt-5.6-sol")).toBe(true);
  });

  test("maps nested detail limitations", () => {
    const model = catalogRecordToModelConfig("zhipu/glm-5.1", {
      limitations: { context_window: 200_000, max_output_tokens: 32_000 },
    });
    expect(model.contextWindow).toBe(200_000);
    expect(model.maxTokens).toBe(32_000);
  });

  test("keeps OMP thinking controls available despite missing or incorrect upstream metadata", () => {
    for (const record of [
      { capabilities: { reasoning: false, supported_parameters: ["reasoning_effort"] } },
      { capabilities: { supported_parameters: ["include_reasoning"] } },
      { search_capabilities: ["coding", "reasoning"] },
      { tags: ["代码能力", "强推理"] },
      { is_reasoning: false, capabilities: { reasoning: false } },
      {},
    ]) {
      expect(catalogRecordToModelConfig("model-a", record).reasoning).toBe(true);
    }
  });

  test("maps the live Portal detail shape", () => {
    const model = catalogRecordToModelConfig("anthropic/claude-sonnet-4-6", {
      display_label: "list fallback label",
      display_name: ["claude-sonnet-4-6"],
      capabilities: { reasoning: { mandatory: false }, input_modalities: ["text", "image", "file"] },
      limitations: { context_window: 1_000_000, max_output_tokens: 128_000 },
      model_pricing: { pricing_details: { input_cost_per_million_tokens: 22.68, output_cost_per_million_tokens: 113.4 } },
    });
    expect(model).toMatchObject({
      name: "claude-sonnet-4-6",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      cost: { input: 3.24324, output: 16.2162 },
    });
  });

  test("applies model_pricing.discount_rate to every catalog estimate", () => {
    const model = catalogRecordToModelConfig("openai/gpt-5.6-sol", {
      model_pricing: {
        discount_rate: 0.3,
        pricing_details: {
          input_cost_per_million_tokens: 28,
          output_cost_per_million_tokens: 140,
          cache_creation_cost_per_million_tokens: 35,
          cache_read_input_cost_per_million_tokens: 2.8,
        },
      },
    });
    expect(model.cost).toEqual({ input: 1.2012, output: 6.006, cacheRead: 0.12012, cacheWrite: 1.5015 });
  });

  test("rounds catalog prices to stable decimal values", () => {
    expect(catalogRecordToModelConfig("model-a", {
      input_price_per_mtoken: 1.2,
      output_price_per_mtoken: 11.34,
    }).cost).toMatchObject({ input: 0.1716, output: 1.62162 });
  });

  test("ignores a detail record for a different model ID", async () => {
    const fetcher = (async () => Response.json({ data: [{ id: "other-model", limitations: { context_window: 42 } }] })) as unknown as typeof fetch;
    expect(await fetchHepAICatalog(["requested-model"], "website-token", fetcher)).toEqual([]);
  });

  test("ignores a detail record without an exact model ID", async () => {
    const fetcher = (async () => Response.json({ data: [{ limitations: { context_window: 42 } }] })) as unknown as typeof fetch;
    expect(await fetchHepAICatalog(["requested-model"], "website-token", fetcher)).toEqual([]);
  });
});
