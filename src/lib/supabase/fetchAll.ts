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
