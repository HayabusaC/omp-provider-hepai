import type { OAuthCredentials, OAuthLoginCallbacks } from "@oh-my-pi/pi-ai/oauth/types";
import { HEPAI_BASE_URL } from "./endpoints.ts";

export const PORTAL_SSO_PROVIDER = "hepai-portal-sso";
export const PORTAL_BASE_URL = HEPAI_BASE_URL;

const FALLBACK_TOKEN_LIFETIME_MS = 5 * 60_000;
const REFRESH_COOKIE_NAME = "refresh-token";

interface PortalUser {
  id?: unknown;
  username?: unknown;
  email?: unknown;
}

interface PortalTokenResponse {
  access_token?: unknown;
  token_type?: unknown;
  user?: PortalUser;
}

type Fetcher = NonNullable<OAuthLoginCallbacks["fetch"]>;

function tokenExpiry(accessToken: string): number {
  try {
    const encoded = accessToken.split(".")[1];
    if (!encoded) throw new Error("JWT has no payload");
    const normalized = encoded.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(encoded.length / 4) * 4, "=");
    const payload = JSON.parse(atob(normalized)) as { exp?: unknown };
    if (typeof payload.exp === "number" && Number.isFinite(payload.exp)) return payload.exp * 1_000;
  } catch {
    // A short fallback forces an early refresh instead of retaining an opaque stale token.
  }
  return Date.now() + FALLBACK_TOKEN_LIFETIME_MS;
}

function identity(user: PortalUser | undefined): Pick<OAuthCredentials, "email" | "accountId"> {
  const email = typeof user?.email === "string" && user.email ? user.email : undefined;
  const accountId = typeof user?.id === "string" && user.id
    ? user.id
    : typeof user?.username === "string" && user.username
      ? user.username
      : undefined;
  return { ...(email ? { email } : {}), ...(accountId ? { accountId } : {}) };
}

async function parseTokenResponse(response: Response, operation: string): Promise<PortalTokenResponse & { access_token: string }> {
  if (!response.ok) {
    let serverDetail = "";
    try {
      const payload = await response.json() as { detail?: unknown };
      const detail = payload.detail;
      if (detail && typeof detail === "object") {
        const code = (detail as { code?: unknown }).code;
        const message = (detail as { message?: unknown }).message;
        const safeCode = typeof code === "number" || typeof code === "string" ? String(code).slice(0, 32) : "";
        const safeMessage = typeof message === "string" ? message.replace(/[\r\n\t]/g, " ").slice(0, 160) : "";
        serverDetail = [safeCode, safeMessage].filter(Boolean).join(": ");
      } else if (typeof detail === "string") {
        serverDetail = detail.replace(/[\r\n\t]/g, " ").slice(0, 160);
      }
    } catch {
      // HTTP status remains authoritative when the server error body is absent or malformed.
    }
    throw new Error(
      `HepAI Portal ${operation} failed with HTTP ${response.status}`
      + (serverDetail ? ` (${serverDetail})` : "")
    );
  }
  let payload: PortalTokenResponse;
  try {
    payload = await response.json() as PortalTokenResponse;
  } catch {
    throw new Error(`HepAI Portal ${operation} returned invalid JSON`);
  }
  if (typeof payload.access_token !== "string" || !payload.access_token) {
    throw new Error(`HepAI Portal ${operation} returned no access_token`);
  }
  return { ...payload, access_token: payload.access_token };
}

function validateRefreshCookie(value: string): string {
  const cookie = value.trim();
  if (!cookie || /[\s;]/.test(cookie)) throw new Error("HepAI Portal SSO returned an invalid refresh cookie");
  return cookie;
}

function explainBrowserNetworkFailure(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.match(/ERR_(?:CONNECTION_CLOSED|PROXY_CONNECTION_FAILED|TUNNEL_CONNECTION_FAILED|SSL_PROTOCOL_ERROR)/)?.[0];
  if (code) {
    throw new Error(
      `HepAI Portal SSO browser could not reach aiapi.ihep.ac.cn (${code}). `
      + "Check the system browser proxy or bypass aiapi.ihep.ac.cn and newlogin.ihep.ac.cn, then retry.",
    );
  }
  throw error;
}

async function refreshCookieToken(
  refreshCookie: string,
  fetchImpl: Fetcher,
  signal?: AbortSignal,
): Promise<PortalTokenResponse & { access_token: string }> {
  const request = (url: string) => fetchImpl(url, {
    method: "GET",
    headers: { Cookie: `${REFRESH_COOKIE_NAME}=${refreshCookie}`, Accept: "application/json" },
    signal,
    redirect: "error",
  });
  let response = await request(`${PORTAL_BASE_URL}/portal/user/refresh`);
  // The 2026-09-21 production deployment mistakenly exposed an unbound `self`
  // argument as a required query parameter. Keep the documented request first,
  // then use the narrow workaround only for that exact FastAPI validation error.
  if (response.status === 422) {
    try {
      const payload = await response.clone().json() as { detail?: unknown };
      const errors = Array.isArray(payload.detail) ? payload.detail : [];
      const missingSelf = errors.some(error => {
        if (!error || typeof error !== "object") return false;
        const candidate = error as { type?: unknown; loc?: unknown };
        return candidate.type === "missing"
          && Array.isArray(candidate.loc)
          && candidate.loc.length === 2
          && candidate.loc[0] === "query"
          && candidate.loc[1] === "self";
      });
      if (missingSelf) response = await request(`${PORTAL_BASE_URL}/portal/user/refresh?self=1`);
    } catch {
      // Preserve the original response for normal error handling.
    }
  }
  return parseTokenResponse(response, "SSO refresh");
}

function ssoCredentials(
  token: PortalTokenResponse & { access_token: string },
  refreshCookie: string,
  previous?: OAuthCredentials,
): OAuthCredentials {
  return {
    access: token.access_token,
    refresh: refreshCookie,
    expires: tokenExpiry(token.access_token),
    ...identity(token.user),
    ...(previous?.email && !token.user?.email ? { email: previous.email } : {}),
    ...(previous?.accountId && !token.user?.id && !token.user?.username ? { accountId: previous.accountId } : {}),
    ...(previous?.authorizedAt ? { authorizedAt: previous.authorizedAt } : {}),
  };
}

export async function loginPortalWithSso(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  if (!callbacks.onBrowserSession) throw new Error("HepAI Portal SSO requires an OMP client with browser-session login support");
  callbacks.onProgress?.("Complete IHEP unified authentication in the browser window.");
  let capturedCookie: string;
  try {
    capturedCookie = await callbacks.onBrowserSession({
      url: `${PORTAL_BASE_URL}/portal/user/login_sso`,
      cookieNames: [REFRESH_COOKIE_NAME],
    }, callbacks.signal);
  } catch (error) {
    explainBrowserNetworkFailure(error);
  }
  const refreshCookie = validateRefreshCookie(capturedCookie);
  callbacks.onProgress?.("Validating the HepAI Portal session...");
  const token = await refreshCookieToken(refreshCookie, callbacks.fetch ?? fetch, callbacks.signal);
  return ssoCredentials(token, refreshCookie);
}

export async function refreshPortalSso(
  credentials: OAuthCredentials,
  signal?: AbortSignal,
): Promise<OAuthCredentials> {
  const refreshCookie = validateRefreshCookie(credentials.refresh);
  const token = await refreshCookieToken(refreshCookie, fetch, signal);
  return ssoCredentials(token, refreshCookie, credentials);
}

export function portalAccessToken(credentials: OAuthCredentials): string {
  return credentials.access;
}
