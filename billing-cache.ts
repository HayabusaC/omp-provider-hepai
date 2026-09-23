import { dirname, join } from "node:path";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import type { HepAICostComponent, HepAIInvokeRecord } from "./billing-types.ts";

const CACHE_DAYS = 30;
const writeTails = new Map<string, Promise<void>>();

interface CacheEntry {
  cachedAt: string;
  invoice: HepAIInvokeRecord;
}

interface BillingCache {
  version: 1;
  records: Record<string, CacheEntry>;
}

export function billingCachePath(): string {
  return join(getAgentDir(), "cache", "hepai-invoices.json");
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numericFields(value: unknown, names: readonly string[]): Record<string, number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result: Record<string, number> = {};
  for (const name of names) {
    const number = finite((value as Record<string, unknown>)[name]);
    if (number !== undefined) result[name] = number;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** Keep only fields needed for exact matching and settlement, never raw remarks. */
export function invoiceSnapshot(record: HepAIInvokeRecord): HepAIInvokeRecord | undefined {
  const requestId = string(record.remarks?.request_id);
  if (!requestId || record.is_billing_failed === true) return undefined;
  const traceId = string(record.remarks?.trace_id);
  const standard = record.standard_invoke_record;
  const standardAmounts = numericFields(standard?.std_amounts, [
    "prompt", "completion", "input_cache_read", "input_cache_write", "internal_reasoning",
  ]);
  const basisUsage = record.billing_basis?.usage;
  const usageAmounts = numericFields(basisUsage?.std_amounts, [
    "prompt", "completion", "input_cache_read", "input_cache_write", "internal_reasoning",
  ]);
  const outputDetails = numericFields(basisUsage?.output_tokens_details, ["reasoning_tokens", "thinking_tokens"]);
  const safeUsage = {
    ...numericFields(basisUsage, ["output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]),
    ...(usageAmounts ? { std_amounts: usageAmounts } : {}),
    ...(outputDetails ? { output_tokens_details: outputDetails } : {}),
  };
  const breakdown = record.billing_basis?.cost_breakdown ?? record.cost_breakdown;
  if (finite(record.payable_amount) === undefined || (!standard && !breakdown)) return undefined;
  const safeBreakdown = breakdown && typeof breakdown === "object" && !Array.isArray(breakdown)
    ? Object.fromEntries(Object.entries(breakdown).map(([name, value]) => {
      const component = value && typeof value === "object" ? value as HepAICostComponent : {};
      return [name, {
        ...(finite(component.amount) !== undefined ? { amount: component.amount } : {}),
        ...(finite(component.cost) !== undefined ? { cost: component.cost } : {}),
      }];
    }))
    : undefined;
  return {
    ...(typeof record.invoke_id === "string" || typeof record.invoke_id === "number" ? { invoke_id: record.invoke_id } : {}),
    ...(string(record.request_time) ? { request_time: record.request_time } : {}),
    ...(finite(record.original_price) !== undefined ? { original_price: record.original_price } : {}),
    ...(finite(record.discount_amount) !== undefined ? { discount_amount: record.discount_amount } : {}),
    ...(finite(record.payable_amount) !== undefined ? { payable_amount: record.payable_amount } : {}),
    ...(finite(record.billing_basis?.total_discount_rate) !== undefined || safeBreakdown || Object.keys(safeUsage).length > 0
      ? { billing_basis: {
      ...(finite(record.billing_basis?.total_discount_rate) !== undefined
        ? { total_discount_rate: record.billing_basis?.total_discount_rate } : {}),
      ...(Object.keys(safeUsage).length > 0 ? { usage: safeUsage } : {}),
      ...(safeBreakdown ? { cost_breakdown: safeBreakdown } : {}),
    } } : {}),
    ...(finite(record.total_discount_rate) !== undefined ? { total_discount_rate: record.total_discount_rate } : {}),
    ...(!record.billing_basis && safeBreakdown ? { cost_breakdown: safeBreakdown } : {}),
    ...(standard && typeof standard === "object" ? { standard_invoke_record: {
      input_tokens: finite(standard.input_tokens),
      output_tokens: finite(standard.output_tokens),
      cache_read_tokens: finite(standard.cache_read_tokens),
      cache_write_tokens: finite(standard.cache_write_tokens),
      reasoning_tokens: finite(standard.reasoning_tokens),
      ...(standardAmounts ? { std_amounts: standardAmounts } : {}),
    } } : {}),
    remarks: {
      request_id: requestId,
      ...(traceId ? { trace_id: traceId } : {}),
    },
  };
}

async function readCache(path: string): Promise<BillingCache> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, records: {} };
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<BillingCache>;
    if (parsed.version !== 1 || !parsed.records || typeof parsed.records !== "object" || Array.isArray(parsed.records)) {
      return { version: 1, records: {} };
    }
    return parsed as BillingCache;
  } catch {
    return { version: 1, records: {} };
  }
}

export async function cachedInvoice(path: string, requestId: string, traceId?: string): Promise<HepAIInvokeRecord | undefined> {
  const entry = (await readCache(path)).records[requestId];
  if (!entry || !Number.isFinite(Date.parse(entry.cachedAt))
    || Date.now() - Date.parse(entry.cachedAt) > CACHE_DAYS * 86_400_000) return undefined;
  const invoice = entry.invoice;
  if (invoice.remarks?.request_id !== requestId || (traceId && invoice.remarks?.trace_id !== traceId)) return undefined;
  return invoice;
}

export async function cacheInvoices(path: string, invoices: readonly HepAIInvokeRecord[]): Promise<void> {
  const snapshots = invoices.map(invoiceSnapshot).filter((item): item is HepAIInvokeRecord => !!item);
  if (snapshots.length === 0) return;
  const previous = writeTails.get(path) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const cache = await readCache(path);
    const now = Date.now();
    for (const [id, entry] of Object.entries(cache.records)) {
      if (!Number.isFinite(Date.parse(entry.cachedAt))
        || now - Date.parse(entry.cachedAt) > CACHE_DAYS * 86_400_000) delete cache.records[id];
    }
    for (const invoice of snapshots) {
      cache.records[invoice.remarks!.request_id!] = { cachedAt: new Date(now).toISOString(), invoice };
    }
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(cache)}\n`, { encoding: "utf8", flag: "wx" });
    try {
      await rename(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") {
        await unlink(temporary).catch(() => {});
        throw error;
      }
      await unlink(path).catch((unlinkError: NodeJS.ErrnoException) => {
        if (unlinkError.code !== "ENOENT") throw unlinkError;
      });
      await rename(temporary, path);
    }
  });
  writeTails.set(path, next);
  try { await next; } finally { if (writeTails.get(path) === next) writeTails.delete(path); }
}
