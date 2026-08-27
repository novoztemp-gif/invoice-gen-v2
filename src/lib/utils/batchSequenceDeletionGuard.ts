/**
 * Guards deletion order for invoice batches so their invoice-number
 * sequence range always gets safely reclaimed, rather than sometimes
 * being permanently stranded.
 *
 * The invoice number sequence (invoice_sequences, one row per issuing
 * company + financial year + invoice type) only ever moves forward by
 * default — deleting invoices never touches it on its own. The
 * `delete_invoice_batch_and_reclaim_sequence` RPC is the only thing that
 * can roll it back, and it only does so when the batch being deleted
 * currently holds the HIGHEST invoice numbers for its own
 * company+year+type group (i.e. it's genuinely safe — nothing newer is
 * relying on numbers above it). If a batch is deleted while a newer batch
 * in the same group still exists, that check correctly declines to roll
 * back — and that decision is never revisited later, even after the newer
 * batch is also eventually deleted. The result: deleting batches out of
 * order permanently strands a range of invoice numbers, forever, even
 * once every batch is gone.
 *
 * This module answers one question — "is it currently safe to delete this
 * batch without stranding a number range?" — so the UI can restrict
 * deletion to newest-first and this can never happen in the first place.
 */

export interface SequenceGroupIdentity {
  issuing_company_id: string;
  financial_year: string;
  batch_type: string;
}

export interface SequenceGuardedBatch extends SequenceGroupIdentity {
  id: string;
}

// Same trailing-numeric-suffix parse InvoiceNumberingService.fetchSequencePreview
// already uses for "AT-2026-27-P-0003113" -> 3113.
export function parseSequenceNumber(
  invoiceNumber: string | null | undefined,
): number {
  if (!invoiceNumber) return -1;
  const parts = invoiceNumber.split("-");
  const seqNum = parseInt(parts[parts.length - 1], 10);
  return isNaN(seqNum) ? -1 : seqNum;
}

// The invoice number sequence is scoped per (issuing company, financial
// year, invoice type) — matching invoice_sequences' own unique key and
// exactly what delete_invoice_batch_and_reclaim_sequence checks.
export function sequenceGroupKey(batch: SequenceGroupIdentity): string {
  return `${batch.issuing_company_id}|${batch.financial_year}|${batch.batch_type}`;
}

/**
 * A batch with no invoices at all never consumed any sequence numbers, so
 * it can never block anything and is always safe to delete. A batch WITH
 * invoices is only safe to delete (from a numbering standpoint) when no
 * other still-existing batch in the exact same company+year+type group
 * holds a higher sequence number.
 */
export function isBatchDeletable<T extends SequenceGuardedBatch>(
  batch: T,
  allBatches: T[],
  maxSeqByBatchId: Map<string, number>,
): boolean {
  const ownMaxSeq = maxSeqByBatchId.get(batch.id);
  if (ownMaxSeq === undefined) return true;
  const group = sequenceGroupKey(batch);
  return !allBatches.some((other) => {
    if (other.id === batch.id) return false;
    if (sequenceGroupKey(other) !== group) return false;
    const otherMaxSeq = maxSeqByBatchId.get(other.id);
    return otherMaxSeq !== undefined && otherMaxSeq > ownMaxSeq;
  });
}
