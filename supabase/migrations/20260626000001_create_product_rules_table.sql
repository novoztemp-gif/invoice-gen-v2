-- Create product_rules table
CREATE TABLE IF NOT EXISTS public.product_rules (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE UNIQUE,
    quantity_min NUMERIC(15, 2) NOT NULL CHECK (quantity_min >= 0),
    quantity_max NUMERIC(15, 2) NOT NULL CHECK (quantity_max >= quantity_min),
    rate_min NUMERIC(15, 2) NOT NULL CHECK (rate_min >= 0),
    rate_max NUMERIC(15, 2) NOT NULL CHECK (rate_max >= rate_min),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW())
);

-- Enable Row Level Security
ALTER TABLE public.product_rules ENABLE ROW LEVEL SECURITY;

-- Create RLS policies - Allow all authenticated users
CREATE POLICY "Allow authenticated users to view all product rules"
    ON public.product_rules
    FOR SELECT
    TO authenticated
    USING (true);

CREATE POLICY "Allow authenticated users to insert product rules"
    ON public.product_rules
    FOR INSERT
    TO authenticated
    WITH CHECK (true);

CREATE POLICY "Allow authenticated users to update product rules"
    ON public.product_rules
    FOR UPDATE
    TO authenticated
    USING (true)
    WITH CHECK (true);

CREATE POLICY "Allow authenticated users to delete product rules"
    ON public.product_rules
    FOR DELETE
    TO authenticated
    USING (true);

-- Add comment to table
COMMENT ON TABLE public.product_rules IS 'Stores default configuration rules for generating invoices for products';
