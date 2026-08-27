import { SupabaseClient } from "@supabase/supabase-js";
import { SUPABASE_POSTGREST_PAGE_SIZE } from "@/lib/constants/invoice";

/**
 * Fetches ALL invoices belonging to a specific invoice_batch_id, overcoming Supabase PostgREST default 1000-row limit.
 * Uses pagination with .range(from, to) in chunks of SUPABASE_POSTGREST_PAGE_SIZE until all rows are retrieved.
 */
export async function fetchAllInvoicesForBatch<T = any>(
  supabase: SupabaseClient,
  batchId: string,
  selectQuery = "*",
  pageSize = SUPABASE_POSTGREST_PAGE_SIZE,
): Promise<T[]> {
  const allInvoices: T[] = [];
  let page = 0;
  let hasMore = true;

  while (hasMore) {
    const from = page * pageSize;
    const to = from + pageSize - 1;
    const { data, error } = await supabase
      .from("invoice")
      .select(selectQuery)
      .eq("invoice_batch_id", batchId)
      .order("invoice_date", { ascending: true })
      .order("invoice_number", { ascending: true })
      .range(from, to);

    if (error) {
      throw error;
    }

    if (data && data.length > 0) {
      allInvoices.push(...(data as T[]));
      if (data.length < pageSize) {
        hasMore = false;
      } else {
        page++;
      }
    } else {
      hasMore = false;
    }
  }

  allInvoices.sort((a: any, b: any) => {
    const dateA = a.invoice_date || "";
    const dateB = b.invoice_date || "";
    const dateCmp = dateA.localeCompare(dateB);
    if (dateCmp !== 0) return dateCmp;

    if (a.invoice_number && b.invoice_number) {
      return a.invoice_number.localeCompare(b.invoice_number, undefined, {
        numeric: true,
        sensitivity: "base",
      });
    }
    return 0;
  });

  return allInvoices;
}

// Same chunk size used for the InvoiceEngine.ts supplier-category fetch
// this pattern was extracted from — keeps every caller consistent.
const DEFAULT_ID_CHUNK_SIZE = 150;

/**
 * Fetches rows matching an `.in("column", ids)` filter, split into
 * bounded-size chunks instead of one unbounded query.
 *
 * Real bug this fixes: a single `.in("id", [...])` filter with hundreds
 * of UUIDs (confirmed on a real batch: 469 selected suppliers, a ~17KB
 * filter value) can fail outright — the request URL exceeds common
 * length limits (Node's own default max header size is 16KB) — and if
 * the caller doesn't check `error` (several call sites across this
 * codebase didn't), the failure is completely silent: `data` comes back
 * null/undefined and every ID in that unbounded list is treated as if it
 * simply didn't match, with no indication anything went wrong. Chunking
 * keeps every individual request small regardless of how large `ids`
 * grows, and this helper always surfaces a real fetch error by throwing.
 *
 * `queryFactory` receives one chunk of ids and must return a Supabase
 * query builder already filtered by that chunk (e.g.
 * `.from("suppliers").select("id, category").in("id", chunk)`) — this
 * mirrors fetchAllQueryRows' factory shape so callers keep full control
 * over `.select()`/additional filters.
 */
export async function fetchRowsByIds<T = any>(
  queryFactory: (idsChunk: string[]) => any,
  ids: string[],
  chunkSize = DEFAULT_ID_CHUNK_SIZE,
): Promise<T[]> {
  const allRows: T[] = [];
  const uniqueIds = Array.from(new Set(ids.filter(Boolean)));
  for (let i = 0; i < uniqueIds.length; i += chunkSize) {
    const chunk = uniqueIds.slice(i, i + chunkSize);
    const { data, error } = await queryFactory(chunk);
    if (error) {
      throw error;
    }
    if (data) {
      allRows.push(...(data as T[]));
    }
  }
  return allRows;
}

/**
 * Generic helper to fetch ALL rows matching a query factory, overcoming PostgREST default 1000-row cap.
 * Loops page by page until data.length < pageSize. Supports 5,000, 6,000, 10,000+ rows seamlessly.
 */
export async function fetchAllQueryRows<T = any>(
  queryFactory: (rangeFrom: number, rangeTo: number) => any,
  pageSize = SUPABASE_POSTGREST_PAGE_SIZE,
): Promise<T[]> {
  const allRows: T[] = [];
  let page = 0;
  let hasMore = true;

  while (hasMore) {
    const from = page * pageSize;
    const to = from + pageSize - 1;
    const { data, error } = await queryFactory(from, to);

    if (error) {
      throw error;
    }

    if (data && data.length > 0) {
      allRows.push(...(data as T[]));
      if (data.length < pageSize) {
        hasMore = false;
      } else {
        page++;
      }
    } else {
      hasMore = false;
    }
  }

  return allRows;
}
