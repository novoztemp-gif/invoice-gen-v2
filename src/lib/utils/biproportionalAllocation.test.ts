import { describe, expect, it } from "vitest";
import { biproportionalAllocate } from "./biproportionalAllocation";

function rowSums(matrix: number[][]): number[] {
  return matrix.map((row) => row.reduce((s, v) => s + v, 0));
}
function colSums(matrix: number[][]): number[] {
  if (matrix.length === 0) return [];
  const cols = matrix[0].length;
  const sums = new Array(cols).fill(0);
  for (const row of matrix) {
    row.forEach((v, c) => (sums[c] += v));
  }
  return sums;
}

describe("biproportionalAllocate", () => {
  it("matches row totals AND column totals exactly (to 2-decimal precision) for a well-posed 3x4 matrix — compensating transfers close the gap the old column-cleanup step used to leave", () => {
    const seed = [
      [1, 2, 3, 4],
      [4, 3, 2, 1],
      [2, 2, 2, 2],
    ];
    const rowTotals = [100, 200, 60];
    const colTotals = [90, 90, 90, 90]; // sums to 360, matches rowTotals sum

    const { matrix } = biproportionalAllocate({ seed, rowTotals, colTotals });

    // At the default 2-decimal precision, values are integer "cent" units
    // divided back down to a float — exact in decimal terms, but dividing
    // by 100 can land a ULP off in IEEE754 (e.g. 89.99999999999999 instead
    // of 90), so compare with a tight tolerance rather than bit-exact
    // equality. The whole-number (precision 1) case below has no such
    // division error and IS asserted bit-exact.
    rowSums(matrix).forEach((v, i) => expect(v).toBeCloseTo(rowTotals[i], 9));
    colSums(matrix).forEach((v, i) => expect(v).toBeCloseTo(colTotals[i], 9));
  });

  it("hits exact row AND column totals on a simple 2x2 case", () => {
    const seed = [
      [1, 1],
      [1, 1],
    ];
    const rowTotals = [50, 50];
    const colTotals = [50, 50];

    const { matrix } = biproportionalAllocate({ seed, rowTotals, colTotals });

    expect(rowSums(matrix)).toEqual(rowTotals);
    expect(colSums(matrix)).toEqual(colTotals);
  });

  it("increasing iterations reduces (or holds steady) the pre-cleanup column drift", () => {
    const seed = [
      [5, 1, 1],
      [1, 5, 1],
      [1, 1, 5],
    ];
    const rowTotals = [300, 300, 300];
    const colTotals = [200, 400, 300];

    const few = biproportionalAllocate({
      seed,
      rowTotals,
      colTotals,
      maxIterations: 1,
    });
    const many = biproportionalAllocate({
      seed,
      rowTotals,
      colTotals,
      maxIterations: 25,
    });

    const totalDriftFew = few.colDrift.reduce((s, d) => s + Math.abs(d), 0);
    const totalDriftMany = many.colDrift.reduce((s, d) => s + Math.abs(d), 0);
    expect(totalDriftMany).toBeLessThanOrEqual(totalDriftFew + 1);
  });

  it("handles an all-zero row in the seed without producing NaN", () => {
    const seed = [
      [0, 0],
      [1, 1],
    ];
    const rowTotals = [40, 60];
    const colTotals = [50, 50];

    const { matrix } = biproportionalAllocate({ seed, rowTotals, colTotals });

    expect(matrix.flat().every((v) => Number.isFinite(v))).toBe(true);
    expect(rowSums(matrix)).toEqual(rowTotals);
  });

  it("handles an all-zero column in the seed without producing NaN", () => {
    const seed = [
      [0, 1],
      [0, 1],
    ];
    const rowTotals = [30, 30];
    const colTotals = [20, 40];

    const { matrix } = biproportionalAllocate({ seed, rowTotals, colTotals });

    expect(matrix.flat().every((v) => Number.isFinite(v))).toBe(true);
    expect(rowSums(matrix)).toEqual(rowTotals);
  });

  it("hits exact row and column totals at whole-number (precision 1) granularity across many rows", () => {
    // Regression: with precision=1 (whole rupees), the old column-cleanup
    // pass reintroduced a real ₹1 drift on one product's row sum in
    // production data — this locks in that it's now exactly zero.
    const rows = 28;
    const cols = 12;
    const seed = Array.from({ length: rows }, (_, r) =>
      Array.from({ length: cols }, (_, c) => 1 + ((r * 7 + c * 3) % 11)),
    );
    const rowTotals = Array.from({ length: rows }, (_, r) => 1000 + r * 37);
    const grandTotal = rowTotals.reduce((s, v) => s + v, 0);
    const colTotals = Array.from({ length: cols }, (_, c) =>
      Math.floor(grandTotal / cols) + (c === 0 ? grandTotal % cols : 0),
    );

    const { matrix } = biproportionalAllocate({
      seed,
      rowTotals,
      colTotals,
      precision: 1,
    });

    expect(rowSums(matrix)).toEqual(rowTotals);
    expect(colSums(matrix)).toEqual(colTotals);
  });

  it("returns an empty matrix for empty input", () => {
    const { matrix } = biproportionalAllocate({
      seed: [],
      rowTotals: [],
      colTotals: [],
    });
    expect(matrix).toEqual([]);
  });
});
