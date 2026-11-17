import Anthropic from "@anthropic-ai/sdk";
import decodeHeic from "heic-decode";
import sharp from "sharp";

export type OcrConfig = { client: Anthropic; model: string };
export type Usage = { inputTokens: number; outputTokens: number };
export type OcrResult =
  | { ok: true; text: string; usage: Usage; costUsd: number | null }
  | { ok: false; status: 422 | 429 | 500 | 502 | 503; error: string; usage?: Usage; costUsd?: number | null };

/** US dollars per million tokens, input and output. */
export const prices: Record<string, { input: number; output: number }> = {
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
};

export const instruction = [
  "Transcribe all text in this image exactly as it appears.",
  "Keep the original line breaks and reading order.",
  "The text can be in any language, often Danish. Do not translate or correct it.",
  "Reply with only the text: no commentary, no quotes, no formatting.",
  "If the image has no text, reply with nothing at all.",
].join(" ");

const maxSide = 2000;
// The API takes images up to 5 MB; bigger ones are re-encoded as JPEG.
const maxSentBytes = 4 * 1024 * 1024;

/** Undefined while ANTHROPIC_API_KEY is not set, so the app can run and say reading isn't set up yet. */
export function ocrConfig(env: NodeJS.ProcessEnv): OcrConfig | undefined {
  if (!env.ANTHROPIC_API_KEY) return undefined;
  return {
    // The browser retries busy and failed images with backoff, so the SDK must not also retry.
    client: new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, baseURL: env.ANTHROPIC_BASE_URL || undefined, maxRetries: 0 }),
    model: env.OCR_MODEL || "claude-opus-5-5",
  };
}

export function costUsd(model: string, usage: Usage): number | null {
  const price = prices[model];
  if (!price) return null;
  return (usage.inputTokens * price.input + usage.outputTokens * price.output) / 1_000_000;
}

type Prepared = { mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif"; data: Buffer };

/** Sends the original when the API can take it as is; otherwise an upright JPEG at most 2000 px on the long side. HEIC is decoded first. */
export async function prepareImage(bytes: Uint8Array): Promise<Prepared | undefined> {
  let image = sharp(bytes, { failOn: "error" });
  let meta = await image.metadata().catch(() => undefined);
  if (!meta) return undefined;
  if (meta.format === "heif") {
    // The prebuilt sharp reads HEIC headers but cannot decode HEVC, which iPhone photos use. AVIF still works in sharp.
    const decoded = await decodeHeic({ buffer: bytes }).catch(() => undefined);
    if (decoded) {
      image = sharp(decoded.data, { raw: { width: decoded.width, height: decoded.height, channels: 4 } });
      meta = await image.metadata();
    }
  }
  const sendable = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" } as const;
  const mediaType = sendable[meta.format as keyof typeof sendable];
  const longSide = Math.max(meta.autoOrient?.width ?? meta.width ?? 0, meta.autoOrient?.height ?? meta.height ?? 0);
  const upright = !meta.orientation || meta.orientation === 1;
  if (mediaType && upright && longSide <= maxSide && bytes.byteLength <= maxSentBytes) return { mediaType, data: Buffer.from(bytes) };
  try {
    const data = await image.rotate().resize({ width: maxSide, height: maxSide, fit: "inside", withoutEnlargement: true }).flatten({ background: "#ffffff" }).jpeg({ quality: 88 }).toBuffer();
    return { mediaType: "image/jpeg", data };
  } catch {
    return undefined;
  }
}

export async function readImageText(config: OcrConfig | undefined, bytes: Uint8Array): Promise<OcrResult> {
  if (!config) return { ok: false, status: 503, error: "Reading text isn't set up yet." };
  const image = await prepareImage(bytes);
  if (!image) return { ok: false, status: 422, error: "This file could not be opened as an image." };
  let message: Anthropic.Beta.Messages.BetaMessage;
  try {
    message = await config.client.beta.messages.create({
      model: config.model,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low" },
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data.toString("base64") } },
            { type: "text", text: instruction },
          ],
        },
      ],
    });
  } catch (error) {
    // Status only: never the key or the image.
    const status = error instanceof Anthropic.APIError ? error.status : undefined;
    console.error(JSON.stringify({ event: "ocr-failed", model: config.model, status: status ?? (error as Error).name }));
    if (error instanceof Anthropic.RateLimitError) return { ok: false, status: 429, error: "Claude is busy. Trying again shortly." };
    if (error instanceof Anthropic.APIConnectionError || (status !== undefined && status >= 500)) {
      return { ok: false, status: 502, error: "Claude had a problem. Try again." };
    }
    return { ok: false, status: 500, error: "Claude refused the request. The API key may be wrong." };
  }
  // A fallback model may have served the reply; it bills at its own price.
  const fallback = message.content.findLast((block) => block.type === "fallback");
  const servedBy = fallback && prices[fallback.to.model] ? fallback.to.model : config.model;
  const usage = { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens };
  const cost = costUsd(servedBy, usage);
  console.log(JSON.stringify({ event: "ocr", model: servedBy, ...usage, costUsd: cost, stopReason: message.stop_reason }));
  if (message.stop_reason === "refusal") {
    return { ok: false, status: 422, error: "Claude would not read this image.", usage, costUsd: cost };
  }
  const text = message.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
  return { ok: true, text, usage, costUsd: cost };
}
