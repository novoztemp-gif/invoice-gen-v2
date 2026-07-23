-- Simplify Category Architecture to fixed 'Meat' and 'Fruits' categories

-- 1. Add fixed category column to products table
ALTER TABLE public.products 
ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'Meat';

UPDATE public.products 
SET category = 'Meat' 
WHERE category IS NULL OR category NOT IN ('Meat', 'Fruits');

ALTER TABLE public.products DROP CONSTRAINT IF EXISTS chk_products_category;
ALTER TABLE public.products ADD CONSTRAINT chk_products_category CHECK (category IN ('Meat', 'Fruits'));

-- 2. Add fixed category column to suppliers table
ALTER TABLE public.suppliers 
ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'Meat';

UPDATE public.suppliers 
SET category = 'Meat' 
WHERE category IS NULL OR category NOT IN ('Meat', 'Fruits');

ALTER TABLE public.suppliers DROP CONSTRAINT IF EXISTS chk_suppliers_category;
ALTER TABLE public.suppliers ADD CONSTRAINT chk_suppliers_category CHECK (category IN ('Meat', 'Fruits'));

-- 3. Add fixed category column to receiving_companies table
ALTER TABLE public.receiving_companies 
ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'Meat';

UPDATE public.receiving_companies 
SET category = 'Meat' 
WHERE category IS NULL OR category NOT IN ('Meat', 'Fruits');

ALTER TABLE public.receiving_companies DROP CONSTRAINT IF EXISTS chk_receiving_companies_category;
ALTER TABLE public.receiving_companies ADD CONSTRAINT chk_receiving_companies_category CHECK (category IN ('Meat', 'Fruits'));

-- 4. Clean up old dynamic category references if present
ALTER TABLE public.products DROP COLUMN IF EXISTS category_id;
ALTER TABLE public.suppliers DROP COLUMN IF EXISTS categories;
ALTER TABLE public.receiving_companies DROP COLUMN IF EXISTS categories;
DROP TABLE IF EXISTS public.categories CASCADE;
