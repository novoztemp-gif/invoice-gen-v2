import { describe, expect, it } from "vitest";
import { fetchRowsByIds } from "./fetchAll";

/**
 * Real bug: several routes queried Supabase with a single unbounded
 * `.in("id", [...])` filter and never checked the returned `error` — a
 * real batch had 469 selected suppliers, producing a ~17KB filter value
 * that failed outright (Node's own default max header size is 16KB), and
 * because `error` was never read, the failure was silent: every supplier
 * was treated as "didn't match" instead of the request having failed.
 * fetchRowsByIds fixes this by chunking and always surfacing a real
 * fetch error.
 */
describe("fetchRowsByIds", () => {
  it("chunks a large id list into bounded-size requests instead of one unbounded call", async () => {
    const ids = Array.from({ length: 469 }, (_, i) => `id-${i}`);
    const chunkSizesSeen: number[] = [];

    const rows = await fetchRowsByIds(
      (chunk) => {
        chunkSizesSeen.push(chunk.length);
        return Promise.resolve({
          data: chunk.map((id) => ({ id, category: "Meat" })),
          error: null,
        });
      },
      ids,
      150,
    );

    expect(chunkSizesSeen).toEqual([150, 150, 150, 19]);
    expect(rows.length).toBe(469);
  });

  it("throws when a chunk's query returns an error, instead of silently treating it as no rows", async () => {
    const ids = ["a", "b", "c"];
    await expect(
      fetchRowsByIds(
        () =>
          Promise.resolve({
            data: null,
            error: { message: "URI Too Long (simulated)" },
          }),
        ids,
      ),
    ).rejects.toMatchObject({ message: "URI Too Long (simulated)" });
  });

  it("de-duplicates ids before chunking", async () => {
    const ids = ["a", "a", "b", "b", "c"];
    const seenIds: string[] = [];

    const rows = await fetchRowsByIds(
      (chunk) => {
        seenIds.push(...chunk);
        return Promise.resolve({
          data: chunk.map((id) => ({ id })),
          error: null,
        });
      },
      ids,
      150,
    );

    expect(seenIds.sort()).toEqual(["a", "b", "c"]);
    expect(rows.length).toBe(3);
  });

  it("returns an empty array for an empty id list without making any request", async () => {
    let calls = 0;
    const rows = await fetchRowsByIds(
      (chunk) => {
        calls++;
        return Promise.resolve({ data: chunk, error: null });
      },
      [],
    );
    expect(calls).toBe(0);
    expect(rows).toEqual([]);
  });
});
