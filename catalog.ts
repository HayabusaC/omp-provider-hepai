import type { ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";
import { HEPAI_CNY_TO_USD } from "./billing-types.ts";
import { HEPAI_CATALOG_URL } from "./endpoints.ts";

const PAGE_SIZE = 100;
const MAX_PAGES = 50;

export const REQUIRED_CONTEXT_FALLBACK = 128_000;
export const REQUIRED_OUTPUT_FALLBACK = 16_384;

export interface HepAICatalogRecord {
  id?: unknown;
  display_label?: unknown;
  context_window?: unknown;
  max_output_tokens?: unknown;
  is_reasoning?: unknown;
  input_modalities?: unknown;
  input_price_per_mtoken?: unknown;
  output_price_per_mtoken?: unknown;
  model_pricing?: unknown;
}

interface CatalogPage {
  data?: unknown;
  page?: unknown;
  total_pages?: unknown;
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

function rate(primary: unknown, fallback: unknown): number {
  return (nonNegativeNumber(primary) ?? nonNegativeNumber(fallback) ?? 0) * HEPAI_CNY_TO_USD;
}

export function catalogRecordToModelConfig(id: string, record?: HepAICatalogRecord): ProviderModelConfig {
  const details = record ? pricingDetails(record) : undefined;
  const modalities = Array.isArray(record?.input_modalities) ? record.input_modalities : [];
  const input: ("text" | "image")[] = ["text"];
  if (modalities.includes("image")) input.push("image");

  return {
    id,
    name: typeof record?.display_label === "string" && record.display_label.trim()
      ? record.display_label.trim()
      : id,
    api: "hepai-auto",
    reasoning: record?.is_reasoning === true || (
      !!record?.is_reasoning && typeof record.is_reasoning === "object"
    ),
    input,
    cost: {
      input: rate(record?.input_price_per_mtoken, details?.input_cost_per_million_tokens ?? details?.rates?.prompt),
      output: rate(record?.output_price_per_mtoken, details?.output_cost_per_million_tokens ?? details?.rates?.completion),
      cacheRead: rate(details?.cache_read_input_cost_per_million_tokens, details?.rates?.input_cache_read),
      cacheWrite: rate(details?.cache_creation_cost_per_million_tokens, details?.rates?.input_cache_write),
    },
    contextWindow: positiveInteger(record?.context_window) ?? REQUIRED_CONTEXT_FALLBACK,
    maxTokens: positiveInteger(record?.max_output_tokens) ?? REQUIRED_OUTPUT_FALLBACK,
  };
}

export function indexCatalog(records: readonly HepAICatalogRecord[]): Map<string, HepAICatalogRecord> {
  const indexed = new Map<string, HepAICatalogRecord>();
  for (const record of records) {
    if (typeof record.id === "string" && record.id.length > 0) indexed.set(record.id, record);
  }
  return indexed;
}

export async function fetchHepAICatalog(fetcher: typeof fetch = fetch): Promise<HepAICatalogRecord[]> {
  const records: HepAICatalogRecord[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = new URL(HEPAI_CATALOG_URL);
    url.searchParams.set("page", String(page));
    url.searchParams.set("page_size", String(PAGE_SIZE));
    const response = await fetcher(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    });
    if (!response.ok) throw new Error(`HepAI catalog discovery failed with HTTP ${response.status}`);
    const payload = await response.json() as CatalogPage;
    if (!Array.isArray(payload.data)) throw new Error("HepAI catalog returned no data array");
    records.push(...payload.data.filter(
      (item): item is HepAICatalogRecord => !!item && typeof item === "object",
    ));
    const totalPages = positiveInteger(payload.total_pages);
    if ((totalPages !== undefined && page >= totalPages) || payload.data.length < PAGE_SIZE) return records;
  }
  throw new Error(`HepAI catalog exceeded the ${MAX_PAGES}-page safety limit`);
}
