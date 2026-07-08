-- Create purchase_batch_products table
CREATE TABLE IF NOT EXISTS public.purchase_batch_products (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    batch_id UUID NOT NULL REFERENCES public.invoice_batch(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
    monthly_quantity NUMERIC(15, 2) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- Enable Row Level Security
ALTER TABLE public.purchase_batch_products ENABLE ROW LEVEL SECURITY;

-- Allow authenticated users to perform all operations
CREATE POLICY "Allow all operations for authenticated users" 
ON public.purchase_batch_products
FOR ALL 
TO authenticated 
USING (true) 
WITH CHECK (true);
