import { createSeededRandom, hashStringToSeed } from "@/lib/utils/seededRandom";
import { generateRealisticExactSplit } from "@/lib/utils/realisticSeries";
import {
  DebtorCreditorPerson,
  DebtorCreditorSourceData,
  PersonAmountEntry,
  PersonKnockoffSummary,
  StockAllocationLine,
  StockAllocationRunResult,
  StockAllocationShortfall,
} from "./types";

/** A product-month's cumulative allocation across every person can reach at
 * most (1 - margin) of the uploaded figure — "always less than it, not even
 * equal to it" is satisfied by construction, not a runtime check. Named and
 * tunable rather than a magic number. */
export const STOCK_SAFETY_MARGIN = 0.02;

const AMOUNT_EPSILON = 0.5; // rupees — rounding slack for "fully covered"

export interface AllocateStockInput {
  role: "debtor" | "creditor";
  source: DebtorCreditorSourceData;
  /** Selection order = the tie-break order used when processing people
   * within a month. */
  people: DebtorCreditorPerson[];
  selectedMonthIndices: number[];
  personAmounts: PersonAmountEntry[];
  /** Creditor role only — each person's own debtor-role HSNs, which their
   * creditor allocation must never reuse. */
  excludedHsnByPerson?: Record<string, Set<string>>;
}

function roundQty(n: number): number {
  return Math.round(n * 100) / 100;
}

function roundAmount(n: number): number {
  return Math.round(n * 100) / 100;
}

export function allocateStock(input: AllocateStockInput): StockAllocationRunResult {
  const { role, source, people, personAmounts, excludedHsnByPerson } = input;
  const matrix = role === "debtor" ? source.salesMatrix : source.purchaseMatrix;
  const products = source.products;
  const months = [...input.selectedMonthIndices].sort((a, b) => a - b);

  const amountByPersonId = new Map(personAmounts.map((p) => [p.personId, p.amount]));

  const runSeed = hashStringToSeed(
    `${source.financialYear}|${role}|${months.join(",")}|${personAmounts
      .map((p) => `${p.personId}:${p.amount}`)
      .join(",")}`,
  );
  const rng = createSeededRandom(runSeed);

  // Step A: split each person's total across their selected months.
  const personMonthAmounts = new Map<string, number[]>();
  for (const person of people) {
    const total = amountByPersonId.get(person.id) ?? 0;
    personMonthAmounts.set(
      person.id,
      generateRealisticExactSplit(total, months.length, rng, { precision: 1 }),
    );
  }

  const lines: StockAllocationLine[] = [];
  const shortfalls: StockAllocationShortfall[] = [];
  const usedByPerson = new Map<string, Set<number>>();
  for (const person of people) usedByPerson.set(person.id, new Set());

  // Step B: month-major, person-minor.
  months.forEach((monthIndex, monthPos) => {
    const allocatedSoFarThisMonth = new Array(products.length).fill(0);
    const monthLabel = source.months[monthIndex]?.label ?? `Month ${monthIndex + 1}`;

    people.forEach((person) => {
      const monthSplits = personMonthAmounts.get(person.id)!;
      let remaining = monthSplits[monthPos] ?? 0;
      if (remaining <= AMOUNT_EPSILON) return;

      const excluded = excludedHsnByPerson?.[person.id];
      const used = usedByPerson.get(person.id)!;

      const isCandidate = (pIdx: number): boolean => {
        const product = products[pIdx];
        if (!product || product.category !== person.category) return false;
        if (excluded?.has(product.hsnCode.trim())) return false;
        const cell = matrix[pIdx]?.[monthIndex];
        if (!cell || cell.amount <= 0) return false;
        const cap = Math.floor(cell.amount * (1 - STOCK_SAFETY_MARGIN));
        return cap - allocatedSoFarThisMonth[pIdx] > 0;
      };

      const allIndices = products.map((_, i) => i).filter(isCandidate);
      const fresh = allIndices.filter((i) => !used.has(i));
      const reused = allIndices.filter((i) => used.has(i));

      const withSortKey = (indices: number[]) =>
        indices
          .map((i) => ({ i, key: rng() }))
          .sort((a, b) => a.key - b.key)
          .map((x) => x.i);

      const orderedCandidates = [...withSortKey(fresh), ...withSortKey(reused)];

      for (const pIdx of orderedCandidates) {
        if (remaining <= AMOUNT_EPSILON) break;
        const cell = matrix[pIdx][monthIndex];
        const cap = Math.floor(cell.amount * (1 - STOCK_SAFETY_MARGIN));
        const remainingCapacity = cap - allocatedSoFarThisMonth[pIdx];
        if (remainingCapacity <= 0) continue;

        const take = Math.min(remaining, remainingCapacity);
        const rate = cell.qty / cell.amount;
        const qty = roundQty(take * rate);
        if (qty <= 0) continue;

        const product = products[pIdx];
        lines.push({
          personId: person.id,
          monthIndex,
          monthLabel,
          productIndex: pIdx,
          hsnCode: product.hsnCode,
          description: product.description,
          qty,
          amount: roundAmount(take),
        });

        allocatedSoFarThisMonth[pIdx] += take;
        remaining -= take;
        used.add(pIdx);
      }

      if (remaining > AMOUNT_EPSILON) {
        shortfalls.push({
          personId: person.id,
          personName: person.companyName,
          monthIndex,
          monthLabel,
          category: person.category,
          requiredAmount: roundAmount(monthSplits[monthPos] ?? 0),
          allocatedAmount: roundAmount((monthSplits[monthPos] ?? 0) - remaining),
          shortfallAmount: roundAmount(remaining),
        });
      }
    });
  });

  if (shortfalls.length > 0) {
    return { ok: false, lines: [], shortfalls };
  }
  return { ok: true, lines, shortfalls: [] };
}

export function summarizeKnockoff(
  people: DebtorCreditorPerson[],
  debtorLines: StockAllocationLine[],
  creditorLines: StockAllocationLine[],
): PersonKnockoffSummary[] {
  const debtorTotals = new Map<string, number>();
  for (const line of debtorLines) {
    debtorTotals.set(line.personId, (debtorTotals.get(line.personId) ?? 0) + line.amount);
  }
  const creditorTotals = new Map<string, number>();
  for (const line of creditorLines) {
    creditorTotals.set(line.personId, (creditorTotals.get(line.personId) ?? 0) + line.amount);
  }

  return people.map((person) => {
    const debtorTotal = roundAmount(debtorTotals.get(person.id) ?? 0);
    const creditorTotal = roundAmount(creditorTotals.get(person.id) ?? 0);
    return {
      personId: person.id,
      companyName: person.companyName,
      category: person.category,
      debtorTotal,
      creditorTotal,
      knockoff: roundAmount(debtorTotal - creditorTotal),
    };
  });
}
