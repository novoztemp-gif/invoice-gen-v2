import {
  roundMoney,
  SALES_BALANCE_COST,
  SalesInvoiceCandidate,
  SalesLine,
  SalesLineCandidate,
  SalesProductConstraint,
} from "./types";

export class SalesCandidateScorer {
  /**
   * Calculates movement cost for a line candidate.
   */
  public static scoreLineCandidate(
    originalLine: SalesLine,
    candidateLine: SalesLine,
    constraint?: SalesProductConstraint,
  ): number {
    const isQtyChanged =
      Math.abs(candidateLine.quantity - originalLine.quantity) > 0.001;
    const isRateChanged =
      Math.abs(candidateLine.rate - originalLine.rate) > 0.001;

    if (!isQtyChanged && !isRateChanged) {
      return 0; // Zero movement cost for unchanged line
    }

    let cost = SALES_BALANCE_COST.changedLine;

    if (isQtyChanged) {
      const uom =
        candidateLine.unit_of_measure || constraint?.unitOfMeasure || "kg";
      const isWeight =
        uom.toLowerCase().includes("kg") || uom.toLowerCase().includes("ton");
      const stepSize = isWeight ? 0.25 : 1;
      const numSteps = Math.round(
        Math.abs(candidateLine.quantity - originalLine.quantity) / stepSize,
      );
      cost += numSteps * SALES_BALANCE_COST.quantityStep;
    }

    if (isRateChanged) {
      const rateDiff = Math.abs(candidateLine.rate - originalLine.rate);
      cost += rateDiff * SALES_BALANCE_COST.rateRupee;
    }

    // Boundary penalty if quantity or rate reaches configured min/max boundaries
    if (constraint) {
      if (
        candidateLine.quantity === constraint.quantityMin ||
        candidateLine.quantity === constraint.quantityMax
      ) {
        cost += SALES_BALANCE_COST.quantityBoundary;
      }
      if (
        candidateLine.rate === constraint.rateMin ||
        candidateLine.rate === constraint.rateMax
      ) {
        cost += SALES_BALANCE_COST.rateBoundary;
      }
    }

    return Math.round(cost);
  }

  /**
   * Calculates total cost for an entire invoice candidate.
   */
  public static scoreInvoiceCandidate(
    originalInvoiceProducts: SalesLine[],
    candidateInvoiceProducts: SalesLine[],
    constraints: Map<string, SalesProductConstraint>,
  ): number {
    let totalCost = 0;
    let hasAnyLineChanged = false;

    for (let i = 0; i < originalInvoiceProducts.length; i++) {
      const orig = originalInvoiceProducts[i];
      const cand = candidateInvoiceProducts[i] || orig;
      const constraint = constraints.get(orig.product_id);

      const lineCost = this.scoreLineCandidate(orig, cand, constraint);
      if (lineCost > 0) {
        hasAnyLineChanged = true;
        totalCost += lineCost;
      }
    }

    if (hasAnyLineChanged) {
      totalCost += SALES_BALANCE_COST.changedInvoice;
    }

    return Math.round(totalCost);
  }
}
