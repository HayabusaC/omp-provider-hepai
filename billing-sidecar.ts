import { dirname } from "node:path";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import type { HepAIBillingMetadata } from "./billing-types.ts";

const writeTails = new Map<string, Promise<void>>();

export type BillingSettlementStatus = "pending" | "settled" | "failed";

export interface BillingSettlementRecord {
  requestId: string;
  responseId: string;
  traceId?: string;
  invokeId?: string;
  sessionFile: string;
  sessionEntryId?: string;
  status: BillingSettlementStatus;
  attempts: number;
  requestedAt: string;
  nextAttemptAt?: string;
  settledAt?: string;
  lastError?: string;
  billing?: HepAIBillingMetadata;
}

export interface BillingSidecar {
  version: 1;
  records: Record<string, BillingSettlementRecord>;
}

export function billingSidecarPath(sessionFile: string): string {
  return `${sessionFile}.hepai-billing.json`;
}

export async function readBillingSidecar(path: string): Promise<BillingSidecar> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<BillingSidecar>;
    if (parsed.version !== 1 || !parsed.records || typeof parsed.records !== "object") {
      throw new Error(`Unsupported HepAI billing sidecar: ${path}`);
    }
    return parsed as BillingSidecar;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, records: {} };
    throw error;
  }
}

/** Same-directory temporary replacement keeps a sidecar update atomic. */
export async function writeBillingSidecar(path: string, value: BillingSidecar): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  try {
    await rename(temporary, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      await unlink(path).catch((unlinkError: NodeJS.ErrnoException) => {
        if (unlinkError.code !== "ENOENT") throw unlinkError;
      });
      await rename(temporary, path);
    } else {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }
}

export async function upsertBillingRecord(record: BillingSettlementRecord): Promise<BillingSettlementRecord> {
  const path = billingSidecarPath(record.sessionFile);
  let result!: BillingSettlementRecord;
  const previous = writeTails.get(path) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const sidecar = await readBillingSidecar(path);
    const current = sidecar.records[record.requestId];
    if (current?.status === "settled") {
      result = current;
      return;
    }
    result = sidecar.records[record.requestId] = { ...current, ...record };
    await writeBillingSidecar(path, sidecar);
  });
  writeTails.set(path, next);
  try {
    await next;
    return result;
  } finally {
    if (writeTails.get(path) === next) writeTails.delete(path);
  }
}

export async function updateBillingRecord(
  sessionFile: string,
  requestId: string,
  update: (current: BillingSettlementRecord) => BillingSettlementRecord,
): Promise<BillingSettlementRecord | undefined> {
  const path = billingSidecarPath(sessionFile);
  let result: BillingSettlementRecord | undefined;
  const previous = writeTails.get(path) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const sidecar = await readBillingSidecar(path);
    const current = sidecar.records[requestId];
    if (!current) return;
    result = sidecar.records[requestId] = update(current);
    await writeBillingSidecar(path, sidecar);
  });
  writeTails.set(path, next);
  try {
    await next;
    return result;
  } finally {
    if (writeTails.get(path) === next) writeTails.delete(path);
  }
}
