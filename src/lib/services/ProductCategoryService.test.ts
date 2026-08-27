import { describe, expect, it } from "vitest";
import { resolveProductCategory } from "./ProductCategoryService";

describe("resolveProductCategory (Sprint 1.7K — unified category resolver)", () => {
  it("TEST 1: explicit category = 'Meat' -> Meat", () => {
    expect(resolveProductCategory({ category: "Meat" })).toBe("Meat");
  });

  it("TEST 2: explicit category = 'Fruits' -> Fruits", () => {
    expect(resolveProductCategory({ category: "Fruits" })).toBe("Fruits");
  });

  it("TEST 3: lowercase 'meat' -> Meat", () => {
    expect(resolveProductCategory({ category: "meat" })).toBe("Meat");
  });

  it("TEST 4: lowercase 'fruits' -> Fruits", () => {
    expect(resolveProductCategory({ category: "fruits" })).toBe("Fruits");
  });

  it("TEST 5: mixed case 'FrUiTs' / 'MeAt' -> normalized correctly", () => {
    expect(resolveProductCategory({ category: "FrUiTs" })).toBe("Fruits");
    expect(resolveProductCategory({ category: "MeAt" })).toBe("Meat");
  });

  it("TEST 6: category_name = 'Meat' (category field absent) -> Meat", () => {
    expect(resolveProductCategory({ category_name: "Meat" })).toBe("Meat");
  });

  it("TEST 7: category_name = 'Fruits' (category field absent) -> Fruits", () => {
    expect(resolveProductCategory({ category_name: "Fruits" })).toBe("Fruits");
  });

  it("precedence: explicit `category` wins over `category_name` when both present", () => {
    expect(
      resolveProductCategory({ category: "Meat", category_name: "Fruits" }),
    ).toBe("Meat");
  });

  it("TEST 8 / 9: missing category, keyword fallback — Apple -> Fruits", () => {
    expect(
      resolveProductCategory({ product_name: "Apple", category: "" }),
    ).toBe("Fruits");
  });

  it("TEST 10: missing category, keyword fallback — Chicken -> Meat", () => {
    expect(
      resolveProductCategory({ product_name: "Chicken", category: "" }),
    ).toBe("Meat");
  });

  it("TEST 11: every remaining keyword in the current implementation, exhaustively", () => {
    const fruitKeywords = [
      "APPLE",
      "BANANA",
      "BLUEBERRY",
      "CUSTARD APPLE",
      "KIWI",
      "LYCHEE",
      "CHERRY",
      "FIG",
      "ORANGE",
      "GRAPE",
      "MANGO",
      "PEACH",
      "PEAR",
      "PLUM",
      "WATERMELON",
      "PINEAPPLE",
      "PAPAYA",
      "FRUIT",
    ];
    for (const kw of fruitKeywords) {
      expect(
        resolveProductCategory({ product_name: `Fresh ${kw} Special` }),
      ).toBe("Fruits");
    }

    const meatKeywords = [
      "CHICKEN",
      "GOAT",
      "DUCK",
      "CLAM",
      "FISH",
      "MACKEREL",
      "MUSSEL",
      "OYSTER",
      "CRAB",
      "SHRIMP",
      "MEAT",
    ];
    for (const kw of meatKeywords) {
      expect(
        resolveProductCategory({ product_name: `Fresh ${kw} Special` }),
      ).toBe("Meat");
    }
  });

  it("TEST 12: unknown product (no category, no keyword match) -> defaults to Meat", () => {
    // Matches the documented behavior: YAMS, SEER, GOOSEBERRY, SAPOTA,
    // POMFRET etc. match neither keyword list and fall through to Meat.
    expect(resolveProductCategory({ product_name: "Yams" })).toBe("Meat");
    expect(resolveProductCategory({ product_name: "Gooseberry" })).toBe(
      "Meat",
    );
  });

  it("TEST 13: null product -> Meat (no throw)", () => {
    expect(resolveProductCategory(null)).toBe("Meat");
  });

  it("TEST 13b: undefined product -> Meat (no throw)", () => {
    expect(resolveProductCategory(undefined)).toBe("Meat");
  });

  it("TEST 14: empty object -> Meat", () => {
    expect(resolveProductCategory({})).toBe("Meat");
  });

  it("TEST 15: whitespace around category is trimmed", () => {
    expect(resolveProductCategory({ category: "  Fruits  " })).toBe("Fruits");
    expect(resolveProductCategory({ category: "\tMeat\n" })).toBe("Meat");
  });

  it("an explicit category that merely contains 'fruit' as a substring (not exactly FRUITS) falls through to the final default check, matching the old implementation's exact fallthrough behavior", () => {
    // "FRUITY" !== "FRUITS" exactly, so it skips the first two exact-match
    // branches; it also doesn't match either keyword list (no product_name
    // given); the final line's `explicitCategory.includes("FRUIT")` check
    // then catches it.
    expect(resolveProductCategory({ category: "Fruity" })).toBe("Fruits");
  });
});
