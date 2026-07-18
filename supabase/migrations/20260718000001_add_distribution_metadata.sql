-- 1. Add distribution metadata columns to public.expense_batch
ALTER TABLE public.expense_batch ADD COLUMN IF NOT EXISTS distribution_method TEXT CHECK (distribution_method IN ('EQUAL', 'RANDOM', 'MANUAL'));
ALTER TABLE public.expense_batch ADD COLUMN IF NOT EXISTS splitup_generated_at TIMESTAMPTZ;
ALTER TABLE public.expense_batch ADD COLUMN IF NOT EXISTS splitup_generated_by UUID REFERENCES auth.users(id);

-- 2. Re-create transactional save function to track metadata and audit fields
CREATE OR REPLACE FUNCTION public.save_expense_split_up_transactional(
    p_batch_id UUID,
    p_ledger_rows JSONB,
    p_distribution_method TEXT,
    p_generated_by UUID,
    p_generated_at TIMESTAMPTZ
)
RETURNS BOOLEAN AS $$
DECLARE
    ledger_row RECORD;
BEGIN
    -- Delete any existing daily ledger rows for this batch to ensure idempotency
    DELETE FROM public.expense_daily_ledger WHERE expense_batch_id = p_batch_id;

    -- Insert all the new ledger rows
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

    -- Update status and metadata of the batch
    UPDATE public.expense_batch
    SET status = 'generated',
        distribution_method = p_distribution_method,
        splitup_generated_by = p_generated_by,
        splitup_generated_at = COALESCE(p_generated_at, now()),
        updated_at = now()
    WHERE id = p_batch_id;

    RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

-- 3. Create PL/pgSQL function to safely revert generated batch back to pending state
CREATE OR REPLACE FUNCTION public.regenerate_expense_split_up_transactional(
    p_batch_id UUID
)
RETURNS BOOLEAN AS $$
BEGIN
    -- Delete all daily ledger rows associated with the batch
    DELETE FROM public.expense_daily_ledger WHERE expense_batch_id = p_batch_id;

    -- Reset status and audit metadata columns to pending state
    UPDATE public.expense_batch
    SET status = 'pending',
        distribution_method = NULL,
        splitup_generated_by = NULL,
        splitup_generated_at = NULL,
        updated_at = now()
    WHERE id = p_batch_id;

    RETURN TRUE;
END;
$$ LANGUAGE plpgsql;
