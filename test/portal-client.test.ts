import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { billingCachePath } from "../billing-cache.ts";
import {
  findPortalInvocation,
  portalDateTime,
} from "../portal-client.ts";

describe("HepAI website billing", () => {
  test("places the shared invoice cache under the active OMP agent directory", () => {
    expect(billingCachePath()).toBe(join(getAgentDir(), "cache", "hepai-invoices.json"));
  });

  test("formats production-compatible billing dates and rejects malformed server envelopes", async () => {
    expect(portalDateTime(new Date("2026-09-21T12:34:56.789Z"))).toBe("2026-09-21");
    await expect(findPortalInvocation("token", {
      requestId: "req", fetch: async () => Response.json({ data: [] }),
    })).rejects.toThrow("returned no items array");
    await expect(findPortalInvocation("token", {
      requestId: "req", maxPages: 0, fetch: async () => Response.json({ items: [] }),
    })).rejects.toThrow("Invalid HepAI billing page limit");
  });

  test("matches invoke records only by exact request and trace ids across pages", async () => {
    const pages: number[] = [];
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      pages.push(body.page);
      return Response.json({
        total: 3,
        items: body.page === 1
          ? [
              { invoke_id: "newest-but-wrong", remarks: { request_id: "req-other", trace_id: "trace-1" } },
              { invoke_id: "wrong-trace", remarks: { request_id: "req-1", trace_id: "trace-other" } },
            ]
          : [{ invoke_id: "exact", payable_amount: 1, remarks: { request_id: "req-1", trace_id: "trace-1" } }],
      });
    };
    const record = await findPortalInvocation("website-token", {
      requestId: "req-1",
      traceId: "trace-1",
      pageSize: 2,
      fetch: fetchImpl,
      requestedAt: new Date("2026-09-21T12:00:00Z"),
    });
    expect(record?.invoke_id).toBe("exact");
    expect(pages).toEqual([1, 2]);
  });

  test("uses website authentication, reads beyond 20 pages, and reuses a sanitized local cache", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hepai-invoice-cache-"));
    const cachePath = join(dir, "invoices.json");
    const pages: number[] = [];
    try {
      const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe("https://ai.ihep.ac.cn/apiv2/portal/billing/invoke_records");
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer website-token");
        expect(new Headers(init?.headers).get("Cookie")).toBe("token=website-token");
        const page = JSON.parse(String(init?.body)).page as number;
        pages.push(page);
        return Response.json({ total: 21, items: [{
          invoke_id: page, payable_amount: 1, original_price: 2, discount_amount: 1,
          standard_invoke_record: { input_tokens: 2, output_tokens: 1, reasoning_tokens: 1 },
          total_discount_rate: 0.6,
          billing_basis: { usage: {
            output_tokens: 3,
            cache_creation_input_tokens: 4,
            output_tokens_details: { thinking_tokens: 2 },
            std_amounts: { prompt: 5, input_cache_read: 6 },
          }, total_discount_rate: 0.5, cost_breakdown: {
            prompt: { amount: 2, configured_rate: 1, cost: 0.25 },
          } },
          remarks: { request_id: page === 21 ? "wanted" : `other-${page}`, trace_id: "trace", request_headers: { secret: "never persist" } },
          api_key: "never persist",
        }] });
      };
      const options = { requestId: "wanted", traceId: "trace", pageSize: 1, cachePath };
      expect((await findPortalInvocation("website-token", { ...options, fetch: fetchImpl }))?.invoke_id).toBe(21);
      expect(pages).toHaveLength(21);
      const persisted = await readFile(cachePath, "utf8");
      expect(persisted).not.toContain("never persist");
      expect(persisted).not.toContain("api_key");
      expect(persisted).not.toContain("configured_rate");
      expect(persisted).toContain('"billing_basis"');
      expect(persisted).toContain('"cost":0.25');
      expect(persisted).toContain('"cache_creation_input_tokens":4');
      expect(persisted).toContain('"thinking_tokens":2');
      expect(persisted).toContain('"total_discount_rate":0.6');
      expect((await findPortalInvocation("website-token", {
        ...options, fetch: async () => { throw new Error("cache miss"); },
      }))?.invoke_id).toBe(21);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("repairs a corrupt invoice cache on the next successful lookup", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hepai-invoice-corrupt-"));
    const cachePath = join(dir, "invoices.json");
    try {
      await writeFile(cachePath, "not json");
      const record = await findPortalInvocation("website-token", {
        requestId: "wanted",
        cachePath,
        fetch: async () => Response.json({ total: 1, items: [{
          invoke_id: 1,
          payable_amount: 1,
          standard_invoke_record: { input_tokens: 1, output_tokens: 1 },
          remarks: { request_id: "wanted" },
        }] }),
      });
      expect(record?.invoke_id).toBe(1);
      expect(JSON.parse(await readFile(cachePath, "utf8"))).toMatchObject({
        version: 1,
        records: { wanted: { invoice: { invoke_id: 1 } } },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
