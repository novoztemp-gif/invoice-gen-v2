import {
  computeLineAmount,
  isValidWholeNumber,
} from "@/lib/utils/quantity-rate-utils";
import { CandidateGenerator } from "./CandidateGenerator";
import {
  BALANCE_LIMITS,
  InvoiceCandidate,
  MONEY_TOLERANCE,
  ProductConstraint,
  PurchaseInvoice,
  roundMoney,
} from "./types";

export type ResidualRepairSuccess = {
  status: "success";
  chosenCandidates: Map<string, InvoiceCandidate>;
  totalCost: number;
  residualClosed: number;
  combinationsExplored: number;
};

export type ResidualRepairFailure = {
  status: "failure";
  reason: "no_valid_solution" | "search_capacity_exceeded";
  message: string;
  combinationsExplored: number;
};

export type ResidualRepairResult =
  | ResidualRepairSuccess
  | ResidualRepairFailure;

export class ResidualRepair {
  /**
   * Exhaustively searches the approved candidate universe across up to 3 residual-repair invoices
   * to close any exact rupee difference while strictly respecting all business constraints and bounds.
   */
  public static repairResidual(
    targetResidualNeeded: number,
    eligibleInvoices: PurchaseInvoice[],
    candidatesPerInvoice: Map<string, InvoiceCandidate[]>,
    constraints: Map<string, ProductConstraint>,
    startTimeMs: number = Date.now(),
  ): ResidualRepairResult {
    // Limit search to final residualInvoiceCount (3) invoices
    const targetInvoices = eligibleInvoices.slice(
      Math.max(
        0,
        eligibleInvoices.length - BALANCE_LIMITS.residualInvoiceCount,
      ),
    );

    if (targetInvoices.length === 0) {
      return {
        status: "failure",
        reason: "no_valid_solution",
        message: "No eligible residual repair invoices provided",
        combinationsExplored: 0,
      };
    }

    const candidateLists: InvoiceCandidate[][] = [];
    let totalCombinations = 1;

    for (const inv of targetInvoices) {
      const candidates = candidatesPerInvoice.get(inv.id) || [];
      if (candidates.length === 0) {
        return {
          status: "failure",
          reason: "no_valid_solution",
          message: `No candidate options available for invoice ${inv.invoice_number || inv.id}`,
          combinationsExplored: 0,
        };
      }
      candidateLists.push(candidates);
      totalCombinations *= candidates.length;
    }

    if (totalCombinations > BALANCE_LIMITS.maxResidualCombinations) {
      return {
        status: "failure",
        reason: "search_capacity_exceeded",
        message: `Maximum residual repair combinations exceeded (${totalCombinations} > ${BALANCE_LIMITS.maxResidualCombinations})`,
        combinationsExplored: totalCombinations,
      };
    }

    let combinationsExplored = 0;
    let bestResult: {
      chosenCandidates: Map<string, InvoiceCandidate>;
      totalCost: number;
      residualClosed: number;
    } | null = null;

    const currentChoice: InvoiceCandidate[] = [];

    const searchCombinations = (
      index: number,
      currentDelta: number,
      currentCost: number,
    ) => {
      if (Date.now() - startTimeMs > BALANCE_LIMITS.plannerTimeMs) {
        return;
      }

      if (index === candidateLists.length) {
        combinationsExplored++;
        const deltaMatch =
          Math.abs(currentDelta - targetResidualNeeded) <= MONEY_TOLERANCE;

        if (deltaMatch) {
          // Validate business rules for every invoice candidate in this combination
          const isValidCombination = currentChoice.every((cand) =>
            this.validateInvoiceCandidate(cand, constraints),
          );

          if (isValidCombination) {
            if (!bestResult || currentCost < bestResult.totalCost) {
              const chosenMap = new Map<string, InvoiceCandidate>();
              for (let i = 0; i < targetInvoices.length; i++) {
                chosenMap.set(targetInvoices[i].id, currentChoice[i]);
              }
              bestResult = {
                chosenCandidates: chosenMap,
                totalCost: currentCost,
                residualClosed: currentDelta,
              };
            }
          }
        }
        return;
      }

      for (const cand of candidateLists[index]) {
        currentChoice.push(cand);
        searchCombinations(
          index + 1,
          roundMoney(currentDelta + cand.delta),
          currentCost + cand.cost,
        );
        currentChoice.pop();

        if (Date.now() - startTimeMs > BALANCE_LIMITS.plannerTimeMs) {
          break;
        }
      }
    };

    searchCombinations(0, 0, 0);

    if (
      Date.now() - startTimeMs > BALANCE_LIMITS.plannerTimeMs &&
      !bestResult
    ) {
      return {
        status: "failure",
        reason: "search_capacity_exceeded",
        message: "Planner time budget exceeded during residual repair",
        combinationsExplored,
      };
    }

    if (bestResult) {
      return {
        status: "success",
        chosenCandidates: (
          bestResult as { chosenCandidates: Map<string, InvoiceCandidate> }
        ).chosenCandidates,
        totalCost: (bestResult as { totalCost: number }).totalCost,
        residualClosed: (bestResult as { residualClosed: number })
          .residualClosed,
        combinationsExplored,
      };
    }

    return {
      status: "failure",
      reason: "no_valid_solution",
      message:
        "No exact residual repair combination found satisfying business constraints",
      combinationsExplored,
    };
  }

  /**
   * Strictly validates commercial quantity, whole-number rate, line amount, and total rules.
   */
  public static validateInvoiceCandidate(
    invoiceCandidate: InvoiceCandidate,
    constraints: Map<string, ProductConstraint>,
  ): boolean {
    if (!invoiceCandidate.products || invoiceCandidate.products.length === 0) {
      return false;
    }

    let calculatedTotal = 0;

    for (const line of invoiceCandidate.products) {
      const constraint = constraints.get(line.product_id);
      if (!constraint) return false;

      // 1. Commercial quantity check
      if (!CandidateGenerator.isCommercialQuantity(line.quantity, constraint)) {
        return false;
      }

      // 2. Whole number rate check within [rateMin, rateMax]
      if (
        !isValidWholeNumber(line.rate) ||
        line.rate < constraint.rateMin - MONEY_TOLERANCE ||
        line.rate > constraint.rateMax + MONEY_TOLERANCE
      ) {
        return false;
      }

      // 3. Line amount equals computeLineAmount(quantity, rate)
      const expectedLineAmount = computeLineAmount(line.quantity, line.rate);
      if (
        line.amount <= 0 ||
        Math.abs(line.amount - expectedLineAmount) > MONEY_TOLERANCE
      ) {
        return false;
      }

      calculatedTotal += line.amount;
    }

    calculatedTotal = roundMoney(calculatedTotal);

    // 4. Invoice total equals sum of line amounts
    return (
      calculatedTotal > 0 &&
      Math.abs(calculatedTotal - roundMoney(invoiceCandidate.totalAmount)) <=
        MONEY_TOLERANCE
    );
  }
}
