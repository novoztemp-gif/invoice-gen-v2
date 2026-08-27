import { readFile } from "fs/promises";
import path from "path";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { applyXlsmTemplate, templateHasVbaProject } from "./xlsmPackager";

const REAL_TEMPLATE_PATH = path.join(
  process.cwd(),
  "templates",
  "BLANK EXCEL.xlsm",
);

async function buildPlainXlsxBuffer(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Test Sheet");
  sheet.getCell("A1").value = "hello";
  return (await workbook.xlsx.writeBuffer()) as unknown as Buffer;
}

/** A synthetic template with no VBA project — mirrors the real supplied template's current state. */
async function buildBlankTemplateBuffer(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/></Types>`,
  );
  return zip.generateAsync({ type: "nodebuffer" }) as unknown as Buffer;
}

/** A synthetic template WITH a fake VBA project binary, for testing the copy/link logic. */
async function buildTemplateWithVbaBuffer(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/><Override PartName="/xl/vbaProject.bin" ContentType="application/vnd.ms-office.vbaProject"/></Types>`,
  );
  zip.file("xl/vbaProject.bin", Buffer.from("FAKE-VBA-BYTES-FOR-TEST"));
  return zip.generateAsync({ type: "nodebuffer" }) as unknown as Buffer;
}

describe("applyXlsmTemplate", () => {
  it("marks the workbook part as macro-enabled in [Content_Types].xml", async () => {
    const xlsxBuffer = await buildPlainXlsxBuffer();
    const templateBuffer = await buildBlankTemplateBuffer();
    const result = await applyXlsmTemplate(xlsxBuffer, templateBuffer);

    const zip = await JSZip.loadAsync(result);
    const contentTypes = await zip.file("[Content_Types].xml")!.async("string");
    expect(contentTypes).toContain(
      'PartName="/xl/workbook.xml" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"',
    );
    // The plain-xlsx content type must be gone, not just supplemented.
    expect(contentTypes).not.toContain(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
    );
  });

  it("preserves all original sheet data untouched", async () => {
    const xlsxBuffer = await buildPlainXlsxBuffer();
    const templateBuffer = await buildBlankTemplateBuffer();
    const result = await applyXlsmTemplate(xlsxBuffer, templateBuffer);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(result as any);
    expect(workbook.getWorksheet("Test Sheet")!.getCell("A1").value).toBe(
      "hello",
    );
  });

  it("when the template has no VBA project, the output has none either — but is still correctly typed as macro-enabled", async () => {
    const xlsxBuffer = await buildPlainXlsxBuffer();
    const templateBuffer = await buildBlankTemplateBuffer();
    const result = await applyXlsmTemplate(xlsxBuffer, templateBuffer);

    const zip = await JSZip.loadAsync(result);
    expect(zip.file("xl/vbaProject.bin")).toBeNull();
    const contentTypes = await zip.file("[Content_Types].xml")!.async("string");
    expect(contentTypes).toContain("macroEnabled");
  });

  it("when the template DOES have a VBA project, it gets copied into the output with matching content-type and relationship entries", async () => {
    const xlsxBuffer = await buildPlainXlsxBuffer();
    const templateBuffer = await buildTemplateWithVbaBuffer();
    const result = await applyXlsmTemplate(xlsxBuffer, templateBuffer);

    const zip = await JSZip.loadAsync(result);
    const vbaFile = zip.file("xl/vbaProject.bin");
    expect(vbaFile).not.toBeNull();
    const vbaContent = await vbaFile!.async("string");
    expect(vbaContent).toBe("FAKE-VBA-BYTES-FOR-TEST");

    const contentTypes = await zip.file("[Content_Types].xml")!.async("string");
    expect(contentTypes).toContain(
      'PartName="/xl/vbaProject.bin" ContentType="application/vnd.ms-office.vbaProject"',
    );

    const rels = await zip
      .file("xl/_rels/workbook.xml.rels")!
      .async("string");
    expect(rels).toContain("vbaProject.bin");
    expect(rels).toContain(
      "http://schemas.microsoft.com/office/2006/relationships/vbaProject",
    );
  });

  it("throws a clear error rather than silently producing a broken package when the input isn't a valid xlsx", async () => {
    const brokenZip = new JSZip();
    brokenZip.file("not-a-workbook.txt", "nope");
    const brokenBuffer = await brokenZip.generateAsync({ type: "nodebuffer" });
    const templateBuffer = await buildBlankTemplateBuffer();

    await expect(
      applyXlsmTemplate(brokenBuffer as any, templateBuffer),
    ).rejects.toThrow();
  });
});

describe("templateHasVbaProject", () => {
  it("returns false for a template with no VBA project", async () => {
    const templateBuffer = await buildBlankTemplateBuffer();
    expect(await templateHasVbaProject(templateBuffer)).toBe(false);
  });

  it("returns true for a template with a VBA project", async () => {
    const templateBuffer = await buildTemplateWithVbaBuffer();
    expect(await templateHasVbaProject(templateBuffer)).toBe(true);
  });
});

describe("applyXlsmTemplate — real supplied template integration", () => {
  it("Prompt 7: the real template now carries a genuinely compiled VBA project (manually compiled and embedded)", async () => {
    const templateBuffer = await readFile(REAL_TEMPLATE_PATH);
    const hasVba = await templateHasVbaProject(templateBuffer);
    // Was documented as blank through Prompt 6 — this flips to true now
    // that a real vbaProject.bin has been manually compiled into the
    // supplied template, exactly the signal this test was written to catch.
    expect(hasVba).toBe(true);
  });

  it("grafts the real vbaProject.bin binary into a generated workbook byte-for-byte, correctly wired", async () => {
    const xlsxBuffer = await buildPlainXlsxBuffer();
    const templateBuffer = await readFile(REAL_TEMPLATE_PATH);

    const result = await applyXlsmTemplate(xlsxBuffer, templateBuffer);
    const zip = await JSZip.loadAsync(result);

    const contentTypes = await zip.file("[Content_Types].xml")!.async("string");
    expect(contentTypes).toContain("application/vnd.ms-excel.sheet.macroEnabled.main+xml");
    expect(contentTypes).toContain(
      'PartName="/xl/vbaProject.bin" ContentType="application/vnd.ms-office.vbaProject"',
    );

    const rels = await zip.file("xl/_rels/workbook.xml.rels")!.async("string");
    expect(rels).toContain("vbaProject.bin");
    expect(rels).toContain("http://schemas.microsoft.com/office/2006/relationships/vbaProject");

    // The embedded binary in the generated workbook must be byte-identical
    // to the template's own compiled project — a graft, not a re-encoding.
    const templateZip = await JSZip.loadAsync(templateBuffer);
    const originalVba = await templateZip.file("xl/vbaProject.bin")!.async("nodebuffer");
    const graftedVba = await zip.file("xl/vbaProject.bin")!.async("nodebuffer");
    expect(graftedVba.equals(originalVba)).toBe(true);

    // Sanity-check the compiled binary actually contains the approved
    // procedures/modules, not some placeholder — module/procedure names
    // are stored as readable strings inside the OLE compound file.
    const asText = graftedVba.toString("latin1");
    for (const marker of ["SyncEngine", "clsSheetWatcher", "ThisWorkbook", "AddNewInvoice", "gSyncInProgress"]) {
      expect(asText).toContain(marker);
    }

    // Still a fully valid, openable workbook.
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(result as any);
    expect(workbook.getWorksheet("Test Sheet")).toBeDefined();
  });
});
