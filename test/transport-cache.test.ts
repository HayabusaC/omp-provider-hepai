import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HepAITransportCache, transportCachePath } from "../transport-cache.ts";

describe("HepAI transport cache", () => {
  test("uses the active OMP agent directory", () => {
    expect(transportCachePath()).toMatch(/[\\/]cache[\\/]hepai-transports\.json$/u);
  });

  test("persists successful transports and invalidates only a matching compatibility failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hepai-transport-"));
    const path = join(directory, "cache", "transports.json");
    try {
      const first = new HepAITransportCache(path);
      expect(await first.get("model-a")).toBeUndefined();
      await Promise.all([
        first.remember("model-a", "responses"),
        first.remember("model-b", "anthropic"),
      ]);
      const second = new HepAITransportCache(path);
      expect(await second.get("model-a")).toBe("responses");
      expect(await second.get("model-b")).toBe("anthropic");
      await second.forget("model-a", "chat");
      expect(await second.get("model-a")).toBe("responses");
      await second.forget("model-a", "responses");
      const third = new HepAITransportCache(path);
      expect(await third.get("model-a")).toBeUndefined();
      expect(await third.get("model-b")).toBe("anthropic");
      const stored = JSON.parse(await readFile(path, "utf8")) as { models: Record<string, string> };
      expect(stored.models).toEqual({ "model-b": "anthropic" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("ignores corrupt and unknown cache entries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hepai-transport-"));
    const path = join(directory, "transports.json");
    try {
      await writeFile(path, "not json");
      const cache = new HepAITransportCache(path);
      expect(await cache.get("model-a")).toBeUndefined();
      await cache.remember("model-a", "chat");
      const reloaded = new HepAITransportCache(path);
      expect(await reloaded.get("model-a")).toBe("chat");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
