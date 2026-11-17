import sharp from "sharp";
import { errorReply, messageReply, startFakeAnthropic } from "../test/support/fake-anthropic.ts";

// The real server, with the Anthropic API swapped for a fake that "reads" each image as a line naming its width.
// The first request is told the API is busy, so the browser's retry is exercised too.
const fake = await startFakeAnthropic(async (request, index) => {
  if (index === 0) return errorReply(429, "rate_limit_error");
  const image = request.body.messages[0].content[0].source.data as string;
  const { width } = await sharp(Buffer.from(image, "base64")).metadata();
  return messageReply(`Billede ${width} px bredt\nAnden linje`, { inputTokens: 1000, outputTokens: 20 });
});

process.env.ANTHROPIC_BASE_URL = fake.url;
process.env.ANTHROPIC_API_KEY = "e2e-fake-key";
process.env.APP_PASSWORD = process.env.E2E_APP_PASSWORD;
process.env.SESSION_SECRET = process.env.E2E_SESSION_SECRET;
await import("../src/server/main.ts");
