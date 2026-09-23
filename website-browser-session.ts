import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { LoginCancelledError } from "@oh-my-pi/pi-ai/error";
import type { OAuthBrowserSessionRequest } from "@oh-my-pi/pi-ai/oauth/types";
import { gracefulKillTreeOnce } from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import { ensureChromiumExecutable, loadPuppeteer, removeUserDataDir } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { withTimeout } from "@oh-my-pi/pi-utils";
import { untilAborted } from "@oh-my-pi/pi-utils/abortable";
import type { Browser } from "puppeteer-core";
import { HEPAI_WEBSITE_LOGIN_URL, HEPAI_WEBSITE_ORIGIN } from "./endpoints.ts";

const REFRESH_COOKIE_URL = `${HEPAI_WEBSITE_ORIGIN}/api/v1/auths/refresh`;
const LOGIN_TIMEOUT_MS = 5 * 60_000;

/** OMP's generic capture checks cookies against the login URL; hai_refresh is scoped to the refresh URL. */
export async function captureWebsiteBrowserSession(
  request: OAuthBrowserSessionRequest,
  signal?: AbortSignal,
): Promise<string> {
  if (request.url !== HEPAI_WEBSITE_LOGIN_URL || !request.cookieNames.includes("hai_refresh")) {
    throw new Error("Unexpected HepAI website browser-session request");
  }
  if (signal?.aborted) throw new LoginCancelledError();

  const timeout = AbortSignal.timeout(LOGIN_TIMEOUT_MS);
  const lifetime = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const closed = new AbortController();
  const waiting = AbortSignal.any([lifetime, closed.signal]);
  let browser: Browser | undefined;
  let userDataDir: string | undefined;
  try {
    const [puppeteer, executablePath] = await untilAborted(lifetime, () =>
      Promise.all([loadPuppeteer(), ensureChromiumExecutable()]),
    );
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-hepai-sso-"));
    lifetime.throwIfAborted();
    browser = await puppeteer.launch({
      executablePath,
      headless: false,
      defaultViewport: null,
      pipe: true,
      ignoreDefaultArgs: ["--no-sandbox", "--disable-setuid-sandbox", "--ignore-certificate-errors"],
      args: [`--user-data-dir=${userDataDir}`],
      signal: lifetime,
      timeout: 30_000,
    });
    lifetime.throwIfAborted();
    browser.once("disconnected", () => closed.abort());
    const context = await untilAborted(waiting, () => browser!.createBrowserContext());
    const page = await untilAborted(waiting, () => context.newPage());
    page.once("close", () => closed.abort());
    await untilAborted(waiting, () => page.goto(request.url, { waitUntil: "domcontentloaded", timeout: 30_000 }));
    await untilAborted(waiting, () => page.bringToFront());
    const cdp = await untilAborted(waiting, () => page.createCDPSession());
    while (true) {
      const { cookies } = await untilAborted(waiting, () => cdp.send("Network.getCookies", { urls: [REFRESH_COOKIE_URL] }));
      waiting.throwIfAborted();
      const cookie = cookies.find(candidate => candidate.name === "hai_refresh" && candidate.value);
      if (cookie) return cookie.value;
      await untilAborted(waiting, () => Bun.sleep(250));
    }
  } catch (error) {
    if (signal?.aborted) throw new LoginCancelledError();
    if (timeout.aborted) throw new Error("HepAI website login timed out. Start login again.");
    if (closed.signal.aborted) throw new Error("Login window closed before HepAI website sign-in completed.");
    throw error;
  } finally {
    try {
      if (browser) {
        const pid = browser.process()?.pid;
        try {
          await withTimeout(browser.close(), 5_000, "Timed out closing HepAI sign-in browser");
        } catch {
          if (pid !== undefined) await gracefulKillTreeOnce(pid);
        }
      }
    } finally {
      if (userDataDir) await removeUserDataDir(userDataDir);
    }
  }
}
