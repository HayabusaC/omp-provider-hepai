import { describe, expect, test } from "bun:test";
import { fetchPortalBillingSummary, findPortalInvocation, portalDateTime } from "../portal-client.ts";

describe("HepAI Portal billing", () => {
  test("uses production-compatible timestamps and summarizes verified fields", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      if (String(input).endsWith("/portal/billing/mine/all_funds")) {
        return Response.json({ items: [
          { credit_paid: 10, credit_contributed: 2, credit_used: 3 },
          { credit_paid: 5, credit_contributed: 1, credit_used: 4 },
        ] });
      }
      return Response.json({ items: [
        { standard_invoke_record: { input_tokens: 11, output_tokens: 7, total_cost: 0.8 }, payable_amount: 0.5 },
        { standard_invoke_record: { input_tokens: 13, output_tokens: 9, total_cost: 1 }, payable_amount: 0.75 },
      ] });
    };

    const summary = await fetchPortalBillingSummary("portal-jwt", {
      days: 30,
      now: new Date("2026-09-21T12:34:56.789Z"),
      fetch: fetchImpl,
    });

    expect(summary).toEqual({
      period: { start: "2026-08-22", end: "2026-09-21" },
      funds: {
        count: 2,
        creditPaid: 15 * 0.143,
        creditContributed: 3 * 0.143,
        creditUsed: 7 * 0.143,
      },
      invocations: { count: 2, promptTokens: 24, completionTokens: 16, cost: 1.25 * 0.143 },
    });
    expect(new Headers(requests[0].init?.headers).get("Authorization")).toBe("Bearer portal-jwt");
    expect(JSON.parse(String(requests[1].init?.body))).toEqual({
      page: 1,
      page_size: 20,
      start_date: "2026-08-22",
      end_date: "2026-09-21",
    });
  });

  test("rejects unsupported ranges and malformed server envelopes", async () => {
    expect(portalDateTime(new Date("2026-09-21T12:34:56.789Z"))).toBe("2026-09-21");
    await expect(fetchPortalBillingSummary("token", { days: 0 })).rejects.toThrow("between 1 and 366 days");
    await expect(fetchPortalBillingSummary("token", {
      fetch: async () => Response.json({ data: [] }),
    })).rejects.toThrow("returned no items array");
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
    const record = await findPortalInvocation("jwt", {
      requestId: "req-1",
      traceId: "trace-1",
      pageSize: 2,
      fetch: fetchImpl,
      requestedAt: new Date("2026-09-21T12:00:00Z"),
    });
    expect(record?.invoke_id).toBe("exact");
    expect(pages).toEqual([1, 2]);
  });
});
