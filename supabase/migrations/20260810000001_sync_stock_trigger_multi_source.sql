-- stock_source_batch_id on invoice_batch was just widened from UUID to
-- TEXT (see 20260810000000_stock_source_batch_id_multi.sql) so it can hold
-- a comma-joined list of multiple Purchase batch IDs, matching how the app
-- has always treated this column everywhere else. This trigger function
-- (fired on invoice UPDATE/DELETE to keep daily_stock_ledger.sold_quantity
-- in sync with edits) still compared
-- `daily_stock_ledger.purchase_batch_id = parent_batch.stock_source_batch_id`
-- directly, which becomes a uuid = text type error now, and never handled
-- the comma-list case anyway (it would only ever have matched the ledger
-- rows for a single source batch). Recreate it to match against every
-- comma-separated source batch id.

CREATE OR REPLACE FUNCTION public.sync_stock_on_invoice_change()
RETURNS TRIGGER AS $$
DECLARE
    parent_batch RECORD;
    prod RECORD;
BEGIN
    -- If UPDATE or DELETE: Revert the old quantities from the ledger
    IF TG_OP = 'DELETE' OR TG_OP = 'UPDATE' THEN
        SELECT stock_source_batch_id, batch_type
        INTO parent_batch
        FROM public.invoice_batch
        WHERE id = OLD.invoice_batch_id;

        IF FOUND AND parent_batch.batch_type = 'SALES' AND parent_batch.stock_source_batch_id IS NOT NULL THEN
            FOR prod IN SELECT * FROM jsonb_to_recordset(OLD.products) AS x(
                product_id UUID,
                quantity NUMERIC
            ) LOOP
                UPDATE public.daily_stock_ledger
                SET sold_quantity = GREATEST(0, sold_quantity - prod.quantity),
                    updated_at = now()
                WHERE purchase_batch_id::text = ANY(
                        string_to_array(parent_batch.stock_source_batch_id, ',')
                      )
                  AND ledger_date = OLD.invoice_date
                  AND product_id = prod.product_id;
            END LOOP;
        END IF;
    END IF;

    -- If UPDATE: Apply the new quantities to the ledger
    IF TG_OP = 'UPDATE' THEN
        SELECT stock_source_batch_id, batch_type
        INTO parent_batch
        FROM public.invoice_batch
        WHERE id = NEW.invoice_batch_id;

        IF FOUND AND parent_batch.batch_type = 'SALES' AND parent_batch.stock_source_batch_id IS NOT NULL THEN
            FOR prod IN SELECT * FROM jsonb_to_recordset(NEW.products) AS x(
                product_id UUID,
                quantity NUMERIC
            ) LOOP
                UPDATE public.daily_stock_ledger
                SET sold_quantity = sold_quantity + prod.quantity,
                    updated_at = now()
                WHERE purchase_batch_id::text = ANY(
                        string_to_array(parent_batch.stock_source_batch_id, ',')
                      )
                  AND ledger_date = NEW.invoice_date
                  AND product_id = prod.product_id;
            END LOOP;
        END IF;
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
