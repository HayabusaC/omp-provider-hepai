import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "@oh-my-pi/pi-coding-agent";
import { settledUsageCost } from "../billing-types.ts";
import { HepAIBillingSettler, responseLink, rewriteAssistantCost, rewriteAssistantUsage } from "../billing-settlement.ts";
import { billingSidecarPath, readBillingSidecar } from "../billing-sidecar.ts";

describe("HepAI authoritative billing settlement", () => {
  test("uses payable_amount for total and folds internal reasoning into output", () => {
    const record = {
      invoke_id: 13818596,
      total_discount_rate: 0.3,
      cost_breakdown: {
        prompt: { amount: 34, cost: 0.000068 },
        completion: { amount: 32, cost: 0.000256 },
        internal_reasoning: { amount: 32, cost: 0.000256 },
      },
      original_price: 0.00058,
      discount_amount: 0.000406,
      payable_amount: 0.000174,
      remarks: { request_id: "req-1", trace_id: "trace-1" },
    };
    const result = settledUsageCost(record);

    expect(result.usage).toEqual({
      input: 34,
      output: 64,
      cacheRead: 0,
      cacheWrite: 0,
      reasoningTokens: 32,
      totalTokens: 98,
    });
    expect(result.cost.total).toBeCloseTo(0.000174 * 0.143, 14);
    expect(result.cost.input).toBeCloseTo(0.000068 * 0.3 * 0.143, 14);
    expect(result.cost.output).toBeCloseTo((0.000256 + 0.000256) * 0.3 * 0.143, 14);
    expect(result.cost.input + result.cost.output).toBeCloseTo(result.cost.total, 14);
    expect(result.billing).toMatchObject({ currency: "USD", sourceCurrency: "CNY", exchangeRate: 0.143 });
    expect(result.billing.original_price).toBeCloseTo(0.00058 * 0.143, 14);
    expect(result.billing.discount_amount).toBeCloseTo(0.000406 * 0.143, 14);
    expect(result.billing.payable_amount).toBeCloseTo(0.000174 * 0.143, 14);
    expect(result.billing.cost_breakdown.internal_reasoning).toMatchObject({ amount: 32 });
    expect((result.billing.cost_breakdown.internal_reasoning as { cost: number }).cost)
      .toBeCloseTo(0.000256 * 0.143, 14);
    expect((result.billing.cost_breakdown.prompt as { cost: number }).cost)
      .toBeCloseTo(0.000068 * 0.143, 14);
  });

  test("treats missing usage and billing components as zero", () => {
    const result = settledUsageCost({
      total_discount_rate: 1,
      cost_breakdown: { internal_reasoning: { amount: 9, cost: 2 } },
      original_price: 2,
      discount_amount: 0,
      payable_amount: 2,
    });

    expect(result.usage).toEqual({
      input: 0,
      output: 9,
      cacheRead: 0,
      cacheWrite: 0,
      reasoningTokens: 9,
      totalTokens: 9,
    });
    expect(result.cost).toEqual({
      input: 0,
      output: 2 * 0.143,
      cacheRead: 0,
      cacheWrite: 0,
      total: 2 * 0.143,
    });
  });

  test("captures only successful response request and trace ids", () => {
    expect(responseLink({ status: 200, requestId: "req-1", headers: { "X-Trace-ID": "trace-1" } }))
      .toMatchObject({ requestId: "req-1", traceId: "trace-1" });
    expect(responseLink({ status: 500, requestId: "req-2", headers: {} })).toBeUndefined();
  });

  test("rewrites only cost for the exact response id and is idempotent", async () => {
    const message = {
      role: "assistant",
      provider: "hepai",
      responseId: "resp-1",
      usage: {
        input: 11,
        output: 7,
        cacheRead: 3,
        cacheWrite: 2,
        totalTokens: 23,
        reasoningTokens: 4,
        cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
      },
    };
    let rewrites = 0;
    const manager = {
      getEntries: () => [{ type: "message", id: "entry-1", message }],
      rewriteEntries: async () => { rewrites++; },
    };
    const cost = { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1.2 };

    expect(await rewriteAssistantCost(manager as never, "resp-1", cost)).toEqual({ entryId: "entry-1", changed: true });
    expect(message.usage).toMatchObject({
      input: 11, output: 7, cacheRead: 3, cacheWrite: 2, totalTokens: 23, reasoningTokens: 4, cost,
    });
    expect(await rewriteAssistantCost(manager as never, "resp-1", cost)).toEqual({ entryId: "entry-1", changed: false });
    expect(rewrites).toBe(1);
  });

  test("atomically rewrites settled tokens and cost in the live message and JSONL", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hepai-session-"));
    const manager = SessionManager.create(dir, dir);
    try {
      const message = {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "OK" }],
        api: "openai-responses" as const,
        provider: "hepai",
        model: "deepseek/deepseek-r1",
        responseId: "resp-live",
        usage: {
          input: 10, output: 8, cacheRead: 2, cacheWrite: 1, totalTokens: 21, reasoningTokens: 5,
          cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
        },
        stopReason: "stop" as const,
        timestamp: Date.now(),
      };
      manager.appendMessage(message);
      await manager.rewriteEntries();
      const usage = {
        input: 12, output: 13, cacheRead: 0, cacheWrite: 3, totalTokens: 28, reasoningTokens: 5,
      };
      const cost = { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.04, total: 0.12 };
      await rewriteAssistantUsage(manager, "resp-live", usage, cost);

      expect(message.usage).toEqual({ ...usage, cost });
      const lines = (await readFile(manager.getSessionFile()!, "utf8")).trim().split("\n");
      const persisted = lines.map(line => JSON.parse(line)).find(entry => entry.type === "message");
      expect(persisted.message.usage).toEqual({ ...usage, cost });
      expect(persisted.message.usage.reasoningTokens).toBe(5);
    } finally {
      await manager.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("settles once by request/trace and persists the invoke id", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hepai-worker-"));
    const manager = SessionManager.create(dir, dir);
    const callbacks: Array<() => void | Promise<void>> = [];
    let lookups = 0;
    let syncs = 0;
    try {
      manager.appendMessage({
        role: "assistant", content: [], api: "openai-responses", provider: "hepai", model: "deepseek/test",
        responseId: "resp-worker", usage: {
          input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20,
          cost: { input: 9, output: 9, cacheRead: 0, cacheWrite: 0, total: 18 },
        }, stopReason: "stop", timestamp: Date.now(),
      });
      await manager.rewriteEntries();
      const settler = new HepAIBillingSettler({
        sessionManager: manager,
        getPortalToken: async () => "jwt",
        schedule: callback => callbacks.push(callback),
        syncStats: async () => { syncs++; },
        findInvocation: async (_token, options) => {
          lookups++;
          expect(options).toMatchObject({ requestId: "req-worker", traceId: "trace-worker" });
          return {
            invoke_id: 42,
            total_discount_rate: 0.5,
            cost_breakdown: {
              prompt: { amount: 10, cost: 1 },
              completion: { amount: 6, cost: 1 },
              internal_reasoning: { amount: 4, cost: 1 },
            },
            original_price: 3,
            discount_amount: 1.5,
            payable_amount: 1.5,
            remarks: { request_id: "req-worker", trace_id: "trace-worker" },
          };
        },
      });
      await settler.register("resp-worker", {
        requestId: "req-worker", traceId: "trace-worker", requestedAt: "2026-09-21T00:00:00.000Z",
      });
      await callbacks.shift()?.();

      const stored = await readBillingSidecar(billingSidecarPath(manager.getSessionFile()!));
      expect(stored.records["req-worker"]).toMatchObject({
        responseId: "resp-worker", traceId: "trace-worker", invokeId: "42", status: "settled", attempts: 1,
      });
      expect(stored.records["req-worker"]?.billing?.payable_amount).toBeCloseTo(1.5 * 0.143, 12);
      expect(stored.records["req-worker"]?.billing?.original_price).toBeCloseTo(3 * 0.143, 12);
      expect((stored.records["req-worker"]?.billing?.cost_breakdown.internal_reasoning as { cost: number }).cost)
        .toBeCloseTo(1 * 0.143, 12);
      const settledEntry = manager.getEntries()[0];
      if (settledEntry?.type !== "message" || settledEntry.message.role !== "assistant") {
        throw new Error("expected settled assistant entry");
      }
      expect(settledEntry.message.usage).toMatchObject({
        input: 10, output: 10, cacheRead: 0, cacheWrite: 0, reasoningTokens: 4, totalTokens: 20,
      });
      expect(settledEntry.message.usage.cost.total).toBeCloseTo(1.5 * 0.143, 12);
      expect(lookups).toBe(1);
      expect(syncs).toBe(1);

      await settler.register("resp-worker", {
        requestId: "req-worker", traceId: "trace-worker", requestedAt: "2026-09-21T00:00:00.000Z",
      });
      expect(callbacks).toHaveLength(0);
      expect(lookups).toBe(1);
    } finally {
      await manager.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
