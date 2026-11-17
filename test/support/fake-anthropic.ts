import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export type FakeRequest = { method: string; path: string; apiKey: string | undefined; beta: string | undefined; body: any };
export type Reply = { status: number; body: unknown };

/** A stand-in for POST /v1/messages. `answer` decides each reply; every request is kept in `requests`. */
export async function startFakeAnthropic(answer: (request: FakeRequest, index: number) => Reply | Promise<Reply>) {
  const requests: FakeRequest[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const request: FakeRequest = {
      method: req.method ?? "",
      path: req.url ?? "",
      // Current SDKs send the key as a bearer token, older ones as x-api-key.
      apiKey: (req.headers["x-api-key"] as string | undefined) ?? req.headers.authorization?.replace(/^Bearer /, ""),
      beta: req.headers["anthropic-beta"] as string | undefined,
      body: JSON.parse(Buffer.concat(chunks).toString() || "{}"),
    };
    requests.push(request);
    const reply = await answer(request, requests.length - 1);
    res.writeHead(reply.status, { "content-type": "application/json" });
    res.end(JSON.stringify(reply.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export function messageReply(text: string, { stopReason = "end_turn", inputTokens = 1500, outputTokens = 100, content }: { stopReason?: string; inputTokens?: number; outputTokens?: number; content?: unknown[] } = {}): Reply {
  return {
    status: 200,
    body: {
      id: "msg_fake",
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content: content ?? (text ? [{ type: "text", text }] : []),
      stop_reason: stopReason,
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    },
  };
}

export const errorReply = (status: number, type: string): Reply => ({ status, body: { type: "error", error: { type, message: type } } });
