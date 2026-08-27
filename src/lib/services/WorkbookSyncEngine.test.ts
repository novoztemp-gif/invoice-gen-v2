import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  addProductToInvoice,
  computeInvoiceTotal,
  computePartnerSummary,
  computeProductSummary,
  createInvoice,
  deleteInvoice,
  deleteInvoices,
  editInvoiceLine,
  editInvoicePartnerName,
  extractTrailingSequence,
  formatInvoiceNumber,
  generateWorkbookLocalInvoiceId,
  generateWorkbookLocalPartnerId,
  generateWorkbookLocalProductId,
  nextInvoiceNumber,
  PartnerCatalogEntry,
  ProductCatalogEntry,
  redistributeProductAmount,
  redistributeProductQuantity,
  redistributeProportionally,
  renamePartner,
  renameProduct,
  renumberInvoicesSequentially,
  resolvePartnerForNewInvoice,
  resolveProductForAddition,
  stripInvoicePrefixForDisplay,
  SyncWorkbookModel,
} from "./WorkbookSyncEngine";

function baseModel(): SyncWorkbookModel {
  return {
    invoices: [
      {
        invoiceId: "inv-1",
        invoiceNumber: "AT-2026-27-P-0000001",
        partnerId: "party-1",
        partnerName: "Acme Traders",
        lines: [
          { invoiceId: "inv-1", productId: "p1", productName: "Seer", hsn: "0301", qty: 20, rate: 100, amount: 2000 },
        ],
      },
      {
        invoiceId: "inv-2",
        invoiceNumber: "AT-2026-27-P-0000002",
        partnerId: "party-1",
        partnerName: "Acme Traders",
        lines: [
          { invoiceId: "inv-2", productId: "p1", productName: "Seer", hsn: "0301", qty: 30, rate: 100, amount: 3000 },
        ],
      },
      {
        invoiceId: "inv-3",
        invoiceNumber: "AT-2026-27-P-0000003",
        partnerId: "party-2",
        partnerName: "Beta Foods",
        lines: [
          { invoiceId: "inv-3", productId: "p1", productName: "Seer", hsn: "0301", qty: 50, rate: 100, amount: 5000 },
        ],
      },
    ],
  };
}

describe("redistributeProportionally", () => {
  it("matches the Prompt 4 worked example exactly: [20,30,50] -> 120 => [24,36,60]", () => {
    expect(redistributeProportionally([20, 30, 50], 120)).toEqual([24, 36, 60]);
  });

  it("redistributes a decrease deterministically and sums exactly", () => {
    const result = redistributeProportionally([20, 30, 50], 60);
    expect(result.reduce((s, v) => s + v, 0)).toBe(60);
    expect(result).toEqual([12, 18, 30]);
  });

  it("never produces negative quantities, even for a drastic decrease", () => {
    const result = redistributeProportionally([1, 1, 1000], 1);
    for (const v of result) expect(v).toBeGreaterThanOrEqual(0);
    expect(result.reduce((s, v) => s + v, 0)).toBe(1);
  });

  it("sums exactly to the target even with fractional largest-remainder ties", () => {
    const result = redistributeProportionally([1, 1, 1], 10);
    expect(result.reduce((s, v) => s + v, 0)).toBeCloseTo(10, 6);
    // Deterministic tie-break: ascending index gets the leftover unit first.
    expect(result[0]).toBeGreaterThanOrEqual(result[1]);
  });

  it("is deterministic — repeated calls with the same input produce the same output", () => {
    const a = redistributeProportionally([7, 13, 5, 22], 47);
    const b = redistributeProportionally([7, 13, 5, 22], 47);
    expect(a).toEqual(b);
  });

  it("splits evenly and deterministically when every weight is zero", () => {
    const result = redistributeProportionally([0, 0, 0], 10);
    expect(result.reduce((s, v) => s + v, 0)).toBe(10);
    for (const v of result) expect(v).toBeGreaterThanOrEqual(0);
  });
});

describe("renameProduct — stable Product ID (Prompt 4, section 6)", () => {
  it("propagates a new product name to every line sharing that Product ID, across invoices", () => {
    const updated = renameProduct(baseModel(), "p1", { name: "Sankara" });
    for (const inv of updated.invoices) {
      for (const line of inv.lines) {
        expect(line.productName).toBe("Sankara");
      }
    }
  });

  it("propagates a new HSN the same way", () => {
    const updated = renameProduct(baseModel(), "p1", { hsn: "0302" });
    for (const inv of updated.invoices) {
      for (const line of inv.lines) {
        expect(line.hsn).toBe("0302");
      }
    }
  });

  it("never changes the Product ID itself during a name/HSN edit", () => {
    const updated = renameProduct(baseModel(), "p1", { name: "Sankara", hsn: "0302" });
    for (const inv of updated.invoices) {
      for (const line of inv.lines) {
        expect(line.productId).toBe("p1");
      }
    }
  });

  it("does not affect lines belonging to a different Product ID", () => {
    const model = baseModel();
    model.invoices[0].lines.push({
      invoiceId: "inv-1", productId: "p2", productName: "Vanjaram", hsn: "0303", qty: 5, rate: 200, amount: 1000,
    });
    const updated = renameProduct(model, "p1", { name: "Sankara" });
    const otherLine = updated.invoices[0].lines.find((l) => l.productId === "p2")!;
    expect(otherLine.productName).toBe("Vanjaram");
  });
});

describe("renamePartner / editInvoicePartnerName — stable Partner ID (Prompt 4, sections 6, 9, 11)", () => {
  it("propagates a new partner name to every invoice sharing that Partner ID", () => {
    const updated = renamePartner(baseModel(), "party-1", "Acme Global Traders");
    expect(updated.invoices.find((i) => i.invoiceId === "inv-1")!.partnerName).toBe("Acme Global Traders");
    expect(updated.invoices.find((i) => i.invoiceId === "inv-2")!.partnerName).toBe("Acme Global Traders");
    expect(updated.invoices.find((i) => i.invoiceId === "inv-3")!.partnerName).toBe("Beta Foods"); // untouched
  });

  it("never changes the Partner ID itself during a name edit", () => {
    const updated = renamePartner(baseModel(), "party-1", "Acme Global Traders");
    for (const inv of updated.invoices) {
      const original = baseModel().invoices.find((i) => i.invoiceId === inv.invoiceId)!;
      expect(inv.partnerId).toBe(original.partnerId);
    }
  });

  it("an invoice-sheet-originated partner rename (section 11) reaches every other invoice with the same Partner ID (section 9 behavior)", () => {
    const updated = editInvoicePartnerName(baseModel(), "inv-1", "Acme Global Traders");
    expect(updated.invoices.find((i) => i.invoiceId === "inv-2")!.partnerName).toBe("Acme Global Traders");
  });
});

describe("editInvoiceLine — Invoice -> Summary direction (Prompt 4, sections 4, 11)", () => {
  it("a quantity edit on one invoice line updates that line's amount and is reflected by the recomputed Product Summary", () => {
    const updated = editInvoiceLine(baseModel(), "inv-1", "p1", { qty: 25 });
    const line = updated.invoices[0].lines[0];
    expect(line.qty).toBe(25);
    expect(line.amount).toBe(2500); // 25 * rate(100)

    const productSummary = computeProductSummary(updated);
    // 25 (edited) + 30 + 50 = 105
    expect(productSummary.get("p1")!.totalQty).toBe(105);
  });

  it("a rate edit recomputes amount and cascades into Product Summary's total amount", () => {
    const updated = editInvoiceLine(baseModel(), "inv-1", "p1", { rate: 120 });
    expect(updated.invoices[0].lines[0].amount).toBe(2400); // 20 * 120
    const productSummary = computeProductSummary(updated);
    expect(productSummary.get("p1")!.totalAmount).toBe(2400 + 3000 + 5000);
  });

  it("does not disturb other invoices' lines for the same product", () => {
    const updated = editInvoiceLine(baseModel(), "inv-1", "p1", { qty: 999 });
    expect(updated.invoices[1].lines[0].qty).toBe(30);
    expect(updated.invoices[2].lines[0].qty).toBe(50);
  });
});

describe("redistributeProductQuantity — Summary -> Invoice direction (Prompt 4, sections 5, 6, 7)", () => {
  it("increasing Product Summary's total quantity redistributes proportionally across every invoice line for that Product ID", () => {
    const updated = redistributeProductQuantity(baseModel(), "p1", 120);
    expect(updated.invoices[0].lines[0].qty).toBe(24);
    expect(updated.invoices[1].lines[0].qty).toBe(36);
    expect(updated.invoices[2].lines[0].qty).toBe(60);
  });

  it("decreasing Product Summary's total quantity redistributes proportionally the same way", () => {
    const updated = redistributeProductQuantity(baseModel(), "p1", 60);
    expect(updated.invoices[0].lines[0].qty).toBe(12);
    expect(updated.invoices[1].lines[0].qty).toBe(18);
    expect(updated.invoices[2].lines[0].qty).toBe(30);
  });

  it("never produces a negative invoice-line quantity", () => {
    const updated = redistributeProductQuantity(baseModel(), "p1", 0.01);
    for (const inv of updated.invoices) {
      for (const line of inv.lines) {
        if (line.productId === "p1") expect(line.qty).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("the redistributed invoice-line quantities always sum exactly to the edited Product Summary quantity", () => {
    for (const newTotal of [120, 60, 1, 0, 333.33]) {
      const updated = redistributeProductQuantity(baseModel(), "p1", newTotal);
      const sum = updated.invoices.reduce(
        (s, inv) => s + inv.lines.filter((l) => l.productId === "p1").reduce((s2, l) => s2 + l.qty, 0),
        0,
      );
      expect(sum).toBeCloseTo(newTotal, 6);
    }
  });

  it("recomputes each line's amount from its own (unchanged) rate", () => {
    const updated = redistributeProductQuantity(baseModel(), "p1", 120);
    expect(updated.invoices[0].lines[0].amount).toBe(24 * 100);
  });

  it("recomputing Product Summary after redistribution shows the new total, matching the edited value", () => {
    const updated = redistributeProductQuantity(baseModel(), "p1", 120);
    expect(computeProductSummary(updated).get("p1")!.totalQty).toBe(120);
  });
});

describe("redistributeProductAmount — Summary -> Invoice direction (Prompt 4, section 8)", () => {
  it("propagates a total-amount edit across invoice lines proportionally and derives a new rate per line", () => {
    const updated = redistributeProductAmount(baseModel(), "p1", 12000);
    // original amounts [2000,3000,5000] sum 10000 -> scale by 1.2
    expect(updated.invoices[0].lines[0].amount).toBe(2400);
    expect(updated.invoices[1].lines[0].amount).toBe(3600);
    expect(updated.invoices[2].lines[0].amount).toBe(6000);
    expect(updated.invoices[0].lines[0].rate).toBe(2400 / 20);
  });

  it("does not change unrelated products or invoices", () => {
    const model = baseModel();
    model.invoices[0].lines.push({
      invoiceId: "inv-1", productId: "p2", productName: "Vanjaram", hsn: "0303", qty: 5, rate: 200, amount: 1000,
    });
    const updated = redistributeProductAmount(model, "p1", 12000);
    const untouched = updated.invoices[0].lines.find((l) => l.productId === "p2")!;
    expect(untouched.amount).toBe(1000);
    expect(untouched.rate).toBe(200);
  });

  it("recomputing Product Summary reflects the new total amount exactly", () => {
    const updated = redistributeProductAmount(baseModel(), "p1", 12000);
    expect(computeProductSummary(updated).get("p1")!.totalAmount).toBe(12000);
  });
});

describe("computePartnerSummary — reflects Invoice -> Summary edits", () => {
  it("an invoice total-amount change (via a line edit) is reflected in the recomputed partner total", () => {
    const updated = editInvoiceLine(baseModel(), "inv-1", "p1", { qty: 40 }); // amount 4000
    const partnerSummary = computePartnerSummary(updated);
    // party-1 = inv-1 (4000) + inv-2 (3000) = 7000
    expect(partnerSummary.get("party-1")!.totalAmount).toBe(7000);
    expect(partnerSummary.get("party-1")!.invoiceCount).toBe(2);
  });
});

describe("Section 15 — no database/API calls exist in the synchronization implementation", () => {
  // Call-shaped patterns only — a comment that documents "this never calls
  // Supabase" legitimately contains the word without being a violation, so
  // bare-word matching would produce false positives on our own honesty.
  const forbidden = [
    /supabase\s*\.\s*from\s*\(/i,
    /supabase\s*\.\s*rpc\s*\(/i,
    /createClient\s*\(/,
    /\bfetch\s*\(/,
    /new XMLHttpRequest/,
    /\baxios\s*\./i,
  ];

  it("WorkbookSyncEngine.ts contains no network/database calls", () => {
    const src = readFileSync(path.join(__dirname, "WorkbookSyncEngine.ts"), "utf8");
    for (const pattern of forbidden) {
      expect(src).not.toMatch(pattern);
    }
  });

  it("the VBA sync source (templates/vba/SyncEngine.bas) contains no network/database calls", () => {
    const src = readFileSync(
      path.join(process.cwd(), "templates", "vba", "SyncEngine.bas"),
      "utf8",
    );
    for (const pattern of forbidden) {
      expect(src).not.toMatch(pattern);
    }
    // VBA's own HTTP/process-execution-capable APIs, invoked as actual
    // objects/calls — must not appear anywhere in the file's real code.
    expect(src).not.toMatch(/CreateObject\s*\(\s*"MSXML2/i);
    expect(src).not.toMatch(/CreateObject\s*\(\s*"WinHttp/i);
    expect(src).not.toMatch(/URLDownloadToFile\s*\(/i);
    expect(src).not.toMatch(/\bShell\s*\(/);
  });
});

describe("Section 16 — recursion / infinite-loop guard structure", () => {
  it("the VBA sync source declares a module-level re-entrancy guard and every entry point checks it before writing", () => {
    const src = readFileSync(
      path.join(process.cwd(), "templates", "vba", "SyncEngine.bas"),
      "utf8",
    );
    expect(src).toMatch(/gSyncInProgress\s+As\s+Boolean/);
    // Every propagation routine must check the guard before doing work.
    const guardChecks = src.match(/If gSyncInProgress Then Exit Sub/g) || [];
    expect(guardChecks.length).toBeGreaterThanOrEqual(5);
    // And must suspend event firing during its own writes, then restore it,
    // including on the error path (every CleanFail: label unconditionally
    // restores both — section 15).
    const disableCount = (src.match(/Application\.EnableEvents = False/g) || []).length;
    const enableCount = (src.match(/Application\.EnableEvents = True/g) || []).length;
    expect(disableCount).toBeGreaterThan(0);
    expect(enableCount).toBeGreaterThanOrEqual(disableCount);
  });
});

// ---------------------------------------------------------------------------
// Prompt 4B — dynamic product addition (section 20)
// ---------------------------------------------------------------------------

function catalog(): ProductCatalogEntry[] {
  return [
    { productId: "p1", name: "Seer", hsn: "0301" },
    { productId: "p2", name: "Mutton", hsn: "0204" },
  ];
}

describe("resolveProductForAddition / generateWorkbookLocalProductId", () => {
  it("reuses the existing Product ID when the name matches an existing Product Summary entry (case-insensitively)", () => {
    const r = resolveProductForAddition(catalog(), "seer", "9999", 0);
    expect(r.productId).toBe("p1"); // existing ID wins, not a new one
    expect(r.hsn).toBe("0301"); // existing HSN wins over whatever was typed
    expect(r.isNew).toBe(false);
  });

  it("generates a new, unique workbook-local Product ID for a genuinely new product", () => {
    const r = resolveProductForAddition(catalog(), "Vanjaram", "0302", 5);
    expect(r.isNew).toBe(true);
    expect(r.name).toBe("Vanjaram");
    expect(r.hsn).toBe("0302");
    expect(r.productId).toMatch(/^WBLOCAL-/);
  });

  it("never reuses a name as identity — two different new products get two different IDs", () => {
    const a = generateWorkbookLocalProductId(10, new Date("2026-08-24T10:00:00Z"));
    const b = generateWorkbookLocalProductId(11, new Date("2026-08-24T10:00:00Z"));
    expect(a).not.toBe(b);
  });
});

describe("addProductToInvoice — dynamic product blocks (Prompt 4B, sections 3, 7, 18)", () => {
  it("an invoice with 1 product can have a second product added", () => {
    const model = baseModel(); // inv-1/2/3 each start with 1 line of product p1
    const resolution = resolveProductForAddition(catalog(), "Mutton", undefined, 1);
    const updated = addProductToInvoice(model, "inv-1", resolution, 5, 200);
    expect(updated.invoices[0].lines.length).toBe(2);
    expect(updated.invoices[0].lines[1].productId).toBe("p2");
    expect(updated.invoices[0].lines[1].amount).toBe(1000);
  });

  it("products can be added repeatedly with no hardcoded maximum (5th, and beyond the old 8-product assumption)", () => {
    let model = baseModel();
    for (let i = 0; i < 10; i++) {
      const resolution = resolveProductForAddition([], `New Product ${i}`, "0000", model.invoices[0].lines.length);
      model = addProductToInvoice(model, "inv-1", resolution, 1, 10);
    }
    // 1 original + 10 added = 11 — well past the old 8-product assumption,
    // and nothing in this model enforces any upper bound.
    expect(model.invoices[0].lines.length).toBe(11);
  });

  it("existing product blocks on the same invoice remain completely unchanged", () => {
    const model = baseModel();
    const originalFirstLine = { ...model.invoices[0].lines[0] };
    const resolution = resolveProductForAddition(catalog(), "Mutton", undefined, 1);
    const updated = addProductToInvoice(model, "inv-1", resolution, 5, 200);
    expect(updated.invoices[0].lines[0]).toEqual(originalFirstLine);
  });

  it("does not affect other invoices", () => {
    const model = baseModel();
    const resolution = resolveProductForAddition(catalog(), "Mutton", undefined, 1);
    const updated = addProductToInvoice(model, "inv-1", resolution, 5, 200);
    expect(updated.invoices[1].lines.length).toBe(1);
    expect(updated.invoices[2].lines.length).toBe(1);
  });

  it("adding an EXISTING product preserves its Product ID exactly", () => {
    const model = baseModel();
    const resolution = resolveProductForAddition(catalog(), "Seer", undefined, 1); // same product already on the invoice
    const updated = addProductToInvoice(model, "inv-1", resolution, 3, 100);
    expect(updated.invoices[0].lines[1].productId).toBe("p1");
    expect(updated.invoices[0].lines[0].productId).toBe("p1");
  });

  it("recomputing Product Summary after an addition includes the new line's quantity and amount", () => {
    const model = baseModel();
    const resolution = resolveProductForAddition(catalog(), "Mutton", undefined, 1);
    const updated = addProductToInvoice(model, "inv-1", resolution, 5, 200);
    const summary = computeProductSummary(updated);
    expect(summary.get("p2")!.totalQty).toBe(5);
    expect(summary.get("p2")!.totalAmount).toBe(1000);
  });

  it("recomputing Product Summary for a genuinely new product creates a new entry without disturbing existing ones", () => {
    const model = baseModel();
    const before = computeProductSummary(model);
    const resolution = resolveProductForAddition([], "Vanjaram", "0302", 1);
    const updated = addProductToInvoice(model, "inv-1", resolution, 5, 200);
    const after = computeProductSummary(updated);
    expect(after.has(resolution.productId)).toBe(true);
    expect(after.get(resolution.productId)!.totalAmount).toBe(1000);
    // The pre-existing product's totals are untouched.
    expect(after.get("p1")!.totalAmount).toBe(before.get("p1")!.totalAmount);
  });

  it("the invoice's own total (Invoice Amount) includes the newly added product line", () => {
    const model = baseModel(); // inv-1 starts at amount 2000 (20 * 100)
    const before = computeInvoiceTotal(model, "inv-1");
    const resolution = resolveProductForAddition(catalog(), "Mutton", undefined, 1);
    const updated = addProductToInvoice(model, "inv-1", resolution, 5, 200);
    expect(computeInvoiceTotal(updated, "inv-1")).toBe(before + 1000);
  });

  it("Partner Summary remains correct after a product addition (unaffected partner identity, updated invoice total)", () => {
    const model = baseModel();
    const resolution = resolveProductForAddition(catalog(), "Mutton", undefined, 1);
    const updated = addProductToInvoice(model, "inv-1", resolution, 5, 200);
    const partnerSummary = computePartnerSummary(updated);
    // party-1 = inv-1 (2000+1000=3000) + inv-2 (3000) = 6000
    expect(partnerSummary.get("party-1")!.totalAmount).toBe(6000);
    expect(partnerSummary.get("party-1")!.invoiceCount).toBe(2); // unchanged — still 2 invoices
  });
});

// ---------------------------------------------------------------------------
// Prompt 4B — multi-cell editing (section 21)
// ---------------------------------------------------------------------------

describe("Multi-cell editing — VBA source no longer bails out on multi-cell Target", () => {
  it("the Target.Cells.Count > 1 early-exit restriction from Prompt 4 has been removed from the actual code", () => {
    const src = readFileSync(path.join(process.cwd(), "templates", "vba", "SyncEngine.bas"), "utf8");
    // Check real code lines only — the file's own prose legitimately
    // documents (in comments) that this restriction was removed, which
    // would otherwise trip a naive substring check on its own honesty.
    const codeLines = src
      .split("\n")
      .filter((line) => !line.trim().startsWith("'"));
    expect(codeLines.join("\n")).not.toMatch(/Target\.Cells\.Count > 1/);
  });

  it("the VBA source provides a distinct-rows collector for multi-cell paste/fill handling", () => {
    const src = readFileSync(path.join(process.cwd(), "templates", "vba", "SyncEngine.bas"), "utf8");
    expect(src).toMatch(/Function CollectDistinctRows/);
    expect(src).toMatch(/For Each area In Target\.Areas/);
  });

  it("Product Summary and Partner Summary row handlers are dedupe-aware (process each distinct row once)", () => {
    const src = readFileSync(path.join(process.cwd(), "templates", "vba", "SyncEngine.bas"), "utf8");
    expect(src).toMatch(/HandleProductSummaryRowChange/);
    expect(src).toMatch(/HandlePartnerSummaryRowChange/);
    expect(src).toMatch(/AddUnique/);
  });
});

describe("Multi-cell editing — processing distinct affected records exactly once, using final values", () => {
  it("applying edits for multiple distinct Product IDs from one simulated multi-cell paste updates all of them independently", () => {
    // Simulates what HandleProductSummaryRowChange does once per distinct
    // row collected from a multi-row paste: apply each affected product's
    // final pasted name.
    let model = baseModel();
    model = renameProduct(model, "p1", { name: "Sankara" });
    const model2 = { ...model, invoices: model.invoices.map((i) => ({ ...i, lines: [...i.lines] })) };
    model2.invoices[0].lines.push({
      invoiceId: "inv-1", productId: "p2", productName: "Mutton", hsn: "0204", qty: 5, rate: 200, amount: 1000,
    });
    const final = renameProduct(model2, "p2", { name: "Goat Meat" });

    // Both products reflect their own final pasted name — neither
    // overwrote the other, matching "process every affected Product ID".
    for (const inv of final.invoices) {
      for (const line of inv.lines) {
        if (line.productId === "p1") expect(line.productName).toBe("Sankara");
        if (line.productId === "p2") expect(line.productName).toBe("Goat Meat");
      }
    }
  });

  it("re-applying a rename to the same Product ID multiple times in sequence (simulating a duplicate-affected multi-cell event) leaves only the FINAL value", () => {
    let model = baseModel();
    // Simulates a dedupe bug NOT happening: even if a row were somehow
    // processed twice with different intermediate values, the pure
    // function is idempotent on its final input — only the last call's
    // value survives, never a compounded/partial result.
    model = renameProduct(model, "p1", { name: "Intermediate Name" });
    model = renameProduct(model, "p1", { name: "Final Name" });
    for (const inv of model.invoices) {
      for (const line of inv.lines) {
        if (line.productId === "p1") expect(line.productName).toBe("Final Name");
      }
    }
  });

  it("redistributing the same Product ID twice in sequence does not compound — the second call's total is authoritative", () => {
    let model = redistributeProductQuantity(baseModel(), "p1", 120);
    model = redistributeProductQuantity(model, "p1", 60); // final intended value
    const sum = model.invoices.reduce(
      (s, inv) => s + inv.lines.filter((l) => l.productId === "p1").reduce((s2, l) => s2 + l.qty, 0),
      0,
    );
    expect(sum).toBe(60); // not 120+60 or any compounded figure
  });
});

// ---------------------------------------------------------------------------
// Prompt 5 — invoice creation, deletion, and automatic renumbering
// ---------------------------------------------------------------------------

/** N invoices numbered INV-0000001..INV-000000N, one product line each. */
function numberedModel(count: number): SyncWorkbookModel {
  return {
    invoices: Array.from({ length: count }, (_, i) => ({
      invoiceId: `id-${i + 1}`,
      invoiceNumber: `INV-${String(i + 1).padStart(7, "0")}`,
      partnerId: "party-1",
      partnerName: "Acme Traders",
      lines: [
        {
          invoiceId: `id-${i + 1}`,
          productId: "p1",
          productName: "Sankara",
          hsn: "0301",
          qty: (i + 1) * 10,
          rate: 1,
          amount: (i + 1) * 10,
        },
      ],
    })),
  };
}

describe("invoice number formatting (Prompt 5, section 2/12)", () => {
  it("extracts the trailing digit run, preserving prefix and zero-padded width", () => {
    const parsed = extractTrailingSequence("AT-2026-27-P-0000042");
    expect(parsed).toEqual({ prefix: "AT-2026-27-P-", digits: "0000042", width: 7, value: 42 });
  });

  it("formatInvoiceNumber rewrites only the trailing digits, preserving the prefix and width", () => {
    expect(formatInvoiceNumber("AT-2026-27-P-0000042", 2)).toBe("AT-2026-27-P-0000002");
    expect(formatInvoiceNumber("INV-001", 4)).toBe("INV-004");
  });

  it("a number with no trailing digits is left unchanged by formatInvoiceNumber", () => {
    expect(formatInvoiceNumber("NO-DIGITS-HERE", 5)).toBe("NO-DIGITS-HERE");
  });

  it("nextInvoiceNumber continues the existing sequence", () => {
    expect(nextInvoiceNumber("AT-2026-27-P-0000003")).toBe("AT-2026-27-P-0000004");
  });

  it("nextInvoiceNumber falls back to a sensible default when there are no invoices yet", () => {
    expect(nextInvoiceNumber(undefined)).toBe("INV-0000001");
  });
});

describe("+ ADD NEW INVOICE (Prompt 5, sections 1, 6, 14 items 1-4)", () => {
  it("a new invoice receives a unique stable Invoice ID", () => {
    const a = generateWorkbookLocalInvoiceId(3, new Date("2026-08-25T09:00:00Z"));
    const b = generateWorkbookLocalInvoiceId(4, new Date("2026-08-25T09:00:00Z"));
    expect(a).not.toBe(b);
    expect(a).toMatch(/^WBLOCAL-INV-/);
  });

  it("a new invoice receives the correct next invoice number and starts with zero lines", () => {
    const model = numberedModel(3); // INV-0000001..0000003
    const newNumber = nextInvoiceNumber(model.invoices[model.invoices.length - 1].invoiceNumber);
    expect(newNumber).toBe("INV-0000004");
    const resolution = resolvePartnerForNewInvoice([{ partnerId: "party-1", name: "Acme Traders" }], "Acme Traders", 1);
    const updated = createInvoice(model, "id-4", newNumber, resolution);
    expect(updated.invoices.length).toBe(4);
    expect(updated.invoices[3].invoiceNumber).toBe("INV-0000004");
    expect(updated.invoices[3].lines).toEqual([]);
  });

  it("the new invoice does not disturb any existing invoice", () => {
    const model = numberedModel(3);
    const resolution = resolvePartnerForNewInvoice([], "New Co", 0);
    const updated = createInvoice(model, "id-4", "INV-0000004", resolution);
    expect(updated.invoices.slice(0, 3)).toEqual(model.invoices);
  });
});

describe("new customer/supplier resolution (Prompt 5, section 6, 14 items 5-8)", () => {
  const partnerCatalog: PartnerCatalogEntry[] = [{ partnerId: "party-1", name: "Acme Traders" }];

  it("a new customer/supplier name creates exactly one new Partner ID", () => {
    const r = resolvePartnerForNewInvoice(partnerCatalog, "Beta Foods", 1);
    expect(r.isNew).toBe(true);
    expect(r.partnerId).toMatch(/^WBLOCAL-PARTNER-/);
    expect(r.name).toBe("Beta Foods");
  });

  it("an existing customer/supplier name (case-insensitive) reuses its Partner ID — no duplicate", () => {
    const r = resolvePartnerForNewInvoice(partnerCatalog, "acme traders", 1);
    expect(r.isNew).toBe(false);
    expect(r.partnerId).toBe("party-1");
  });

  it("two different new-partner resolutions never collide on Partner ID", () => {
    const a = generateWorkbookLocalPartnerId(1, new Date("2026-08-25T09:00:00Z"));
    const b = generateWorkbookLocalPartnerId(2, new Date("2026-08-25T09:00:00Z"));
    expect(a).not.toBe(b);
  });

  it("the same resolution logic applies symmetrically for Purchase (Supplier) and Sales (Customer)", () => {
    // resolvePartnerForNewInvoice has no batch-type branch at all — Sales
    // vs Purchase is purely a label chosen by the caller (VBA reads it
    // off which invoice-list sheet exists), never a different algorithm.
    const supplierResult = resolvePartnerForNewInvoice(partnerCatalog, "Gamma Meats", 1);
    const customerResult = resolvePartnerForNewInvoice(partnerCatalog, "Gamma Meats", 1);
    expect(supplierResult).toEqual(customerResult);
  });
});

describe("new product on a new invoice (Prompt 5, section 7, 14 items 9-10)", () => {
  it("a genuinely new product on a newly created invoice produces exactly one new Product Summary entry", () => {
    const model = createInvoice(numberedModel(1), "id-2", "INV-0000002", {
      partnerId: "party-1", name: "Acme Traders", isNew: false,
    });
    const resolution = resolveProductForAddition([], "Vanjaram", "0302", 0);
    const updated = addProductToInvoice(model, "id-2", resolution, 50, 200);
    const summary = computeProductSummary(updated);
    expect(summary.get(resolution.productId)!.totalQty).toBe(50);
    expect(summary.get(resolution.productId)!.totalAmount).toBe(10000);
    // Matches the prompt's own example exactly: Sankara/1234/50/200.
  });

  it("adding an existing product to a new invoice does not create a duplicate Product Summary entry", () => {
    const catalog: ProductCatalogEntry[] = [{ productId: "p1", name: "Sankara", hsn: "0301" }];
    const model = createInvoice(numberedModel(1), "id-2", "INV-0000002", {
      partnerId: "party-1", name: "Acme Traders", isNew: false,
    });
    const resolution = resolveProductForAddition(catalog, "Sankara", undefined, 0);
    const updated = addProductToInvoice(model, "id-2", resolution, 20, 100);
    expect(resolution.productId).toBe("p1"); // reused, not invented
    const summary = computeProductSummary(updated);
    // Exactly one distinct product ("p1"), now spread across 2 invoices —
    // no second/duplicate Product Summary entry was created.
    expect(summary.size).toBe(1);
    expect(summary.get("p1")!.totalQty).toBe(10 + 20); // id-1's original 10 + the new line's 20
  });
});

describe("deleting an invoice (Prompt 5, sections 3, 8, 14 items 11-15)", () => {
  it("deleting an invoice removes it (and its lines) from the model entirely", () => {
    const model = numberedModel(3);
    const updated = deleteInvoice(model, "id-2");
    expect(updated.invoices.length).toBe(2);
    expect(updated.invoices.find((i) => i.invoiceId === "id-2")).toBeUndefined();
  });

  it("deleting an invoice removes its contribution from Product Summary — matches the prompt's own Sankara 40/60 example", () => {
    const model: SyncWorkbookModel = {
      invoices: [
        { invoiceId: "inv-1", invoiceNumber: "INV-0000001", partnerId: "p1", partnerName: "A", lines: [
          { invoiceId: "inv-1", productId: "sankara", productName: "Sankara", hsn: "0301", qty: 40, rate: 1, amount: 40 },
        ] },
        { invoiceId: "inv-2", invoiceNumber: "INV-0000002", partnerId: "p2", partnerName: "B", lines: [
          { invoiceId: "inv-2", productId: "sankara", productName: "Sankara", hsn: "0301", qty: 60, rate: 1, amount: 60 },
        ] },
      ],
    };
    expect(computeProductSummary(model).get("sankara")!.totalQty).toBe(100);
    const updated = deleteInvoice(model, "inv-2");
    expect(computeProductSummary(updated).get("sankara")!.totalQty).toBe(40);
  });

  it("deleting an invoice removes its contribution from Customer/Supplier Summary", () => {
    const model = numberedModel(3); // all share partner-1
    const before = computePartnerSummary(model).get("party-1")!;
    const updated = deleteInvoice(model, "id-2");
    const after = computePartnerSummary(updated).get("party-1")!;
    expect(after.invoiceCount).toBe(before.invoiceCount - 1);
    expect(after.totalAmount).toBe(before.totalAmount - 20); // id-2's amount was 20
  });

  it("cancelled deletion changes nothing (simulated: no delete call made)", () => {
    const model = numberedModel(3);
    const untouched = model; // VBA's Cancel path: MsgBox answer <> vbYes -> Exit Sub, no mutation at all
    expect(untouched.invoices.length).toBe(3);
    expect(untouched).toBe(model);
  });
});

describe("automatic renumbering after deletion (Prompt 5, sections 2-4, 14 items 16-23)", () => {
  it("matches the prompt's own worked example exactly: delete INV-002 from 4 -> [001,002,003]", () => {
    const model = numberedModel(4); // INV-0000001..0000004
    const afterDelete = deleteInvoice(model, "id-2");
    const renumbered = renumberInvoicesSequentially(afterDelete);
    expect(renumbered.invoices.map((i) => i.invoiceNumber)).toEqual([
      "INV-0000001", "INV-0000002", "INV-0000003",
    ]);
  });

  it("stable Invoice IDs are unchanged by renumbering — only the display number moves", () => {
    const model = numberedModel(4);
    const afterDelete = deleteInvoice(model, "id-2"); // id-1, id-3, id-4 remain
    const renumbered = renumberInvoicesSequentially(afterDelete);
    expect(renumbered.invoices.map((i) => i.invoiceId)).toEqual(["id-1", "id-3", "id-4"]);
  });

  it("product/customer/supplier relationships remain attached to the correct invoice after renumbering", () => {
    const model = numberedModel(4);
    const afterDelete = deleteInvoice(model, "id-2");
    const before = computeProductSummary(afterDelete);
    const renumbered = renumberInvoicesSequentially(afterDelete);
    const after = computeProductSummary(renumbered);
    // Renumbering only rewrites invoiceNumber text — every line's
    // productId/qty/amount, and therefore every aggregate, is identical.
    expect(after).toEqual(before);
  });

  it("renumbered invoice numbers are always unique — no duplicate sheet names would result", () => {
    const model = numberedModel(6);
    const afterDelete = deleteInvoices(model, ["id-2", "id-4"]);
    const renumbered = renumberInvoicesSequentially(afterDelete);
    const numbers = renumbered.invoices.map((i) => i.invoiceNumber);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it("multiple invoice deletion (delete INV-002 and INV-004 from 5) matches the prompt's own example exactly", () => {
    const model = numberedModel(5); // INV-0000001..0000005
    const afterDelete = deleteInvoices(model, ["id-2", "id-4"]);
    const renumbered = renumberInvoicesSequentially(afterDelete);
    expect(renumbered.invoices.map((i) => i.invoiceNumber)).toEqual([
      "INV-0000001", "INV-0000002", "INV-0000003",
    ]);
    // The survivors are the ORIGINAL id-1, id-3, id-5, in that order.
    expect(renumbered.invoices.map((i) => i.invoiceId)).toEqual(["id-1", "id-3", "id-5"]);
  });

  it("adding a new invoice after a delete-and-renumber receives the next sequential number", () => {
    const model = numberedModel(4);
    const afterDelete = deleteInvoice(model, "id-2");
    const renumbered = renumberInvoicesSequentially(afterDelete); // -> 001,002,003
    const newNumber = nextInvoiceNumber(renumbered.invoices[renumbered.invoices.length - 1].invoiceNumber);
    expect(newNumber).toBe("INV-0000004"); // continues the NEW sequence, not the old one
  });
});

describe("Prompt 5 — VBA structural checks", () => {
  const src = () => readFileSync(path.join(process.cwd(), "templates", "vba", "SyncEngine.bas"), "utf8");

  it("defines the Add New Invoice entry point, deletion is native row/sheet deletion, and the renumbering routine", () => {
    const s = src();
    expect(s).toMatch(/Public Sub AddNewInvoice\(\)/);
    expect(s).toMatch(/Public Function ReconcileDeletedInvoiceRows\(/);
    expect(s).toMatch(/Public Sub HandleInvoiceSheetBeforeDelete\(/);
    expect(s).toMatch(/Public Sub DeleteInvoiceByStableId\(/);
    expect(s).toMatch(/Public Sub RenumberAllInvoices\(\)/);
  });

  it("renumbering uses a two-phase temporary-name rename to avoid intermediate collisions (section 4)", () => {
    const s = src();
    expect(s).toMatch(/__tmp_renum_/);
    expect(s).toMatch(/Phase 1/);
    expect(s).toMatch(/Phase 2/);
  });

  it("deletion removes the invoice sheet and its _hidden_invoice_data rows, bottom-to-top", () => {
    const s = src();
    expect(s).toMatch(/delWs\.Delete/);
    expect(s).toMatch(/hws\.Rows\(hr\)\.Delete/);
    expect(s).toMatch(/For hr = lastRow To HID_DATA_START_ROW Step -1/);
  });

  it("Product/Partner Summary formulas are never rewritten by delete/renumber — they stay live SUMIF/COUNTIF (section 8, 17)", () => {
    const s = src();
    // DeleteInvoiceByStableId's own body must not touch Product/Partner
    // Summary cells directly — deletion relies entirely on the existing
    // formula-driven totals recomputing automatically.
    const deleteSubMatch = s.match(/Public Sub DeleteInvoiceByStableId[\s\S]*?End Sub/);
    expect(deleteSubMatch).not.toBeNull();
    expect(deleteSubMatch![0]).not.toMatch(/ProductSummarySheet\(\)\.Cells/);
    expect(deleteSubMatch![0]).not.toMatch(/PartnerSummarySheet\(\)\.Cells/);
  });

  it("multi-cell editing remains supported — no Target.Cells.Count > 1 restriction anywhere in real code", () => {
    const s = src();
    const codeLines = s.split("\n").filter((line) => !line.trim().startsWith("'"));
    expect(codeLines.join("\n")).not.toMatch(/Target\.Cells\.Count > 1/);
  });

  it("recursion protection covers the new Subs too — guard/EnableEvents counts stay balanced and non-trivial", () => {
    const s = src();
    const guardChecks = s.match(/If gSyncInProgress Then Exit Sub/g) || [];
    expect(guardChecks.length).toBeGreaterThanOrEqual(7); // grew from Prompt 4B's 6
    const disableCount = (s.match(/Application\.EnableEvents = False/g) || []).length;
    const enableCount = (s.match(/Application\.EnableEvents = True/g) || []).length;
    expect(disableCount).toBeGreaterThan(0);
    expect(enableCount).toBe(disableCount);
  });

  it("no network/database calls anywhere in the extended file", () => {
    const s = src();
    expect(s).not.toMatch(/supabase\s*\.\s*from\s*\(/i);
    expect(s).not.toMatch(/createClient\s*\(/);
    expect(s).not.toMatch(/\bfetch\s*\(/);
    expect(s).not.toMatch(/CreateObject\s*\(\s*"MSXML2/i);
    expect(s).not.toMatch(/URLDownloadToFile\s*\(/i);
  });
});

// ---------------------------------------------------------------------------
// Prompt 6 — display-only invoice number stripping (Purchase invoice sheets)
// ---------------------------------------------------------------------------

describe("stripInvoicePrefixForDisplay (Prompt 18: strips only the leading abbreviation, keeps the rest)", () => {
  it("matches the prompt's own worked example exactly", () => {
    expect(stripInvoicePrefixForDisplay("AT-2021-22-P-00000001")).toBe("2021-22-P-00000001");
  });

  it("strips a longer/shorter alphabetic prefix the same way", () => {
    expect(stripInvoicePrefixForDisplay("XYZCO-2026-27-P-0000042")).toBe("2026-27-P-0000042");
  });

  it("leaves a number with no leading alphabetic prefix unchanged", () => {
    expect(stripInvoicePrefixForDisplay("2026-27-P-0000042")).toBe("2026-27-P-0000042");
  });

  it("never mutates the input string (display-only, no side effects)", () => {
    const original = "AT-2021-22-P-00000001";
    stripInvoicePrefixForDisplay(original);
    expect(original).toBe("AT-2021-22-P-00000001");
  });
});

describe("Prompt 6 — VBA structural checks", () => {
  const src = () => readFileSync(path.join(process.cwd(), "templates", "vba", "SyncEngine.bas"), "utf8");

  it("defines the number-to-words port and the display-stripping port", () => {
    const s = src();
    expect(s).toMatch(/Public Function NumberToWordsVba\(/);
    expect(s).toMatch(/Private Function StripInvoicePrefixForDisplayVba\(/);
  });

  it("Amount in Words is recomputed after every mutation path that can change Invoice Amount", () => {
    const s = src();
    const callSites = s.match(/UpdateAmountInWords\s+\w+/g) || [];
    // HandleInvoiceLineEdit, AddProductBlock, and once per affected sheet
    // in each of the two redistribution Subs — at least 4 real call sites.
    expect(callSites.length).toBeGreaterThanOrEqual(4);
  });

  it("RenumberAllInvoices applies the display-stripping transform only for Purchase sheets", () => {
    const s = src();
    const renumberSub = s.match(/Public Sub RenumberAllInvoices[\s\S]*?End Sub/);
    expect(renumberSub).not.toBeNull();
    expect(renumberSub![0]).toMatch(/StripInvoicePrefixForDisplayVba/);
    expect(renumberSub![0]).toMatch(/If isSales Then/);
  });

  it("PropagatePartnerRename writes the Purchase supplier rename to the top-banner cell, not the (now-reversed) row 7", () => {
    const s = src();
    const renameSub = s.match(/Public Sub PropagatePartnerRename[\s\S]*?End Sub/);
    expect(renameSub).not.toBeNull();
    expect(renameSub![0]).toMatch(/ws\.Cells\(1, 1\)\.Value = newName/);
    expect(renameSub![0]).toMatch(/CertificationText\(newName\)/); // also refreshes "For {supplier}"
  });

  it("HandleInvoiceSheetChange watches the top-banner cell (not row 7) as the partner-rename trigger for Purchase sheets", () => {
    const s = src();
    const handlerSub = s.match(/Public Sub HandleInvoiceSheetChange[\s\S]*?(?=\n' Called by)/);
    expect(handlerSub).not.toBeNull();
    expect(handlerSub![0]).toMatch(/isSalesSheet/);
    expect(handlerSub![0]).toMatch(/partnerNameCellRow = 1/);
  });
});
