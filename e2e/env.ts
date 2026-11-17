import { randomBytes } from "node:crypto";

// Made once in the Playwright runner when it loads the config; the server and the workers inherit them through env.
process.env.E2E_APP_PASSWORD ??= randomBytes(12).toString("hex");
process.env.E2E_SESSION_SECRET ??= randomBytes(32).toString("hex");

export const e2ePassword = process.env.E2E_APP_PASSWORD;
