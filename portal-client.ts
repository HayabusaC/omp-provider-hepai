import { PORTAL_BASE_URL } from "./portal-auth.ts";
import { HEPAI_CNY_TO_USD, type HepAIInvokeRecord } from "./billing-types.ts";

export interface PortalFundsSummary {
  count: number;
  creditPaid: number;
  creditContributed: number;
  creditUsed: number;
}

export interface PortalInvocationSummary {
  count: number;
  promptTokens: number;
  completionTokens: number;
  cost: number;
}

export interface PortalBillingSummary {
  funds: PortalFundsSummary;
  invocations: PortalInvocationSummary;
  period: { start: string; end: string };
}

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

function firstFiniteNumber(...values: unknown[]): number {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
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
  const response = await fetchImpl(`${PORTAL_BASE_URL}${endpoint}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
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

export async function fetchPortalBillingSummary(
  accessToken: string,
  options: { days?: number; now?: Date; signal?: AbortSignal; fetch?: Fetcher } = {},
): Promise<PortalBillingSummary> {
  const days = options.days ?? 30;
  if (!Number.isInteger(days) || days < 1 || days > 366) throw new Error("HepAI billing range must be between 1 and 366 days");
  const endDate = options.now ?? new Date();
  const startDate = new Date(endDate.getTime() - days * 24 * 60 * 60 * 1_000);
  const period = { start: portalDateTime(startDate), end: portalDateTime(endDate) };
  const fetchImpl = options.fetch ?? fetch;

  const [fundsPayload, invocationsPayload] = await Promise.all([
    portalJson(accessToken, "/portal/billing/mine/all_funds", { method: "GET" }, fetchImpl, options.signal),
    portalJson(accessToken, "/portal/billing/invoke_records", {
      method: "POST",
      // Match the production portal frontend. The older documentation used
      // start_time/end_time, which production accepts but does not apply.
      body: JSON.stringify({ page: 1, page_size: 20, start_date: period.start, end_date: period.end }),
    }, fetchImpl, options.signal),
  ]);

  const funds = itemsOf(fundsPayload, "fund summary");
  const invocations = itemsOf(invocationsPayload, "invoke records");
  const standardInvocations = invocations.map(item => ({
    item,
    standard: objectOf(item.standard_invoke_record),
  }));
  return {
    period,
    funds: {
      count: funds.length,
      creditPaid: funds.reduce((sum, item) => sum + finiteNumber(item.credit_paid), 0) * HEPAI_CNY_TO_USD,
      creditContributed: funds.reduce((sum, item) => sum + finiteNumber(item.credit_contributed), 0) * HEPAI_CNY_TO_USD,
      creditUsed: funds.reduce((sum, item) => sum + finiteNumber(item.credit_used), 0) * HEPAI_CNY_TO_USD,
    },
    invocations: {
      count: invocations.length,
      // Production nests canonical token usage under standard_invoke_record.
      // Retain the documented flat names as a compatibility fallback.
      promptTokens: standardInvocations.reduce(
        (sum, { item, standard }) => sum + firstFiniteNumber(standard.input_tokens, item.prompt_tokens),
        0,
      ),
      completionTokens: standardInvocations.reduce(
        (sum, { item, standard }) => sum + firstFiniteNumber(standard.output_tokens, item.completion_tokens),
        0,
      ),
      // payable_amount is the post-discount amount actually billed. total_cost
      // remains a last-resort fallback when neither production nor legacy fields exist.
      cost: standardInvocations.reduce(
        (sum, { item, standard }) => sum + firstFiniteNumber(item.payable_amount, item.cost, standard.total_cost),
        0,
      ) * HEPAI_CNY_TO_USD,
    },
  };
}

/** Validate a Portal access token without loading invocation history. */
export async function verifyPortalAccessToken(
  accessToken: string,
  options: { signal?: AbortSignal; fetch?: Fetcher } = {},
): Promise<void> {
  const payload = await portalJson(
    accessToken,
    "/portal/billing/mine/all_funds",
    { method: "GET" },
    options.fetch ?? fetch,
    options.signal,
  );
  itemsOf(payload, "fund summary");
}

export interface FindInvocationOptions {
  requestId: string;
  traceId?: string;
  requestedAt?: Date;
  signal?: AbortSignal;
  fetch?: Fetcher;
  pageSize?: number;
  maxPages?: number;
}

/**
 * Search a bounded billing window, accepting only an exact request-id match
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
  const maxPages = options.maxPages ?? 20;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new Error("Invalid HepAI billing page size");

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
    const exact = items.find(item => {
      const remarks = objectOf(item.remarks);
      if (stringField(remarks.request_id) !== options.requestId) return false;
      return !options.traceId || stringField(remarks.trace_id) === options.traceId;
    });
    if (exact) return exact;
    const envelope = objectOf(payload);
    const total = finiteNumber(envelope.total);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    if (items.length < pageSize || page >= totalPages) return undefined;
  }
  return undefined;
}
