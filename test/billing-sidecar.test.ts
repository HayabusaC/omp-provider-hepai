import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { billingSidecarPath, readBillingSidecar, upsertBillingRecord } from "../billing-sidecar.ts";

describe("HepAI billing sidecar", () => {
  test("persists pending links and never overwrites a settled request", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hepai-sidecar-"));
    try {
      const sessionFile = join(dir, "session.jsonl");
      const base = {
        requestId: "req-1", responseId: "resp-1", traceId: "trace-1", sessionFile,
        status: "pending" as const, attempts: 0, requestedAt: "2026-09-21T00:00:00.000Z",
      };
      await upsertBillingRecord(base);
      await upsertBillingRecord({ ...base, status: "settled", invokeId: "inv-1", attempts: 1 });
      await upsertBillingRecord({ ...base, responseId: "resp-wrong" });
      const sidecar = await readBillingSidecar(billingSidecarPath(sessionFile));
      expect(sidecar.records["req-1"]).toMatchObject({
        responseId: "resp-1", traceId: "trace-1", invokeId: "inv-1", status: "settled", attempts: 1,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
