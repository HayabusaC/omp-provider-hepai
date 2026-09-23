import { describe, expect, test } from "bun:test";
import type { OAuthLoginCallbacks } from "@oh-my-pi/pi-ai/oauth/types";
import { loginWebsiteWithSso, refreshWebsiteSso, websiteAccessToken, websiteTokenNeedsRefresh } from "../website-auth.ts";

function jwt(exp: number): string {
  return `header.${btoa(JSON.stringify({ exp }))}.signature`;
}

describe("HepAI website SSO", () => {
  test("refreshes only when the JWT has less than 900 seconds remaining", () => {
    const now = 2_000_000_000_000;
    expect(websiteTokenNeedsRefresh(jwt(now / 1_000 + 900), now)).toBe(false);
    expect(websiteTokenNeedsRefresh(jwt(now / 1_000 + 899), now)).toBe(true);
    expect(websiteTokenNeedsRefresh("opaque-token", now)).toBe(false);
  });

  test("captures the refresh cookie and exchanges it for a website token", async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = jwt(exp);
    let request: unknown;
    const callbacks: OAuthLoginCallbacks = {
      onAuth: () => {},
      onPrompt: async () => { throw new Error("password prompt is not used"); },
      onBrowserSession: async value => { request = value; return "refresh-value"; },
      fetch: async (input, init) => {
        expect(String(input)).toBe("https://ai.ihep.ac.cn/api/v1/auths/refresh");
        expect(init?.method).toBe("POST");
        expect(init?.redirect).toBe("error");
        const headers = new Headers(init?.headers);
        expect(headers.get("Cookie")).toBe("hai_refresh=refresh-value");
        expect(headers.get("X-HAI-Session")).toBe("1");
        expect(headers.get("Origin")).toBe("https://ai.ihep.ac.cn");
        return Response.json({ token, id: "account-1" });
      },
    };
    const credentials = await loginWebsiteWithSso(callbacks, callbacks.onBrowserSession);
    expect(request).toEqual({ url: "https://ai.ihep.ac.cn/oauth/ihep/login", cookieNames: ["hai_refresh"] });
    expect(credentials).toMatchObject({ access: token, refresh: "refresh-value", expires: exp * 1000, accountId: "account-1" });
    expect(websiteAccessToken(credentials)).toBe(token);
  });

  test("refreshes headlessly and saves a rotated refresh cookie", async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const credentials = await refreshWebsiteSso(
      { access: "old-token", refresh: "old-refresh", expires: Date.now() - 1, email: "test@example.invalid" },
      undefined,
      async (_input, init) => {
        expect(new Headers(init?.headers).get("Cookie")).toBe("hai_refresh=old-refresh");
        return new Response(JSON.stringify({ token: jwt(exp) }), {
          status: 200,
          headers: { "Content-Type": "application/json", "Set-Cookie": "hai_refresh=new-refresh; HttpOnly; Secure; Path=/" },
        });
      },
    );
    expect(credentials).toMatchObject({ access: jwt(exp), refresh: "new-refresh", expires: exp * 1000, email: "test@example.invalid" });
  });

  test("keeps the refresh cookie when the response does not rotate it", async () => {
    const credentials = await refreshWebsiteSso(
      { access: "old-token", refresh: "current-refresh", expires: 0 },
      undefined,
      async () => Response.json({ token: jwt(Math.floor(Date.now() / 1000) + 3600) }),
    );
    expect(credentials.refresh).toBe("current-refresh");
  });

  test("rejects unsafe cookie values before making a request", async () => {
    const callbacks: OAuthLoginCallbacks = {
      onAuth: () => {}, onPrompt: async () => "", onBrowserSession: async () => "bad; injected=yes",
      fetch: async () => { throw new Error("must not fetch"); },
    };
    await expect(loginWebsiteWithSso(callbacks, callbacks.onBrowserSession)).rejects.toThrow("invalid refresh cookie");
  });

  test("reports unauthorized refresh without exposing the cookie", async () => {
    await expect(refreshWebsiteSso(
      { access: "old-token", refresh: "secret-refresh", expires: 0 },
      undefined,
      async () => Response.json({ detail: "Website refresh session expired or revoked" }, { status: 401 }),
    )).rejects.toThrow("HepAI website SSO refresh failed with HTTP 401");
  });
});
