import {
  BALANCE_COST,
  GeneratedLineCandidate,
  InvoiceCandidate,
  LineCandidate,
  MONEY_TOLERANCE,
  ProductConstraint,
  PurchaseInvoice,
  PurchaseLine,
  roundMoney,
} from "./types";

const WEIGHT_UOMS = new Set(["KG", "KGS", "KILOGRAM", "KILOGRAMS"]);
const TONNAGE_UOMS = new Set(["MT", "TON", "TONNE", "TONNES"]);
const WHOLESALE_WEIGHT_BASES = [
  10, 12, 15, 18, 20, 25, 30, 35, 40, 45, 50, 60, 75, 80, 100, 125, 150, 200,
  250, 300, 400, 500, 750, 1000,
];

export class CandidateScorer {
  /**
   * Scores a single line candidate using frozen Phase 1 cost weights.
   * Does not mutate the candidate object.
   */
  public static scoreLineCandidate(
    candidate: GeneratedLineCandidate | LineCandidate,
    originalLine: PurchaseLine,
    constraint: ProductConstraint,
  ): LineCandidate {
    const candidateQty = candidate.line
      ? candidate.line.quantity
      : (candidate as GeneratedLineCandidate).quantity;
    const candidateRate = candidate.line
      ? candidate.line.rate
      : (candidate as GeneratedLineCandidate).rate;
    const candidateAmount = candidate.line
      ? candidate.line.amount
      : (candidate as GeneratedLineCandidate).amount;

    const quantityChanged =
      Math.abs(candidateQty - originalLine.quantity) > MONEY_TOLERANCE;
    const rateChanged =
      Math.abs(candidateRate - originalLine.rate) > MONEY_TOLERANCE;

    if (!quantityChanged && !rateChanged) {
      return {
        line: {
          ...originalLine,
          quantity: originalLine.quantity,
          rate: originalLine.rate,
          amount: originalLine.amount,
        },
        delta: 0,
        cost: 0,
      };
    }

    let cost = BALANCE_COST.changedLine;

    // Quantity movement cost
    if (quantityChanged) {
      const stepDistance = this.calculateQuantityStepDistance(
        originalLine.quantity,
        candidateQty,
        constraint,
      );
      cost += stepDistance * BALANCE_COST.quantityStep;

      // Quantity boundary penalty
      if (
        Math.abs(candidateQty - constraint.quantityMin) <= MONEY_TOLERANCE ||
        Math.abs(candidateQty - constraint.quantityMax) <= MONEY_TOLERANCE
      ) {
        cost += BALANCE_COST.quantityBoundary;
      }
    }

    // Rate movement cost
    if (rateChanged) {
      const rateDistance = Math.abs(candidateRate - originalLine.rate);
      cost += rateDistance * BALANCE_COST.rateRupee;

      // Rate boundary penalty
      if (
        Math.abs(candidateRate - constraint.rateMin) <= MONEY_TOLERANCE ||
        Math.abs(candidateRate - constraint.rateMax) <= MONEY_TOLERANCE
      ) {
        cost += BALANCE_COST.rateBoundary;
      }
    }

    const line: PurchaseLine = {
      ...originalLine,
      quantity: candidateQty,
      rate: candidateRate,
      amount: candidateAmount,
    };

    const delta = roundMoney(candidateAmount - originalLine.amount);

    return {
      line,
      delta,
      cost,
    };
  }

  /**
   * Scores an entire invoice candidate composed of scored line candidates.
   * Applies the changedInvoice penalty (100) if any line changed.
   * Does not mutate input objects.
   */
  public static scoreInvoiceCandidate(
    scoredLines: LineCandidate[],
    originalInvoice: PurchaseInvoice,
  ): InvoiceCandidate {
    const originalLinesMap = new Map(
      originalInvoice.products.map((line) => [line.product_id, line]),
    );

    let hasLineChanges = false;
    let totalLineCost = 0;

    const clonedLines: PurchaseLine[] = scoredLines.map((scored) => {
      const orig = originalLinesMap.get(scored.line.product_id);
      if (
        orig &&
        (Math.abs(scored.line.quantity - orig.quantity) > MONEY_TOLERANCE ||
          Math.abs(scored.line.rate - orig.rate) > MONEY_TOLERANCE)
      ) {
        hasLineChanges = true;
      }
      totalLineCost += scored.cost;
      return { ...scored.line };
    });

    const totalAmount = roundMoney(
      clonedLines.reduce((sum, line) => sum + line.amount, 0),
    );
    const delta = roundMoney(totalAmount - originalInvoice.total_amount);

    const cost = hasLineChanges
      ? BALANCE_COST.changedInvoice + totalLineCost
      : 0;

    return {
      invoiceId: originalInvoice.id,
      products: clonedLines,
      totalAmount,
      delta,
      cost,
    };
  }

  /**
   * Helper to calculate the commercial step distance between two quantities.
   */
  public static calculateQuantityStepDistance(
    fromQty: number,
    toQty: number,
    constraint: ProductConstraint,
  ): number {
    if (Math.abs(fromQty - toQty) <= MONEY_TOLERANCE) return 0;

    const uom = (constraint.unitOfMeasure || "").trim().toUpperCase();

    if (WEIGHT_UOMS.has(uom)) {
      const weightSteps = this.getWeightSteps(constraint);
      const fromIdx = weightSteps.findIndex(
        (step) => Math.abs(step - fromQty) <= MONEY_TOLERANCE,
      );
      const toIdx = weightSteps.findIndex(
        (step) => Math.abs(step - toQty) <= MONEY_TOLERANCE,
      );

      if (fromIdx !== -1 && toIdx !== -1) {
        return Math.abs(toIdx - fromIdx);
      }
      return Math.max(1, Math.round(Math.abs(toQty - fromQty) / 0.25));
    }

    if (TONNAGE_UOMS.has(uom)) {
      return Math.max(1, Math.round(Math.abs(toQty - fromQty) / 0.25));
    }

    // Count / Package / Unknown UOM: whole unit distance
    return Math.max(1, Math.round(Math.abs(toQty - fromQty)));
  }

  private static getWeightSteps(constraint: ProductConstraint): number[] {
    const steps: number[] = [];
    if (constraint.quantityMax < 10) {
      const minQ = Math.ceil(constraint.quantityMin * 4) / 4;
      const maxQ = Math.floor(constraint.quantityMax * 4) / 4;
      for (let q = minQ; q <= maxQ + MONEY_TOLERANCE; q += 0.25) {
        steps.push(roundMoney(q));
      }
    } else {
      for (const base of WHOLESALE_WEIGHT_BASES) {
        for (const variant of [base, base + 0.25, base + 0.5, base + 0.75]) {
          const val = roundMoney(variant);
          if (val >= constraint.quantityMin && val <= constraint.quantityMax) {
            steps.push(val);
          }
        }
      }
    }
    return steps;
  }
}
