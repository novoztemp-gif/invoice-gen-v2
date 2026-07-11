-- Add stock_source_batch_id column to public.invoice_batch table
ALTER TABLE public.invoice_batch 
ADD COLUMN IF NOT EXISTS stock_source_batch_id UUID REFERENCES public.invoice_batch(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.invoice_batch.stock_source_batch_id IS 'References the finalized PURCHASE batch that serves as the stock source for this SALES batch';
