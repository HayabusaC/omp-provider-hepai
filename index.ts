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
import { captureBrowserSession } from "@oh-my-pi/pi-coding-agent/utils/browser-session";
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
  loginPortalWithSso,
  PORTAL_SSO_PROVIDER,
  portalAccessToken,
  refreshPortalSso,
} from "./portal-auth.ts";
import { fetchPortalBillingSummary, PortalHttpError, verifyPortalAccessToken } from "./portal-client.ts";
import { catalogRecordToModelConfig, fetchHepAICatalog, indexCatalog } from "./catalog.ts";
import { HEPAI_ANTHROPIC_BASE_URL, HEPAI_BASE_URL } from "./endpoints.ts";
import {
  HepAIBillingSettler,
  isHepAIAssistant,
  responseLink,
  type HepAIResponseLink,
} from "./billing-settlement.ts";

const PROVIDER = "hepai";
const API = "hepai-auto";
const protocolCache = new Map<string, HepAITransport>();
const completedResponseLinks = new Map<string, HepAIResponseLink>();
let resolvePortalToken: (() => Promise<string | undefined>) | undefined;

interface HepAIModelRecord { id?: unknown; }
interface ModelList { data?: unknown; }

async function discover(apiKey: string | undefined): Promise<ProviderModelConfig[]> {
  if (!apiKey) return [];
  const response = await fetch(`${HEPAI_BASE_URL}/models`, {
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
  const uniqueIds = [...new Set(ids)];
  let portalToken: string | undefined;
  try {
    portalToken = await resolvePortalToken?.();
  } catch {
    // Portal metadata is optional. A stale or unavailable SSO credential must
    // not hide models authorized by the model API key.
  }
  const catalogResult = portalToken
    ? await fetchHepAICatalog(uniqueIds, portalToken).catch(() => [])
    : [];
  const catalog = indexCatalog(catalogResult);
  return uniqueIds.map(id => catalogRecordToModelConfig(id, catalog.get(id)));
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
    const attempts = orderedTransports(model.id, protocolCache.get(model.id));
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
              tryNext = true;
              break;
            }
          }
          held.push(event);
        }
        const terminal = held.at(-1);
        if (terminal?.type === "done") {
          protocolCache.set(model.id, protocol);
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
      }
    }
    outer.fail(new Error("HepAI supports none of Responses, Chat Completions, or Anthropic Messages for this model"));
  })();
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

export default function hepAIProvider(omp: ExtensionAPI): void {
  let activeSettler: HepAIBillingSettler | undefined;
  let portalPreflight: Promise<void> | undefined;

  const activateSettlement = (ctx: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1]) => {
    activeSettler = new HepAIBillingSettler({
      sessionManager: ctx.sessionManager,
      getPortalToken: forceRefresh => ctx.modelRegistry.getApiKeyForProvider(
        PORTAL_SSO_PROVIDER,
        ctx.sessionManager.getSessionId(),
        { forceRefresh },
      ),
      schedule: (callback, delayMs) => ctx.setTimeout(callback, delayMs),
    });
    void activeSettler.resume();
  };

  const startPortalPreflight = (ctx: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1]) => {
    if (portalPreflight) return;
    portalPreflight = (async () => {
      let loginRequired = !ctx.modelRegistry.authStorage.hasAuth(PORTAL_SSO_PROVIDER);
      if (!loginRequired) {
        try {
          let token = await ctx.modelRegistry.getApiKeyForProvider(
            PORTAL_SSO_PROVIDER,
            ctx.sessionManager.getSessionId(),
          );
          if (!token) {
            loginRequired = true;
          } else {
            try {
              await verifyPortalAccessToken(token, { signal: AbortSignal.timeout(15_000) });
            } catch (error) {
              if (!(error instanceof PortalHttpError) || (error.status !== 401 && error.status !== 403)) {
                omp.logger.warn("HepAI Portal preflight could not verify the saved JWT", { error });
                return;
              }
              token = await ctx.modelRegistry.getApiKeyForProvider(
                PORTAL_SSO_PROVIDER,
                ctx.sessionManager.getSessionId(),
                { forceRefresh: true },
              );
              if (!token) {
                loginRequired = true;
              } else {
                try {
                  await verifyPortalAccessToken(token, { signal: AbortSignal.timeout(15_000) });
                } catch (refreshError) {
                  if (refreshError instanceof PortalHttpError
                    && (refreshError.status === 401 || refreshError.status === 403)) {
                    loginRequired = true;
                  } else {
                    omp.logger.warn("HepAI Portal preflight failed after refreshing the JWT", { error: refreshError });
                    return;
                  }
                }
              }
            }
          }
        } catch (error) {
          omp.logger.warn("HepAI Portal credential refresh failed; requesting SSO login", { error });
          loginRequired = true;
        }
      }
      if (!loginRequired) return;
      if (!ctx.hasUI || ctx.mode !== "tui") {
        omp.logger.warn(`HepAI Portal SSO login is required; run /login ${PORTAL_SSO_PROVIDER} in interactive mode`);
        return;
      }

      const statusKey = "hepai-portal-preflight";
      ctx.ui.setStatus(statusKey, "HepAI Portal login required…");
      try {
        await ctx.modelRegistry.authStorage.login(PORTAL_SSO_PROVIDER, {
          onAuth: () => {},
          onPrompt: async prompt => (await ctx.ui.input(prompt.message)) ?? "",
          onProgress: message => ctx.ui.setStatus(statusKey, message),
          onBrowserSession: captureBrowserSession,
        });
        ctx.ui.notify("HepAI Portal SSO login completed", "info");
        await activeSettler?.resume();
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      } finally {
        ctx.ui.setStatus(statusKey, undefined);
      }
    })();
  };

  omp.on("session_start", (_event, ctx) => {
    resolvePortalToken = () => ctx.modelRegistry.getApiKeyForProvider(
      PORTAL_SSO_PROVIDER,
      ctx.sessionManager.getSessionId(),
    );
    activateSettlement(ctx);
    startPortalPreflight(ctx);
  });
  omp.on("session_switch", (_event, ctx) => activateSettlement(ctx));
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
    fetchDynamicModels: discover,
  });

  // Portal authentication is intentionally separate from the model API-key provider.
  // Both flows use OMP's native /login UI and AuthStorage persistence.
  omp.registerProvider(PORTAL_SSO_PROVIDER, {
    oauth: {
      name: "HepAI Portal (IHEP SSO — refresh cookie only)",
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
    description: "Show HepAI Portal SSO login status",
    handler: async (_args, ctx) => {
      const sso = ctx.modelRegistry.authStorage.hasAuth(PORTAL_SSO_PROVIDER) ? "saved" : "not configured";
      ctx.ui.notify(
        `Portal SSO: ${sso}. Use /login ${PORTAL_SSO_PROVIDER}.`,
        "info",
      );
    },
  });

  omp.registerCommand("hepai-settle", {
    description: "Retry pending HepAI billing settlement for this session",
    handler: async (_args, ctx) => {
      activateSettlement(ctx);
      ctx.ui.notify("Queued pending HepAI billing records for exact-ID settlement", "info");
    },
  });

  omp.registerCommand("hepai-billing", {
    description: "Show HepAI Portal fund and recent invocation totals",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("Usage: /hepai-billing", "warning");
        return;
      }
      if (!ctx.modelRegistry.authStorage.hasAuth(PORTAL_SSO_PROVIDER)) {
        ctx.ui.notify(
          `No HepAI Portal SSO login. Use /login ${PORTAL_SSO_PROVIDER}.`,
          "error",
        );
        return;
      }
      const sessionId = ctx.sessionManager.getSessionId();
      let lastError: unknown;
      let forceRefresh = false;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const token = await ctx.modelRegistry.getApiKeyForProvider(PORTAL_SSO_PROVIDER, sessionId, { forceRefresh });
          if (!token) {
            lastError = new Error("HepAI Portal SSO credential is unavailable");
            break;
          }
          const summary = await fetchPortalBillingSummary(token);
          ctx.ui.notify(
            `HepAI billing ${summary.period.start}–${summary.period.end} — `
            + `funds: ${summary.funds.count}; credit_paid USD: ${summary.funds.creditPaid}; `
            + `credit_contributed USD: ${summary.funds.creditContributed}; credit_used USD: ${summary.funds.creditUsed}; `
            + `recent page calls: ${summary.invocations.count}; prompt tokens: ${summary.invocations.promptTokens}; `
            + `completion tokens: ${summary.invocations.completionTokens}; payable_amount USD: ${summary.invocations.cost}`,
            "info",
          );
          return;
        } catch (error) {
          lastError = error;
          if (error instanceof PortalHttpError && (error.status === 401 || error.status === 403) && !forceRefresh) {
            forceRefresh = true;
            continue;
          }
          if (!(error instanceof PortalHttpError && (error.status === 401 || error.status === 403))) {
            ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
            return;
          }
          break;
        }
      }
      ctx.ui.notify(lastError instanceof Error ? lastError.message : String(lastError), "error");
    },
  });
}
