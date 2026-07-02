-- Add locking columns for auto balancing engine
ALTER TABLE public.invoice_batch 
ADD COLUMN IF NOT EXISTS is_balancing BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS balancing_locked_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS balancing_locked_by UUID REFERENCES auth.users(id);
