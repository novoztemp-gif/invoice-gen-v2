-- Create transactional function to insert Sales Batch, Invoices, and update stock ledger atomically
CREATE OR REPLACE FUNCTION public.create_sales_batch_transactional(
    batch_payload JSONB,
    invoices_payload JSONB,
    stock_source_id UUID
)
RETURNS UUID AS $$
DECLARE
    new_batch_id UUID;
    inv RECORD;
    daily_qty_record RECORD;
    ledger_row RECORD;
    available_stock NUMERIC(15,2);
    product_name_str TEXT;
    formatted_date_str TEXT;
    unit_str TEXT;
BEGIN
    -- 1. Insert the Sales Batch with status = 'generated'
    INSERT INTO public.invoice_batch (
        issuing_company_id,
        receiving_company_id,
        selected_customers,
        major_customers,
        batch_type,
        transport_mode,
        vehicle_number,
        date_of_supply,
        invoice_date_from,
        invoice_date_to,
        minimum_invoice_amount,
        maximum_invoice_amount,
        total_amount,
        financial_year,
        products,
        recurring_products,
        status,
        created_by,
        stock_source_batch_id
    ) VALUES (
        (batch_payload->>'issuing_company_id')::UUID,
        (batch_payload->>'receiving_company_id')::UUID,
        COALESCE(ARRAY(SELECT jsonb_array_elements_text(batch_payload->'selected_customers'))::UUID[], '{}'::UUID[]),
        COALESCE(batch_payload->'major_customers', '[]'::JSONB),
        batch_payload->>'batch_type',
        batch_payload->>'transport_mode',
        batch_payload->>'vehicle_number',
        (batch_payload->>'date_of_supply')::DATE,
        (batch_payload->>'invoice_date_from')::DATE,
        (batch_payload->>'invoice_date_to')::DATE,
        (batch_payload->>'minimum_invoice_amount')::NUMERIC,
        (batch_payload->>'maximum_invoice_amount')::NUMERIC,
        (batch_payload->>'total_amount')::NUMERIC,
        batch_payload->>'financial_year',
        batch_payload->'products',
        COALESCE(batch_payload->'recurring_products', '[]'::JSONB),
        'generated',
        (batch_payload->>'created_by')::UUID,
        stock_source_id
    )
    RETURNING id INTO new_batch_id;

    -- 2. Loop through invoices and insert them
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
            new_batch_id,
            inv.invoice_number,
            inv.invoice_date,
            inv.products,
            inv.total_amount,
            'generated',
            'SALES'
        );
    END LOOP;

    -- 3. Accumulate quantities and check/update daily stock ledger
    FOR daily_qty_record IN 
        WITH inv_products AS (
            SELECT 
                (inv_row->>'invoice_date')::DATE as date_supply,
                (prod_row->>'product_id')::UUID as prod_id,
                (prod_row->>'quantity')::NUMERIC as qty
            FROM jsonb_array_elements(invoices_payload) AS inv_row
            CROSS JOIN LATERAL jsonb_array_elements(inv_row->'products') AS prod_row
        )
        SELECT date_supply, prod_id, SUM(qty) as total_qty
        FROM inv_products
        GROUP BY date_supply, prod_id
    LOOP
        -- Lock the row using FOR UPDATE to prevent race conditions
        SELECT id, opening_stock, purchased_quantity, sold_quantity
        INTO ledger_row
        FROM public.daily_stock_ledger
        WHERE purchase_batch_id = stock_source_id
          AND ledger_date = daily_qty_record.date_supply
          AND product_id = daily_qty_record.prod_id
        FOR UPDATE;

        IF NOT FOUND THEN
            SELECT product_name, unit_of_measure INTO product_name_str, unit_str FROM public.products WHERE id = daily_qty_record.prod_id;
            formatted_date_str := to_char(daily_qty_record.date_supply, 'DD-Mon-YYYY');
            
            RAISE EXCEPTION 'Insufficient stock for % on %. Available: 0.00 %, Requested: % %',
                COALESCE(product_name_str, 'Unknown Product'),
                formatted_date_str,
                COALESCE(unit_str, 'kg'),
                daily_qty_record.total_qty,
                COALESCE(unit_str, 'kg');
        END IF;

        available_stock := (ledger_row.opening_stock) + (ledger_row.purchased_quantity) - (ledger_row.sold_quantity);

        IF daily_qty_record.total_qty > available_stock THEN
            SELECT product_name, unit_of_measure INTO product_name_str, unit_str FROM public.products WHERE id = daily_qty_record.prod_id;
            formatted_date_str := to_char(daily_qty_record.date_supply, 'DD-Mon-YYYY');
            
            RAISE EXCEPTION 'Insufficient stock for % on %. Available: % %, Requested: % %',
                COALESCE(product_name_str, 'Unknown Product'),
                formatted_date_str,
                available_stock,
                COALESCE(unit_str, 'kg'),
                daily_qty_record.total_qty,
                COALESCE(unit_str, 'kg');
        END IF;

        -- Update the ledger
        UPDATE public.daily_stock_ledger
        SET sold_quantity = sold_quantity + daily_qty_record.total_qty,
            updated_at = now()
        WHERE id = ledger_row.id;
    END LOOP;

    RETURN new_batch_id;
END;
$$ LANGUAGE plpgsql;
