import type { ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";
import { HEPAI_CNY_TO_USD } from "./billing-types.ts";
import { HEPAI_CLOUD_MODELS_URL, HEPAI_MODEL_DETAILS_URL } from "./endpoints.ts";
import { getBundledModelReferenceIndex, resolveModelReference } from "@oh-my-pi/pi-catalog/identity";
import {
  OPENAI_COMPAT_DISCOVERY_DEFAULT_CONTEXT_WINDOW,
  OPENAI_COMPAT_DISCOVERY_DEFAULT_MAX_TOKENS,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";

const DETAIL_CONCURRENCY = 8;

export const REQUIRED_CONTEXT_FALLBACK = 128_000;
export const REQUIRED_OUTPUT_FALLBACK = 16_384;
const bundledReferences = getBundledModelReferenceIndex();

export interface HepAICatalogRecord {
  id?: unknown;
  model_name?: unknown;
  display_label?: unknown;
  display_name?: unknown;
  provider?: unknown;
  context_window?: unknown;
  max_output_tokens?: unknown;
  is_reasoning?: unknown;
  input_modalities?: unknown;
  input_price_per_mtoken?: unknown;
  output_price_per_mtoken?: unknown;
  model_pricing?: unknown;
  limitations?: unknown;
  capabilities?: unknown;
  search_capabilities?: unknown;
  tags?: unknown;
}

interface DetailResponse {
  data?: unknown;
}

interface PricingDetails {
  input_cost_per_million_tokens?: unknown;
  output_cost_per_million_tokens?: unknown;
  cache_creation_cost_per_million_tokens?: unknown;
  cache_read_input_cost_per_million_tokens?: unknown;
  rates?: {
    prompt?: unknown;
    completion?: unknown;
    input_cache_write?: unknown;
    input_cache_read?: unknown;
  };
}

function nonNegativeNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = nonNegativeNumber(value);
  return parsed !== undefined && parsed > 0 ? Math.floor(parsed) : undefined;
}

function pricingDetails(record: HepAICatalogRecord): PricingDetails | undefined {
  if (!record.model_pricing || typeof record.model_pricing !== "object") return undefined;
  const details = (record.model_pricing as ModelPricing).pricing_details;
  return details && typeof details === "object" ? details as PricingDetails : undefined;
}

interface ModelPricing {
  discount_rate?: unknown;
  pricing_details?: unknown;
}

function nestedRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function catalogDiscountRate(record: HepAICatalogRecord | undefined): number {
  const pricing = nestedRecord(record?.model_pricing);
  return nonNegativeNumber(pricing?.discount_rate) ?? 1;
}

function roundedPrice(value: number): number {
  return Number(value.toFixed(12));
}

function rate(primary: unknown, fallback: unknown, discountRate: number): number {
  return roundedPrice((nonNegativeNumber(primary) ?? nonNegativeNumber(fallback) ?? 0)
    * discountRate * HEPAI_CNY_TO_USD);
}

const INVALID_DISPLAY_NAMES = new Set(["", "{}", "[]", "null", "undefined"]);
const GLOBAL_FILTER_ID_EXEMPTIONS = new Set([
  "aliyun/qwen3.8-max",
  "moonshot/kimi-k3",
  "Metadata_completion_model",
]);
export const SPECIFIC_MODEL_KEYWORDS = [
  "BOSS", "COMET", "Reconstruct", "Sensor", "HXMT", "simulation", "NRS", "XRD",
  "BESIII", "HEPS", "Metadata", "xiwu", "filter", "OCLIMAX", "NPD", "Materials", "analysis",
  "number", "protein", "Algorithm", "particle",
] as const;
export const AGENT_MODEL_KEYWORDS = ["Agent", "master", "Dr", "explorer"] as const;

function validDisplayName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return INVALID_DISPLAY_NAMES.has(trimmed.toLowerCase()) ? undefined : trimmed;
}

function exemptDisplayName(id: string): string | undefined {
  if (!GLOBAL_FILTER_ID_EXEMPTIONS.has(id)) return undefined;
  const slash = id.indexOf("/");
  return slash >= 0 ? id.slice(slash + 1) : id;
}

export function hasDisplayName(record: HepAICatalogRecord | undefined, id?: string): boolean {
  const displayName = Array.isArray(record?.display_name)
    ? record.display_name.find(name => validDisplayName(name) !== undefined)
    : record?.display_name;
  return validDisplayName(displayName) !== undefined
    || validDisplayName(record?.display_label) !== undefined
    || !!id && exemptDisplayName(id) !== undefined;
}

export function catalogRecordToModelConfig(
  id: string,
  record?: HepAICatalogRecord,
  normalizeLimits = true,
): ProviderModelConfig {
  const details = record ? pricingDetails(record) : undefined;
  const discountRate = catalogDiscountRate(record);
  const limitations = nestedRecord(record?.limitations);
  const capabilities = nestedRecord(record?.capabilities);
  const sourceModalities = capabilities?.input_modalities ?? record?.input_modalities;
  const modalities = Array.isArray(sourceModalities) ? sourceModalities : [];
  const input: ("text" | "image")[] = ["text"];
  if (modalities.includes("image")) input.push("image");

  const detailName = Array.isArray(record?.display_name)
    ? record.display_name.find(name => validDisplayName(name) !== undefined)
    : record?.display_name;
  const name = validDisplayName(detailName) ?? validDisplayName(record?.display_label) ?? exemptDisplayName(id) ?? id;
  let contextWindow = positiveInteger(record?.context_window ?? limitations?.context_window);
  let maxTokens = positiveInteger(record?.max_output_tokens ?? limitations?.max_output_tokens);
  if (normalizeLimits && (contextWindow === undefined || (contextWindow === 8_192 && maxTokens === 2_048))) {
    const reference = resolveModelReference(id, bundledReferences);
    contextWindow = reference?.contextWindow ?? OPENAI_COMPAT_DISCOVERY_DEFAULT_CONTEXT_WINDOW;
    maxTokens = Math.min(
      reference?.maxTokens ?? OPENAI_COMPAT_DISCOVERY_DEFAULT_MAX_TOKENS,
      contextWindow,
    );
  } else if (normalizeLimits && contextWindow !== undefined && maxTokens !== undefined
    && contextWindow <= 1_024 && maxTokens <= 1_024) {
    contextWindow *= 1_000;
    maxTokens *= 1_000;
  }

  return {
    id,
    name,
    api: "hepai-auto",
    // HepAI capability metadata is incomplete and sometimes explicitly wrong.
    // Keep OMP's thinking controls available; the selected transport/upstream
    // remains authoritative about whether a particular request accepts them.
    reasoning: true,
    input,
    cost: {
      input: rate(record?.input_price_per_mtoken, details?.input_cost_per_million_tokens ?? details?.rates?.prompt, discountRate),
      output: rate(record?.output_price_per_mtoken, details?.output_cost_per_million_tokens ?? details?.rates?.completion, discountRate),
      cacheRead: rate(details?.cache_read_input_cost_per_million_tokens, details?.rates?.input_cache_read, discountRate),
      cacheWrite: rate(details?.cache_creation_cost_per_million_tokens, details?.rates?.input_cache_write, discountRate),
    },
    contextWindow: contextWindow ?? REQUIRED_CONTEXT_FALLBACK,
    maxTokens: maxTokens ?? REQUIRED_OUTPUT_FALLBACK,
  };
}

export function indexCatalog(records: readonly HepAICatalogRecord[]): Map<string, HepAICatalogRecord> {
  const indexed = new Map<string, HepAICatalogRecord>();
  for (const record of records) {
    if (typeof record.id === "string" && record.id.length > 0) indexed.set(record.id, record);
  }
  return indexed;
}

async function fetchModelDetail(
  modelId: string,
  accessToken: string,
  fetcher: typeof fetch,
): Promise<HepAICatalogRecord | undefined> {
  const url = new URL(HEPAI_MODEL_DETAILS_URL);
  url.searchParams.set("model_name", modelId);
  const response = await fetcher(url, {
    headers: { Authorization: `Bearer ${accessToken}`, Cookie: `token=${accessToken}`, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`HepAI model detail discovery failed with HTTP ${response.status}`);
  const payload = await response.json() as DetailResponse;
  const candidates = Array.isArray(payload.data) ? payload.data : [payload.data];
  return candidates.find(
    (item): item is HepAICatalogRecord => !!item && typeof item === "object"
      && (
        (item as HepAICatalogRecord).id === modelId
        || (item as HepAICatalogRecord).model_name === modelId
      ),
  );
}

/**
 * Drop an unqualified model ID B when the same exact B is also available as A/B.
 * Comparisons are case-sensitive and only the first slash separates A from B.
 */
export function excludeUnqualifiedAliases(ids: readonly string[]): string[] {
  const qualifiedSuffixes = new Set(
    ids.flatMap(id => {
      const slash = id.indexOf("/");
      return slash > 0 ? [id.slice(slash + 1)] : [];
    }),
  );
  return ids.filter(id => GLOBAL_FILTER_ID_EXEMPTIONS.has(id) || id.includes("/") || !qualifiedSuffixes.has(id));
}

export function excludeDemoModels(ids: readonly string[]): string[] {
  return ids.filter(id => GLOBAL_FILTER_ID_EXEMPTIONS.has(id) || !id.toLowerCase().includes("demo"));
}

export function isSpecificModel(id: string): boolean {
  const normalized = id.toLowerCase();
  return SPECIFIC_MODEL_KEYWORDS.some(keyword => normalized.includes(keyword.toLowerCase()));
}

export function excludeSpecificModels(ids: readonly string[], enabled: boolean): string[] {
  return enabled ? ids.filter(id => !isSpecificModel(id)) : [...ids];
}

export function isAgentModel(id: string): boolean {
  const normalized = id.toLowerCase();
  return AGENT_MODEL_KEYWORDS.some(keyword => normalized.includes(keyword.toLowerCase()));
}

export function excludeAgentModels(ids: readonly string[], enabled: boolean): string[] {
  return enabled ? ids.filter(id => !isAgentModel(id)) : [...ids];
}

export function mergeCatalogRecords(
  cloudRecords: readonly HepAICatalogRecord[],
  detailRecords: readonly HepAICatalogRecord[],
  apiRecords: readonly HepAICatalogRecord[],
): Map<string, HepAICatalogRecord> {
  const merged = new Map<string, HepAICatalogRecord>();
  for (const source of [cloudRecords, detailRecords, apiRecords]) {
    for (const record of source) {
      if (typeof record.id !== "string" || !record.id) continue;
      const next = { ...merged.get(record.id) };
      const displayName = Array.isArray(record.display_name)
        ? record.display_name.filter((name): name is string => validDisplayName(name) !== undefined)
        : validDisplayName(record.display_name);
      const displayLabel = validDisplayName(record.display_label);
      const hasDisplayName = Array.isArray(displayName) ? displayName.length > 0 : displayName !== undefined;
      if (hasDisplayName || displayLabel !== undefined) {
        delete next.display_name;
        delete next.display_label;
      }
      for (const [key, value] of Object.entries(record)) {
        if (key === "display_name" || key === "display_label") continue;
        if (value !== null && value !== undefined && value !== "") {
          (next as Record<string, unknown>)[key] = value;
        }
      }
      if (hasDisplayName) next.display_name = displayName;
      if (displayLabel !== undefined) next.display_label = displayLabel;
      merged.set(record.id, next);
    }
  }
  return merged;
}

const modelNameCollator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

function modelProvider(id: string, record?: HepAICatalogRecord): string {
  if (typeof record?.provider === "string" && record.provider.trim()) return record.provider.trim();
  const slash = id.indexOf("/");
  return slash > 0 ? id.slice(0, slash) : "Other";
}

export function sortHepAIModels(
  models: readonly ProviderModelConfig[],
  catalog: ReadonlyMap<string, HepAICatalogRecord>,
): ProviderModelConfig[] {
  return [...models].sort((left, right) => {
    const providerOrder = modelNameCollator.compare(
      modelProvider(left.id, catalog.get(left.id)),
      modelProvider(right.id, catalog.get(right.id)),
    );
    return providerOrder || modelNameCollator.compare(left.name, right.name)
      || modelNameCollator.compare(left.id, right.id)
      || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  });
}

function pageRows(payload: unknown): HepAICatalogRecord[] {
  const root = nestedRecord(payload);
  const data = root?.data;
  const container = nestedRecord(data);
  const rows = Array.isArray(data) ? data : container?.list ?? container?.items ?? container?.records ?? container?.results ?? container?.models;
  if (!Array.isArray(rows)) throw new Error("HepAI cloud model list returned no model array");
  return rows.filter((row): row is HepAICatalogRecord => !!row && typeof row === "object" && !Array.isArray(row));
}

export async function fetchHepAICloudModels(fetcher: typeof fetch = fetch): Promise<HepAICatalogRecord[]> {
  const url = new URL(HEPAI_CLOUD_MODELS_URL);
  url.searchParams.set("page", "1");
  url.searchParams.set("page_size", "-1");
  const response = await fetcher(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`HepAI cloud model list failed with HTTP ${response.status}`);

  const records: HepAICatalogRecord[] = [];
  const seen = new Set<string>();
  for (const row of pageRows(await response.json())) {
    const id = typeof row.model_name === "string" ? row.model_name : row.id;
    if (typeof id !== "string" || !id || seen.has(id)) continue;
    seen.add(id);
    records.push({ ...row, id });
  }
  return records;
}

export async function fetchHepAICatalog(
  modelIds: readonly string[],
  accessToken: string,
  fetcher: typeof fetch = fetch,
): Promise<HepAICatalogRecord[]> {
  const records: HepAICatalogRecord[] = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(DETAIL_CONCURRENCY, modelIds.length) }, async () => {
    while (cursor < modelIds.length) {
      const modelId = modelIds[cursor++];
      if (!modelId) continue;
      try {
        const record = await fetchModelDetail(modelId, accessToken, fetcher);
        if (record) records.push({ ...record, id: modelId });
      } catch {
        // Detail enrichment is optional; one unavailable model must not hide the
        // authoritative API-key-scoped model list or suppress other details.
      }
    }
  });
  await Promise.all(workers);
  return records;
}
