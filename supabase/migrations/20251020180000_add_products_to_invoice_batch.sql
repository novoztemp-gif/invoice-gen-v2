-- Add products column to invoice_batch table
ALTER TABLE public.invoice_batch
ADD COLUMN IF NOT EXISTS products JSONB;

-- Add comment to the column
COMMENT ON COLUMN public.invoice_batch.products IS 'JSONB array containing product configurations: [{product_id, product_name, hsn_code, unit_of_measure, perDayQtyMin, perDayQtyMax, perDayRateMin, perDayRateMax}]';

-- Create index for products column
CREATE INDEX IF NOT EXISTS idx_invoice_batch_products ON public.invoice_batch USING GIN(products);
