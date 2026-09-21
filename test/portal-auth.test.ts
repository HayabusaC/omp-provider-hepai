import { describe, expect, test } from "bun:test";
import type { OAuthLoginCallbacks } from "@oh-my-pi/pi-ai/oauth/types";
import {
  loginPortalWithPassword,
  loginPortalWithSso,
  portalAccessToken,
} from "../portal-auth.ts";

function jwt(exp = Math.floor(Date.now() / 1_000) + 3_600): string {
  const payload = btoa(JSON.stringify({ exp })).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  return `header.${payload}.signature`;
}

describe("HepAI Portal authentication", () => {
  test("password login requests masked input and persists a refresh secret", async () => {
    const prompts: Array<{ message: string; placeholder?: string; secret?: boolean }> = [];
    const callbacks: OAuthLoginCallbacks = {
      onAuth: () => {},
      onPrompt: async prompt => {
        prompts.push(prompt);
        return prompt.secret ? "correct horse battery staple" : "alice";
      },
      fetch: (async (input, init) => {
        expect(String(input)).toBe("https://aiapi.ihep.ac.cn/apiv2/portal/user/login");
        expect(init?.method).toBe("POST");
        expect(String(init?.body)).toBe("username=alice&password=correct+horse+battery+staple");
        return Response.json({ access_token: jwt(), user: { id: "user-1", email: "alice@ihep.ac.cn" } });
      }) as typeof fetch,
    };

    const credentials = await loginPortalWithPassword(callbacks);
    expect(prompts).toEqual([
      { message: "HepAI Portal username:", placeholder: "username" },
      { message: "HepAI Portal password:", secret: true },
    ]);
    expect(credentials.refresh).toContain("correct horse battery staple");
    expect(credentials.email).toBe("alice@ihep.ac.cn");
    expect(portalAccessToken(credentials)).toBe(credentials.access);
  });

  test("SSO captures only the refresh cookie and exchanges it for a JWT", async () => {
    let browserRequest: unknown;
    const callbacks: OAuthLoginCallbacks = {
      onAuth: () => {},
      onPrompt: async () => { throw new Error("SSO must not request local credentials"); },
      onBrowserSession: async request => {
        browserRequest = request;
        return "cookie-value";
      },
      fetch: (async (input, init) => {
        expect(String(input)).toBe("https://aiapi.ihep.ac.cn/apiv2/portal/user/refresh");
        expect(new Headers(init?.headers).get("Cookie")).toBe("refresh-token=cookie-value");
        return Response.json({ access_token: jwt() });
      }) as typeof fetch,
    };

    const credentials = await loginPortalWithSso(callbacks);
    expect(browserRequest).toEqual({
      url: "https://aiapi.ihep.ac.cn/apiv2/portal/user/login_sso",
      cookieNames: ["refresh-token"],
    });
    expect(credentials.refresh).toBe("cookie-value");
    expect(credentials.access).toStartWith("header.");
  });

  test("rejects unsafe SSO cookie values", async () => {
    const callbacks: OAuthLoginCallbacks = {
      onAuth: () => {},
      onPrompt: async () => "",
      onBrowserSession: async () => "cookie; injected=true",
      fetch: fetch,
    };
    await expect(loginPortalWithSso(callbacks)).rejects.toThrow("invalid refresh cookie");
  });
});
