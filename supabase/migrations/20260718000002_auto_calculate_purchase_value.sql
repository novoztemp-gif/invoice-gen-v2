-- Re-create save_purchase_batch_transactional PL/pgSQL function to calculate and save batch total amount atomically
CREATE OR REPLACE FUNCTION public.save_purchase_batch_transactional(
    batch_id UUID,
    invoices_payload JSONB,
    ledger_payload JSONB
)
RETURNS BOOLEAN AS $$
DECLARE
    inv RECORD;
    led RECORD;
    calculated_total NUMERIC := 0;
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
        calculated_total := calculated_total + inv.total_amount;
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

    -- 3. Update the batch status and save the dynamically calculated total amount
    UPDATE public.invoice_batch
    SET status = 'generated',
        total_amount = calculated_total
    WHERE id = batch_id;

    RETURN TRUE;
END;
$$ LANGUAGE plpgsql;
