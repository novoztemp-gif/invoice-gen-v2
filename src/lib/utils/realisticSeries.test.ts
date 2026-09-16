import { describe, expect, it } from "vitest";
import { createSeededRandom } from "./seededRandom";
import { generateRealisticExactSplit } from "./realisticSeries";

describe("generateRealisticExactSplit", () => {
  it("sums exactly to the total for various totals/counts", () => {
    const rng = createSeededRandom(1);
    for (const [total, count] of [
      [1000, 5],
      [123456, 12],
      [7, 3],
      [999999.99, 8],
    ] as const) {
      const values = generateRealisticExactSplit(total, count, rng);
      const sum = values.reduce((s, v) => s + v, 0);
      expect(sum).toBeCloseTo(total, 6);
    }
  });

  it("sums exactly at whole-number precision", () => {
    const rng = createSeededRandom(2);
    const values = generateRealisticExactSplit(50000, 7, rng, { precision: 1 });
    const sum = values.reduce((s, v) => s + v, 0);
    expect(sum).toBe(50000);
    expect(values.every((v) => Number.isInteger(v))).toBe(true);
  });

  it("never returns negative values", () => {
    const rng = createSeededRandom(3);
    const values = generateRealisticExactSplit(100, 10, rng, { variation: 0.9 });
    expect(values.every((v) => v >= 0)).toBe(true);
  });

  it("varies — not all-equal — when count > 1 and total > 0", () => {
    const rng = createSeededRandom(4);
    const values = generateRealisticExactSplit(10000, 8, rng);
    const distinct = new Set(values.map((v) => Math.round(v * 100)));
    expect(distinct.size).toBeGreaterThan(1);
  });

  it("returns all zeros for a zero or negative total", () => {
    const rng = createSeededRandom(5);
    expect(generateRealisticExactSplit(0, 4, rng)).toEqual([0, 0, 0, 0]);
    expect(generateRealisticExactSplit(-50, 4, rng)).toEqual([0, 0, 0, 0]);
  });

  it("returns an empty array for count 0", () => {
    const rng = createSeededRandom(6);
    expect(generateRealisticExactSplit(1000, 0, rng)).toEqual([]);
  });

  it("is deterministic for the same rng sequence", () => {
    const a = generateRealisticExactSplit(5000, 6, createSeededRandom(42));
    const b = generateRealisticExactSplit(5000, 6, createSeededRandom(42));
    expect(a).toEqual(b);
  });
});
