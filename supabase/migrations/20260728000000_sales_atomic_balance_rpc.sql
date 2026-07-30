-- Sales Phase 1: Atomically persist a sales invoice edit and all balancing updates,
-- enforcing non-blocking batch row locking, post-persistence invariant verification,
-- audit logging, and single-transaction rollback.

CREATE TABLE IF NOT EXISTS public.sales_batch_edit_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL REFERENCES public.invoice_batch(id) ON DELETE CASCADE,
  edited_invoice_id UUID NOT NULL REFERENCES public.invoice(id) ON DELETE CASCADE,
  user_id UUID,
  edit_timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  affected_invoice_ids JSONB,
  num_products_modified INT NOT NULL DEFAULT 0,
  num_invoices_rebalanced INT NOT NULL DEFAULT 0,
  transaction_status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Enable RLS on audit table
ALTER TABLE public.sales_batch_edit_audit ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow authenticated read/write on sales_batch_edit_audit"
  ON public.sales_batch_edit_audit
  FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.save_sales_invoice_edit_and_balance(
  p_batch_id UUID,
  p_edited_invoice_id UUID,
  p_edited_invoice_data JSONB,
  p_balancing_updates JSONB,
  p_expected_product_totals JSONB DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_batch_total NUMERIC;
  v_batch_type TEXT;
  v_batch_status TEXT;
  v_calculated_total NUMERIC;
  v_item JSONB;
  v_prod RECORD;
  v_calc_qty NUMERIC;
  v_exp_qty NUMERIC;
  v_num_products INT := 0;
  v_num_rebalanced INT := 0;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized: User authentication required.';
  END IF;

  -- STEP 2: Acquire exclusive lock on Sales Batch. Prevent concurrent editing.
  BEGIN
    SELECT total_amount, batch_type, batch_status
    INTO v_batch_total, v_batch_type, v_batch_status
    FROM public.invoice_batch
    WHERE id = p_batch_id
    FOR UPDATE NOWAIT;
  EXCEPTION
    WHEN lock_not_available THEN
      RAISE EXCEPTION 'Concurrent Edit Detected: Sales Batch is currently being edited. Please try again.';
  END;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sales Batch Not Found: Sales batch % does not exist.', p_batch_id;
  END IF;
  IF v_batch_type <> 'SALES' THEN
    RAISE EXCEPTION 'Invalid Batch Type: Atomic sales auto balance is available only for sales batches.';
  END IF;
  IF v_batch_status = 'FINALIZED' THEN
    RAISE EXCEPTION 'Batch Finalized: Sales batch is finalized and read-only.';
  END IF;

  -- Lock all invoices belonging to this batch
  PERFORM id FROM public.invoice WHERE invoice_batch_id = p_batch_id FOR UPDATE;

  -- Count modified products in edited invoice
  SELECT jsonb_array_length(COALESCE(p_edited_invoice_data->'products', '[]'::JSONB)) INTO v_num_products;
  v_num_rebalanced := jsonb_array_length(COALESCE(p_balancing_updates, '[]'::JSONB));

  -- STEP 14: Persist Edited Invoice
  UPDATE public.invoice
  SET
    products = p_edited_invoice_data->'products',
    total_amount = (p_edited_invoice_data->>'total_amount')::NUMERIC,
    transport_mode = p_edited_invoice_data->>'transport_mode',
    vehicle_number = p_edited_invoice_data->>'vehicle_number',
    date_of_supply = NULLIF(p_edited_invoice_data->>'date_of_supply', '')::DATE,
    is_edited = TRUE,
    edited_at = COALESCE(NULLIF(p_edited_invoice_data->>'edited_at', '')::TIMESTAMPTZ, NOW())
  WHERE id = p_edited_invoice_id
    AND invoice_batch_id = p_batch_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Edited Invoice Mismatch: Edited invoice does not belong to this sales batch.';
  END IF;

  -- STEP 15: Persist Balancing Invoice Updates
  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_balancing_updates, '[]'::JSONB)) LOOP
    UPDATE public.invoice
    SET
      products = v_item->'products',
      total_amount = (v_item->>'total_amount')::NUMERIC,
      is_edited = TRUE,
      edited_at = COALESCE(NULLIF(v_item->>'edited_at', '')::TIMESTAMPTZ, NOW())
    WHERE id = (v_item->>'id')::UUID
      AND invoice_batch_id = p_batch_id
      AND id <> p_edited_invoice_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Balancing Invoice Mismatch: A balancing invoice does not belong to this sales batch.';
    END IF;
  END LOOP;

  -- STEP 16: In-Transaction Verification (Verify persisted data)

  -- 16a. Verify Batch Total Amount
  SELECT COALESCE(SUM(total_amount), 0)
  INTO v_calculated_total
  FROM public.invoice
  WHERE invoice_batch_id = p_batch_id;

  IF v_calculated_total <> v_batch_total THEN
    RAISE EXCEPTION 'Batch Total Mismatch: expected %, calculated %.', v_batch_total, v_calculated_total;
  END IF;

  -- 16b. Verify Expected Product Totals (if passed)
  IF p_expected_product_totals IS NOT NULL THEN
    FOR v_prod IN SELECT key, value FROM jsonb_each_text(p_expected_product_totals) LOOP
      v_exp_qty := (v_prod.value)::NUMERIC;

      SELECT COALESCE(SUM((elem->>'quantity')::NUMERIC), 0)
      INTO v_calc_qty
      FROM public.invoice inv,
           jsonb_array_elements(inv.products) elem
      WHERE inv.invoice_batch_id = p_batch_id
        AND elem->>'product_id' = v_prod.key;

      IF v_calc_qty <> v_exp_qty THEN
        RAISE EXCEPTION 'Product Quantity Mismatch: product % expected total % KG, calculated % KG.',
          v_prod.key, v_exp_qty, v_calc_qty;
      END IF;
    END LOOP;
  END IF;

  -- 16c. Verify line rates & quantities are valid positive values
  PERFORM 1
  FROM public.invoice inv,
       jsonb_array_elements(inv.products) elem
  WHERE inv.invoice_batch_id = p_batch_id
    AND ((elem->>'rate')::NUMERIC < 1 OR (elem->>'quantity')::NUMERIC < 0);

  IF FOUND THEN
    RAISE EXCEPTION 'Invalid Line Values: Invoice contains non-positive rates or negative quantities.';
  END IF;

  -- STEP 17: Audit Record Logging
  INSERT INTO public.sales_batch_edit_audit (
    batch_id,
    edited_invoice_id,
    user_id,
    edit_timestamp,
    affected_invoice_ids,
    num_products_modified,
    num_invoices_rebalanced,
    transaction_status
  ) VALUES (
    p_batch_id,
    p_edited_invoice_id,
    auth.uid(),
    NOW(),
    (SELECT jsonb_agg(v_item->>'id') FROM jsonb_array_elements(COALESCE(p_balancing_updates, '[]'::JSONB))),
    v_num_products,
    v_num_rebalanced,
    'SUCCESS'
  );
END;
$$;
