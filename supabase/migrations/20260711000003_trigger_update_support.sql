-- Update stock restoration function to handle both UPDATE and DELETE events
CREATE OR REPLACE FUNCTION public.restore_stock_on_invoice_delete()
RETURNS TRIGGER AS $$
DECLARE
    parent_batch RECORD;
    prod RECORD;
BEGIN
    -- 1. If UPDATE or DELETE: Revert the old quantities from the ledger
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
                WHERE purchase_batch_id = parent_batch.stock_source_batch_id
                  AND ledger_date = OLD.invoice_date
                  AND product_id = prod.product_id;
            END LOOP;
        END IF;
    END IF;

    -- 2. If UPDATE: Apply the new quantities to the ledger
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
                WHERE purchase_batch_id = parent_batch.stock_source_batch_id
                  AND ledger_date = NEW.invoice_date
                  AND product_id = prod.product_id;
            END LOOP;
        END IF;
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- Recreate trigger to fire on both UPDATE and DELETE
DROP TRIGGER IF EXISTS trg_restore_stock_on_invoice_delete ON public.invoice;

CREATE TRIGGER trg_restore_stock_on_invoice_delete
AFTER UPDATE OR DELETE ON public.invoice
FOR EACH ROW
EXECUTE FUNCTION public.restore_stock_on_invoice_delete();
