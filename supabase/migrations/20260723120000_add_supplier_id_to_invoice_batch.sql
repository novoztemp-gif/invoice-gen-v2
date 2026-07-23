-- Migration: Add supplier_id to invoice_batch and relax receiving_company_id constraint
-- Purchase batches reference public.suppliers(id), while Sales batches reference public.receiving_companies(id).

ALTER TABLE public.invoice_batch 
    ADD COLUMN IF NOT EXISTS supplier_id UUID REFERENCES public.suppliers(id) ON DELETE SET NULL;

-- Ensure receiving_company_id is nullable (optional for Purchase batches)
ALTER TABLE public.invoice_batch 
    ALTER COLUMN receiving_company_id DROP NOT NULL;

-- Create index for supplier_id lookups
CREATE INDEX IF NOT EXISTS idx_invoice_batch_supplier_id ON public.invoice_batch(supplier_id);
