-- 1. Create save_purchase_batch_transactional PL/pgSQL function to insert purchase invoices and ledger records atomically
CREATE OR REPLACE FUNCTION public.save_purchase_batch_transactional(
    batch_id UUID,
    invoices_payload JSONB,
    ledger_payload JSONB
)
RETURNS BOOLEAN AS $$
DECLARE
    inv RECORD;
    led RECORD;
BEGIN
    -- 1. Insert the invoices
    FOR inv IN SELECT * FROM jsonb_to_recordset(invoices_payload) AS x(
        invoice_number TEXT,
        invoice_date DATE,
        products JSONB,
        total_amount NUMERIC
    ) LOOP
        INSERT INTO public.invoice (
            invoice_batch_id,
            invoice_number,
            invoice_date,
            products,
            total_amount,
            status,
            batch_type
        ) VALUES (
            batch_id,
            inv.invoice_number,
            inv.invoice_date,
            inv.products,
            inv.total_amount,
            'generated',
            'PURCHASE'
        );
    END LOOP;

    -- 2. Insert the ledger records
    FOR led IN SELECT * FROM jsonb_to_recordset(ledger_payload) AS y(
        purchase_batch_id UUID,
        ledger_date DATE,
        product_id UUID,
        opening_stock NUMERIC,
        purchased_quantity NUMERIC,
        sold_quantity NUMERIC
    ) LOOP
        INSERT INTO public.daily_stock_ledger (
            purchase_batch_id,
            ledger_date,
            product_id,
            opening_stock,
            purchased_quantity,
            sold_quantity
        ) VALUES (
            led.purchase_batch_id,
            led.ledger_date,
            led.product_id,
            led.opening_stock,
            led.purchased_quantity,
            led.sold_quantity
        );
    END LOOP;

    -- 3. Update the batch status
    UPDATE public.invoice_batch
    SET status = 'generated'
    WHERE id = batch_id;

    RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

-- 2. Create function and trigger to restore stock ledger when Sales invoices are deleted
CREATE OR REPLACE FUNCTION public.restore_stock_on_invoice_delete()
RETURNS TRIGGER AS $$
DECLARE
    parent_batch RECORD;
    prod RECORD;
BEGIN
    -- Find parent batch details
    SELECT stock_source_batch_id, batch_type 
    INTO parent_batch
    FROM public.invoice_batch
    WHERE id = OLD.invoice_batch_id;

    -- If it is a SALES batch and has a stock source purchase batch, restore the stock
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

    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

-- Drop trigger if exists first
DROP TRIGGER IF EXISTS trg_restore_stock_on_invoice_delete ON public.invoice;

CREATE TRIGGER trg_restore_stock_on_invoice_delete
AFTER DELETE ON public.invoice
FOR EACH ROW
EXECUTE FUNCTION public.restore_stock_on_invoice_delete();
