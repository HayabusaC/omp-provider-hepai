import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { homedir, tmpdir } from "node:os";
import { AuthStorage } from "@oh-my-pi/pi-ai";

const liveDescribe = process.env.HEPAI_E2E === "1" && process.env.HEPAI_API_KEY ? describe : describe.skip;
const ompExe = "C:\\Users\\Shen Chenye\\.bun\\bin\\omp.exe";
const pluginEntry = join(import.meta.dir, "..", "index.ts");

async function runOMP(args: string[], configRoot: string, agentDir: string) {
  const childEnv = { ...Bun.env };
  delete childEnv.HEPAI_API_KEY;
  delete childEnv.HEPAI_DEV_USE_ENV;
  Object.assign(childEnv, {
    PI_CONFIG_DIR: relative(homedir(), configRoot),
    PI_CODING_AGENT_DIR: agentDir,
  });
  const child = Bun.spawn([ompExe, ...args], {
    cwd: join(import.meta.dir, ".."),
    env: childEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

liveDescribe("HepAI isolated native-AuthStorage integration", () => {
  test("discovers and invokes HepAI without exposing the key as a child environment variable", async () => {
    const configRoot = await mkdtemp(join(tmpdir(), "omp-hepai-e2e-"));
    const agentDir = join(configRoot, "agent");
    await mkdir(agentDir);
    try {
      const storage = await AuthStorage.create(join(agentDir, "agent.db"));
      await storage.reload();
      storage.upsertCredential("hepai", { type: "api_key", key: process.env.HEPAI_API_KEY!, source: "login" });
      storage.close();

      const listing = await runOMP([
        "models", "hepai", "--json", "--no-extensions", "-e", pluginEntry,
      ], configRoot, agentDir);
      expect({ exitCode: listing.exitCode, stderr: listing.stderr }).toEqual({ exitCode: 0, stderr: "" });
      const listedModels = (JSON.parse(listing.stdout) as {
        models: Array<{
          selector: string;
          cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
          contextWindow: number;
          maxTokens: number;
        }>;
      }).models;
      const selectors = listedModels.map(model => model.selector);
      expect(selectors).toContain("hepai/openai/gpt-5.6-sol");
      expect(selectors).toContain("hepai/anthropic/claude-sonnet-4-6");
      expect(listedModels.find(model => model.selector === "hepai/anthropic/claude-sonnet-4-6")).toMatchObject({
        cost: { input: 22.68 * 0.143, output: 113.4 * 0.143, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_000_000,
        maxTokens: 128_000,
      });

      const generation = await runOMP([
        "-p", "--mode", "json", "--no-tools", "--no-session", "--no-extensions",
        "--model", "hepai/anthropic/claude-sonnet-4-6", "-e", pluginEntry,
        "Reply with exactly OK.",
      ], configRoot, agentDir);
      expect(generation.exitCode).toBe(0);
      const events = generation.stdout.trim().split(/\r?\n/u).map(line => JSON.parse(line) as {
        type: string;
        message?: {
          role: string;
          content: Array<{ type: string; text?: string }>;
          usage: {
            input: number;
            output: number;
            cacheWrite: number;
            cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
          };
        };
      });
      const completed = events.find(event => event.type === "message_end" && event.message?.role === "assistant")?.message;
      expect(completed?.content.find(block => block.type === "text")?.text).toMatch(/^OK\.?$/u);
      expect(completed?.usage.cost.input).toBeCloseTo((completed!.usage.input * 22.68 * 0.143) / 1_000_000, 12);
      expect(completed?.usage.cost.output).toBeCloseTo((completed!.usage.output * 113.4 * 0.143) / 1_000_000, 12);
      expect(completed?.usage.cost.cacheWrite).toBe(0);
      expect(completed?.usage.cost.total).toBeCloseTo(
        completed!.usage.cost.input + completed!.usage.cost.output,
        12,
      );
    } finally {
      await rm(configRoot, { recursive: true, force: true });
    }
  }, 60_000);
});
