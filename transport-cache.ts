import { dirname, join } from "node:path";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import type { HepAITransport } from "./capabilities.ts";

interface TransportCacheFile {
  version: 1;
  models: Record<string, HepAITransport>;
}

function isTransport(value: unknown): value is HepAITransport {
  return value === "responses" || value === "chat" || value === "anthropic";
}

export function transportCachePath(): string {
  return join(getAgentDir(), "cache", "hepai-transports.json");
}

export class HepAITransportCache {
  private models = new Map<string, HepAITransport>();
  private loading?: Promise<void>;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  private async load(): Promise<void> {
    if (!this.loading) {
      this.loading = (async () => {
        let raw: string;
        try {
          raw = await readFile(this.path, "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
          throw error;
        }
        let parsed: unknown;
        try { parsed = JSON.parse(raw); } catch { return; }
        if (!parsed || typeof parsed !== "object" || (parsed as { version?: unknown }).version !== 1) return;
        const models = (parsed as { models?: unknown }).models;
        if (!models || typeof models !== "object" || Array.isArray(models)) return;
        for (const [id, transport] of Object.entries(models)) {
          if (id && isTransport(transport)) this.models.set(id, transport);
        }
      })().catch(error => { this.loading = undefined; throw error; });
    }
    await this.loading;
  }

  async get(modelId: string): Promise<HepAITransport | undefined> {
    await this.load();
    return this.models.get(modelId);
  }

  async remember(modelId: string, transport: HepAITransport): Promise<void> {
    await this.load();
    if (this.models.get(modelId) === transport) return;
    this.models.set(modelId, transport);
    await this.persist();
  }

  async forget(modelId: string, transport: HepAITransport): Promise<void> {
    await this.load();
    if (this.models.get(modelId) !== transport) return;
    this.models.delete(modelId);
    await this.persist();
  }

  private async persist(): Promise<void> {
    const next = this.writing.catch(() => {}).then(async () => {
      const models = Object.fromEntries(this.models);
      const data: TransportCacheFile = { version: 1, models };
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${process.pid}.${crypto.randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(data)}\n`, { encoding: "utf8", flag: "wx" });
      try {
        await rename(temporary, this.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EPERM") {
          await unlink(temporary).catch(() => {});
          throw error;
        }
        await unlink(this.path).catch((unlinkError: NodeJS.ErrnoException) => {
          if (unlinkError.code !== "ENOENT") throw unlinkError;
        });
        await rename(temporary, this.path);
      }
    });
    this.writing = next;
    await next;
  }
}
