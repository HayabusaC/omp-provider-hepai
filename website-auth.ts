import type { OAuthCredentials, OAuthLoginCallbacks } from "@oh-my-pi/pi-ai/oauth/types";
import { HEPAI_WEBSITE_LOGIN_URL, HEPAI_WEBSITE_ORIGIN } from "./endpoints.ts";
import { captureWebsiteBrowserSession } from "./website-browser-session.ts";

export const WEBSITE_SSO_PROVIDER = "hepai-website-sso";
const FALLBACK_LIFETIME_MS = 5 * 60_000;
export const WEBSITE_TOKEN_REFRESH_WINDOW_MS = 900_000;
const REFRESH_COOKIE_NAME = "hai_refresh";
const REFRESH_URL = `${HEPAI_WEBSITE_ORIGIN}/api/v1/auths/refresh`;

type Fetcher = NonNullable<OAuthLoginCallbacks["fetch"]>;

function validateRefreshCookie(value: string): string {
  const cookie = value.trim();
  if (!cookie || /[\s;,]/.test(cookie)) throw new Error("HepAI website SSO returned an invalid refresh cookie");
  return cookie;
}

function rotatedRefreshCookie(response: Response, previous: string): string {
  for (const header of response.headers.getSetCookie()) {
    const match = /^hai_refresh=([^;]*)/.exec(header);
    if (match?.[1]) return validateRefreshCookie(match[1]);
  }
  return previous;
}

async function exchangeRefreshCookie(
  cookie: string,
  fetchImpl: Fetcher,
  signal?: AbortSignal,
): Promise<OAuthCredentials> {
  const response = await fetchImpl(REFRESH_URL, {
    method: "POST",
    headers: {
      Cookie: `${REFRESH_COOKIE_NAME}=${cookie}`,
      "X-HAI-Session": "1",
      Origin: HEPAI_WEBSITE_ORIGIN,
      Referer: `${HEPAI_WEBSITE_ORIGIN}/`,
      Accept: "application/json",
    },
    signal,
    redirect: "error",
  });
  if (!response.ok) throw new Error(`HepAI website SSO refresh failed with HTTP ${response.status}`);
  let payload: { token?: unknown; id?: unknown };
  try {
    payload = await response.json() as typeof payload;
  } catch {
    throw new Error("HepAI website SSO refresh returned invalid JSON");
  }
  if (typeof payload.token !== "string" || !payload.token) {
    throw new Error("HepAI website SSO refresh returned no token");
  }
  return {
    access: payload.token,
    refresh: rotatedRefreshCookie(response, cookie),
    expires: websiteTokenExpiry(payload.token),
    ...(typeof payload.id === "string" && payload.id ? { accountId: payload.id } : {}),
  };
}

export function websiteTokenExpiry(token: string): number {
  try {
    const encoded = token.split(".")[1];
    if (encoded) {
      const payload = JSON.parse(atob(encoded.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(encoded.length / 4) * 4, "="))) as { exp?: unknown };
      if (typeof payload.exp === "number" && Number.isFinite(payload.exp)) return payload.exp * 1_000;
    }
  } catch { /* Opaque cookies have no readable expiry. */ }
  return Date.now() + FALLBACK_LIFETIME_MS;
}

export function websiteTokenNeedsRefresh(token: string, now = Date.now()): boolean {
  try {
    const encoded = token.split(".")[1];
    if (!encoded) return false;
    const payload = JSON.parse(atob(encoded.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(encoded.length / 4) * 4, "="))) as { exp?: unknown };
    return typeof payload.exp === "number"
      && Number.isFinite(payload.exp)
      && payload.exp * 1_000 - now < WEBSITE_TOKEN_REFRESH_WINDOW_MS;
  } catch {
    return false;
  }
}

export async function loginWebsiteWithSso(
  callbacks: OAuthLoginCallbacks,
  captureSession: NonNullable<OAuthLoginCallbacks["onBrowserSession"]> = captureWebsiteBrowserSession,
): Promise<OAuthCredentials> {
  callbacks.onProgress?.("Complete IHEP unified authentication in the browser window.");
  const cookie = validateRefreshCookie(await captureSession({
    url: HEPAI_WEBSITE_LOGIN_URL,
    cookieNames: [REFRESH_COOKIE_NAME],
  }, callbacks.signal));
  callbacks.onProgress?.("Validating the HepAI website session...");
  return exchangeRefreshCookie(cookie, callbacks.fetch ?? fetch, callbacks.signal);
}

export async function refreshWebsiteSso(
  credentials: OAuthCredentials,
  signal?: AbortSignal,
  fetchImpl: Fetcher = fetch,
): Promise<OAuthCredentials> {
  const next = await exchangeRefreshCookie(validateRefreshCookie(credentials.refresh), fetchImpl, signal);
  return {
    ...next,
    ...(credentials.email ? { email: credentials.email } : {}),
    ...(credentials.accountId && !next.accountId ? { accountId: credentials.accountId } : {}),
    ...(credentials.authorizedAt ? { authorizedAt: credentials.authorizedAt } : {}),
  };
}

export function websiteAccessToken(credentials: OAuthCredentials): string {
  return credentials.access;
}
