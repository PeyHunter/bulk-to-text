import { strToU8, zipSync } from "fflate";

export type Status = "waiting" | "reading" | "done" | "failed";
export type Item = { id: string; name: string; status: Status; text: string; error: string; costUsd: number | null };

export type OcrAnswer = { ok: true; text: string; costUsd: number | null } | { ok: false; error: string; costUsd: number | null; retry: boolean };

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
/** "page 2" before "page 10". */
export const naturalOrder = (a: { name: string }, b: { name: string }) => collator.compare(a.name, b.name);

export const imageExtensions = ["jpg", "jpeg", "png", "webp", "heic", "heif", "gif", "avif"];
export const isImage = (file: File) => file.type.startsWith("image/") || imageExtensions.includes(extension(file.name));
const extension = (name: string) => name.split(".").pop()?.toLowerCase() ?? "";

/** Tries `send` once, then up to `retries` more times while the answer says to retry, waiting 2 s, 4 s, 8 s (plus a little jitter). */
export async function withRetries(send: () => Promise<OcrAnswer>, sleep: (ms: number) => Promise<void>, retries = 3): Promise<OcrAnswer & { spent: number | null }> {
  let spent: number | null = null;
  for (let attempt = 0; ; attempt++) {
    const answer = await send();
    if (answer.costUsd !== null) spent = (spent ?? 0) + answer.costUsd;
    if (answer.ok || !answer.retry || attempt >= retries) return { ...answer, spent };
    await sleep(2000 * 2 ** attempt + Math.random() * 500);
  }
}

/** Posts one image to the server. 429, 5xx and network failures are worth retrying; anything else is final. */
export async function sendImage(file: File, name: string): Promise<OcrAnswer> {
  const form = new FormData();
  form.set("image", file, name);
  let response: Response;
  try {
    response = await fetch("/api/ocr", { method: "POST", body: form });
  } catch {
    return { ok: false, error: "No connection to the server.", costUsd: null, retry: true };
  }
  const body = (await response.json().catch(() => ({}))) as { text?: string; error?: string; costUsd?: number | null };
  const costUsd = typeof body.costUsd === "number" ? body.costUsd : null;
  if (response.ok && typeof body.text === "string") return { ok: true, text: body.text, costUsd };
  if (response.status === 401) return { ok: false, error: "You were logged out. Reload the page and log in again.", costUsd, retry: false };
  return { ok: false, error: body.error ?? `Something went wrong (${response.status}).`, costUsd, retry: response.status === 429 || response.status >= 500 };
}

/** Every image under its name, in order. Failed images are listed too, so none go missing unnoticed. */
export function combinedText(items: Item[]) {
  return items
    .filter((item) => item.status === "done" || item.status === "failed")
    .map((item) => {
      const body = item.status === "failed" ? `(Could not read this image: ${item.error})` : item.text || "(No text found)";
      return `===== ${item.name} =====\n\n${body}\n`;
    })
    .join("\n");
}

/** One .txt per read image, named after the image; folders are kept. */
export function zipOfTexts(items: Item[]) {
  const files: Record<string, Uint8Array> = {};
  for (const item of items) {
    if (item.status !== "done") continue;
    const base = item.name.replace(/\.[^./]+$/, "");
    let name = `${base}.txt`;
    for (let n = 2; name in files; n++) name = `${base} (${n}).txt`;
    files[name] = strToU8(item.text);
  }
  return zipSync(files);
}

export function formatUsd(amount: number) {
  return `$${amount.toFixed(amount < 1 ? 4 : 2)}`;
}
