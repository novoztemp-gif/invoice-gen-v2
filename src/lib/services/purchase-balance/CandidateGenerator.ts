import {
  computeLineAmount,
  isValidWholeNumber,
} from "@/lib/utils/quantity-rate-utils";
import {
  BALANCE_LIMITS,
  GeneratedInvoiceLineCandidates,
  GeneratedLineCandidate,
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

export class CandidateGenerator {
  /**
   * Generates valid commercial quantity candidates for a single product line.
   * Guarantees priority inclusion of current quantity, quantityMin, and quantityMax
   * (if valid), supplemented by the closest commercial step candidates up to 12 total.
   */
  public static generateQuantityCandidates(
    currentQuantity: number,
    constraint: ProductConstraint,
  ): number[] {
    const uom = (constraint.unitOfMeasure || "").trim().toUpperCase();
    const allStepCandidates: number[] = [];

    if (WEIGHT_UOMS.has(uom)) {
      if (constraint.quantityMax < 10) {
        const minQ = Math.ceil(constraint.quantityMin * 4) / 4;
        const maxQ = Math.floor(constraint.quantityMax * 4) / 4;
        for (let q = minQ; q <= maxQ + MONEY_TOLERANCE; q += 0.25) {
          const val = roundMoney(q);
          if (this.isCommercialQuantity(val, constraint)) {
            allStepCandidates.push(val);
          }
        }
      } else {
        for (const base of WHOLESALE_WEIGHT_BASES) {
          for (const variant of [base, base + 0.25, base + 0.5, base + 0.75]) {
            const val = roundMoney(variant);
            if (this.isCommercialQuantity(val, constraint)) {
              allStepCandidates.push(val);
            }
          }
        }
      }
    } else if (TONNAGE_UOMS.has(uom)) {
      const minQ = Math.ceil(constraint.quantityMin * 4) / 4;
      const maxQ = Math.floor(constraint.quantityMax * 4) / 4;
      for (let q = minQ; q <= maxQ + MONEY_TOLERANCE; q += 0.25) {
        const val = roundMoney(q);
        if (this.isCommercialQuantity(val, constraint)) {
          allStepCandidates.push(val);
        }
      }
    } else {
      // Count / Package / Unknown UOM: positive integers
      const minQ = Math.ceil(constraint.quantityMin);
      const maxQ = Math.floor(constraint.quantityMax);
      for (let q = minQ; q <= maxQ; q++) {
        if (this.isCommercialQuantity(q, constraint)) {
          allStepCandidates.push(q);
        }
      }
    }

    // Priority candidates: currentQuantity, min, max
    const priorityCandidates: number[] = [];
    if (
      currentQuantity > 0 &&
      this.isCommercialQuantity(currentQuantity, constraint)
    ) {
      priorityCandidates.push(roundMoney(currentQuantity));
    }
    if (
      constraint.quantityMin > 0 &&
      this.isCommercialQuantity(constraint.quantityMin, constraint)
    ) {
      priorityCandidates.push(roundMoney(constraint.quantityMin));
    }
    if (
      constraint.quantityMax > 0 &&
      this.isCommercialQuantity(constraint.quantityMax, constraint)
    ) {
      priorityCandidates.push(roundMoney(constraint.quantityMax));
    }

    // Sort remaining step candidates by closeness to currentQuantity
    const remainingSorted = Array.from(new Set(allStepCandidates)).sort(
      (a, b) => {
        const diffA = Math.abs(a - currentQuantity);
        const diffB = Math.abs(b - currentQuantity);
        if (Math.abs(diffA - diffB) > MONEY_TOLERANCE) {
          return diffA - diffB;
        }
        return a - b;
      },
    );

    const combined: number[] = [];
    const seen = new Set<number>();

    for (const val of priorityCandidates) {
      if (!seen.has(val)) {
        seen.add(val);
        combined.push(val);
      }
    }

    for (const val of remainingSorted) {
      if (combined.length >= BALANCE_LIMITS.maxQuantityCandidates) break;
      if (!seen.has(val)) {
        seen.add(val);
        combined.push(val);
      }
    }

    return combined.slice(0, BALANCE_LIMITS.maxQuantityCandidates);
  }

  /**
   * Generates valid whole-number rate candidates for a given quantity candidate.
   * Guarantees priority inclusion of current rate, rateMin, rateMax, and idealRate
   * (if valid), supplemented by nearest integer rate candidates up to 5 total.
   */
  public static generateRateCandidates(
    quantity: number,
    currentRate: number,
    constraint: ProductConstraint,
    currentAmount?: number,
  ): number[] {
    if (quantity <= 0) return [];

    const minRate = Math.ceil(constraint.rateMin);
    const maxRate = Math.floor(constraint.rateMax);
    if (minRate > maxRate) return [];

    const targetAmount = currentAmount ?? quantity * currentRate;
    const idealRate = Math.round(targetAmount / quantity);

    const priorityCandidates: number[] = [];

    // Current rate if integer and within bounds
    if (
      isValidWholeNumber(currentRate) &&
      currentRate >= minRate &&
      currentRate <= maxRate
    ) {
      priorityCandidates.push(Math.round(currentRate));
    }

    // Ideal rate if in bounds
    if (idealRate >= minRate && idealRate <= maxRate) {
      priorityCandidates.push(idealRate);
    }

    // Candidate rates pool (bounds and adjacent rates)
    const stepCandidates: number[] = [minRate, maxRate];
    for (let offset = -5; offset <= 5; offset++) {
      const r1 = idealRate + offset;
      if (r1 >= minRate && r1 <= maxRate) stepCandidates.push(r1);
      const r2 = Math.round(currentRate) + offset;
      if (r2 >= minRate && r2 <= maxRate) stepCandidates.push(r2);
    }

    const sortedSteps = Array.from(new Set(stepCandidates)).sort((a, b) => {
      const diffA = Math.abs(a - currentRate);
      const diffB = Math.abs(b - currentRate);
      if (Math.abs(diffA - diffB) > MONEY_TOLERANCE) return diffA - diffB;
      return a - b;
    });

    const combined: number[] = [];
    const seen = new Set<number>();

    for (const val of priorityCandidates) {
      if (val >= minRate && val <= maxRate && !seen.has(val)) {
        seen.add(val);
        combined.push(val);
      }
    }

    for (const val of sortedSteps) {
      if (combined.length >= BALANCE_LIMITS.maxRateCandidates) break;
      if (!seen.has(val)) {
        seen.add(val);
        combined.push(val);
      }
    }

    return combined.slice(0, BALANCE_LIMITS.maxRateCandidates);
  }

  /**
   * Generates line candidates (quantity & rate combinations) for a single line item.
   */
  public static generateLineCandidates(
    line: PurchaseLine,
    constraint: ProductConstraint,
  ): GeneratedLineCandidate[] {
    const quantities = this.generateQuantityCandidates(
      line.quantity,
      constraint,
    );
    const candidates: GeneratedLineCandidate[] = [];

    for (const qty of quantities) {
      const rates = this.generateRateCandidates(
        qty,
        line.rate,
        constraint,
        line.amount,
      );
      for (const rate of rates) {
        const amount = computeLineAmount(qty, rate);
        const delta = roundMoney(amount - line.amount);
        const updatedLine: PurchaseLine = {
          ...line,
          quantity: qty,
          rate,
          amount,
        };

        candidates.push({
          line: updatedLine,
          delta,
          quantity: qty,
          rate,
          amount,
        });
      }
    }

    // Sort line candidates deterministically:
    // 1. Quantity distance ascending
    // 2. Rate distance ascending
    // 3. Absolute delta ascending
    // 4. Quantity ascending
    // 5. Rate ascending
    candidates.sort((a, b) => {
      const qDiffA = Math.abs(a.quantity - line.quantity);
      const qDiffB = Math.abs(b.quantity - line.quantity);
      if (Math.abs(qDiffA - qDiffB) > MONEY_TOLERANCE) return qDiffA - qDiffB;

      const rDiffA = Math.abs(a.rate - line.rate);
      const rDiffB = Math.abs(b.rate - line.rate);
      if (Math.abs(rDiffA - rDiffB) > MONEY_TOLERANCE) return rDiffA - rDiffB;

      const absDeltaA = Math.abs(a.delta);
      const absDeltaB = Math.abs(b.delta);
      if (Math.abs(absDeltaA - absDeltaB) > MONEY_TOLERANCE)
        return absDeltaA - absDeltaB;

      if (Math.abs(a.quantity - b.quantity) > MONEY_TOLERANCE)
        return a.quantity - b.quantity;
      return a.rate - b.rate;
    });

    return candidates;
  }

  /**
   * Generates line candidates for all product lines in an invoice.
   * Product lines are processed in deterministic order (product_name asc, product_id asc).
   */
  public static generateInvoiceLineCandidates(
    invoice: PurchaseInvoice,
    constraints: Map<string, ProductConstraint>,
  ): GeneratedInvoiceLineCandidates[] {
    const sortedLines = [...(invoice.products || [])].sort((a, b) => {
      const nameA = a.product_name || a.product_id;
      const nameB = b.product_name || b.product_id;
      const nameCmp = nameA.localeCompare(nameB);
      if (nameCmp !== 0) return nameCmp;
      return a.product_id.localeCompare(b.product_id);
    });

    return sortedLines.map((line) => {
      const constraint = constraints.get(line.product_id);
      if (!constraint) {
        throw new Error(
          `Missing product rule constraint for product ${line.product_name || line.product_id}.`,
        );
      }

      const candidates = this.generateLineCandidates(line, constraint);
      return {
        productId: line.product_id,
        originalLine: line,
        candidates,
      };
    });
  }

  /**
   * Helper to check if a quantity is a valid commercial quantity per business rules.
   */
  public static isCommercialQuantity(
    quantity: number,
    constraint: ProductConstraint,
  ): boolean {
    if (
      !Number.isFinite(quantity) ||
      quantity <= 0 ||
      quantity < constraint.quantityMin - MONEY_TOLERANCE ||
      quantity > constraint.quantityMax + MONEY_TOLERANCE
    ) {
      return false;
    }

    const uom = (constraint.unitOfMeasure || "").trim().toUpperCase();

    if (WEIGHT_UOMS.has(uom)) {
      if (constraint.quantityMax < 10) {
        return (
          Math.abs(quantity * 4 - Math.round(quantity * 4)) < MONEY_TOLERANCE
        );
      }
      if (quantity < 10 - MONEY_TOLERANCE) return false;
      return WHOLESALE_WEIGHT_BASES.some((base) =>
        [base, base + 0.25, base + 0.5, base + 0.75].some(
          (variant) => Math.abs(variant - quantity) < MONEY_TOLERANCE,
        ),
      );
    }

    if (TONNAGE_UOMS.has(uom)) {
      return (
        Math.abs(quantity * 4 - Math.round(quantity * 4)) < MONEY_TOLERANCE
      );
    }

    // Count / Package / Unknown UOM
    return (
      Number.isInteger(quantity) ||
      Math.abs(quantity - Math.round(quantity)) < MONEY_TOLERANCE
    );
  }
}
