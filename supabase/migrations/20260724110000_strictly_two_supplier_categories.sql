-- Migration: Restrict public.suppliers category strictly to Meat or Fruits
-- Purchase Workflow strictly divides suppliers into Meat Suppliers and Fruit Suppliers.

ALTER TABLE public.suppliers 
    DROP CONSTRAINT IF EXISTS chk_suppliers_category;

-- Update any existing non-conforming supplier categories to 'Meat'
UPDATE public.suppliers 
SET category = 'Meat' 
WHERE category NOT IN ('Meat', 'Fruits') OR category IS NULL;

-- Enforce strict CHECK constraint
ALTER TABLE public.suppliers 
    ADD CONSTRAINT chk_suppliers_category 
    CHECK (category IN ('Meat', 'Fruits'));

-- Default category to 'Meat'
ALTER TABLE public.suppliers 
    ALTER COLUMN category SET DEFAULT 'Meat';
