-- Add recurring_products column to invoice_batch table
ALTER TABLE public.invoice_batch
ADD COLUMN IF NOT EXISTS recurring_products JSONB;

-- Add comment to the column
COMMENT ON COLUMN public.invoice_batch.recurring_products IS 'JSONB array containing recurring product configuration: [{product_id, percentage}]';

-- Create index
CREATE INDEX IF NOT EXISTS idx_invoice_batch_recurring_products
ON public.invoice_batch USING GIN(recurring_products);
