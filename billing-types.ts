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
  is_billing_failed?: boolean;
  total_discount_rate?: number;
  cost_breakdown?: Record<string, HepAICostComponent | unknown>;
  billing_basis?: {
    usage?: Record<string, unknown>;
    total_discount_rate?: number;
    cost_breakdown?: Record<string, HepAICostComponent | unknown>;
    [key: string]: unknown;
  };
  standard_invoke_record?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
    reasoning_tokens?: number;
    [key: string]: unknown;
  };
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
  total_discount_rate?: number;
  cost_breakdown: Record<string, HepAICostComponent | unknown>;
  standard_invoke_record?: HepAIInvokeRecord["standard_invoke_record"];
  original_price: number;
  discount_amount: number;
  payable_amount: number;
}

type SettledUsage = Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite" | "totalTokens" | "reasoningTokens">;

export interface OmpBillingUsage {
  usage: SettledUsage;
  cost: Usage["cost"];
}

function finite(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`HepAI billing record has no finite ${field}`);
  }
  return value;
}

function optionalTokenCount(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  }
  return undefined;
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
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

function componentAmount(breakdown: Record<string, HepAICostComponent | unknown>, names: string[]): number {
  let total = 0;
  for (const name of names) {
    const item = breakdown[name];
    if (item && typeof item === "object" && "amount" in item) {
      const value = (item as HepAICostComponent).amount;
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) total += value;
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

/** Map the normalized, USD-denominated sidecar billing object to OMP Usage. */
export function usageCostFromBilling(
  billing: HepAIBillingMetadata,
  estimatedCost?: Usage["cost"],
): OmpBillingUsage {
  const standard = billing.standard_invoke_record;
  const breakdown = billing.cost_breakdown;
  const input = optionalTokenCount(standard?.input_tokens,
    componentAmount(breakdown, ["prompt", "input"])) ?? 0;
  const completion = optionalTokenCount(standard?.output_tokens,
    componentAmount(breakdown, ["completion", "output"])) ?? 0;
  const reasoningTokens = optionalTokenCount(standard?.reasoning_tokens,
    componentAmount(breakdown, ["internal_reasoning"])) ?? 0;
  const cacheRead = optionalTokenCount(standard?.cache_read_tokens,
    componentAmount(breakdown, ["input_cache_read", "cache_read", "cacheRead"])) ?? 0;
  const cacheWrite = optionalTokenCount(standard?.cache_write_tokens,
    componentAmount(breakdown, ["input_cache_write", "cache_write", "cacheWrite"])) ?? 0;
  const output = completion + reasoningTokens;
  const discountRate = billing.total_discount_rate ?? 1;
  const hasBreakdown = Object.keys(breakdown).length > 0;
  const discounted = (usd: number) => usd * discountRate;
  return {
    usage: { input, output, cacheRead, cacheWrite, reasoningTokens,
      totalTokens: input + output + cacheRead + cacheWrite },
    cost: {
      input: hasBreakdown ? discounted(componentCost(breakdown, ["prompt", "input"])) : estimatedCost?.input ?? 0,
      output: hasBreakdown ? discounted(componentCost(breakdown, ["completion", "output", "internal_reasoning"])) : estimatedCost?.output ?? 0,
      cacheRead: hasBreakdown ? discounted(componentCost(breakdown, ["input_cache_read", "cache_read", "cacheRead"])) : estimatedCost?.cacheRead ?? 0,
      cacheWrite: hasBreakdown ? discounted(componentCost(breakdown, ["input_cache_write", "cache_write", "cacheWrite"])) : estimatedCost?.cacheWrite ?? 0,
      total: billing.payable_amount,
    },
  };
}

/** Apply HepAI's authoritative token and monetary breakdown to OMP's native Usage. */
export function settledUsageCost(record: HepAIInvokeRecord, estimatedCost?: Usage["cost"]): {
  usage: Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite" | "totalTokens" | "reasoningTokens">;
  cost: Usage["cost"];
  billing: HepAIBillingMetadata;
} {
  const payable = finite(record.payable_amount, "payable_amount");
  const original = typeof record.original_price === "number" && Number.isFinite(record.original_price)
    ? record.original_price : payable + (typeof record.discount_amount === "number" ? record.discount_amount : 0);
  const discount = typeof record.discount_amount === "number" && Number.isFinite(record.discount_amount)
    ? record.discount_amount : Math.max(0, original - payable);
  const standard = record.standard_invoke_record;
  const basis = recordOf(record.billing_basis);
  const usage = recordOf(basis.usage);
  const usageStd = recordOf(usage.std_amounts);
  const standardStd = recordOf(standard?.std_amounts);
  const liveBreakdown = record.billing_basis?.cost_breakdown;
  const breakdown = liveBreakdown && typeof liveBreakdown === "object" && !Array.isArray(liveBreakdown)
    ? liveBreakdown : record.cost_breakdown;
  if (standard || Object.keys(basis).length > 0) {
    const input = optionalTokenCount(standard?.input_tokens, standardStd.prompt, usageStd.prompt,
      componentAmount(recordOf(breakdown), ["prompt", "input"])) ?? 0;
    const completion = optionalTokenCount(standard?.output_tokens, usage.output_tokens, standardStd.completion,
      usageStd.completion, componentAmount(recordOf(breakdown), ["completion", "output"])) ?? 0;
    const cacheRead = optionalTokenCount(standard?.cache_read_tokens, standardStd.input_cache_read,
      usageStd.input_cache_read, usage.cache_read_input_tokens,
      componentAmount(recordOf(breakdown), ["input_cache_read", "cache_read", "cacheRead"])) ?? 0;
    const cacheWrite = optionalTokenCount(standard?.cache_write_tokens, standardStd.input_cache_write,
      usageStd.input_cache_write, usage.cache_creation_input_tokens,
      componentAmount(recordOf(breakdown), ["input_cache_write", "cache_write", "cacheWrite"])) ?? 0;
    const outputDetails = recordOf(usage.output_tokens_details);
    const reasoningTokens = optionalTokenCount(standard?.reasoning_tokens, outputDetails.reasoning_tokens,
      outputDetails.thinking_tokens, standardStd.internal_reasoning, usageStd.internal_reasoning,
      componentAmount(recordOf(breakdown), ["internal_reasoning"])) ?? 0;
    const output = completion + reasoningTokens;
    const discountRate = typeof record.billing_basis?.total_discount_rate === "number"
      && Number.isFinite(record.billing_basis.total_discount_rate)
      ? record.billing_basis.total_discount_rate
      : typeof record.total_discount_rate === "number" && Number.isFinite(record.total_discount_rate)
        ? record.total_discount_rate : undefined;
    const billingBreakdown = breakdown && typeof breakdown === "object" && !Array.isArray(breakdown)
      ? convertedBreakdown(breakdown) : {};
    const discountedUsd = (cny: number) => cny * (discountRate ?? 1) * HEPAI_CNY_TO_USD;
    const hasBreakdown = Object.keys(billingBreakdown).length > 0;
    return {
      usage: { input, output, cacheRead, cacheWrite, reasoningTokens, totalTokens: input + output + cacheRead + cacheWrite },
      cost: {
        input: hasBreakdown ? discountedUsd(componentCost(breakdown!, ["prompt", "input"])) : estimatedCost?.input ?? 0,
        output: hasBreakdown ? discountedUsd(componentCost(breakdown!, ["completion", "output", "internal_reasoning"])) : estimatedCost?.output ?? 0,
        cacheRead: hasBreakdown ? discountedUsd(componentCost(breakdown!, ["input_cache_read", "cache_read", "cacheRead"])) : estimatedCost?.cacheRead ?? 0,
        cacheWrite: hasBreakdown ? discountedUsd(componentCost(breakdown!, ["input_cache_write", "cache_write", "cacheWrite"])) : estimatedCost?.cacheWrite ?? 0,
        total: payable * HEPAI_CNY_TO_USD,
      },
      billing: {
        currency: "USD", sourceCurrency: "CNY", exchangeRate: HEPAI_CNY_TO_USD,
        ...(discountRate !== undefined ? { total_discount_rate: discountRate } : {}),
        cost_breakdown: billingBreakdown,
        standard_invoke_record: { input_tokens: input, output_tokens: completion, cache_read_tokens: cacheRead,
          cache_write_tokens: cacheWrite, reasoning_tokens: reasoningTokens },
        original_price: original * HEPAI_CNY_TO_USD,
        discount_amount: discount * HEPAI_CNY_TO_USD,
        payable_amount: payable * HEPAI_CNY_TO_USD,
      },
    };
  }
  if (!breakdown || typeof breakdown !== "object" || Array.isArray(breakdown)) {
    throw new Error("HepAI billing record has neither cost_breakdown nor standard_invoke_record");
  }
  const discountRate = finite(record.total_discount_rate, "total_discount_rate");

  // Observed HepAI records store pre-discount component costs. Missing token
  // and cost components are zero. HepAI bills internal reasoning separately,
  // while OMP's output bucket represents all generated tokens and their cost.
  const billingBreakdown = convertedBreakdown(breakdown);
  const discountedUsd = (cny: number) => cny * discountRate * HEPAI_CNY_TO_USD;
  const input = componentAmount(breakdown, ["prompt", "input"]);
  const generatedOutput = componentAmount(breakdown, ["completion", "output"]);
  const reasoningTokens = componentAmount(breakdown, ["internal_reasoning"]);
  const output = generatedOutput + reasoningTokens;
  const cacheRead = componentAmount(breakdown, ["input_cache_read", "cache_read", "cacheRead"]);
  const cacheWrite = componentAmount(breakdown, ["input_cache_write", "cache_write", "cacheWrite"]);
  return {
    usage: {
      input,
      output,
      cacheRead,
      cacheWrite,
      reasoningTokens,
      totalTokens: input + output + cacheRead + cacheWrite,
    },
    cost: {
      input: discountedUsd(componentCost(breakdown, ["prompt", "input"])),
      output: discountedUsd(componentCost(breakdown, ["completion", "output", "internal_reasoning"])),
      cacheRead: discountedUsd(componentCost(breakdown, ["input_cache_read", "cache_read", "cacheRead"])),
      cacheWrite: discountedUsd(componentCost(breakdown, ["input_cache_write", "cache_write", "cacheWrite"])),
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
