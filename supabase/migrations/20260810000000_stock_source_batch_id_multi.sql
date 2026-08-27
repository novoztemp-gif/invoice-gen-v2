-- The Sales batch creation UI lets the user select MULTIPLE Purchase
-- batches as the stock source (comma-joined into one string client-side,
-- e.g. "uuid1,uuid2"), and every consumer of stock_source_batch_id in the
-- application (InvoiceEngine.postSalesBatchStockLedger,
-- create-sales-batch-transactional's ledger fetch, SalesInvoiceValidator,
-- debug-sales-vs-purchase, debug-product-capacity) already splits this
-- column's value on "," to support that. But the column itself was only
-- ever a single UUID with a foreign key to invoice_batch(id), so saving a
-- batch with more than one selected source batch fails outright with
-- "invalid input syntax for type uuid" — a single UUID column can never
-- hold a comma-joined multi-id string, and a FOREIGN KEY constraint can't
-- reference more than one row per column either way.
--
-- Widen the column to TEXT (dropping the FK, since it can no longer point
-- at a single invoice_batch row) so the app's existing comma-list handling
-- actually works for multi-source-batch Sales batches.

ALTER TABLE public.invoice_batch
  DROP CONSTRAINT IF EXISTS invoice_batch_stock_source_batch_id_fkey;

ALTER TABLE public.invoice_batch
  ALTER COLUMN stock_source_batch_id TYPE TEXT USING stock_source_batch_id::TEXT;

COMMENT ON COLUMN public.invoice_batch.stock_source_batch_id IS
  'Comma-separated list of one or more finalized PURCHASE batch IDs that serve as the stock source for this SALES batch. No longer a FK (was UUID -> invoice_batch.id) because multiple source batches are supported.';
