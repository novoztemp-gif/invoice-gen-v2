import {
  computeLineAmount,
  roundToQuarterIncrement,
  roundToWholeInteger,
} from "@/lib/utils/quantity-rate-utils";
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

    return Array.from(candidates)
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

    return Array.from(candidates)
      .filter((r) => r >= rateMin && r <= rateMax && r >= 1)
      .sort((a, b) => Math.abs(a - currentRate) - Math.abs(b - currentRate))
      .slice(0, SALES_BALANCE_LIMITS.maxRateCandidates);
  }

  /**
   * Generates line candidates for each product in an invoice.
   * If affectedProductIds is provided, UNAFFECTED products are locked strictly to their original quantity.
   */
  public static generateInvoiceLineCandidates(
    invoice: SalesInvoice,
    constraints: Map<string, SalesProductConstraint>,
    availableStockMap?: Map<string, number>,
    targetProductTotals?: Map<string, number>,
    affectedProductIds?: Set<string>,
    originalTotalBalancingMap?: Map<string, number>,
  ): SalesGeneratedInvoiceLineCandidates[] {
    return invoice.products.map((line) => {
      const isAffected =
        !affectedProductIds || affectedProductIds.has(line.product_id);

      const constraint = constraints.get(line.product_id);
      const stockKey = `${invoice.invoice_date}_${line.product_id}`;
      const availableStockLimit =
        availableStockMap?.get(stockKey) ?? Number.POSITIVE_INFINITY;
      const targetQtyHint = targetProductTotals?.get(line.product_id);
      const originalTotalBalancingQty = originalTotalBalancingMap?.get(
        line.product_id,
      );

      const quantities = isAffected
        ? this.generateQuantityCandidates(
            line.quantity,
            line.unit_of_measure || constraint?.unitOfMeasure || "kg",
            availableStockLimit,
            targetQtyHint,
            constraint,
            originalTotalBalancingQty,
          )
        : [line.quantity];

      const rates = this.generateRateCandidates(line.rate, constraint);

      const candidateSet = new Map<string, SalesGeneratedLineCandidate>();

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

      const candidates = Array.from(lineCandidatePool.values());

      return {
        productId: line.product_id,
        originalLine: line,
        candidates,
      };
    });
  }
}
