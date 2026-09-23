import { HEPAI_WEBSITE_ORIGIN } from "./endpoints.ts";
import type { HepAIInvokeRecord } from "./billing-types.ts";
import { cachedInvoice, cacheInvoices } from "./billing-cache.ts";

const BILLING_BASE_URL = `${HEPAI_WEBSITE_ORIGIN}/apiv2`;

export class PortalHttpError extends Error {
  constructor(readonly endpoint: string, readonly status: number) {
    super(`HepAI Portal ${endpoint} failed with HTTP ${status}`);
    this.name = "PortalHttpError";
  }
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function objectOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function itemsOf(payload: unknown, endpoint: string): Record<string, unknown>[] {
  if (!payload || typeof payload !== "object") throw new Error(`HepAI Portal ${endpoint} returned an invalid object`);
  const items = (payload as { items?: unknown }).items;
  if (!Array.isArray(items)) throw new Error(`HepAI Portal ${endpoint} returned no items array`);
  return items.filter((item): item is Record<string, unknown> => !!item && typeof item === "object");
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function portalJson(
  accessToken: string,
  endpoint: string,
  init: RequestInit,
  fetchImpl: Fetcher,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await fetchImpl(`${BILLING_BASE_URL}${endpoint}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Cookie: `token=${accessToken}`,
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
    signal,
    redirect: "error",
  });
  if (!response.ok) throw new PortalHttpError(endpoint, response.status);
  try {
    return await response.json();
  } catch {
    throw new Error(`HepAI Portal ${endpoint} returned invalid JSON`);
  }
}

/** Production currently validates billing dates as date-only strings with a maximum length of 10. */
export function portalDateTime(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export interface FindInvocationOptions {
  requestId: string;
  traceId?: string;
  requestedAt?: Date;
  signal?: AbortSignal;
  fetch?: Fetcher;
  pageSize?: number;
  maxPages?: number;
  cachePath?: string;
}

/**
 * Search the complete billing date window, accepting only an exact request-id match
 * and, when known, an exact trace-id match. Ordering and temporal proximity
 * are never used as identity.
 */
export async function findPortalInvocation(
  accessToken: string,
  options: FindInvocationOptions,
): Promise<HepAIInvokeRecord | undefined> {
  const requestedAt = options.requestedAt ?? new Date();
  const start = new Date(requestedAt.getTime() - 24 * 60 * 60 * 1_000);
  const end = new Date(requestedAt.getTime() + 24 * 60 * 60 * 1_000);
  const pageSize = options.pageSize ?? 100;
  const maxPages = options.maxPages ?? Number.POSITIVE_INFINITY;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new Error("Invalid HepAI billing page size");
  if (maxPages !== Number.POSITIVE_INFINITY && (!Number.isInteger(maxPages) || maxPages < 1)) {
    throw new Error("Invalid HepAI billing page limit");
  }
  if (options.cachePath) {
    const cached = await cachedInvoice(options.cachePath, options.requestId, options.traceId).catch(() => undefined);
    if (cached) return cached;
  }
  const seen: HepAIInvokeRecord[] = [];

  for (let page = 1; page <= maxPages; page++) {
    const payload = await portalJson(accessToken, "/portal/billing/invoke_records", {
      method: "POST",
      body: JSON.stringify({
        page,
        page_size: pageSize,
        start_date: portalDateTime(start),
        end_date: portalDateTime(end),
      }),
    }, options.fetch ?? fetch, options.signal);
    const items = itemsOf(payload, "invoke records") as HepAIInvokeRecord[];
    seen.push(...items);
    const exact = items.find(item => {
      const remarks = objectOf(item.remarks);
      if (stringField(remarks.request_id) !== options.requestId) return false;
      return !options.traceId || stringField(remarks.trace_id) === options.traceId;
    });
    if (exact) {
      if (options.cachePath) await cacheInvoices(options.cachePath, seen).catch(() => {});
      return exact;
    }
    const envelope = objectOf(payload);
    const total = finiteNumber(envelope.total);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    if (items.length < pageSize || page >= totalPages) {
      if (options.cachePath) await cacheInvoices(options.cachePath, seen).catch(() => {});
      return undefined;
    }
  }
  return undefined;
}
