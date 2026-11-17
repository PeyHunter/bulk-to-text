import type { Item } from "./batch.ts";

export type Format = "docx" | "pdf" | "txt";
export const formats: { value: Format; label: string }[] = [
  { value: "docx", label: "Word (.docx)" },
  { value: "pdf", label: "PDF (.pdf)" },
  { value: "txt", label: "Text (.txt)" },
];

/** What goes in the one download: every read image in list order, then the ones left out and why. */
export type Collected = { sections: { name: string; text: string }[]; leftOut: string[] };

export function collect(items: Item[], skippedFiles: string[] = []): Collected {
  const sections = items.filter((item) => item.status === "done").map((item) => ({ name: item.name, text: item.text.replace(/\r\n?/g, "\n") || "(No text found)" }));
  const leftOut = [
    ...items.filter((item) => item.status === "failed").map((item) => `${item.name} (could not be read)`),
    ...items.filter((item) => item.status === "waiting" || item.status === "reading").map((item) => `${item.name} (not read yet)`),
    ...skippedFiles.map((name) => `${name} (not an image)`),
  ];
  return { sections, leftOut };
}

const leftOutHeading = "Not included";

export function asText({ sections, leftOut }: Collected) {
  const parts = sections.map(({ name, text }) => `===== ${name} =====\n\n${text}\n`);
  if (leftOut.length) parts.push(`===== ${leftOutHeading} =====\n\n${leftOut.map((line) => `- ${line}`).join("\n")}\n`);
  return parts.join("\n");
}

export async function asDocx({ sections, leftOut }: Collected): Promise<Uint8Array> {
  const { Document, HeadingLevel, Packer, Paragraph } = await import("docx");
  const heading = (text: string) => new Paragraph({ text, heading: HeadingLevel.HEADING_2, spacing: { before: 360, after: 120 } });
  const lines = (text: string) => text.split("\n").map((line) => new Paragraph({ text: line, spacing: { after: 0 } }));
  const children = sections.flatMap(({ name, text }) => [heading(name), ...lines(text)]);
  if (leftOut.length) children.push(heading(leftOutHeading), ...leftOut.map((line) => new Paragraph({ text: line, bullet: { level: 0 } })));
  const document = new Document({
    creator: "Bulk to Text",
    styles: { default: { document: { run: { font: "Calibri", size: 22 } } } },
    sections: [{ children }],
  });
  return new Uint8Array(await Packer.toArrayBuffer(document));
}

export type PdfFonts = { regular: ArrayBuffer | Uint8Array; bold: ArrayBuffer | Uint8Array };

/** Plex Sans ships with the page so Danish letters come out right; it is fetched only when a PDF is made. */
export async function loadPdfFonts(): Promise<PdfFonts> {
  const get = (url: URL) => fetch(url).then((response) => response.arrayBuffer());
  const [regular, bold] = await Promise.all([
    get(new URL("./fonts/IBMPlexSans-Regular.ttf", import.meta.url)),
    get(new URL("./fonts/IBMPlexSans-SemiBold.ttf", import.meta.url)),
  ]);
  return { regular, bold };
}

export async function asPdf({ sections, leftOut }: Collected, fonts: PdfFonts): Promise<Uint8Array> {
  const [{ PDFDocument, rgb }, { default: fontkit }] = await Promise.all([import("pdf-lib"), import("@pdf-lib/fontkit")]);
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  pdf.setTitle("Bulk to Text");
  const regular = await pdf.embedFont(fonts.regular, { subset: true });
  const bold = await pdf.embedFont(fonts.bold, { subset: true });

  const [pageWidth, pageHeight] = [595.28, 841.89]; // A4
  const margin = 56;
  const width = pageWidth - 2 * margin;
  const body = { font: regular, size: 10.5, leading: 15 };
  const head = { font: bold, size: 12.5, leading: 18 };
  const ink = rgb(0.1, 0.11, 0.13);

  let page = pdf.addPage([pageWidth, pageHeight]);
  let y = pageHeight - margin;
  const room = (height: number) => {
    if (y - height >= margin + 20) return;
    page = pdf.addPage([pageWidth, pageHeight]);
    y = pageHeight - margin;
  };
  // Characters the font has no glyph for (emoji and the like) would stop pdf-lib, so they become "?".
  const glyphs = new Map([regular, bold].map((font) => [font, new Set(font.getCharacterSet())]));
  const printable = (font: typeof regular, text: string) =>
    [...text.replace(/\t/g, "    ")].map((char) => (glyphs.get(font)!.has(char.codePointAt(0)!) ? char : "?")).join("");
  // Measuring whole strings runs a full text layout each time (about 1 ms); summed character widths are close enough to wrap by.
  const advances = new Map<string, number>();
  const measure = (style: typeof body, text: string) => {
    let total = 0;
    for (const char of text) {
      const key = `${style.font === bold ? "b" : "r"}${char}`;
      let advance = advances.get(key);
      if (advance === undefined) advances.set(key, (advance = style.font.widthOfTextAtSize(char, 1)));
      total += advance;
    }
    return total * style.size;
  };
  const wrap = (style: typeof body, text: string) => {
    const out: string[] = [];
    let line = "";
    for (const word of text.split(/(?<= )/)) {
      if (measure(style, line + word.trimEnd()) <= width) line += word;
      else if (measure(style, word.trimEnd()) <= width) (out.push(line.trimEnd()), (line = word));
      else {
        if (line) out.push(line.trimEnd());
        line = "";
        for (const char of word) {
          if (measure(style, line + char) > width) (out.push(line), (line = ""));
          line += char;
        }
      }
    }
    out.push(line.trimEnd());
    return out;
  };
  const write = (style: typeof body, text: string) => {
    for (const line of wrap(style, printable(style.font, text))) {
      room(style.leading);
      y -= style.leading;
      if (line) page.drawText(line, { x: margin, y, font: style.font, size: style.size, color: ink });
    }
  };
  const section = (title: string, lines: string[]) => {
    if (y < pageHeight - margin) y -= 14;
    room(head.leading + body.leading * 2); // keep a heading with its first lines
    write(head, title);
    y -= 4;
    for (const line of lines) write(body, line);
  };

  for (const { name, text } of sections) section(name, text.split("\n"));
  if (leftOut.length) section(leftOutHeading, leftOut.map((line) => `• ${line}`));

  const pages = pdf.getPages();
  pages.forEach((each, index) => {
    const label = `${index + 1} / ${pages.length}`;
    each.drawText(label, { x: (pageWidth - regular.widthOfTextAtSize(label, 9)) / 2, y: margin / 2, font: regular, size: 9, color: rgb(0.45, 0.47, 0.52) });
  });
  return pdf.save();
}

export function fileName(format: Format, today = new Date()) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `bulk-to-text-${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}.${format}`;
}

export const mimeTypes: Record<Format, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
  txt: "text/plain;charset=utf-8",
};

export async function build(format: Format, collected: Collected): Promise<BlobPart> {
  if (format === "txt") return asText(collected);
  if (format === "docx") return (await asDocx(collected)) as BlobPart;
  return (await asPdf(collected, await loadPdfFonts())) as BlobPart;
}
