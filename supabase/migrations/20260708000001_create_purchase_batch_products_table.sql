-- Create purchase_batch_products table
CREATE TABLE IF NOT EXISTS public.purchase_batch_products (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    batch_id UUID NOT NULL REFERENCES public.invoice_batch(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
    monthly_quantity NUMERIC(15, 2) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    CONSTRAINT unique_batch_product UNIQUE (batch_id, product_id)
);

-- Create indexes for performance optimization
CREATE INDEX IF NOT EXISTS idx_purchase_batch_products_batch_id ON public.purchase_batch_products (batch_id);
CREATE INDEX IF NOT EXISTS idx_purchase_batch_products_product_id ON public.purchase_batch_products (product_id);

-- Enable Row Level Security
ALTER TABLE public.purchase_batch_products ENABLE ROW LEVEL SECURITY;

-- Allow authenticated users to perform all operations
CREATE POLICY "Allow all operations for authenticated users" 
ON public.purchase_batch_products
FOR ALL 
TO authenticated 
USING (true) 
WITH CHECK (true);
