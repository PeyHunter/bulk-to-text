import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Context } from "hono";
import { createApp } from "./app.ts";
import { ocrConfig } from "./ocr.ts";

function fail(message: string): never {
  console.error(`bulk-to-text cannot start: ${message}`);
  process.exit(1);
}

const env = process.env;
const production = env.NODE_ENV === "production";
if (!env.APP_PASSWORD) fail("APP_PASSWORD is not set. It is the one password everyone logs in with.");
if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) fail("SESSION_SECRET must be set to at least 32 random characters.");
const port = Number(env.PORT ?? 3000);
const ocr = ocrConfig(env);
if (!ocr) console.log("ANTHROPIC_API_KEY is not set: the app runs, but cannot read text from images.");

const app = createApp({ password: env.APP_PASSWORD, sessionSecret: env.SESSION_SECRET, ocr, secure: production, now: () => new Date() });
// Built files carry a hash in their name, so they never change; the page itself must be asked for again each time.
const cacheRules = (path: string, c: Context) =>
  c.header("cache-control", /\/assets\//.test(path) ? "public, max-age=31536000, immutable" : "no-cache");
app.use("*", serveStatic({ root: "dist/web", onFound: cacheRules }));
app.get("*", serveStatic({ path: "dist/web/index.html", onFound: cacheRules }));

const server = serve({ fetch: app.fetch, port }, (info) => console.log(`bulk-to-text listening on :${info.port}`));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
