import { SupabaseClient } from "@supabase/supabase-js";

/**
 * Finds the true maximum numeric invoice sequence already used for a given
 * invoice_number prefix (<abbreviation>-<financialYear>-<P|S>), scanning the
 * ENTIRE `invoice` table rather than any one batch's own invoices — so that
 * two different batches sharing the same issuing company + financial year +
 * invoice type never get assigned overlapping sequence numbers when
 * balancing creates a brand-new invoice on either one.
 *
 * The numeric suffix is parsed and compared numerically (never
 * lexicographically), matching the existing approach in
 * InvoiceEngine.generateAndSaveInvoices and
 * InvoiceNumberingService.fetchSequencePreview/generateSequentialInvoiceNumbers.
 */
export async function findMaxInvoiceSequenceForPrefix(
  supabase: SupabaseClient,
  prefix: string,
): Promise<number> {
  if (!prefix) return 0;

  let maxSeq = 0;
  let page = 0;
  const pageSize = 1000;
  let hasMore = true;

  while (hasMore) {
    const { data } = await supabase
      .from("invoice")
      .select("invoice_number")
      .like("invoice_number", `${prefix}-%`)
      .range(page * pageSize, (page + 1) * pageSize - 1);

    if (data && data.length > 0) {
      for (const row of data) {
        const parts = (row.invoice_number || "").split("-");
        const seq = parseInt(parts[parts.length - 1], 10);
        if (!isNaN(seq) && seq > maxSeq) maxSeq = seq;
      }
      hasMore = data.length === pageSize;
      page++;
    } else {
      hasMore = false;
    }
  }

  return maxSeq;
}
