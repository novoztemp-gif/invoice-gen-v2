-- Create PL/pgSQL function for atomic expense batch and items transactional insertion
CREATE OR REPLACE FUNCTION public.create_expense_batch_transactional(
    batch_payload JSONB,
    items_payload JSONB
)
RETURNS UUID AS $$
DECLARE
    new_batch_id UUID;
    item RECORD;
BEGIN
    -- 1. Insert the expense batch
    INSERT INTO public.expense_batch (
        financial_year,
        expense_date_from,
        expense_date_to,
        total_amount,
        status,
        created_by
    ) VALUES (
        batch_payload->>'financial_year',
        (batch_payload->>'expense_date_from')::DATE,
        (batch_payload->>'expense_date_to')::DATE,
        (batch_payload->>'total_amount')::NUMERIC,
        COALESCE(batch_payload->>'status', 'pending'),
        (batch_payload->>'created_by')::UUID
    )
    RETURNING id INTO new_batch_id;

    -- 2. Insert all the items
    FOR item IN SELECT * FROM jsonb_to_recordset(items_payload) AS x(
        expense_name TEXT,
        expense_category TEXT,
        amount NUMERIC
    ) LOOP
        INSERT INTO public.expense_batch_items (
            expense_batch_id,
            expense_name,
            expense_category,
            amount
        ) VALUES (
            new_batch_id,
            item.expense_name,
            item.expense_category,
            item.amount
        );
    END LOOP;

    RETURN new_batch_id;
END;
$$ LANGUAGE plpgsql;
