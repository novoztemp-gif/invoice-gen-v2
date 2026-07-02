-- Drop sheet_link from invoice_batch and invoice tables
ALTER TABLE public.invoice_batch DROP COLUMN IF EXISTS sheet_link;
ALTER TABLE public.invoice DROP COLUMN IF EXISTS sheet_link;
