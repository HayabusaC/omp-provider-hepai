import type { ExtensionAPI, ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";
import {
  type Api,
  type AssistantMessageEvent,
  type Context,
  type Model,
  type OptionsForApi,
  type SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { resolveApiKeyOnce } from "@oh-my-pi/pi-ai/auth-retry";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { resolveModelPolicy } from "@oh-my-pi/pi-catalog/compat/resolve";
import {
  buildProbeBody,
  chooseSupportedTransport,
  classifyProbe,
  orderedTransports,
  shouldFallbackStatus,
  type HepAITransport,
  type ProbeEndpoint,
  type ProbeResult,
} from "./capabilities.ts";
import {
  loginPortalWithPassword,
  loginPortalWithSso,
  PORTAL_PASSWORD_PROVIDER,
  PORTAL_SSO_PROVIDER,
  portalAccessToken,
  refreshPortalPassword,
  refreshPortalSso,
} from "./portal-auth.ts";

const PROVIDER = "hepai";
const API = "hepai-auto";
const BASE_URL = "https://aiapi.ihep.ac.cn/apiv2";
const ANTHROPIC_BASE_URL = `${BASE_URL}/anthropic`;
// ProviderModelConfig requires concrete numbers even when discovery omits them.
// These are OMP execution fallbacks, not claims about HepAI catalog metadata.
const REQUIRED_CONTEXT_FALLBACK = 128_000;
const REQUIRED_OUTPUT_FALLBACK = 16_384;
const protocolCache = new Map<string, HepAITransport>();

interface HepAIModelRecord { id?: unknown; }
interface ModelList { data?: unknown; }

function modelConfig(id: string): ProviderModelConfig {
  return {
    id,
    name: id,
    api: API,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: REQUIRED_CONTEXT_FALLBACK,
    maxTokens: REQUIRED_OUTPUT_FALLBACK,
  };
}

async function discover(apiKey: string | undefined): Promise<ProviderModelConfig[]> {
  if (!apiKey) return [];
  const response = await fetch(`${BASE_URL}/models`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`HepAI model discovery failed with HTTP ${response.status}`);
  const json = await response.json() as ModelList;
  if (!Array.isArray(json.data)) throw new Error("HepAI /models returned no data array");
  const ids = json.data
    .map(item => (item && typeof item === "object" ? (item as HepAIModelRecord).id : undefined))
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  return [...new Set(ids)].map(modelConfig);
}

function cloneModel(model: Model<Api>, api: "openai-responses" | "openai-completions" | "anthropic-messages"): Model<Api> {
  const baseUrl = api === "anthropic-messages" ? ANTHROPIC_BASE_URL : BASE_URL;
  const candidate = { ...model, api, baseUrl, compat: undefined } as Model<Api>;
  const policy = resolveModelPolicy(candidate);
  return { ...candidate, compat: policy.compat, identity: policy.identity, thinking: policy.thinking } as Model<Api>;
}

function dispatch(protocol: HepAITransport, model: Model<Api>, context: Context, options: SimpleStreamOptions) {
  if (protocol === "responses") {
    return streamOpenAIResponses(
      cloneModel(model, "openai-responses") as Model<"openai-responses">,
      context,
      options as OptionsForApi<"openai-responses">,
    );
  }
  if (protocol === "chat") {
    return streamOpenAICompletions(
      cloneModel(model, "openai-completions") as Model<"openai-completions">,
      context,
      options as OptionsForApi<"openai-completions">,
    );
  }
  return streamAnthropic(
    cloneModel(model, "anthropic-messages") as Model<"anthropic-messages">,
    context,
    options as OptionsForApi<"anthropic-messages">,
  );
}

function autoStream(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
  const outer = new AssistantMessageEventStream();
  void (async () => {
    const apiKey = await resolveApiKeyOnce(options?.apiKey, options?.signal);
    if (!apiKey) {
      outer.fail(new Error("No HepAI API key is available"));
      return;
    }
    const resolvedOptions = { ...options, apiKey };
    const attempts = orderedTransports(model.id, protocolCache.get(model.id));
    for (const protocol of attempts) {
      const inner = dispatch(protocol, model, context, resolvedOptions);
      const held: AssistantMessageEvent[] = [];
      let tryNext = false;
      try {
        for await (const event of inner) {
          if (event.type === "error") {
            const message = event.error.errorMessage ?? "";
            // OMP provider streams persist the HTTP status on AssistantMessage.errorStatus.
            // AIError.status() intentionally inspects thrown-error shapes, not this field.
            const status = event.error.errorStatus ?? AIError.status({ message });
            if (shouldFallbackStatus(status, message)) {
              tryNext = true;
              break;
            }
          }
          held.push(event);
        }
        const terminal = held.at(-1);
        if (terminal?.type === "done") {
          protocolCache.set(model.id, protocol);
          for (const event of held) outer.push(event);
          return;
        }
        if (!tryNext) {
          for (const event of held) outer.push(event);
          if (!outer.done) outer.fail(new Error(`HepAI ${protocol} stream ended without a result`));
          return;
        }
      } catch (error) {
        const status = AIError.status(error);
        const message = error instanceof Error ? error.message : String(error);
        if (!shouldFallbackStatus(status, message)) {
          outer.fail(error);
          return;
        }
      }
    }
    outer.fail(new Error("HepAI supports none of Responses, Chat Completions, or Anthropic Messages for this model"));
  })();
  return outer;
}

async function probe(endpoint: ProbeEndpoint, model: string, apiKey: string): Promise<ProbeResult> {
  const body = buildProbeBody(endpoint, model);
  try {
    const response = await fetch(`${BASE_URL}/${endpoint}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(endpoint === "anthropic/v1/messages" ? { "anthropic-version": "2023-06-01" } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    });
    const text = await response.text();
    let payload: unknown = text;
    try { payload = JSON.parse(text); } catch { /* retain bounded text */ }
    return classifyProbe(endpoint, response.status, payload);
  } catch (error) {
    return { endpoint, kind: "upstream-error", status: 0, detail: error instanceof Error ? error.message : String(error) };
  }
}

export default function hepAIProvider(omp: ExtensionAPI): void {
  omp.registerProvider(PROVIDER, {
    baseUrl: BASE_URL,
    api: API,
    streamSimple: autoStream,
    authHeader: true,
    ...(process.env.HEPAI_DEV_USE_ENV === "1" ? { apiKey: "HEPAI_API_KEY" } : {}),
    fetchDynamicModels: discover,
  });

  // Portal authentication is intentionally separate from the model API-key provider.
  // Both flows use OMP's native /login UI and AuthStorage persistence.
  omp.registerProvider(PORTAL_PASSWORD_PROVIDER, {
    oauth: {
      name: "HepAI Portal (username/password)",
      login: loginPortalWithPassword,
      refreshToken: refreshPortalPassword,
      getApiKey: portalAccessToken,
    },
  });
  omp.registerProvider(PORTAL_SSO_PROVIDER, {
    oauth: {
      name: "HepAI Portal (IHEP SSO — no saved password)",
      login: loginPortalWithSso,
      refreshToken: refreshPortalSso,
      getApiKey: portalAccessToken,
    },
  });

  omp.registerCommand("hepai-login", {
    description: "Save a HepAI API key in OMP AuthStorage",
    handler: async (_args, ctx) => {
      const key = await ctx.ui.input("HepAI API key (stored in OMP credentials)");
      if (!key?.trim()) return;
      await ctx.modelRegistry.authStorage.upsertCredential(PROVIDER, { type: "api_key", key: key.trim(), source: "login" });
      ctx.ui.notify("Saved HepAI credential in OMP AuthStorage", "info");
    },
  });

  omp.registerCommand("hepai-test", {
    description: "Probe HepAI Responses, Chat Completions, and Anthropic Messages for a model",
    handler: async (args, ctx) => {
      const model = args.trim() || (ctx.model?.provider === PROVIDER ? ctx.model.id : "");
      if (!model) {
        ctx.ui.notify("Usage: /hepai-test <model-id>", "warning");
        return;
      }
      const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER, ctx.sessionManager.getSessionId(), { modelId: model });
      if (!apiKey) {
        ctx.ui.notify("No HepAI credential. Run /hepai-login first.", "error");
        return;
      }
      const results = await Promise.all([
        probe("responses", model, apiKey),
        probe("chat/completions", model, apiKey),
        probe("anthropic/v1/messages", model, apiKey),
      ]);
      const supported = results.filter(result => result.kind === "supported");
      const preferred = chooseSupportedTransport(model, results);
      if (preferred) protocolCache.set(model, preferred);
      const summary = results.map(result => `${result.endpoint}: ${result.kind} (HTTP ${result.status})`).join("; ");
      ctx.ui.notify(`${model} — ${summary}`, supported.length > 0 ? "info" : "warning");
    },
  });

  omp.registerCommand("hepai-portal-auth", {
    description: "Show HepAI Portal password and SSO login entry points",
    handler: async (_args, ctx) => {
      const password = ctx.modelRegistry.authStorage.hasAuth(PORTAL_PASSWORD_PROVIDER) ? "saved" : "not configured";
      const sso = ctx.modelRegistry.authStorage.hasAuth(PORTAL_SSO_PROVIDER) ? "saved" : "not configured";
      ctx.ui.notify(
        `Portal auth — password: ${password}; SSO: ${sso}. Use /login ${PORTAL_PASSWORD_PROVIDER} or /login ${PORTAL_SSO_PROVIDER}.`,
        "info",
      );
    },
  });
}
