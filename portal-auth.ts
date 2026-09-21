import type { OAuthCredentials, OAuthLoginCallbacks } from "@oh-my-pi/pi-ai/oauth/types";

export const PORTAL_PASSWORD_PROVIDER = "hepai-portal-password";
export const PORTAL_SSO_PROVIDER = "hepai-portal-sso";
export const PORTAL_BASE_URL = "https://aiapi.ihep.ac.cn/apiv2";

const PASSWORD_REFRESH_VERSION = 1;
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

interface PasswordRefreshSecret {
  version: typeof PASSWORD_REFRESH_VERSION;
  username: string;
  password: string;
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
  if (!response.ok) throw new Error(`HepAI Portal ${operation} failed with HTTP ${response.status}`);
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

async function passwordToken(
  username: string,
  password: string,
  fetchImpl: Fetcher,
  signal?: AbortSignal,
): Promise<PortalTokenResponse & { access_token: string }> {
  const response = await fetchImpl(`${PORTAL_BASE_URL}/portal/user/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ username, password }),
    signal,
    redirect: "error",
  });
  return parseTokenResponse(response, "password login");
}

function encodePasswordSecret(username: string, password: string): string {
  return JSON.stringify({ version: PASSWORD_REFRESH_VERSION, username, password } satisfies PasswordRefreshSecret);
}

function decodePasswordSecret(value: string): PasswordRefreshSecret {
  let secret: unknown;
  try { secret = JSON.parse(value); } catch { throw new Error("Stored HepAI Portal password credential is invalid"); }
  if (!secret || typeof secret !== "object") throw new Error("Stored HepAI Portal password credential is invalid");
  const candidate = secret as Partial<PasswordRefreshSecret>;
  if (
    candidate.version !== PASSWORD_REFRESH_VERSION
    || typeof candidate.username !== "string"
    || !candidate.username
    || typeof candidate.password !== "string"
    || !candidate.password
  ) throw new Error("Stored HepAI Portal password credential is invalid");
  return candidate as PasswordRefreshSecret;
}

function passwordCredentials(
  token: PortalTokenResponse & { access_token: string },
  username: string,
  password: string,
): OAuthCredentials {
  return {
    access: token.access_token,
    refresh: encodePasswordSecret(username, password),
    expires: tokenExpiry(token.access_token),
    ...identity(token.user),
  };
}

export async function loginPortalWithPassword(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  const username = (await callbacks.onPrompt({ message: "HepAI Portal username:", placeholder: "username" })).trim();
  if (!username) throw new Error("HepAI Portal username is required");
  const password = await callbacks.onPrompt({ message: "HepAI Portal password:", secret: true });
  if (!password) throw new Error("HepAI Portal password is required");
  callbacks.onProgress?.("Signing in to HepAI Portal...");
  const token = await passwordToken(username, password, callbacks.fetch ?? fetch, callbacks.signal);
  return passwordCredentials(token, username, password);
}

export async function refreshPortalPassword(
  credentials: OAuthCredentials,
  signal?: AbortSignal,
): Promise<OAuthCredentials> {
  const secret = decodePasswordSecret(credentials.refresh);
  const token = await passwordToken(secret.username, secret.password, fetch, signal);
  return { ...passwordCredentials(token, secret.username, secret.password), ...identity(token.user), authorizedAt: credentials.authorizedAt };
}

function validateRefreshCookie(value: string): string {
  const cookie = value.trim();
  if (!cookie || /[\s;]/.test(cookie)) throw new Error("HepAI Portal SSO returned an invalid refresh cookie");
  return cookie;
}

async function refreshCookieToken(
  refreshCookie: string,
  fetchImpl: Fetcher,
  signal?: AbortSignal,
): Promise<PortalTokenResponse & { access_token: string }> {
  const response = await fetchImpl(`${PORTAL_BASE_URL}/portal/user/refresh`, {
    method: "GET",
    headers: { Cookie: `${REFRESH_COOKIE_NAME}=${refreshCookie}`, Accept: "application/json" },
    signal,
    redirect: "error",
  });
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
  const refreshCookie = validateRefreshCookie(await callbacks.onBrowserSession({
    url: `${PORTAL_BASE_URL}/portal/user/login_sso`,
    cookieNames: [REFRESH_COOKIE_NAME],
  }, callbacks.signal));
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
