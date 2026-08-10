import {
  computeLineAmount,
  roundToQuarterIncrement,
  roundToWholeInteger,
} from "@/lib/utils/quantity-rate-utils";
import { computeAddRoom, SalesAllocationTracker } from "./SalesLineCapacity";
import {
  roundMoney,
  SALES_BALANCE_LIMITS,
  SalesGeneratedInvoiceLineCandidates,
  SalesGeneratedLineCandidate,
  SalesInvoice,
  SalesLine,
  SalesProductConstraint,
} from "./types";

export class SalesCandidateGenerator {
  /**
   * Generates candidate quantities for a line based on UOM commercial rules, stock limits, product rules, and target hints.
   */
  public static generateQuantityCandidates(
    currentQty: number,
    uom = "kg",
    availableStockLimit = Number.POSITIVE_INFINITY,
    targetQtyHint?: number,
    constraint?: SalesProductConstraint,
    originalTotalBalancingQty?: number,
  ): number[] {
    const isWeight =
      uom.toLowerCase().includes("kg") || uom.toLowerCase().includes("ton");

    const minQty = constraint?.quantityMin ?? 0;
    const maxQty = Math.min(
      constraint?.quantityMax ?? Number.POSITIVE_INFINITY,
      availableStockLimit,
    );

    const candidates = new Set<number>();
    candidates.add(roundToQuarterIncrement(currentQty));
    candidates.add(0);

    if (targetQtyHint !== undefined && targetQtyHint >= 0) {
      candidates.add(roundToQuarterIncrement(targetQtyHint));
    }

    const intSteps = [
      1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50, 60, 75, 80, 100, 150,
      200, 400,
    ];

    // Directional delta calculation across balancing invoices
    const targetDelta =
      targetQtyHint !== undefined && originalTotalBalancingQty !== undefined
        ? targetQtyHint - originalTotalBalancingQty
        : 0;

    if (Math.abs(targetDelta) > 0.001) {
      const directTargetCandidate = roundToQuarterIncrement(
        currentQty + targetDelta,
      );
      if (directTargetCandidate >= minQty && directTargetCandidate <= maxQty) {
        candidates.add(directTargetCandidate);
      }
    }

    for (const step of intSteps) {
      const down = roundToQuarterIncrement(currentQty - step);
      if (down >= minQty && down <= maxQty) candidates.add(down);

      const up = roundToQuarterIncrement(currentQty + step);
      if (up >= minQty && up <= maxQty) candidates.add(up);
    }

    if (targetQtyHint !== undefined && targetQtyHint >= 0) {
      for (const step of intSteps) {
        const down = roundToQuarterIncrement(targetQtyHint - step);
        if (down >= minQty && down <= maxQty) candidates.add(down);

        const up = roundToQuarterIncrement(targetQtyHint + step);
        if (up >= minQty && up <= maxQty) candidates.add(up);
      }
    }

    if (isWeight) {
      for (const fracStep of [
        0.25, 0.5, 0.75, 1.25, 1.5, 1.75, 2.25, 2.5, 2.75,
      ]) {
        const down = roundToQuarterIncrement(currentQty - fracStep);
        if (down >= minQty && down <= maxQty) candidates.add(down);

        const up = roundToQuarterIncrement(currentQty + fracStep);
        if (up >= minQty && up <= maxQty) candidates.add(up);
      }
    }

    const result = Array.from(candidates)
      .filter((q) => q === 0 || (q >= minQty && q <= maxQty))
      .sort((a, b) => {
        const isCurrentA = Math.abs(a - currentQty) < 0.001 ? 1 : 0;
        const isCurrentB = Math.abs(b - currentQty) < 0.001 ? 1 : 0;
        if (isCurrentA !== isCurrentB) return isCurrentB - isCurrentA;

        // Direct delta match (e.g. 30 + (-10) = 20)
        if (Math.abs(targetDelta) > 0.001) {
          const directTarget = roundToQuarterIncrement(
            currentQty + targetDelta,
          );
          const isDirectA = Math.abs(a - directTarget) < 0.001 ? 1 : 0;
          const isDirectB = Math.abs(b - directTarget) < 0.001 ? 1 : 0;
          if (isDirectA !== isDirectB) return isDirectB - isDirectA;
        }

        const isTargetA =
          targetQtyHint !== undefined && Math.abs(a - targetQtyHint) < 0.001
            ? 1
            : 0;
        const isTargetB =
          targetQtyHint !== undefined && Math.abs(b - targetQtyHint) < 0.001
            ? 1
            : 0;
        if (isTargetA !== isTargetB) return isTargetB - isTargetA;

        const isZeroA = a === 0 ? 1 : 0;
        const isZeroB = b === 0 ? 1 : 0;
        if (isZeroA !== isZeroB) return isZeroB - isZeroA;

        // Whole integer quantity preference over quarter decimal steps
        const isIntA = Math.abs(a - Math.round(a)) < 0.001 ? 1 : 0;
        const isIntB = Math.abs(b - Math.round(b)) < 0.001 ? 1 : 0;
        if (isIntA !== isIntB) return isIntB - isIntA;

        const diffA = Math.abs(a - currentQty);
        const diffB = Math.abs(b - currentQty);
        if (Math.abs(diffA - diffB) > 0.001) {
          return diffA - diffB;
        }

        // Directional sorting based on targetDelta
        if (Math.abs(targetDelta) > 0.001) {
          const neededIncrease = targetDelta > 0;
          const isIncreaseA = a > currentQty;
          const isIncreaseB = b > currentQty;
          if (neededIncrease) {
            if (isIncreaseA !== isIncreaseB) return isIncreaseA ? -1 : 1;
          } else {
            if (isIncreaseA !== isIncreaseB) return isIncreaseA ? 1 : -1;
          }
        }

        return diffA - diffB;
      })
      .slice(0, SALES_BALANCE_LIMITS.maxQuantityCandidates);

    if (result.length === 0) {
      return [currentQty];
    }
    return result;
  }

  /**
   * Generates candidate integer rates around the current line rate.
   */
  public static generateRateCandidates(
    currentRate: number,
    constraint?: SalesProductConstraint,
  ): number[] {
    const rateMin = constraint?.rateMin || 1;
    const rateMax = constraint?.rateMax || 10000;
    const baseRate = roundToWholeInteger(currentRate);

    const candidates = new Set<number>();
    candidates.add(baseRate);

    const steps = [-5, -4, -3, -2, -1, 1, 2, 3, 4, 5];
    for (const s of steps) {
      const r = baseRate + s;
      if (r >= rateMin && r <= rateMax && r >= 1) {
        candidates.add(r);
      }
    }

    const rates = Array.from(candidates)
      .filter((r) => r >= rateMin && r <= rateMax && r >= 1)
      .sort((a, b) => Math.abs(a - currentRate) - Math.abs(b - currentRate))
      .slice(0, SALES_BALANCE_LIMITS.maxRateCandidates);

    if (rates.length === 0) {
      return [Math.max(1, baseRate)];
    }
    return rates;
  }

  /**
   * Generates line candidates for each product in an invoice.
   * If affectedProductIds is provided, UNAFFECTED products are locked strictly to their original quantity.
   */
  public static generateInvoiceLineCandidates(
    invoice: SalesInvoice,
    constraints: Map<string, SalesProductConstraint>,
    tracker: SalesAllocationTracker | undefined,
    targetProductTotals?: Map<string, number>,
    affectedProductIds?: Set<string>,
    originalTotalBalancingMap?: Map<string, number>,
    thresholdMax?: number,
    productTemplates?: Map<string, SalesLine>,
  ): SalesGeneratedInvoiceLineCandidates[] {
    const existingLineResults = invoice.products.map((line) => {
      const isAffected =
        !affectedProductIds || affectedProductIds.has(line.product_id);

      const constraint = constraints.get(line.product_id);
      const targetQtyHint = targetProductTotals?.get(line.product_id);
      const originalTotalBalancingQty = originalTotalBalancingMap?.get(
        line.product_id,
      );

      // One shared calculation of how far this line is allowed to grow —
      // product quantity max, the shared per-date/product stock ceiling,
      // and the invoice's own headroom under the batch's maximum invoice
      // amount, all folded together instead of checked separately (a
      // separately-checked stock limit here used to ignore the ₹ cap
      // entirely, and vice versa, letting the search commit to candidates
      // that only failed at final validation). Queried at zero "already
      // used" — cross-invoice coordination during the actual search happens
      // via the same tracker in SalesCandidateSolver.
      const stockCeiling = tracker
        ? tracker.ceilingFor(invoice.invoice_date, line.product_id)
        : Number.POSITIVE_INFINITY;
      const { room } = computeAddRoom({
        currentQuantity: line.quantity,
        currentAmount: line.amount,
        invoiceTotalAmount: invoice.total_amount,
        rate: line.rate,
        constraint,
        thresholdMax,
        stockCeiling,
        stockAlreadyUsed: 0,
      });
      const maxQtyCeiling =
        room === Number.POSITIVE_INFINITY
          ? Number.POSITIVE_INFINITY
          : roundToQuarterIncrement(line.quantity + room);

      const quantities = isAffected
        ? this.generateQuantityCandidates(
            line.quantity,
            line.unit_of_measure || constraint?.unitOfMeasure || "kg",
            maxQtyCeiling,
            targetQtyHint,
            constraint,
            originalTotalBalancingQty,
          )
        : [line.quantity];

      // Same lock as quantity above — an unaffected line's rate must never
      // vary either, or a different, untouched product could silently end
      // up with a different rate.
      const rates = isAffected
        ? this.generateRateCandidates(line.rate, constraint)
        : [line.rate];

      const candidateSet = new Map<string, SalesGeneratedLineCandidate>();

      // Guarantee the original unmodified line item candidate is present
      const originalKey = `${line.quantity}_${line.rate}`;
      candidateSet.set(originalKey, {
        line: {
          ...line,
          quantity: line.quantity,
          rate: line.rate,
          amount: line.amount,
        },
        delta: 0,
        quantity: line.quantity,
        rate: line.rate,
        amount: line.amount,
      });

      for (const q of quantities) {
        for (const r of rates) {
          const amount = computeLineAmount(q, r);
          const delta = roundMoney(amount - line.amount);
          const key = `${q}_${r}`;

          if (!candidateSet.has(key)) {
            candidateSet.set(key, {
              line: {
                ...line,
                quantity: q,
                rate: r,
                amount,
              },
              delta,
              quantity: q,
              rate: r,
              amount,
            });
          }
        }
      }

      const targetDelta =
        targetQtyHint !== undefined && originalTotalBalancingQty !== undefined
          ? targetQtyHint - originalTotalBalancingQty
          : 0;
      const directTargetQty = roundToQuarterIncrement(
        line.quantity + targetDelta,
      );

      const allCandidates = Array.from(candidateSet.values()).sort((a, b) => {
        if (Math.abs(targetDelta) > 0.001) {
          const isDirectA =
            Math.abs(a.quantity - directTargetQty) < 0.001 ? 1 : 0;
          const isDirectB =
            Math.abs(b.quantity - directTargetQty) < 0.001 ? 1 : 0;
          if (isDirectA !== isDirectB) return isDirectB - isDirectA;
        }

        const isTargetA =
          targetQtyHint !== undefined &&
          Math.abs(a.quantity - targetQtyHint) < 0.001
            ? 1
            : 0;
        const isTargetB =
          targetQtyHint !== undefined &&
          Math.abs(b.quantity - targetQtyHint) < 0.001
            ? 1
            : 0;
        if (isTargetA !== isTargetB) return isTargetB - isTargetA;

        const isZeroA = a.quantity === 0 ? 1 : 0;
        const isZeroB = b.quantity === 0 ? 1 : 0;
        if (isZeroA !== isZeroB) return isZeroB - isZeroA;

        const qtyDiffA = Math.abs(a.quantity - line.quantity);
        const qtyDiffB = Math.abs(b.quantity - line.quantity);
        if (qtyDiffA !== qtyDiffB) return qtyDiffA - qtyDiffB;

        const rateDiffA = Math.abs(a.rate - line.rate);
        const rateDiffB = Math.abs(b.rate - line.rate);
        return rateDiffA - rateDiffB;
      });

      const uniqueByQty = new Map<number, SalesGeneratedLineCandidate>();
      for (const cand of allCandidates) {
        if (!uniqueByQty.has(cand.quantity)) {
          uniqueByQty.set(cand.quantity, cand);
        }
      }

      const lineCandidatePool = new Map<string, SalesGeneratedLineCandidate>();
      for (const cand of uniqueByQty.values()) {
        lineCandidatePool.set(`${cand.quantity}_${cand.rate}`, cand);
      }
      for (const cand of allCandidates) {
        if (lineCandidatePool.size >= SALES_BALANCE_LIMITS.maxLineCandidates)
          break;
        lineCandidatePool.set(`${cand.quantity}_${cand.rate}`, cand);
      }

      // maxQtyCeiling already bounds quantity at the line's CURRENT rate —
      // but candidate rates can vary too (generateRateCandidates), so a
      // higher-rate candidate at that same capped quantity could still push
      // the invoice over the ₹ cap. Final safety filter for that case, still
      // always keeping the original (unchanged) line as a fallback even if
      // it was already over the cap before this edit.
      const otherLinesTotal = roundMoney(invoice.total_amount - line.amount);
      const maxAmountForThisLine =
        thresholdMax && thresholdMax > 0
          ? Math.max(0, thresholdMax - otherLinesTotal)
          : Number.POSITIVE_INFINITY;
      const candidates = Array.from(lineCandidatePool.values()).filter(
        (cand) =>
          (Math.abs(cand.quantity - line.quantity) < 0.001 &&
            Math.abs(cand.rate - line.rate) < 0.001) ||
          cand.amount <= maxAmountForThisLine + 0.5,
      );

      return {
        productId: line.product_id,
        originalLine: line,
        candidates,
      };
    });

    // Balancing invoices are no longer restricted to ones that already
    // carry the edited product — any invoice in the batch is eligible.
    // For an affected product this invoice doesn't currently hold at all,
    // synthesize a phantom zero-quantity line from productTemplates and
    // generate ADD-only candidates for it (a q=0 candidate — "don't add it
    // here" — is always kept, so this never forces a change).
    const newLineResults: SalesGeneratedInvoiceLineCandidates[] = [];
    if (affectedProductIds && productTemplates) {
      const existingPids = new Set(invoice.products.map((p) => p.product_id));
      for (const pid of affectedProductIds) {
        if (existingPids.has(pid)) continue;
        const template = productTemplates.get(pid);
        if (!template) continue;

        const constraint = constraints.get(pid);
        const targetQtyHint = targetProductTotals?.get(pid);
        const originalTotalBalancingQty = originalTotalBalancingMap?.get(pid);
        const zeroLine: SalesLine = {
          ...template,
          quantity: 0,
          rate: template.rate,
          amount: 0,
        };

        const stockCeiling = tracker
          ? tracker.ceilingFor(invoice.invoice_date, pid)
          : Number.POSITIVE_INFINITY;
        const { room } = computeAddRoom({
          currentQuantity: 0,
          currentAmount: 0,
          invoiceTotalAmount: invoice.total_amount,
          rate: template.rate,
          constraint,
          thresholdMax,
          stockCeiling,
          stockAlreadyUsed: 0,
        });
        const maxQtyCeiling =
          room === Number.POSITIVE_INFINITY
            ? Number.POSITIVE_INFINITY
            : roundToQuarterIncrement(room);

        const quantities = this.generateQuantityCandidates(
          0,
          zeroLine.unit_of_measure || constraint?.unitOfMeasure || "kg",
          maxQtyCeiling,
          targetQtyHint,
          constraint,
          originalTotalBalancingQty,
        );
        const rates = this.generateRateCandidates(template.rate, constraint);

        const candidateSet = new Map<string, SalesGeneratedLineCandidate>();
        candidateSet.set(`0_${template.rate}`, {
          line: zeroLine,
          delta: 0,
          quantity: 0,
          rate: template.rate,
          amount: 0,
        });

        for (const q of quantities) {
          if (q === 0) continue;
          for (const r of rates) {
            const amount = computeLineAmount(q, r);
            const key = `${q}_${r}`;
            if (!candidateSet.has(key)) {
              candidateSet.set(key, {
                line: { ...zeroLine, quantity: q, rate: r, amount },
                delta: amount,
                quantity: q,
                rate: r,
                amount,
              });
            }
          }
        }

        const otherLinesTotal = invoice.total_amount;
        const maxAmountForThisLine =
          thresholdMax && thresholdMax > 0
            ? Math.max(0, thresholdMax - otherLinesTotal)
            : Number.POSITIVE_INFINITY;

        const candidates = Array.from(candidateSet.values())
          .filter(
            (cand) =>
              cand.quantity === 0 || cand.amount <= maxAmountForThisLine + 0.5,
          )
          .slice(0, SALES_BALANCE_LIMITS.maxLineCandidates);

        newLineResults.push({
          productId: pid,
          originalLine: zeroLine,
          candidates,
        });
      }
    }

    return [...existingLineResults, ...newLineResults];
  }
}
