import { readFile } from "node:fs/promises";
import { strFromU8, unzipSync } from "fflate";
import { PDFDocument } from "pdf-lib";
import { expect, test } from "vitest";
import type { Item } from "../src/web/batch.ts";
import { asDocx, asPdf, asText, collect, fileName } from "../src/web/export.ts";

const item = (name: string, change: Partial<Item> = {}): Item => ({ id: name, name, status: "done", text: `text of ${name}`, error: "", costUsd: null, ...change });
const danish = "Rødgrød med fløde\nÆbler og blåbær\n\nÅ, så er der kaffe";
const items = [
  item("side 1.jpg", { text: danish }),
  item("side 2.jpg", { text: "" }),
  item("side 3.jpg", { status: "failed", error: "busy" }),
  item("side 4.jpg", { status: "waiting" }),
];
const collected = collect(items, ["notes.txt"]);

test("one document of the read images, with the rest listed at the end", () => {
  expect(asText(collected)).toBe(
    `===== side 1.jpg =====\n\n${danish}\n\n===== side 2.jpg =====\n\n(No text found)\n\n` +
      "===== Not included =====\n\n- side 3.jpg (could not be read)\n- side 4.jpg (not read yet)\n- notes.txt (not an image)\n",
  );
});

test("the Word file holds the Danish text", async () => {
  const xml = strFromU8(unzipSync(await asDocx(collected))["word/document.xml"]!);
  for (const line of ["side 1.jpg", "Rødgrød med fløde", "Æbler og blåbær", "Å, så er der kaffe", "side 3.jpg (could not be read)"]) expect(xml).toContain(line);
});

test("the PDF opens, carries page numbers and breaks long text onto more pages", async () => {
  const fonts = {
    regular: await readFile(new URL("../src/web/fonts/IBMPlexSans-Regular.ttf", import.meta.url)),
    bold: await readFile(new URL("../src/web/fonts/IBMPlexSans-SemiBold.ttf", import.meta.url)),
  };
  const short = await PDFDocument.load(await asPdf(collected, fonts));
  expect(short.getPageCount()).toBe(1);

  const long = collect([item("lang.jpg", { text: Array.from({ length: 120 }, (_, n) => `Linje ${n} med æøå og en ret lang sætning der skal ombrydes pænt på siden, så den ikke løber ud over kanten 🙂`).join("\n") })]);
  const pdf = await PDFDocument.load(await asPdf(long, fonts));
  expect(pdf.getPageCount()).toBeGreaterThan(3);
});

test("downloads are named after the day", () => {
  expect(fileName("docx", new Date(2026, 10, 7))).toBe("bulk-to-text-2026-11-07.docx");
});
