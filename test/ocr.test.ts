import Anthropic from "@anthropic-ai/sdk";
import sharp from "sharp";
import { afterEach, describe, expect, test, vi } from "vitest";
import { costUsd, instruction, prepareImage, readImageText, type OcrConfig } from "../src/server/ocr.ts";
import { errorReply, messageReply, startFakeAnthropic, type Reply } from "./support/fake-anthropic.ts";
import { tinyPng } from "./support/images.ts";

let close: (() => Promise<void>) | undefined;
afterEach(() => close?.());
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});

async function fake(answer: (index: number) => Reply, model = "claude-opus-5-5") {
  const server = await startFakeAnthropic((_, index) => answer(index));
  close = server.close;
  const config: OcrConfig = { client: new Anthropic({ apiKey: "test-key", baseURL: server.url, maxRetries: 0 }), model };
  return { server, config };
}

describe("readImageText", () => {
  test("sends the image with the key, low effort and fallbacks, and returns text, usage and cost", async () => {
    const { server, config } = await fake(() => messageReply("Hej verden\nLinje to\n", { inputTokens: 1000, outputTokens: 50 }));
    const png = await tinyPng();
    const result = await readImageText(config, png);
    expect(result).toEqual({ ok: true, text: "Hej verden\nLinje to", usage: { inputTokens: 1000, outputTokens: 50 }, costUsd: (1000 * 4 + 50 * 20) / 1e6 });
    const [request] = server.requests;
    expect(request?.path).toMatch(/^\/v1\/messages/);
    expect(request?.apiKey).toBe("test-key");
    expect(request?.beta).toContain("server-side-fallback-2026-07-01");
    expect(request?.body).toMatchObject({ model: "claude-opus-5-5", max_tokens: 16000, fallbacks: "default", output_config: { effort: "low" } });
    expect(request?.body).not.toHaveProperty("thinking");
    expect(request?.body).not.toHaveProperty("temperature");
    expect(request?.body.messages[0].content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } },
      { type: "text", text: instruction },
    ]);
  });

  test("a 429 stays a 429 so the browser can retry", async () => {
    const { config } = await fake(() => errorReply(429, "rate_limit_error"));
    expect(await readImageText(config, await tinyPng())).toMatchObject({ ok: false, status: 429 });
  });

  test("server errors become 502, other API errors 500", async () => {
    const { config } = await fake((index) => (index === 0 ? errorReply(529, "overloaded_error") : errorReply(401, "authentication_error")));
    expect(await readImageText(config, await tinyPng())).toMatchObject({ ok: false, status: 502 });
    expect(await readImageText(config, await tinyPng())).toMatchObject({ ok: false, status: 500 });
  });

  test("an image with no text gives an empty string", async () => {
    const { config } = await fake(() => messageReply(""));
    expect(await readImageText(config, await tinyPng())).toMatchObject({ ok: true, text: "" });
  });

  test("a refusal is a failed image, with its cost", async () => {
    const { config } = await fake(() => messageReply("", { stopReason: "refusal", inputTokens: 100, outputTokens: 0 }));
    expect(await readImageText(config, await tinyPng())).toMatchObject({ ok: false, status: 422, costUsd: 0.0004 });
  });

  test("a reply served by a fallback model is priced at that model", async () => {
    const content = [
      { type: "fallback", from: { model: "claude-opus-5-5" }, to: { model: "claude-sonnet-5-5" }, trigger: { type: "refusal" } },
      { type: "text", text: "Tekst" },
    ];
    const { config } = await fake(() => messageReply("", { content, inputTokens: 1_000_000, outputTokens: 0 }));
    expect(await readImageText(config, await tinyPng())).toMatchObject({ ok: true, text: "Tekst", costUsd: 2 });
  });

  test("a file that isn't an image is refused without calling the API", async () => {
    const { server, config } = await fake(() => messageReply("x"));
    expect(await readImageText(config, new TextEncoder().encode("not an image"))).toMatchObject({ ok: false, status: 422 });
    expect(server.requests).toHaveLength(0);
  });

  test("without a key it says reading isn't set up", async () => {
    expect(await readImageText(undefined, await tinyPng())).toMatchObject({ ok: false, status: 503 });
  });
});

describe("prepareImage", () => {
  test("small JPEG, PNG and WebP go as they are", async () => {
    const png = await tinyPng();
    expect(await prepareImage(png)).toEqual({ mediaType: "image/png", data: png });
    const webp = await sharp(png).webp().toBuffer();
    expect((await prepareImage(webp))?.mediaType).toBe("image/webp");
  });

  test("big images shrink to a 2000 px JPEG", async () => {
    const big = await tinyPng(3000, 1500);
    const prepared = await prepareImage(big);
    expect(prepared?.mediaType).toBe("image/jpeg");
    const meta = await sharp(prepared!.data).metadata();
    expect([meta.width, meta.height]).toEqual([2000, 1000]);
  });

  test("turned photos are made upright", async () => {
    const turned = await sharp(await tinyPng(40, 20)).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const meta = await sharp((await prepareImage(turned))!.data).metadata();
    expect([meta.width, meta.height]).toEqual([20, 40]);
  });
});

test("cost is unknown for a model not in the price table", () => {
  expect(costUsd("claude-something-else", { inputTokens: 1, outputTokens: 1 })).toBeNull();
  expect(costUsd("claude-haiku-5-5", { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBeCloseTo(0.6);
});
