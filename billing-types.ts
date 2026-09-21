import type { Usage } from "@oh-my-pi/pi-ai";

export const HEPAI_CNY_TO_USD = 0.143;

export interface HepAICostComponent {
  amount?: number;
  cost?: number;
  [key: string]: unknown;
}

export interface HepAIInvokeRecord {
  invoke_id?: string | number;
  request_time?: string;
  total_discount_rate?: number;
  cost_breakdown?: Record<string, HepAICostComponent | unknown>;
  original_price?: number;
  discount_amount?: number;
  payable_amount?: number;
  remarks?: {
    request_id?: string;
    trace_id?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface HepAIBillingMetadata {
  currency: "USD";
  sourceCurrency: "CNY";
  exchangeRate: typeof HEPAI_CNY_TO_USD;
  total_discount_rate: number;
  cost_breakdown: Record<string, HepAICostComponent | unknown>;
  original_price: number;
  discount_amount: number;
  payable_amount: number;
}

function finite(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`HepAI billing record has no finite ${field}`);
  }
  return value;
}

function componentCost(breakdown: Record<string, HepAICostComponent | unknown>, names: string[]): number {
  let total = 0;
  for (const name of names) {
    const item = breakdown[name];
    if (item && typeof item === "object" && "cost" in item) {
      const value = (item as HepAICostComponent).cost;
      if (typeof value === "number" && Number.isFinite(value)) total += value;
    }
  }
  return total;
}

function convertedBreakdown(
  breakdown: Record<string, HepAICostComponent | unknown>,
): Record<string, HepAICostComponent | unknown> {
  return Object.fromEntries(Object.entries(breakdown).map(([name, value]) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [name, value];
    const component = value as HepAICostComponent;
    return [name, {
      ...component,
      ...(typeof component.cost === "number" && Number.isFinite(component.cost)
        ? { cost: component.cost * HEPAI_CNY_TO_USD }
        : {}),
    }];
  }));
}

/** Apply HepAI's invoice to only the monetary portion of OMP's native Usage. */
export function settledUsageCost(record: HepAIInvokeRecord): {
  cost: Usage["cost"];
  billing: HepAIBillingMetadata;
} {
  const payable = finite(record.payable_amount, "payable_amount");
  const original = finite(record.original_price, "original_price");
  const discount = finite(record.discount_amount, "discount_amount");
  const discountRate = finite(record.total_discount_rate, "total_discount_rate");
  const breakdown = record.cost_breakdown;
  if (!breakdown || typeof breakdown !== "object" || Array.isArray(breakdown)) {
    throw new Error("HepAI billing record has no cost_breakdown object");
  }

  // Observed HepAI records store pre-discount component costs. Scale mapped
  // components by the authoritative total_discount_rate. Unmapped items
  // (notably internal_reasoning) remain represented by total only.
  const billingBreakdown = convertedBreakdown(breakdown);
  const discountedUsd = (cny: number) => cny * discountRate * HEPAI_CNY_TO_USD;
  return {
    cost: {
      input: discountedUsd(componentCost(breakdown, ["prompt", "input"])),
      output: discountedUsd(componentCost(breakdown, ["completion", "output"])),
      cacheRead: discountedUsd(componentCost(breakdown, ["input_cache_read", "cache_read"])),
      cacheWrite: discountedUsd(componentCost(breakdown, ["input_cache_write", "cache_write"])),
      total: payable * HEPAI_CNY_TO_USD,
    },
    billing: {
      currency: "USD",
      sourceCurrency: "CNY",
      exchangeRate: HEPAI_CNY_TO_USD,
      total_discount_rate: discountRate,
      cost_breakdown: billingBreakdown,
      original_price: original * HEPAI_CNY_TO_USD,
      discount_amount: discount * HEPAI_CNY_TO_USD,
      payable_amount: payable * HEPAI_CNY_TO_USD,
    },
  };
}
