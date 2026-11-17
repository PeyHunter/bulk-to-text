import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { strFromU8, unzipSync } from "fflate";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import { e2ePassword } from "./env.ts";

const png = async (width: number) => (await sharp({ create: { width, height: 30, channels: 3, background: "#ffffff" } }).png().toBuffer()).toString("base64");

test("log in, drop three images, download all the text", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Password").fill("wrong");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("alert")).toHaveText("Wrong password.");
  await page.getByLabel("Password").fill(e2ePassword!);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByText("Drop images or a whole folder here")).toBeVisible();

  // Dropped out of order and with a file that isn't an image; the list comes out in natural order.
  const files = [
    { name: "side 10.png", data: await png(110) },
    { name: "side 2.png", data: await png(102) },
    { name: "side 1.png", data: await png(101) },
    { name: "notes.txt", data: Buffer.from("hej").toString("base64") },
  ];
  const transfer = await page.evaluateHandle((files) => {
    const transfer = new DataTransfer();
    for (const { name, data } of files) {
      const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
      transfer.items.add(new File([bytes], name, { type: name.endsWith(".png") ? "image/png" : "text/plain" }));
    }
    return transfer;
  }, files);
  await page.locator("main").dispatchEvent("drop", { dataTransfer: transfer });

  await expect(page.getByText("Skipped 1 file that isn't an image.")).toBeVisible();
  await expect(page.getByTestId("progress")).toHaveText("3 of 3 done", { timeout: 20_000 });
  const results = page.getByTestId("result");
  await expect(results).toHaveCount(3);
  await expect(results.nth(0)).toContainText("side 1.png");
  await expect(results.nth(0)).toContainText("Billede 101 px bredt");
  await expect(results.nth(2)).toContainText("Billede 110 px bredt");
  // Three reads of 1000 in and 20 out on claude-opus-5-5.
  // $0.0132 at the default rate of 6.9 kroner.
  await expect(page.getByTestId("total-cost")).toHaveText("Cost so far: ca. 0,09 kr.");

  const downloadAs = async (format: string) => {
    await page.getByLabel("File type").selectOption(format);
    const downloading = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download all" }).click();
    const download = await downloading;
    expect(download.suggestedFilename()).toMatch(new RegExp(`^bulk-to-text-\\d{4}-\\d{2}-\\d{2}\\.${format}$`));
    return readFile((await download.path())!);
  };

  // Word is the default.
  await expect(page.getByLabel("File type")).toHaveValue("docx");
  const xml = strFromU8(unzipSync(new Uint8Array(await downloadAs("docx")))["word/document.xml"]!);
  expect(xml.indexOf("side 1.png")).toBeLessThan(xml.indexOf("side 10.png"));
  expect(xml).toContain("Billede 110 px bredt");

  const pdf = await PDFDocument.load(await downloadAs("pdf"));
  expect(pdf.getPageCount()).toBe(1);

  const text = (await downloadAs("txt")).toString("utf8");
  expect(text).toBe(
    ["side 1.png", "side 2.png", "side 10.png"]
      .map((name) => `===== ${name} =====\n\nBillede ${100 + Number(name.match(/\d+/)![0])} px bredt\nAnden linje\n`)
      .join("\n") + "\n===== Not included =====\n\n- notes.txt (not an image)\n",
  );
});
