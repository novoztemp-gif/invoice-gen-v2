-- 1. Add columns to public.expense_batch
ALTER TABLE public.expense_batch ADD COLUMN IF NOT EXISTS batch_name TEXT;
ALTER TABLE public.expense_batch ADD COLUMN IF NOT EXISTS remarks TEXT;

-- 2. Populate batch_name for existing records with fallback generated name
UPDATE public.expense_batch
SET batch_name = 'FY ' || financial_year || ' - ' || trim(to_char(expense_date_from, 'Month')) || ' Expenses'
WHERE batch_name IS NULL;

-- 3. Alter batch_name to NOT NULL
ALTER TABLE public.expense_batch ALTER COLUMN batch_name SET NOT NULL;

-- 4. Add display_order to public.expense_batch_items
ALTER TABLE public.expense_batch_items ADD COLUMN IF NOT EXISTS display_order INTEGER DEFAULT 0;

-- 5. Re-create create_expense_batch_transactional RPC to include batch_name, remarks, and display_order
CREATE OR REPLACE FUNCTION public.create_expense_batch_transactional(
    batch_payload JSONB,
    items_payload JSONB
)
RETURNS UUID AS $$
DECLARE
    new_batch_id UUID;
    item RECORD;
BEGIN
    -- Insert the expense batch
    INSERT INTO public.expense_batch (
        batch_name,
        financial_year,
        expense_date_from,
        expense_date_to,
        total_amount,
        status,
        remarks,
        created_by
    ) VALUES (
        batch_payload->>'batch_name',
        batch_payload->>'financial_year',
        (batch_payload->>'expense_date_from')::DATE,
        (batch_payload->>'expense_date_to')::DATE,
        (batch_payload->>'total_amount')::NUMERIC,
        COALESCE(batch_payload->>'status', 'pending'),
        batch_payload->>'remarks',
        (batch_payload->>'created_by')::UUID
    )
    RETURNING id INTO new_batch_id;

    -- Insert all the items preserving display_order
    FOR item IN SELECT * FROM jsonb_to_recordset(items_payload) AS x(
        expense_name TEXT,
        expense_category TEXT,
        amount NUMERIC,
        display_order INTEGER
    ) LOOP
        INSERT INTO public.expense_batch_items (
            expense_batch_id,
            expense_name,
            expense_category,
            amount,
            display_order
        ) VALUES (
            new_batch_id,
            item.expense_name,
            item.expense_category,
            item.amount,
            COALESCE(item.display_order, 0)
        );
    END LOOP;

    -- Update updated_at for consistency
    UPDATE public.expense_batch
    SET updated_at = now()
    WHERE id = new_batch_id;

    RETURN new_batch_id;
END;
$$ LANGUAGE plpgsql;
