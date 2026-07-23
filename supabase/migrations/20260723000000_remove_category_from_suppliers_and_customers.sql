-- Migration: Remove category column from suppliers and receiving_companies tables
-- Product Category belongs strictly to Products (e.g. Meat vs Fruits)

ALTER TABLE public.suppliers DROP CONSTRAINT IF EXISTS chk_suppliers_category;
ALTER TABLE public.suppliers DROP COLUMN IF EXISTS category;

ALTER TABLE public.receiving_companies DROP CONSTRAINT IF EXISTS chk_receiving_companies_category;
ALTER TABLE public.receiving_companies DROP COLUMN IF EXISTS category;
