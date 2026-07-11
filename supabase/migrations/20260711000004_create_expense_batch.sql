-- Create expense_batch table
CREATE TABLE IF NOT EXISTS public.expense_batch (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    financial_year TEXT NOT NULL,
    expense_date_from DATE NOT NULL,
    expense_date_to DATE NOT NULL,
    total_amount NUMERIC(15, 2) NOT NULL,
    status TEXT DEFAULT 'pending' NOT NULL,
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- Create expense_batch_items table
CREATE TABLE IF NOT EXISTS public.expense_batch_items (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    expense_batch_id UUID NOT NULL REFERENCES public.expense_batch(id) ON DELETE CASCADE,
    expense_name TEXT NOT NULL,
    expense_category TEXT DEFAULT 'General' NOT NULL,
    amount NUMERIC(15, 2) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- Enable Row Level Security (RLS)
ALTER TABLE public.expense_batch ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expense_batch_items ENABLE ROW LEVEL SECURITY;

-- Allow all operations for authenticated users on expense_batch
CREATE POLICY "Allow all operations for authenticated users on expense_batch" 
ON public.expense_batch
FOR ALL 
TO authenticated 
USING (true) 
WITH CHECK (true);

-- Allow all operations for authenticated users on expense_batch_items
CREATE POLICY "Allow all operations for authenticated users on expense_batch_items" 
ON public.expense_batch_items
FOR ALL 
TO authenticated 
USING (true) 
WITH CHECK (true);
