import type { AssistantMessage, ProviderResponseMetadata, Usage } from "@oh-my-pi/pi-ai";
import type { ReadonlySessionManager, SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { syncAllSessions } from "@oh-my-pi/omp-stats";
import {
  billingSidecarPath,
  readBillingSidecar,
  updateBillingRecord,
  upsertBillingRecord,
  type BillingSettlementRecord,
} from "./billing-sidecar.ts";
import { settledUsageCost } from "./billing-types.ts";
import { findPortalInvocation, PortalHttpError } from "./portal-client.ts";

const MAX_ATTEMPTS = 8;
const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000] as const;

export interface HepAIResponseLink {
  requestId: string;
  traceId?: string;
  requestedAt: string;
}

interface WritableSessionManager extends ReadonlySessionManager {
  rewriteEntries(): Promise<void>;
}

export interface SettlementContext {
  sessionManager: ReadonlySessionManager;
  getPortalToken(forceRefresh?: boolean): Promise<string | undefined>;
  schedule(callback: () => void | Promise<void>, delayMs: number): unknown;
  syncStats?: () => Promise<unknown>;
  findInvocation?: typeof findPortalInvocation;
  now?: () => Date;
}

function writableManager(manager: ReadonlySessionManager): WritableSessionManager {
  const candidate = manager as Partial<WritableSessionManager>;
  if (typeof candidate.rewriteEntries !== "function") {
    throw new Error("HepAI settlement requires OMP 18.2.7 SessionManager.rewriteEntries()");
  }
  return manager as WritableSessionManager;
}

function matchingAssistantEntry(entries: SessionEntry[], responseId: string) {
  return entries.find(entry => entry.type === "message"
    && entry.message.role === "assistant"
    && entry.message.responseId === responseId);
}

export async function rewriteAssistantUsage(
  manager: ReadonlySessionManager,
  responseId: string,
  usage: Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite" | "totalTokens" | "reasoningTokens">,
  cost: Usage["cost"],
): Promise<{ entryId: string; changed: boolean }> {
  const entry = matchingAssistantEntry(manager.getEntries(), responseId);
  if (!entry || entry.type !== "message" || entry.message.role !== "assistant") {
    throw new Error(`No persisted AssistantMessage matches responseId ${responseId}`);
  }
  const currentUsage = entry.message.usage;
  const current = currentUsage.cost;
  const changed = currentUsage.input !== usage.input || currentUsage.output !== usage.output
    || currentUsage.cacheRead !== usage.cacheRead || currentUsage.cacheWrite !== usage.cacheWrite
    || currentUsage.totalTokens !== usage.totalTokens || currentUsage.reasoningTokens !== usage.reasoningTokens
    || current.input !== cost.input || current.output !== cost.output || current.cacheRead !== cost.cacheRead
    || current.cacheWrite !== cost.cacheWrite || current.total !== cost.total;
  if (changed) {
    Object.assign(entry.message.usage, usage);
    entry.message.usage.cost = { ...cost };
    await writableManager(manager).rewriteEntries();
  }
  return { entryId: entry.id, changed };
}

/** Backward-compatible helper for callers that only need to replace cost. */
export async function rewriteAssistantCost(
  manager: ReadonlySessionManager,
  responseId: string,
  cost: Usage["cost"],
): Promise<{ entryId: string; changed: boolean }> {
  const entry = matchingAssistantEntry(manager.getEntries(), responseId);
  if (!entry || entry.type !== "message" || entry.message.role !== "assistant") {
    throw new Error(`No persisted AssistantMessage matches responseId ${responseId}`);
  }
  const usage = entry.message.usage;
  return rewriteAssistantUsage(manager, responseId, usage, cost);
}

function retryAt(attempts: number, now: Date): string {
  const delay = RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)]!;
  return new Date(now.getTime() + delay).toISOString();
}

export class HepAIBillingSettler {
  readonly #running = new Set<string>();
  constructor(private readonly context: SettlementContext) {}

  async register(responseId: string, link: HepAIResponseLink, expectedSessionFile?: string): Promise<void> {
    const sessionFile = expectedSessionFile ?? this.context.sessionManager.getSessionFile();
    if (!sessionFile) throw new Error("HepAI billing cannot attach before the session has a file");
    const record = await upsertBillingRecord({
      requestId: link.requestId,
      responseId,
      traceId: link.traceId,
      sessionFile,
      status: "pending",
      attempts: 0,
      requestedAt: link.requestedAt,
    });
    if (record.status !== "settled") this.#schedule(record, 0);
  }

  async resume(): Promise<void> {
    const sessionFile = this.context.sessionManager.getSessionFile();
    if (!sessionFile) return;
    const sidecar = await readBillingSidecar(billingSidecarPath(sessionFile));
    const now = (this.context.now ?? (() => new Date()))().getTime();
    for (let record of Object.values(sidecar.records)) {
      if (record.status === "settled") continue;
      // A process performs a finite retry run. A later OMP start is a new
      // opportunity to settle a bill that appeared after the prior run ended.
      if (record.attempts >= MAX_ATTEMPTS) {
        record = await updateBillingRecord(record.sessionFile, record.requestId, current => ({
          ...current,
          status: "pending",
          attempts: 0,
          nextAttemptAt: undefined,
        })) ?? record;
      }
      const due = record.nextAttemptAt ? Math.max(0, Date.parse(record.nextAttemptAt) - now) : 0;
      this.#schedule(record, due);
    }
  }

  #schedule(record: BillingSettlementRecord, delayMs: number): void {
    const key = `${record.sessionFile}\0${record.requestId}`;
    if (this.#running.has(key)) return;
    this.#running.add(key);
    this.context.schedule(() => this.#attempt(record).finally(() => this.#running.delete(key)), delayMs);
  }

  async #attempt(record: BillingSettlementRecord): Promise<void> {
    const now = (this.context.now ?? (() => new Date()))();
    const attempts = record.attempts + 1;
    try {
      // SessionManager is a live object whose backing file changes on /new or
      // /resume. Never spend retries or query billing for a now-inactive file;
      // its persisted sidecar will resume when that session is opened again.
      if (this.context.sessionManager.getSessionFile() !== record.sessionFile) {
        await updateBillingRecord(record.sessionFile, record.requestId, current => ({
          ...current,
          status: "pending",
          nextAttemptAt: undefined,
          lastError: "HepAI settlement paused while another session is active",
        }));
        return;
      }
      let token = await this.context.getPortalToken(false);
      if (!token) {
        await updateBillingRecord(record.sessionFile, record.requestId, current => ({
          ...current,
          status: "pending",
          lastError: "HepAI Portal SSO is not configured",
          nextAttemptAt: undefined,
        }));
        return;
      }
      let invoice;
      try {
        invoice = await (this.context.findInvocation ?? findPortalInvocation)(token, {
          requestId: record.requestId,
          traceId: record.traceId,
          requestedAt: new Date(record.requestedAt),
        });
      } catch (error) {
        if (!(error instanceof PortalHttpError) || (error.status !== 401 && error.status !== 403)) throw error;
        token = await this.context.getPortalToken(true);
        if (!token) throw error;
        invoice = await (this.context.findInvocation ?? findPortalInvocation)(token, {
          requestId: record.requestId,
          traceId: record.traceId,
          requestedAt: new Date(record.requestedAt),
        });
      }
      if (!invoice) throw new Error("matching HepAI billing record is not available yet");
      const { usage, cost, billing } = settledUsageCost(invoice);
      if (this.context.sessionManager.getSessionFile() !== record.sessionFile) return;
      const rewrite = await rewriteAssistantUsage(this.context.sessionManager, record.responseId, usage, cost);
      await (this.context.syncStats ?? (() => syncAllSessions({ workers: 1 })))();
      await updateBillingRecord(record.sessionFile, record.requestId, current => ({
        ...current,
        invokeId: invoice.invoke_id === undefined ? undefined : String(invoice.invoke_id),
        sessionEntryId: rewrite.entryId,
        status: "settled",
        attempts,
        settledAt: now.toISOString(),
        nextAttemptAt: undefined,
        lastError: undefined,
        billing,
      }));
    } catch (error) {
      const exhausted = attempts >= MAX_ATTEMPTS;
      const updated = await updateBillingRecord(record.sessionFile, record.requestId, current => ({
        ...current,
        status: exhausted ? "failed" : "pending",
        attempts,
        nextAttemptAt: exhausted ? undefined : retryAt(attempts, now),
        lastError: error instanceof Error ? error.message : String(error),
      }));
      if (updated?.status === "pending" && updated.nextAttemptAt) {
        const delay = Math.max(0, Date.parse(updated.nextAttemptAt!) - now.getTime());
        this.context.schedule(() => this.#schedule(updated, 0), delay);
      }
    }
  }
}

export function responseTrace(headers: Record<string, string>): string | undefined {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "x-trace-id" && value) return value;
  }
  return undefined;
}

export function responseLink(metadata: ProviderResponseMetadata): HepAIResponseLink | undefined {
  if (metadata.status < 200 || metadata.status >= 300 || !metadata.requestId) return undefined;
  return {
    requestId: metadata.requestId,
    traceId: responseTrace(metadata.headers),
    requestedAt: new Date().toISOString(),
  };
}

export function isHepAIAssistant(message: unknown): message is AssistantMessage {
  return !!message && typeof message === "object"
    && (message as AssistantMessage).role === "assistant"
    && (message as AssistantMessage).provider === "hepai";
}
