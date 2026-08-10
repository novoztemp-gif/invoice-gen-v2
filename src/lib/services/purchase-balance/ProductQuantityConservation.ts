import { randomUUID } from "crypto";
import { computeLineAmount } from "@/lib/utils/quantity-rate-utils";
import { CandidateGenerator } from "./CandidateGenerator";
import {
  BALANCE_LIMITS,
  MONEY_TOLERANCE,
  normaliseCategory,
  ProductConstraint,
  PurchaseInvoice,
  PurchaseLine,
  roundMoney,
} from "./types";

export interface ConservationResult {
  updatedInvoices: Map<string, PurchaseInvoice>;
  newInvoices: PurchaseInvoice[];
  // Present only when Priority 4 (see conserve()) had to adjust one of the
  // EDITED invoice's own other lines — e.g. absorbing the cost of a product
  // that had never appeared anywhere else in the batch before. Undefined
  // means the edited invoice is exactly the normalisedEditedInvoice that was
  // passed in, unchanged.
  updatedEditedInvoice?: PurchaseInvoice;
  errors: string[];
}

/**
 * Stage 1 of the purchase invoice edit pipeline: keeps the TOTAL quantity of
 * every product across the whole batch exactly what it was before the edit,
 * by moving the delta onto/off that same product's lines on other invoices
 * — rather than the existing monetary-only solver (CandidateSolver,
 * unchanged, runs after this as Stage 2), which picks whichever line closes
 * the rupee gap with zero regard for product identity.
 *
 * Every product's [rate_min, rate_max] comes from product_rules, keyed by
 * product — not by invoice — so the edited invoice's post-edit rate for a
 * product is automatically a VALID rate for that same product everywhere
 * else too. That does NOT mean it's the SAME rate already sitting on that
 * product's other lines elsewhere in the batch — different invoices can
 * (and routinely do) carry the same product at different rates within the
 * configured range. Priority 1 below therefore always adjusts an existing
 * line's QUANTITY at THAT line's own existing rate, never forcing it onto
 * rateForP — forcing it would silently move extra, untracked money equal
 * to the line's unchanged portion times the rate difference. Instead, the
 * REAL money moved by priorities 1-3 is tracked explicitly (actualMoneyMoved)
 * and compared against what the edited invoice's own line actually needs
 * offset (editedLineMoneyDelta); any gap between them — whether from unmet
 * quantity conservation or from this rate-mismatch effect — is what
 * Priority 4 closes.
 *
 * Four priorities, in order:
 *  1. Adjust this product's EXISTING lines on other invoices (own rate).
 *  2. Add this product as a new line to other invoices that don't carry it
 *     yet (only while still needing to ADD quantity somewhere; new lines
 *     have no prior rate to conflict with, so they use rateForP exactly).
 *  3. Create a brand-new invoice for a category-matched supplier who
 *     doesn't already have an invoice on some date in the batch (same
 *     daily-billing rule generation already enforces; also rateForP).
 *  4. Last resort: close whatever real money gap remains — from a product
 *     with no "elsewhere" to conserve against at all (e.g. a genuinely new
 *     addition to the whole batch), from a rate mismatch on the lines
 *     priorities 1-3 did touch, or both — entirely within the EDITED
 *     invoice itself, by shrinking/growing one of its OTHER existing lines
 *     at THAT line's own valid rate, so every other invoice in the batch
 *     stays completely untouched. Only when even this can't fully close the
 *     gap does it fall through as a genuine shortfall for the caller to
 *     handle (see AutoBalanceEngine's Stage 2 fallback).
 */
export class ProductQuantityConservation {
  public static conserve(
    originalEditedInvoice: PurchaseInvoice,
    normalizedEditedInvoice: PurchaseInvoice,
    allOtherInvoices: PurchaseInvoice[],
    constraints: Map<string, ProductConstraint>,
    majorCustomerIds: Set<string>,
    supplierCategory: string,
    // Only needed for Priority 3 (creating a brand-new invoice). Callers
    // that don't want to pay for a numbering lookup up front can omit
    // these and re-call with them populated only if `errors` comes back
    // non-empty from a first pass — see AutoBalanceEngine.
    invoiceNumberPrefix?: string,
    startingSequence?: number,
  ): ConservationResult {
    const errors: string[] = [];
    const newInvoices: PurchaseInvoice[] = [];
    let nextSequence = startingSequence ?? 0;

    const origById = new Map(
      originalEditedInvoice.products.map((l) => [l.product_id, l]),
    );
    const newById = new Map(
      normalizedEditedInvoice.products.map((l) => [l.product_id, l]),
    );
    const touchedProductIds = new Set<string>([
      ...origById.keys(),
      ...newById.keys(),
    ]);

    // Base pool: everything except major-customer invoices. Category
    // eligibility is checked per-product below (against each candidate
    // invoice's OWN baseline category), not a single batch-wide category —
    // a batch can legitimately mix Fruits and Meat suppliers.
    const basePool = [...allOtherInvoices]
      .filter((inv) => {
        const partyId = (inv.products?.[0] as any)?.customer_id;
        return !(partyId && majorCustomerIds.has(partyId));
      })
      .sort((a, b) => {
        const dateCmp = (a.invoice_date || "").localeCompare(
          b.invoice_date || "",
        );
        if (dateCmp !== 0) return dateCmp;
        const numCmp = (a.invoice_number || "").localeCompare(
          b.invoice_number || "",
        );
        if (numCmp !== 0) return numCmp;
        return a.id.localeCompare(b.id);
      });

    const invoiceBaselineCategory = (inv: PurchaseInvoice): string => {
      const firstProductId = inv.products?.[0]?.product_id;
      const c = firstProductId ? constraints.get(firstProductId) : undefined;
      return normaliseCategory(c ? c.category : supplierCategory);
    };

    // Supplier usage across the whole batch (including the edited invoice
    // itself), for Priority 3's "no two invoices for the same supplier on
    // the same day" rule and its category matching.
    const supplierCategoryMap = new Map<string, string>();
    const supplierDatesUsed = new Map<string, Set<string>>();
    const registerSupplierUsage = (inv: PurchaseInvoice) => {
      const first = inv.products?.[0] as any;
      const supplierId = first?.supplier_id || first?.customer_id;
      if (!supplierId || !inv.invoice_date) return;
      if (!supplierDatesUsed.has(supplierId)) {
        supplierDatesUsed.set(supplierId, new Set());
      }
      supplierDatesUsed.get(supplierId)!.add(inv.invoice_date);
      if (!supplierCategoryMap.has(supplierId)) {
        supplierCategoryMap.set(supplierId, invoiceBaselineCategory(inv));
      }
    };
    for (const inv of allOtherInvoices) registerSupplierUsage(inv);
    registerSupplierUsage(normalizedEditedInvoice);

    // Mutable working copies, keyed by invoice id — reused across different
    // products' passes so changes from multiple touched products on the
    // same edit compose correctly onto the same invoice.
    const working = new Map<string, PurchaseInvoice>();
    const getWorking = (inv: PurchaseInvoice): PurchaseInvoice => {
      let w = working.get(inv.id);
      if (!w) {
        w = { ...inv, products: inv.products.map((p) => ({ ...p })) };
        working.set(inv.id, w);
      }
      return w;
    };
    const recomputeTotal = (w: PurchaseInvoice) => {
      w.total_amount = roundMoney(
        w.products.reduce((sum, p) => sum + Number(p.amount || 0), 0),
      );
    };

    // Priority 4's working copy of the edited invoice itself — only
    // materialised (and only returned) if some touched product actually
    // needs it. Lines belonging to ANY touched product are never used as
    // Priority 4 donors: those lines hold the user's intended edit (or this
    // pass's own target), not spare capacity to raid.
    let workingEdited: PurchaseInvoice | undefined;
    const getWorkingEdited = (): PurchaseInvoice => {
      if (!workingEdited) {
        workingEdited = {
          ...normalizedEditedInvoice,
          products: normalizedEditedInvoice.products.map((p) => ({ ...p })),
        };
      }
      return workingEdited;
    };

    for (const productId of touchedProductIds) {
      const origLine = origById.get(productId);
      const newLine = newById.get(productId);
      const origQty = origLine ? Number(origLine.quantity) || 0 : 0;
      const newQty = newLine ? Number(newLine.quantity) || 0 : 0;
      const deltaQty = roundMoney(newQty - origQty);
      if (Math.abs(deltaQty) < MONEY_TOLERANCE) continue;

      const constraint = constraints.get(productId);
      if (!constraint) continue;

      const productCategory = normaliseCategory(constraint.category);
      const candidatePool = basePool.filter(
        (inv) => invoiceBaselineCategory(inv) === productCategory,
      );

      const rateForP = newLine
        ? Number(newLine.rate)
        : Number(origLine!.rate);
      const neededTotal = Math.abs(deltaQty);
      let remainingNeededChange = roundMoney(-deltaQty);
      // Real money moved by priorities 1-3, tracked independently of
      // remainingNeededChange (a QUANTITY tally). The two are only
      // guaranteed to agree when every touched line shares rateForP — true
      // for Priority 2/3's brand-new lines (which always use rateForP,
      // having no prior rate to conflict with), but NOT generally true for
      // Priority 1's EXISTING lines elsewhere, which can have been
      // generated at a different valid rate for the same product. Forcing
      // those lines onto rateForP would silently move extra, untracked
      // money (exactly the bug this tracker exists to catch): e.g. shrinking
      // a line by 2kg at its OWN rate of 180 removes ₹360, but forcing that
      // same line to rateForP=200 first would instead remove
      // 2*200=₹400 of "intended" money while ALSO shifting the line's
      // unchanged remainder by (200-180)*oldQty — money nothing else
      // accounts for. So Priority 1 below always keeps each line's own
      // rate, and this tracker is what actually decides whether Priority 4
      // needs to run afterward — not remainingNeededChange.
      let actualMoneyMoved = 0;

      // Priority 1: move quantity onto/off this product's EXISTING lines on
      // other invoices, always at THAT line's own existing rate (never
      // rateForP) — see actualMoneyMoved's comment above for why.
      for (const inv of candidatePool) {
        if (Math.abs(remainingNeededChange) <= MONEY_TOLERANCE) break;
        const hasLine = inv.products.some((p) => p.product_id === productId);
        if (!hasLine) continue;

        const w = getWorking(inv);
        const lineIdx = w.products.findIndex(
          (p) => p.product_id === productId,
        );
        if (lineIdx === -1) continue;
        const line = w.products[lineIdx];
        const currentQty = Number(line.quantity) || 0;
        const ownRate = Number(line.rate) || rateForP;
        const targetQty = currentQty + remainingNeededChange;

        // generateQuantityCandidates clamps internally to the product's
        // configured [quantityMin, quantityMax] and returns commercially
        // valid values sorted by closeness to targetQty — so even when
        // targetQty itself is unreachable (e.g. below quantityMin), the
        // closest valid candidate still gives partial credit here.
        const candidates = CandidateGenerator.generateQuantityCandidates(
          targetQty,
          constraint,
        );
        if (candidates.length === 0) continue;
        const chosenQty = candidates[0];
        const achievedDelta = roundMoney(chosenQty - currentQty);
        if (Math.abs(achievedDelta) < MONEY_TOLERANCE) continue;

        const moneyBefore = computeLineAmount(currentQty, ownRate);
        line.quantity = chosenQty;
        line.amount = computeLineAmount(chosenQty, ownRate);
        recomputeTotal(w);
        actualMoneyMoved = roundMoney(
          actualMoneyMoved + (line.amount - moneyBefore),
        );
        remainingNeededChange = roundMoney(
          remainingNeededChange - achievedDelta,
        );
      }

      // Priority 2: add this product as a brand-new line on other invoices
      // — only reached while still needing to ADD quantity somewhere
      // (never to fabricate a negative/removed line).
      if (remainingNeededChange > MONEY_TOLERANCE) {
        for (const inv of candidatePool) {
          if (remainingNeededChange <= MONEY_TOLERANCE) break;
          const alreadyHasLine = inv.products.some(
            (p) => p.product_id === productId,
          );
          if (alreadyHasLine) continue;

          const w = getWorking(inv);
          if (w.products.some((p) => p.product_id === productId)) continue;
          if (w.products.length >= BALANCE_LIMITS.maxInvoiceLines) continue;

          const candidates = CandidateGenerator.generateQuantityCandidates(
            remainingNeededChange,
            constraint,
          );
          if (candidates.length === 0) continue;
          const chosenQty = candidates[0];
          if (chosenQty <= 0) continue;

          const sibling = w.products[0] as any;
          const newLineObj: PurchaseLine = {
            product_id: productId,
            product_name: constraint.productName || "",
            hsn_code: constraint.hsnCode || "",
            category: constraint.category,
            unit_of_measure: constraint.unitOfMeasure,
            quantity: chosenQty,
            rate: rateForP,
            amount: computeLineAmount(chosenQty, rateForP),
          };
          (newLineObj as any).customer_id = sibling?.customer_id;
          (newLineObj as any).supplier_id = sibling?.supplier_id;

          w.products.push(newLineObj);
          recomputeTotal(w);
          actualMoneyMoved = roundMoney(actualMoneyMoved + newLineObj.amount);
          remainingNeededChange = roundMoney(remainingNeededChange - chosenQty);
        }
      }

      // Priority 3 (last resort): create brand-new invoices for
      // category-matched suppliers who don't already have an invoice on
      // whatever date each new invoice is dated — same daily-billing rule
      // generation already enforces. Only reached while still needing to
      // ADD quantity, and only when the caller supplied numbering info (see
      // the optional params' doc comment) — otherwise this priority is
      // skipped entirely and any shortfall falls straight through to the
      // error below.
      //
      // Tries the edited invoice's own date first (keeps the new invoice
      // visually close to the edit), but isn't limited to it — a single
      // day's suppliers of this category are often all already billed that
      // day, while the batch as a whole spans many days. Nothing about the
      // "one invoice per supplier per day" rule requires the NEW invoice to
      // share the edited invoice's date, so falling back to every other
      // date actually present in the batch gives this priority far more
      // real capacity to work with before genuinely giving up.
      if (
        remainingNeededChange > MONEY_TOLERANCE &&
        invoiceNumberPrefix !== undefined &&
        startingSequence !== undefined
      ) {
        const targetDate = normalizedEditedInvoice.invoice_date;
        const allBatchDates = new Set<string>();
        for (const inv of allOtherInvoices) {
          if (inv.invoice_date) allBatchDates.add(inv.invoice_date);
        }
        if (normalizedEditedInvoice.invoice_date) {
          allBatchDates.add(normalizedEditedInvoice.invoice_date);
        }
        const candidateDates = [
          targetDate,
          ...Array.from(allBatchDates)
            .filter((d) => d !== targetDate)
            .sort(),
        ];

        const usedSuppliersForDate = (date: string): Set<string> => {
          const used = new Set<string>();
          for (const [supplierId, dates] of supplierDatesUsed) {
            if (dates.has(date)) used.add(supplierId);
          }
          for (const inv of newInvoices) {
            if (inv.invoice_date !== date) continue;
            const s = (inv.products[0] as any)?.supplier_id;
            if (s) used.add(s);
          }
          return used;
        };

        const allCategorySuppliers = Array.from(supplierCategoryMap.entries())
          .filter(
            ([supplierId, cat]) =>
              cat === productCategory && !majorCustomerIds.has(supplierId),
          )
          .map(([supplierId]) => supplierId)
          .sort();

        outerDates: for (const date of candidateDates) {
          if (remainingNeededChange <= MONEY_TOLERANCE) break;
          const usedForDate = usedSuppliersForDate(date);
          const eligibleSuppliers = allCategorySuppliers.filter(
            (supplierId) => !usedForDate.has(supplierId),
          );

          for (const supplierId of eligibleSuppliers) {
            if (remainingNeededChange <= MONEY_TOLERANCE) break outerDates;

            const candidates = CandidateGenerator.generateQuantityCandidates(
              remainingNeededChange,
              constraint,
            );
            if (candidates.length === 0) continue;
            const chosenQty = candidates[0];
            if (chosenQty <= 0) continue;

            const newLineObj: PurchaseLine = {
              product_id: productId,
              product_name: constraint.productName || "",
              hsn_code: constraint.hsnCode || "",
              category: constraint.category,
              unit_of_measure: constraint.unitOfMeasure,
              quantity: chosenQty,
              rate: rateForP,
              amount: computeLineAmount(chosenQty, rateForP),
            };
            (newLineObj as any).customer_id = supplierId;
            (newLineObj as any).supplier_id = supplierId;

            const newInvoiceNumber = `${invoiceNumberPrefix}-${String(
              nextSequence++,
            ).padStart(7, "0")}`;

            newInvoices.push({
              id: randomUUID(),
              invoice_batch_id: normalizedEditedInvoice.invoice_batch_id,
              invoice_number: newInvoiceNumber,
              invoice_date: date,
              products: [newLineObj],
              total_amount: computeLineAmount(chosenQty, rateForP),
              transport_mode: normalizedEditedInvoice.transport_mode,
              vehicle_number: normalizedEditedInvoice.vehicle_number,
              date_of_supply: normalizedEditedInvoice.date_of_supply,
            });

            actualMoneyMoved = roundMoney(
              actualMoneyMoved + computeLineAmount(chosenQty, rateForP),
            );
            remainingNeededChange = roundMoney(
              remainingNeededChange - chosenQty,
            );
          }
        }
      }

      // The real money gap left after priorities 1-3, independent of
      // whether quantity itself was fully conserved (remainingNeededChange
      // can be ~0 here while this is still nonzero — exactly the RED
      // POMFRET-style case where Priority 1's donor lines had a different
      // pre-existing rate than rateForP, so quantity balanced exactly but
      // money didn't). Positive means the batch now has too MUCH money
      // (something elsewhere must shrink); negative means too LITTLE
      // (something elsewhere must grow).
      const editedLineMoneyDelta = roundMoney(
        (newLine ? computeLineAmount(newQty, Number(newLine.rate)) : 0) -
          (origLine ? computeLineAmount(origQty, Number(origLine.rate)) : 0),
      );
      const moneyResidual = roundMoney(editedLineMoneyDelta + actualMoneyMoved);

      // Priority 4 (last resort): close any remaining money gap — whether
      // from unmet quantity conservation (nowhere else to move this
      // product, e.g. a genuinely new addition to the batch) or from a
      // rate mismatch (this product already existed elsewhere, but at a
      // different rate than the edited invoice's) — using the EDITED
      // invoice's own OTHER lines (never a touched product's own line) at
      // THAT line's own valid rate, so the edited invoice's total lands
      // back on its expected value and every other invoice in the batch
      // stays untouched.
      let finalMoneyResidual = moneyResidual;
      if (Math.abs(moneyResidual) > MONEY_TOLERANCE) {
        let shortfallMoney = roundMoney(-moneyResidual);
        const we = getWorkingEdited();

        for (const line of we.products) {
          if (Math.abs(shortfallMoney) <= MONEY_TOLERANCE) break;
          if (touchedProductIds.has(line.product_id)) continue;
          const lineConstraint = constraints.get(line.product_id);
          if (!lineConstraint) continue;

          const lineCandidates = CandidateGenerator.generateLineCandidates(
            line,
            lineConstraint,
          );
          if (lineCandidates.length === 0) continue;

          let best: (typeof lineCandidates)[number] | undefined;
          for (const c of lineCandidates) {
            const diff = Math.abs(c.delta - shortfallMoney);
            if (!best || diff < Math.abs(best.delta - shortfallMoney)) {
              best = c;
            }
            if (diff < MONEY_TOLERANCE) break;
          }
          if (!best || Math.abs(best.delta) < MONEY_TOLERANCE) continue;

          line.quantity = best.quantity;
          line.rate = best.rate;
          line.amount = best.amount;
          shortfallMoney = roundMoney(shortfallMoney - best.delta);
        }

        recomputeTotal(we);
        finalMoneyResidual = roundMoney(-shortfallMoney);
      }

      if (
        Math.abs(remainingNeededChange) > MONEY_TOLERANCE ||
        Math.abs(finalMoneyResidual) > MONEY_TOLERANCE
      ) {
        const productName =
          constraint.productName ||
          newLine?.product_name ||
          origLine?.product_name ||
          productId;
        const uom = constraint.unitOfMeasure || "";
        const achieved = roundMoney(
          neededTotal - Math.abs(remainingNeededChange),
        );
        errors.push(
          `Cannot conserve quantity for "${productName}": needed to shift ${neededTotal} ${uom} across other invoices in this batch (or offset it within the edited invoice itself), but only ${achieved} ${uom} could be absorbed within configured Quantity limits, category, one-invoice-per-supplier-per-day restrictions, and the edited invoice's own available lines. Widen Product Rules for this product, adjust the edit, or add more eligible suppliers of this category.`,
        );
      }
    }

    return {
      updatedInvoices: working,
      newInvoices,
      updatedEditedInvoice: workingEdited,
      errors,
    };
  }

  /**
   * Read-only estimate of how much of `productId` could be ADDED to
   * `editedInvoice` right now (as a brand-new line, or on top of however
   * much it already has) without the save needing to touch any OTHER
   * invoice's product it doesn't already carry — i.e. an upper bound on
   * what Priority 1 (shrink this product's existing lines elsewhere) +
   * Priority 4 (shrink the edited invoice's own other lines) could actually
   * absorb, computed with simple sums instead of running the full
   * candidate search. Used by the UI to show "up to X available" on Quick
   * Add before the user commits to an edit, so the shortfall this function
   * predicts is caught before Save rather than after.
   *
   * Deliberately approximate (real amounts are always finalised exactly at
   * save time by conserve()) and deliberately cheap — no DP, no candidate
   * generation, just addition — so it's safe to call for every product in
   * a batch's product list on every dialog open without noticeable lag.
   */
  public static estimateAddCapacity(
    productId: string,
    editedInvoice: PurchaseInvoice,
    allOtherInvoices: PurchaseInvoice[],
    constraints: Map<string, ProductConstraint>,
    majorCustomerIds: Set<string>,
    supplierCategory: string,
  ): number {
    const constraint = constraints.get(productId);
    if (!constraint) return 0;
    const productCategory = normaliseCategory(constraint.category);

    const invoiceBaselineCategory = (inv: PurchaseInvoice): string => {
      const firstProductId = inv.products?.[0]?.product_id;
      const c = firstProductId ? constraints.get(firstProductId) : undefined;
      return normaliseCategory(c ? c.category : supplierCategory);
    };

    const eligibleOtherInvoices = allOtherInvoices.filter((inv) => {
      const partyId = (inv.products?.[0] as any)?.customer_id;
      if (partyId && majorCustomerIds.has(partyId)) return false;
      return invoiceBaselineCategory(inv) === productCategory;
    });

    // Priority 1 room: how far this product's EXISTING lines elsewhere
    // could shrink toward quantityMin.
    let priority1Room = 0;
    let existingRate: number | undefined;
    for (const inv of eligibleOtherInvoices) {
      const line = inv.products.find((p) => p.product_id === productId);
      if (!line) continue;
      if (existingRate === undefined) existingRate = Number(line.rate);
      const qty = Number(line.quantity) || 0;
      priority1Room += Math.max(0, qty - constraint.quantityMin);
    }

    // Priority 4 room: how far the EDITED invoice's own OTHER lines could
    // shrink toward their own quantityMin, converted to this product's
    // rate-equivalent quantity. Falls back to the midpoint of this
    // product's configured rate range when it has no existing rate
    // anywhere yet (a genuinely brand-new product) — the real rate used at
    // save time may differ slightly, hence this being an estimate.
    const rateForP = existingRate ?? (constraint.rateMin + constraint.rateMax) / 2;
    let priority4RoomMoney = 0;
    for (const line of editedInvoice.products) {
      if (line.product_id === productId) continue;
      const lineConstraint = constraints.get(line.product_id);
      if (!lineConstraint) continue;
      const qty = Number(line.quantity) || 0;
      const rate = Number(line.rate) || 0;
      const minAmount = computeLineAmount(lineConstraint.quantityMin, rate);
      priority4RoomMoney += Math.max(0, qty * rate - minAmount);
    }
    const priority4Room = rateForP > 0 ? priority4RoomMoney / rateForP : 0;

    const totalRoom = priority1Room + priority4Room;
    if (totalRoom <= 0) return 0;

    // Round down to a valid commercial step so the displayed number is
    // something the user could actually enter.
    const candidates = CandidateGenerator.generateQuantityCandidates(
      totalRoom,
      constraint,
    ).filter((q) => q <= totalRoom + MONEY_TOLERANCE);
    if (candidates.length === 0) return 0;
    return Math.max(...candidates);
  }
}
