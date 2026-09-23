import type { ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";
import { HEPAI_CNY_TO_USD } from "./billing-types.ts";
import { HEPAI_MODEL_DETAILS_URL } from "./endpoints.ts";

const DETAIL_CONCURRENCY = 8;

export const REQUIRED_CONTEXT_FALLBACK = 128_000;
export const REQUIRED_OUTPUT_FALLBACK = 16_384;

export interface HepAICatalogRecord {
  id?: unknown;
  model_name?: unknown;
  display_label?: unknown;
  context_window?: unknown;
  max_output_tokens?: unknown;
  is_reasoning?: unknown;
  input_modalities?: unknown;
  input_price_per_mtoken?: unknown;
  output_price_per_mtoken?: unknown;
  model_pricing?: unknown;
  limitations?: unknown;
  capabilities?: unknown;
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
  const details = (record.model_pricing as { pricing_details?: unknown }).pricing_details;
  return details && typeof details === "object" ? details as PricingDetails : undefined;
}

function nestedRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function rate(primary: unknown, fallback: unknown): number {
  return (nonNegativeNumber(primary) ?? nonNegativeNumber(fallback) ?? 0) * HEPAI_CNY_TO_USD;
}

export function catalogRecordToModelConfig(id: string, record?: HepAICatalogRecord): ProviderModelConfig {
  const details = record ? pricingDetails(record) : undefined;
  const limitations = nestedRecord(record?.limitations);
  const capabilities = nestedRecord(record?.capabilities);
  const modalities = Array.isArray(record?.input_modalities) ? record.input_modalities : [];
  const input: ("text" | "image")[] = ["text"];
  if (modalities.includes("image")) input.push("image");

  return {
    id,
    name: typeof record?.display_label === "string" && record.display_label.trim()
      ? record.display_label.trim()
      : id,
    api: "hepai-auto",
    reasoning: record?.is_reasoning === true || capabilities?.reasoning === true || (
      !!record?.is_reasoning && typeof record.is_reasoning === "object"
    ),
    input,
    cost: {
      input: rate(record?.input_price_per_mtoken, details?.input_cost_per_million_tokens ?? details?.rates?.prompt),
      output: rate(record?.output_price_per_mtoken, details?.output_cost_per_million_tokens ?? details?.rates?.completion),
      cacheRead: rate(details?.cache_read_input_cost_per_million_tokens, details?.rates?.input_cache_read),
      cacheWrite: rate(details?.cache_creation_cost_per_million_tokens, details?.rates?.input_cache_write),
    },
    contextWindow: positiveInteger(record?.context_window ?? limitations?.context_window) ?? REQUIRED_CONTEXT_FALLBACK,
    maxTokens: positiveInteger(record?.max_output_tokens ?? limitations?.max_output_tokens) ?? REQUIRED_OUTPUT_FALLBACK,
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
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
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
        || candidates.length === 1
      ),
  );
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
