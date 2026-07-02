-- Rename existing column to max and add min
ALTER TABLE public.invoice_batch 
RENAME COLUMN threshold_limit TO maximum_invoice_amount;

ALTER TABLE public.invoice_batch 
ADD COLUMN IF NOT EXISTS minimum_invoice_amount NUMERIC(15, 2) NOT NULL DEFAULT 0;
