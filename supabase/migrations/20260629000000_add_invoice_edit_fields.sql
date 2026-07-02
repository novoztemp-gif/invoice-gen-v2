-- Add new fields for Phase 2: Editable Invoices
ALTER TABLE public.invoice
ADD COLUMN IF NOT EXISTS transport_mode TEXT,
ADD COLUMN IF NOT EXISTS vehicle_number TEXT,
ADD COLUMN IF NOT EXISTS date_of_supply DATE,
ADD COLUMN IF NOT EXISTS is_edited BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS edited_at TIMESTAMP WITH TIME ZONE;
