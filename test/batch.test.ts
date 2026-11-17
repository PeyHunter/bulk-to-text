import { strFromU8, unzipSync } from "fflate";
import { describe, expect, test } from "vitest";
import { formatKroner, naturalOrder, withRetries, zipOfTexts, type Item, type OcrAnswer } from "../src/web/batch.ts";

const item = (name: string, change: Partial<Item> = {}): Item => ({ id: name, name, status: "done", text: `text of ${name}`, error: "", costUsd: null, ...change });

test("files sort in natural order", () => {
  const names = ["page 10.jpg", "Page 2.jpg", "page 1.jpg", "a/page 3.jpg"].map((name) => ({ name }));
  expect(names.sort(naturalOrder).map(({ name }) => name)).toEqual(["a/page 3.jpg", "page 1.jpg", "Page 2.jpg", "page 10.jpg"]);
});

describe("withRetries", () => {
  const busy: OcrAnswer = { ok: false, error: "busy", costUsd: null, retry: true };
  const run = async (answers: OcrAnswer[]) => {
    const waits: number[] = [];
    let calls = 0;
    const result = await withRetries(async () => answers[Math.min(calls++, answers.length - 1)]!, async (ms) => void waits.push(ms));
    return { result, calls, waits };
  };

  test("retries busy answers with growing waits, then succeeds", async () => {
    const { result, calls, waits } = await run([busy, busy, { ok: true, text: "hej", costUsd: 0.01 }]);
    expect(result).toMatchObject({ ok: true, text: "hej", spent: 0.01 });
    expect(calls).toBe(3);
    expect(waits[1]! > waits[0]!).toBe(true);
  });

  test("gives up after three retries", async () => {
    const { result, calls } = await run([busy]);
    expect(result.ok).toBe(false);
    expect(calls).toBe(4);
  });

  test("does not retry a final failure", async () => {
    const { calls } = await run([{ ok: false, error: "not an image", costUsd: null, retry: false }]);
    expect(calls).toBe(1);
  });
});

test("cost shows in kroner the Danish way", () => {
  expect(formatKroner(0.0348, 6.9).replace(/\s/g, " ")).toBe("ca. 0,24 kr.");
});

test("the zip has one .txt per read image, with clashing names kept apart", () => {
  const files = unzipSync(zipOfTexts([item("scan/1.jpg"), item("scan/1.png"), item("2.heic"), item("3.jpg", { status: "failed" })]));
  expect(Object.keys(files)).toEqual(["scan/1.txt", "scan/1 (2).txt", "2.txt"]);
  expect(strFromU8(files["2.txt"]!)).toBe("text of 2.heic");
});
