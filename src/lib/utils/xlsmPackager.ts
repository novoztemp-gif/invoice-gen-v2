import JSZip from "jszip";

/**
 * Turns a plain .xlsx buffer (as produced by ExcelJS, which has no concept
 * of macro-enabled workbooks) into a genuine macro-enabled .xlsm package,
 * by grafting the macro-enabled typing — and, once one exists, the actual
 * VBA project — from a real Excel-authored .xlsm template.
 *
 * Why a graft instead of asking ExcelJS to build directly inside the
 * template: ExcelJS has no XLSM support at all (confirmed: no vba/macro
 * reference anywhere in the library), and the template's own worksheet
 * content is just a disposable placeholder — the thing that actually makes
 * a package "macro-enabled" to Excel is (a) the workbook part's content
 * type in [Content_Types].xml and (b) an embedded xl/vbaProject.bin with a
 * matching relationship, not which tool authored the sheets/styles. So the
 * safe approach is: let ExcelJS build a complete, valid .xlsx normally,
 * then patch only the parts that declare "this is macro-enabled" onto it.
 *
 * The supplied template currently has no VBA project at all (confirmed:
 * no xl/vbaProject.bin part) — that's expected for this stage. This
 * function still produces a genuinely macro-enabled package: Excel opens
 * it as "Excel Macro-Enabled Workbook" with an empty macro project, ready
 * for a future template (with real VBA) to be dropped in without any
 * change to this function — the vbaProject.bin copy step below is already
 * conditional on the part actually existing.
 */

const CONTENT_TYPES_PATH = "[Content_Types].xml";
const WORKBOOK_XML_PATH = "xl/workbook.xml";
const WORKBOOK_RELS_PATH = "xl/_rels/workbook.xml.rels";
const VBA_PROJECT_PATH = "xl/vbaProject.bin";
const THIS_WORKBOOK_CODE_NAME = "ThisWorkbook";
const MACRO_ENABLED_WORKBOOK_CONTENT_TYPE =
  "application/vnd.ms-excel.sheet.macroEnabled.main+xml";
const VBA_PROJECT_CONTENT_TYPE = "application/vnd.ms-office.vbaProject";
const VBA_PROJECT_RELATIONSHIP_TYPE =
  "http://schemas.microsoft.com/office/2006/relationships/vbaProject";

function findVbaProjectPart(zip: JSZip): string | null {
  const direct = zip.file(VBA_PROJECT_PATH);
  if (direct) return VBA_PROJECT_PATH;
  // Defensive: some producers place it elsewhere under xl/ — search rather
  // than assume the conventional path is the only valid one.
  const match = Object.keys(zip.files).find((name) =>
    /(^|\/)vbaProject\.bin$/i.test(name),
  );
  return match || null;
}

/**
 * Rewrites the workbook Override entry in [Content_Types].xml to the
 * macro-enabled content type. Throws if the workbook part isn't declared
 * at all — that would mean the input buffer isn't a well-formed OOXML
 * package, which should never happen for an ExcelJS-generated buffer.
 */
function markContentTypesAsMacroEnabled(xml: string): string {
  const workbookOverridePattern =
    /(<Override[^>]*PartName="\/xl\/workbook\.xml"[^>]*ContentType=")([^"]*)("[^>]*\/>)/;
  if (!workbookOverridePattern.test(xml)) {
    throw new Error(
      "xlsmPackager: could not find the /xl/workbook.xml Override entry in [Content_Types].xml — input does not look like a valid xlsx package.",
    );
  }
  return xml.replace(
    workbookOverridePattern,
    `$1${MACRO_ENABLED_WORKBOOK_CONTENT_TYPE}$3`,
  );
}

function addVbaProjectContentTypeIfMissing(xml: string): string {
  if (xml.includes(VBA_PROJECT_PATH)) return xml;
  const override = `<Override PartName="/${VBA_PROJECT_PATH}" ContentType="${VBA_PROJECT_CONTENT_TYPE}"/>`;
  return xml.replace("</Types>", `${override}</Types>`);
}

/**
 * Excel only fires a workbook's document-module events (Workbook_Open,
 * and — transitively, since clsSheetWatcher's registration happens inside
 * Workbook_Open — every Worksheet_Change/SelectionChange sync in this
 * app) if xl/workbook.xml's <workbookPr> declares which compiled module
 * inside vbaProject.bin is "ThisWorkbook" for this specific file. ExcelJS
 * has no concept of this at all, so a freshly-built workbook never has
 * it — the vbaProject.bin graft above is silently inert without this: the
 * compiled code loads and can be run manually from the VBA editor (which
 * is why that always appeared to work), but nothing ever calls it
 * automatically. Real Excel writes this attribute itself on every save,
 * which is why a template file re-saved through Excel doesn't need this
 * function at all.
 */
function ensureWorkbookCodeName(xml: string): string {
  if (/<workbookPr\b[^>]*\bcodeName=/.test(xml)) return xml;
  if (/<workbookPr\b/.test(xml)) {
    return xml.replace(
      /<workbookPr\b/,
      `<workbookPr codeName="${THIS_WORKBOOK_CODE_NAME}"`,
    );
  }
  return xml.replace(
    /(<workbook\b[^>]*>)/,
    `$1<workbookPr codeName="${THIS_WORKBOOK_CODE_NAME}"/>`,
  );
}

function addVbaProjectRelationshipIfMissing(xml: string): string {
  if (xml.includes("vbaProject.bin")) return xml;
  // Relationship IDs must be unique within the file — scan existing rIdN
  // values rather than assuming a fixed next number.
  const usedIds = Array.from(xml.matchAll(/Id="rId(\d+)"/g)).map((m) =>
    parseInt(m[1], 10),
  );
  const nextId = (usedIds.length > 0 ? Math.max(...usedIds) : 0) + 1;
  const relationship = `<Relationship Id="rId${nextId}" Type="${VBA_PROJECT_RELATIONSHIP_TYPE}" Target="vbaProject.bin"/>`;
  return xml.replace("</Relationships>", `${relationship}</Relationships>`);
}

export async function applyXlsmTemplate(
  xlsxBuffer: Parameters<JSZip["loadAsync"]>[0],
  templateBuffer: Parameters<JSZip["loadAsync"]>[0],
): Promise<Buffer> {
  const workbookZip = await JSZip.loadAsync(xlsxBuffer);
  const templateZip = await JSZip.loadAsync(templateBuffer);

  const contentTypesFile = workbookZip.file(CONTENT_TYPES_PATH);
  if (!contentTypesFile) {
    throw new Error(
      "xlsmPackager: generated workbook is missing [Content_Types].xml — cannot apply XLSM template.",
    );
  }
  let contentTypesXml = await contentTypesFile.async("string");
  contentTypesXml = markContentTypesAsMacroEnabled(contentTypesXml);

  const vbaProjectPartName = findVbaProjectPart(templateZip);
  if (vbaProjectPartName) {
    const vbaProjectData = await templateZip
      .file(vbaProjectPartName)!
      .async("nodebuffer");
    workbookZip.file(VBA_PROJECT_PATH, vbaProjectData);

    contentTypesXml = addVbaProjectContentTypeIfMissing(contentTypesXml);

    const relsFile = workbookZip.file(WORKBOOK_RELS_PATH);
    if (!relsFile) {
      throw new Error(
        "xlsmPackager: generated workbook is missing xl/_rels/workbook.xml.rels — cannot link the VBA project.",
      );
    }
    const relsXml = addVbaProjectRelationshipIfMissing(
      await relsFile.async("string"),
    );
    workbookZip.file(WORKBOOK_RELS_PATH, relsXml);

    const workbookXmlFile = workbookZip.file(WORKBOOK_XML_PATH);
    if (!workbookXmlFile) {
      throw new Error(
        "xlsmPackager: generated workbook is missing xl/workbook.xml — cannot bind the VBA project's ThisWorkbook module.",
      );
    }
    const workbookXml = ensureWorkbookCodeName(
      await workbookXmlFile.async("string"),
    );
    workbookZip.file(WORKBOOK_XML_PATH, workbookXml);
  }

  workbookZip.file(CONTENT_TYPES_PATH, contentTypesXml);

  const result = await workbookZip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
  });
  return result;
}

/** Whether the given file has a real embedded VBA project (informational — never throws). */
export async function templateHasVbaProject(
  templateBuffer: Parameters<JSZip["loadAsync"]>[0],
): Promise<boolean> {
  const zip = await JSZip.loadAsync(templateBuffer);
  return findVbaProjectPart(zip) !== null;
}
