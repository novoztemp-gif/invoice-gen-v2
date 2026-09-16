import { describe, expect, it } from "vitest";
import { createSeededRandom, hashStringToSeed } from "./seededRandom";

describe("createSeededRandom", () => {
  it("is deterministic — the same seed always produces the same sequence", () => {
    const a = createSeededRandom(12345);
    const b = createSeededRandom(12345);
    const seqA = Array.from({ length: 20 }, () => a());
    const seqB = Array.from({ length: 20 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it("produces values within [0, 1)", () => {
    const rng = createSeededRandom(999);
    for (let i = 0; i < 500; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("different seeds produce different sequences", () => {
    const a = createSeededRandom(1);
    const b = createSeededRandom(2);
    const seqA = Array.from({ length: 10 }, () => a());
    const seqB = Array.from({ length: 10 }, () => b());
    expect(seqA).not.toEqual(seqB);
  });
});

describe("hashStringToSeed", () => {
  it("is deterministic for the same string", () => {
    expect(hashStringToSeed("2024-25|28|239874655")).toBe(
      hashStringToSeed("2024-25|28|239874655"),
    );
  });

  it("differs for different strings", () => {
    expect(hashStringToSeed("2024-25")).not.toBe(hashStringToSeed("2025-26"));
  });

  it("returns a non-negative 32-bit integer", () => {
    const h = hashStringToSeed("some financial year fingerprint");
    expect(h).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(h)).toBe(true);
  });
});
