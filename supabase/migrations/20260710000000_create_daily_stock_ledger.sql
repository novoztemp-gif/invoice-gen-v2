-- Create daily_stock_ledger table
CREATE TABLE IF NOT EXISTS public.daily_stock_ledger (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    purchase_batch_id UUID NOT NULL REFERENCES public.invoice_batch(id) ON DELETE CASCADE,
    ledger_date DATE NOT NULL,
    product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
    opening_stock NUMERIC(15, 2) DEFAULT 0 NOT NULL,
    purchased_quantity NUMERIC(15, 2) DEFAULT 0 NOT NULL,
    sold_quantity NUMERIC(15, 2) DEFAULT 0 NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    CONSTRAINT unique_batch_date_product UNIQUE (purchase_batch_id, ledger_date, product_id)
);

-- Create index for performance on queries by date and product
CREATE INDEX IF NOT EXISTS idx_daily_stock_ledger_date_product ON public.daily_stock_ledger (ledger_date, product_id);

-- Enable Row Level Security (RLS)
ALTER TABLE public.daily_stock_ledger ENABLE ROW LEVEL SECURITY;

-- Allow authenticated users to perform all operations
CREATE POLICY "Allow all operations for authenticated users" 
ON public.daily_stock_ledger
FOR ALL 
TO authenticated 
USING (true) 
WITH CHECK (true);
