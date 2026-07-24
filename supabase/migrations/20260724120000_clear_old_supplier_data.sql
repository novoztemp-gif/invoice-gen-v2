-- Migration: Clear old test supplier data
-- Clears legacy demo suppliers to allow a clean fresh start with the new Category bulk upload workflow

-- Temporarily nullify FK references in test purchase batches
UPDATE public.invoice_batch SET supplier_id = NULL WHERE supplier_id IS NOT NULL;

-- Clear supplier test records
TRUNCATE TABLE public.suppliers CASCADE;
