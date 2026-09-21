import { describe, expect, test } from "bun:test";
import type { OAuthLoginCallbacks } from "@oh-my-pi/pi-ai/oauth/types";
import {
  loginPortalWithSso,
  portalAccessToken,
} from "../portal-auth.ts";

function jwt(exp = Math.floor(Date.now() / 1_000) + 3_600): string {
  const payload = btoa(JSON.stringify({ exp })).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  return `header.${payload}.signature`;
}

describe("HepAI Portal authentication", () => {
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

  test("uses the narrow production self-query workaround after the exact 422", async () => {
    const urls: string[] = [];
    const callbacks: OAuthLoginCallbacks = {
      onAuth: () => {},
      onPrompt: async () => "",
      onBrowserSession: async () => "cookie-value",
      fetch: async input => {
        urls.push(String(input));
        if (urls.length === 1) {
          return Response.json({
            detail: [{ type: "missing", loc: ["query", "self"], msg: "Field required", input: null }],
          }, { status: 422 });
        }
        return Response.json({ access_token: jwt() });
      },
    };
    const credentials = await loginPortalWithSso(callbacks);
    expect(credentials.access).toStartWith("header.");
    expect(urls).toEqual([
      "https://aiapi.ihep.ac.cn/apiv2/portal/user/refresh",
      "https://aiapi.ihep.ac.cn/apiv2/portal/user/refresh?self=1",
    ]);
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

  test("turns browser proxy failures into actionable SSO diagnostics", async () => {
    const callbacks: OAuthLoginCallbacks = {
      onAuth: () => {},
      onPrompt: async () => "",
      onBrowserSession: async () => {
        throw new Error("net::ERR_CONNECTION_CLOSED at https://aiapi.ihep.ac.cn/apiv2/portal/user/login_sso");
      },
    };
    await expect(loginPortalWithSso(callbacks)).rejects.toThrow(
      "Check the system browser proxy or bypass aiapi.ihep.ac.cn and newlogin.ihep.ac.cn",
    );
  });

});
