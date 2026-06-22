-- Add invoice_type column to invoice_batch table
ALTER TABLE public.invoice_batch ADD COLUMN invoice_type TEXT;