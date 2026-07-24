-- Migration: Re-add category column to public.suppliers table for category-wise supplier allocation
-- Suppliers specialize in product categories (e.g. Meat, Fruits, All)

ALTER TABLE public.suppliers 
    ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'Meat';

-- Add check constraint for supported categories
ALTER TABLE public.suppliers 
    DROP CONSTRAINT IF EXISTS chk_suppliers_category;

ALTER TABLE public.suppliers 
    ADD CONSTRAINT chk_suppliers_category 
    CHECK (category IN ('Meat', 'Fruits', 'All', 'Dairy', 'Vegetables', 'Grocery', 'Hardware'));

-- Create index for supplier category queries
CREATE INDEX IF NOT EXISTS idx_suppliers_category ON public.suppliers(category);
