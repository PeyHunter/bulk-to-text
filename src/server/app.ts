import { createHash, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getSignedCookie, setSignedCookie } from "hono/cookie";
import { readImageText, type OcrConfig } from "./ocr.ts";

export type AppDependencies = {
  password: string;
  sessionSecret: string;
  /** Undefined while ANTHROPIC_API_KEY is not set. */
  ocr: OcrConfig | undefined;
  /** Send the session cookie only over https. */
  secure: boolean;
  now: () => Date;
  /** Approximate rate the page uses to show cost in kroner; Anthropic bills in USD. */
  usdToDkk: number;
};

const minute = 60 * 1000;
const day = 24 * 60 * minute;
const sessionLifetime = 90 * day;
export const sessionCookie = "btt_session";
// The site is public with one shared password, so wrong tries are capped per address to slow down guessing.
const maxFailures = 10;
const failureWindow = 15 * minute;
const megabyte = 1024 * 1024;
export const maxImageBytes = 20 * megabyte;

const sha256 = (value: string) => createHash("sha256").update(value).digest();
const samePassword = (given: string, expected: string) => timingSafeEqual(sha256(given), sha256(expected));
// Traefik sets X-Forwarded-For; without it (tests, local runs) everyone shares one bucket.
const clientAddress = (c: Context) => c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "local";

export function createApp({ password, sessionSecret, ocr, secure, now, usdToDkk }: AppDependencies) {
  const app = new Hono();
  const failures = new Map<string, number[]>();

  const recentFailures = (address: string) => {
    const since = now().getTime() - failureWindow;
    const recent = (failures.get(address) ?? []).filter((time) => time > since);
    if (recent.length) failures.set(address, recent);
    else failures.delete(address);
    return recent;
  };

  app.get("/api/health", (c) => c.json({ ok: true, ocrReady: ocr !== undefined, usdToDkk }));

  app.post("/api/login", async (c) => {
    const address = clientAddress(c);
    if (recentFailures(address).length >= maxFailures) {
      return c.json({ error: "Too many wrong tries. Wait 15 minutes and try again." }, 429);
    }
    const body = (await c.req.json().catch(() => ({}))) as { password?: unknown };
    if (typeof body.password !== "string" || !samePassword(body.password, password)) {
      failures.set(address, [...recentFailures(address), now().getTime()]);
      return c.json({ error: "Wrong password." }, 401);
    }
    failures.delete(address);
    const expires = now().getTime() + sessionLifetime;
    await setSignedCookie(c, sessionCookie, String(expires), sessionSecret, {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      maxAge: sessionLifetime / 1000,
      secure,
    });
    return c.body(null, 204);
  });

  app.use("/api/*", async (c, next) => {
    const expires = await getSignedCookie(c, sessionSecret, sessionCookie);
    if (!expires || Number(expires) <= now().getTime()) return c.json({ error: "Not logged in." }, 401);
    await next();
  });

  app.get("/api/me", (c) => c.body(null, 204));

  app.post(
    "/api/ocr",
    // Room for the multipart wrapping around a 20 MB image.
    bodyLimit({ maxSize: maxImageBytes + megabyte, onError: (c) => c.json({ error: "This image is too big (over 20 MB)." }, 413) }),
    async (c) => {
      const body = await c.req.parseBody().catch(() => undefined);
      const image = body?.image;
      if (!(image instanceof File)) return c.json({ error: "No image was sent." }, 400);
      if (image.size > maxImageBytes) return c.json({ error: "This image is too big (over 20 MB)." }, 413);
      const result = await readImageText(ocr, new Uint8Array(await image.arrayBuffer()));
      if (!result.ok) return c.json({ error: result.error, usage: result.usage, costUsd: result.costUsd }, result.status);
      return c.json({ text: result.text, usage: result.usage, costUsd: result.costUsd });
    },
  );

  return app;
}
