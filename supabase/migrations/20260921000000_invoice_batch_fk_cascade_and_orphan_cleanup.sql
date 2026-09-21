-- Root cause fix for a real production issue: invoice.invoice_batch_id
-- carried NO foreign key constraint at all (confirmed in the original
-- 20251020175900_create_invoice_table.sql — just a bare NOT NULL UUID
-- column). That means deleting an invoice_batch row through ANY path other
-- than the app's own delete_invoice_batch_and_reclaim_sequence() RPC — a
-- raw delete in the Supabase dashboard, or the existing ON DELETE CASCADE
-- from receiving_companies -> invoice_batch (see
-- invoice_batch.receiving_company_id) firing when a customer row is
-- deleted — silently orphans that batch's invoice rows. They vanish from
-- every page in the app (which always joins/filters through invoice_batch),
-- giving the impression the batch was fully cleared, while the raw rows
-- (and their invoice_number values) remain in the table.
--
-- This directly caused a real numbering bug: create-sales-batch-
-- transactional's sequence auto-detection scans invoice.invoice_number by
-- company+FY+type prefix with no awareness of whether the owning batch
-- still exists — so an orphaned batch's old invoice numbers kept being
-- counted as the sequence's high-water mark, even after every Sales batch
-- visible in the app for that company+year had been deleted (confirmed
-- live: next batch still started at #541 with no batch in sight).
--
-- Fix: delete whatever is already orphaned, then add a real foreign key
-- with ON DELETE CASCADE so this can never happen again regardless of how
-- (or why) an invoice_batch row gets removed in the future.

DELETE FROM public.invoice
WHERE invoice_batch_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.invoice_batch
    WHERE invoice_batch.id = invoice.invoice_batch_id
  );

ALTER TABLE public.invoice
  ADD CONSTRAINT invoice_invoice_batch_id_fkey
  FOREIGN KEY (invoice_batch_id)
  REFERENCES public.invoice_batch(id)
  ON DELETE CASCADE;
