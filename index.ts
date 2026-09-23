import type { ExtensionAPI, ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/loader";
import { join } from "node:path";
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
import { loginWebsiteWithSso, refreshWebsiteSso, WEBSITE_SSO_PROVIDER, websiteAccessToken, websiteTokenNeedsRefresh } from "./website-auth.ts";
import { captureWebsiteBrowserSession } from "./website-browser-session.ts";
import { PortalHttpError } from "./portal-client.ts";
import { HepAITransportCache, transportCachePath } from "./transport-cache.ts";
import { catalogRecordToModelConfig, excludeAgentModels, excludeDemoModels, excludeSpecificModels, excludeUnqualifiedAliases, fetchHepAICatalog, fetchHepAICloudModels, hasDisplayName, mergeCatalogRecords, sortHepAIModels, type HepAICatalogRecord } from "./catalog.ts";
import { HEPAI_ANTHROPIC_BASE_URL, HEPAI_BASE_URL, HEPAI_MODEL_DETAILS_URL } from "./endpoints.ts";
import {
  HepAIBillingSettler,
  isHepAIAssistant,
  responseLink,
  type HepAIResponseLink,
} from "./billing-settlement.ts";

const PROVIDER = "hepai";
const API = "hepai-auto";
const PLUGIN_NAME = "omp-provider-hepai";
const protocolCache = new HepAITransportCache(transportCachePath());
const completedResponseLinks = new Map<string, HepAIResponseLink>();
let resolveWebsiteToken: (() => Promise<string | undefined>) | undefined;

interface ModelList { data?: unknown; }

async function storedWebsiteToken(): Promise<string | undefined> {
  const storage = await AuthStorage.create(join(getAgentDir(), "agent.db"));
  try {
    await storage.reload();
    let resolved = await storage.getOAuthAccess(WEBSITE_SSO_PROVIDER);
    if (resolved?.accessToken && websiteTokenNeedsRefresh(resolved.accessToken)) {
      resolved = await storage.getOAuthAccess(WEBSITE_SSO_PROVIDER, undefined, { forceRefresh: true });
    }
    return resolved?.accessToken;
  } finally {
    storage.close();
  }
}

async function discover(
  apiKey: string | undefined,
  filterSpecificModels: boolean,
  filterAgentModels: boolean,
): Promise<ProviderModelConfig[]> {
  let apiRecords: HepAICatalogRecord[] | undefined;
  let apiError: unknown;
  if (apiKey) {
    try {
      const response = await fetch(`${HEPAI_BASE_URL}/models`, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
        redirect: "error",
      });
      if (!response.ok) throw new Error(`HepAI model discovery failed with HTTP ${response.status}`);
      const json = await response.json() as ModelList;
      if (!Array.isArray(json.data)) throw new Error("HepAI /models returned no data array");
      apiRecords = json.data
        .filter((item): item is HepAICatalogRecord => !!item && typeof item === "object" && !Array.isArray(item)
          && typeof (item as HepAICatalogRecord).id === "string" && !!(item as HepAICatalogRecord).id);
    } catch (error) {
      apiError = error;
    }
  }
  let cloudRecords: Awaited<ReturnType<typeof fetchHepAICloudModels>> = [];
  let cloudError: unknown;
  try { cloudRecords = await fetchHepAICloudModels(); } catch (error) { cloudError = error; }
  if (!apiRecords && cloudError) throw apiError ?? cloudError;
  const ids = (apiRecords ?? cloudRecords).map(record => record.id as string);
  const uniqueIds = [...new Set(ids)];
  let websiteToken: string | undefined;
  try {
    websiteToken = resolveWebsiteToken
      ? await resolveWebsiteToken()
      : await storedWebsiteToken();
  } catch {
    // Website metadata is optional. A stale or unavailable SSO credential must
    // not hide models authorized by the model API key.
  }
  const catalogResult = websiteToken
    ? await fetchHepAICatalog(uniqueIds, websiteToken).catch(() => [])
    : [];
  const catalog = mergeCatalogRecords(cloudRecords, catalogResult, apiRecords ?? []);
  // Global filters run first with exact-ID exemptions, followed by optional classes.
  const namedIds = uniqueIds.filter(id => hasDisplayName(catalog.get(id), id));
  const nonDemoIds = excludeDemoModels(namedIds);
  const deduplicatedIds = excludeUnqualifiedAliases(nonDemoIds);
  // Limit repair applies only to the set that survives all five filters with
  // both optional class filters treated as enabled, regardless of visibility settings.
  const normalizedLimitIds = new Set(excludeAgentModels(excludeSpecificModels(deduplicatedIds, true), true));
  const nonSpecificIds = excludeSpecificModels(deduplicatedIds, filterSpecificModels);
  const nonAgentIds = excludeAgentModels(nonSpecificIds, filterAgentModels);
  return sortHepAIModels(nonAgentIds.map(id => catalogRecordToModelConfig(
    id,
    catalog.get(id),
    normalizedLimitIds.has(id),
  )), catalog);
}

function cloneModel(model: Model<Api>, api: "openai-responses" | "openai-completions" | "anthropic-messages"): Model<Api> {
  const baseUrl = api === "anthropic-messages" ? HEPAI_ANTHROPIC_BASE_URL : HEPAI_BASE_URL;
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
    const preferred = await protocolCache.get(model.id).catch(() => undefined);
    const attempts = orderedTransports(model.id, preferred);
    for (const protocol of attempts) {
      let attemptLink: HepAIResponseLink | undefined;
      const inner = dispatch(protocol, model, context, {
        ...resolvedOptions,
        onResponse: async (response, responseModel) => {
          await resolvedOptions.onResponse?.(response, responseModel);
          attemptLink = responseLink(response);
        },
      });
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
              if (protocol === preferred) await protocolCache.forget(model.id, protocol).catch(() => {});
              tryNext = true;
              break;
            }
          }
          held.push(event);
        }
        const terminal = held.at(-1);
        if (terminal?.type === "done") {
          await protocolCache.remember(model.id, protocol).catch(() => {});
          if (attemptLink && terminal.message.responseId) {
            completedResponseLinks.set(terminal.message.responseId, attemptLink);
          }
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
        if (protocol === preferred) await protocolCache.forget(model.id, protocol).catch(() => {});
      }
    }
    outer.fail(new Error("HepAI supports none of Responses, Chat Completions, or Anthropic Messages for this model"));
  })().catch(error => {
    if (!outer.done) outer.fail(error);
  });
  return outer;
}

async function probe(endpoint: ProbeEndpoint, model: string, apiKey: string): Promise<ProbeResult> {
  const body = buildProbeBody(endpoint, model);
  try {
    const response = await fetch(`${HEPAI_BASE_URL}/${endpoint}`, {
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

export default async function hepAIProvider(omp: ExtensionAPI): Promise<void> {
  const settings: Record<string, unknown> = await getPluginSettings(PLUGIN_NAME, process.cwd()).catch(() => ({}));
  const filterSpecificModels = settings.filterSpecificModels !== false;
  const filterAgentModels = settings.filterAgentModels !== false;
  let activeSettler: HepAIBillingSettler | undefined;
  let websitePreflight: Promise<void> | undefined;

  const websiteAccess = async (
    ctx: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1],
    forceRefresh = false,
  ): Promise<string | undefined> => {
    const sessionId = ctx.sessionManager.getSessionId();
    try {
      const token = await ctx.modelRegistry.getApiKeyForProvider(WEBSITE_SSO_PROVIDER, sessionId, { forceRefresh });
      if (!forceRefresh && token && websiteTokenNeedsRefresh(token)) {
        return await ctx.modelRegistry.getApiKeyForProvider(WEBSITE_SSO_PROVIDER, sessionId, { forceRefresh: true });
      }
      return token;
    } catch { /* Billing remains pending until an SSO credential is available. */ }
    return undefined;
  };

  const billingAccess = websiteAccess;

  const startWebsitePreflight = (ctx: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1]) => {
    if (websitePreflight) return websitePreflight;
    websitePreflight = (async () => {
      let token: string | undefined;
      try {
        token = await websiteAccess(ctx);
      } catch { /* An expired website refresh session requires interactive SSO login. */ }
      if (token) {
        try {
          const response = await fetch(`${HEPAI_MODEL_DETAILS_URL}?model_name=gpt-5.6-sol`, {
            headers: { Authorization: `Bearer ${token}`, Cookie: `token=${token}`, Accept: "application/json" },
            signal: AbortSignal.timeout(15_000), redirect: "error",
          });
          if (response.ok) {
            await ctx.modelRegistry.awaitBackgroundRefresh();
            await ctx.modelRegistry.refreshRuntimeProviders("online");
            return;
          }
          if (response.status !== 401 && response.status !== 403) return;
        } catch (error) {
          omp.logger.warn("HepAI website SSO preflight failed", { error });
          return;
        }
      }
      if (!ctx.hasUI || ctx.mode !== "tui") {
        omp.logger.warn(`HepAI website SSO login is required; run /login ${WEBSITE_SSO_PROVIDER} in interactive mode`);
        return;
      }
      const statusKey = "hepai-website-preflight";
      ctx.ui.setStatus(statusKey, "HepAI website login required…");
      try {
        await ctx.modelRegistry.authStorage.login(WEBSITE_SSO_PROVIDER, {
          onAuth: () => {},
          onPrompt: async prompt => (await ctx.ui.input(prompt.message)) ?? "",
          onProgress: message => ctx.ui.setStatus(statusKey, message),
          onBrowserSession: captureWebsiteBrowserSession,
        });
        ctx.ui.notify("HepAI website SSO login completed", "info");
        await ctx.modelRegistry.awaitBackgroundRefresh();
        await ctx.modelRegistry.refreshRuntimeProviders("online");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      } finally {
        ctx.ui.setStatus(statusKey, undefined);
      }
    })();
    return websitePreflight;
  };

  const activateSettlement = (ctx: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1]) => {
    activeSettler = new HepAIBillingSettler({
      sessionManager: ctx.sessionManager,
      getBillingAccess: forceRefresh => billingAccess(ctx, forceRefresh),
      schedule: (callback, delayMs) => ctx.setTimeout(callback, delayMs),
    });
    void activeSettler.resume();
  };

  omp.on("session_start", (_event, ctx) => {
    resolveWebsiteToken = () => websiteAccess(ctx);
    activateSettlement(ctx);
    void startWebsitePreflight(ctx);
  });
  omp.on("session_switch", (_event, ctx) => {
    resolveWebsiteToken = () => websiteAccess(ctx);
    activateSettlement(ctx);
  });
  omp.on("message_end", async (event, ctx) => {
    if (!isHepAIAssistant(event.message) || !event.message.responseId) return;
    const responseId = event.message.responseId;
    const link = completedResponseLinks.get(responseId);
    if (!link) return;
    completedResponseLinks.delete(responseId);
    const settler = activeSettler;
    const sessionFile = ctx.sessionManager.getSessionFile();
    // OMP reserved the JSONL append before extension notification and does not
    // wait on this hook for message persistence. Persist the association now so
    // a process exit cannot lose it; register only queues the billing worker.
    await settler?.register(responseId, link, sessionFile);
  });

  omp.registerProvider(PROVIDER, {
    baseUrl: HEPAI_BASE_URL,
    api: API,
    streamSimple: autoStream,
    authHeader: true,
    ...(process.env.HEPAI_DEV_USE_ENV === "1" ? { apiKey: "HEPAI_API_KEY" } : {}),
    fetchDynamicModels: apiKey => discover(apiKey, filterSpecificModels, filterAgentModels),
  });

  omp.registerProvider(WEBSITE_SSO_PROVIDER, {
    oauth: {
      name: "HepAI website (IHEP SSO — model metadata)",
      login: loginWebsiteWithSso,
      refreshToken: refreshWebsiteSso,
      getApiKey: websiteAccessToken,
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
    description: "Diagnose HepAI transport compatibility without changing routing",
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
      const summary = results.map(result => `${result.endpoint}: ${result.kind} (HTTP ${result.status})`).join("; ");
      ctx.ui.notify(`${model} — ${summary}${preferred ? `; suggested: ${preferred}` : ""}`, supported.length > 0 ? "info" : "warning");
    },
  });

  omp.registerCommand("hepai-website-auth", {
    description: "Show HepAI website SSO login status",
    handler: async (_args, ctx) => {
      const sso = ctx.modelRegistry.authStorage.hasAuth(WEBSITE_SSO_PROVIDER) ? "saved" : "not configured";
      ctx.ui.notify(`Website SSO: ${sso}. Use /login ${WEBSITE_SSO_PROVIDER}.`, "info");
    },
  });

  omp.registerCommand("hepai-settle", {
    description: "Retry pending HepAI billing settlement for this session",
    handler: async (_args, ctx) => {
      activateSettlement(ctx);
      ctx.ui.notify("Queued pending HepAI billing records for exact-ID settlement", "info");
    },
  });

}
