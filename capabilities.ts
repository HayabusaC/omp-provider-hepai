export type ProbeKind =
  | "supported"
  | "model-unsupported"
  | "auth-failed"
  | "endpoint-missing"
  | "upstream-error"
  | "request-rejected";

export type HepAITransport = "responses" | "chat" | "anthropic";
export type ProbeEndpoint = "responses" | "chat/completions" | "anthropic/v1/messages";

export interface ProbeResult {
  endpoint: ProbeEndpoint;
  kind: ProbeKind;
  status: number;
  detail: string;
}

export function buildProbeBody(endpoint: ProbeEndpoint, model: string): Record<string, unknown> {
  if (endpoint === "responses") {
    return { model, input: "Reply with OK", max_output_tokens: 16, stream: false };
  }
  return { model, messages: [{ role: "user", content: "Reply with OK" }], max_tokens: 16, stream: false };
}

export function transportForEndpoint(endpoint: ProbeEndpoint): HepAITransport {
  if (endpoint === "responses") return "responses";
  if (endpoint === "chat/completions") return "chat";
  return "anthropic";
}

export function orderedTransports(modelId: string, preferred?: HepAITransport): HepAITransport[] {
  const nativeFirst: HepAITransport[] = /(^|\/)anthropic\/|claude/iu.test(modelId)
    ? ["anthropic", "responses", "chat"]
    : ["responses", "chat", "anthropic"];
  return preferred ? [preferred, ...nativeFirst.filter(item => item !== preferred)] : nativeFirst;
}

export function chooseSupportedTransport(modelId: string, results: readonly ProbeResult[]): HepAITransport | undefined {
  const supported = new Set(results.filter(result => result.kind === "supported").map(result => transportForEndpoint(result.endpoint)));
  return orderedTransports(modelId).find(transport => supported.has(transport));
}

export function classifyProbe(endpoint: ProbeResult["endpoint"], status: number, body: unknown): ProbeResult {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const detail = text.replace(/\s+/gu, " ").slice(0, 180);
  if (status >= 200 && status < 300) return { endpoint, kind: "supported", status, detail: "ok" };
  if (status === 401 || status === 403) return { endpoint, kind: "auth-failed", status, detail };
  if (status >= 500) return { endpoint, kind: "upstream-error", status, detail };
  if (/model|not support|unsupported|not available|permission/iu.test(text)) {
    return { endpoint, kind: "model-unsupported", status, detail };
  }
  if (status === 404 || status === 405) return { endpoint, kind: "endpoint-missing", status, detail };
  return { endpoint, kind: "request-rejected", status, detail };
}

export function shouldFallbackStatus(status: number | undefined, message: string): boolean {
  if (status === 401 || status === 403 || (status !== undefined && status >= 500)) return false;
  return status === 404 || status === 405 || status === 400 || status === 422 ||
    /responses?.*(?:unsupported|not supported|not found)|model.*(?:unsupported|not available)/iu.test(message);
}
