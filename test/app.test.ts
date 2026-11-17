import Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createApp, sessionCookie } from "../src/server/app.ts";
import type { OcrConfig } from "../src/server/ocr.ts";
import { errorReply, messageReply, startFakeAnthropic, type Reply } from "./support/fake-anthropic.ts";
import { tinyPng } from "./support/images.ts";

const password = "test-password";
let now = new Date("2026-01-01T00:00:00Z");
let close: (() => Promise<void>) | undefined;
afterEach(() => close?.());
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});

const makeApp = (ocr?: OcrConfig) => createApp({ password, sessionSecret: "s".repeat(32), ocr, secure: false, now: () => now, usdToDkk: 6.9 });

async function appWithFake(answer: () => Reply) {
  const server = await startFakeAnthropic(answer);
  close = server.close;
  return { server, app: makeApp({ client: new Anthropic({ apiKey: "k", baseURL: server.url, maxRetries: 0 }), model: "claude-opus-5-5" }) };
}

async function login(app: ReturnType<typeof makeApp>, given = password) {
  const response = await app.request("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: given }) });
  return { response, cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "" };
}

async function ocrRequest(cookie: string, file?: File) {
  file ??= new File([new Uint8Array(await tinyPng())], "side 1.png", { type: "image/png" });
  const form = new FormData();
  form.set("image", file);
  return { method: "POST", headers: { cookie }, body: form };
}

describe("login", () => {
  test("health is open and says whether OCR is ready", async () => {
    expect(await (await makeApp().request("/api/health")).json()).toEqual({ ok: true, ocrReady: false, usdToDkk: 6.9 });
    const ocr = { client: new Anthropic({ apiKey: "k" }), model: "claude-opus-5-5" };
    expect(await (await makeApp(ocr).request("/api/health")).json()).toEqual({ ok: true, ocrReady: true, usdToDkk: 6.9 });
  });

  test("the right password gives a session that opens the API", async () => {
    const app = makeApp();
    expect((await app.request("/api/me")).status).toBe(401);
    const { response, cookie } = await login(app);
    expect(response.status).toBe(204);
    expect(cookie).toMatch(new RegExp(`^${sessionCookie}=`));
    expect((await app.request("/api/me", { headers: { cookie } })).status).toBe(204);
  });

  test("a wrong password is refused, and so is a forged or expired cookie", async () => {
    const app = makeApp();
    expect((await login(app, "nope")).response.status).toBe(401);
    expect((await app.request("/api/me", { headers: { cookie: `${sessionCookie}=99999999999999.forged` } })).status).toBe(401);
    const { cookie } = await login(app);
    now = new Date(now.getTime() + 91 * 24 * 60 * 60 * 1000);
    expect((await app.request("/api/me", { headers: { cookie } })).status).toBe(401);
  });

  test("too many wrong tries locks that address for a while", async () => {
    const app = makeApp();
    for (let i = 0; i < 10; i++) expect((await login(app, "nope")).response.status).toBe(401);
    expect((await login(app)).response.status).toBe(429);
    now = new Date(now.getTime() + 16 * 60 * 1000);
    expect((await login(app)).response.status).toBe(204);
  });
});

describe("ocr", () => {
  test("needs a session", async () => {
    expect((await makeApp().request("/api/ocr", await ocrRequest(""))).status).toBe(401);
  });

  test("reads the text of one image, with tokens and cost", async () => {
    const { app } = await appWithFake(() => messageReply("Tekst", { inputTokens: 1000, outputTokens: 10 }));
    const { cookie } = await login(app);
    const response = await app.request("/api/ocr", await ocrRequest(cookie));
    expect(await response.json()).toEqual({ text: "Tekst", usage: { inputTokens: 1000, outputTokens: 10 }, costUsd: 0.0042 });
  });

  test("a file that isn't an image is refused", async () => {
    const { app, server } = await appWithFake(() => messageReply("x"));
    const { cookie } = await login(app);
    const response = await app.request("/api/ocr", await ocrRequest(cookie, new File(["%PDF"], "notes.pdf", { type: "application/pdf" })));
    expect(response.status).toBe(422);
    expect(server.requests).toHaveLength(0);
  });

  test("a 429 from the API reaches the browser as 429", async () => {
    const { app } = await appWithFake(() => errorReply(429, "rate_limit_error"));
    const { cookie } = await login(app);
    expect((await app.request("/api/ocr", await ocrRequest(cookie))).status).toBe(429);
  });

  test("without a key it answers 503", async () => {
    const app = makeApp();
    const { cookie } = await login(app);
    expect((await app.request("/api/ocr", await ocrRequest(cookie))).status).toBe(503);
  });
});
