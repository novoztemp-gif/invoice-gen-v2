-- Create expense_daily_ledger table
CREATE TABLE IF NOT EXISTS public.expense_daily_ledger (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    expense_batch_id UUID NOT NULL REFERENCES public.expense_batch(id) ON DELETE CASCADE,
    expense_item_id UUID NOT NULL REFERENCES public.expense_batch_items(id) ON DELETE CASCADE,
    expense_date DATE NOT NULL,
    expense_category TEXT NOT NULL,
    expense_name TEXT NOT NULL,
    amount NUMERIC(15, 2) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- Enable Row Level Security (RLS)
ALTER TABLE public.expense_daily_ledger ENABLE ROW LEVEL SECURITY;

-- Allow all operations for authenticated users on expense_daily_ledger
CREATE POLICY "Allow all operations for authenticated users on expense_daily_ledger" 
ON public.expense_daily_ledger
FOR ALL 
TO authenticated 
USING (true) 
WITH CHECK (true);

-- Create PL/pgSQL function to save the daily ledger split-up atomically
CREATE OR REPLACE FUNCTION public.save_expense_split_up_transactional(
    p_batch_id UUID,
    p_ledger_rows JSONB
)
RETURNS BOOLEAN AS $$
DECLARE
    ledger_row RECORD;
BEGIN
    -- 1. Delete any existing daily ledger rows for this batch to ensure idempotency
    DELETE FROM public.expense_daily_ledger WHERE expense_batch_id = p_batch_id;

    -- 2. Insert all the new ledger rows
    FOR ledger_row IN SELECT * FROM jsonb_to_recordset(p_ledger_rows) AS x(
        expense_item_id UUID,
        expense_date DATE,
        expense_category TEXT,
        expense_name TEXT,
        amount NUMERIC
    ) LOOP
        INSERT INTO public.expense_daily_ledger (
            expense_batch_id,
            expense_item_id,
            expense_date,
            expense_category,
            expense_name,
            amount
        ) VALUES (
            p_batch_id,
            ledger_row.expense_item_id,
            ledger_row.expense_date,
            ledger_row.expense_category,
            ledger_row.expense_name,
            ledger_row.amount
        );
    END LOOP;

    -- 3. Update status of the batch to 'generated'
    UPDATE public.expense_batch
    SET status = 'generated',
        updated_at = now()
    WHERE id = p_batch_id;

    RETURN TRUE;
END;
$$ LANGUAGE plpgsql;
