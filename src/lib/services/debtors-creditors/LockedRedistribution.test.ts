import { describe, expect, it } from "vitest";
import { redistributeExcludingLocked } from "./LockedRedistribution";

describe("redistributeExcludingLocked", () => {
  it("sums exactly to newTotal when nothing is locked", () => {
    const items = ["a", "b", "c", "d"].map((id) => ({
      id,
      locked: false,
      value: 0,
    }));
    const { values, feasible } = redistributeExcludingLocked(items, 10000);
    expect(feasible).toBe(true);
    expect(values.reduce((s, v) => s + v.value, 0)).toBeCloseTo(10000, 6);
  });

  it("editing person C after locking person B never changes B's value — the core guarantee", () => {
    const initial = ["a", "b", "c", "d"].map((id) => ({
      id,
      locked: false,
      value: 0,
    }));
    const first = redistributeExcludingLocked(initial, 10000);

    // Lock B at a typed value.
    const bValue = first.values.find((v) => v.id === "b")!.value;
    const afterLockB = initial.map((item) => {
      if (item.id === "b") return { ...item, locked: true, value: bValue + 500 };
      const v = first.values.find((x) => x.id === item.id)!.value;
      return { ...item, value: v };
    });
    const second = redistributeExcludingLocked(afterLockB, 10000);
    const bAfterFirstEdit = second.values.find((v) => v.id === "b")!.value;
    expect(bAfterFirstEdit).toBe(bValue + 500);

    // Now edit/lock C — B must stay exactly where it was.
    const cValue = second.values.find((v) => v.id === "c")!.value;
    const afterLockC = afterLockB.map((item) => {
      if (item.id === "c") return { ...item, locked: true, value: cValue + 777 };
      const v = second.values.find((x) => x.id === item.id)!.value;
      return item.locked ? item : { ...item, value: v };
    });
    const third = redistributeExcludingLocked(afterLockC, 10000);

    expect(third.values.find((v) => v.id === "b")!.value).toBe(bValue + 500);
    expect(third.values.find((v) => v.id === "c")!.value).toBe(cValue + 777);
    expect(third.values.reduce((s, v) => s + v.value, 0)).toBeCloseTo(10000, 6);
  });

  it("marks infeasible when locked values alone exceed the total", () => {
    const items = [
      { id: "a", locked: true, value: 8000 },
      { id: "b", locked: false, value: 0 },
    ];
    const result = redistributeExcludingLocked(items, 5000);
    expect(result.feasible).toBe(false);
    expect(result.lockedSum).toBe(8000);
    expect(result.unlockedTarget).toBe(5000 - 8000);
  });

  it("all-locked, matching total exactly, is feasible", () => {
    const items = [
      { id: "a", locked: true, value: 3000 },
      { id: "b", locked: true, value: 7000 },
    ];
    const result = redistributeExcludingLocked(items, 10000);
    expect(result.feasible).toBe(true);
    expect(result.values).toEqual([
      { id: "a", value: 3000 },
      { id: "b", value: 7000 },
    ]);
  });

  it("is deterministic for identical inputs", () => {
    const items = ["a", "b", "c"].map((id) => ({ id, locked: false, value: 0 }));
    const r1 = redistributeExcludingLocked(items, 9999);
    const r2 = redistributeExcludingLocked(items, 9999);
    expect(r1.values).toEqual(r2.values);
  });

  it("produces a different split once the locked set or total changes", () => {
    const items = ["a", "b", "c"].map((id) => ({ id, locked: false, value: 0 }));
    const r1 = redistributeExcludingLocked(items, 9999);
    const r2 = redistributeExcludingLocked(items, 12345);
    expect(r1.values).not.toEqual(r2.values);
  });
});
