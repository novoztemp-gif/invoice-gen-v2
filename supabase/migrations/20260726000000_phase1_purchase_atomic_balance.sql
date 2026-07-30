-- Phase 1: atomically persist a purchase invoice edit and all balancing updates.
-- This migration deliberately does not post inventory or alter sales behaviour.
CREATE OR REPLACE FUNCTION public.save_purchase_invoice_edit_and_balance(
  p_batch_id UUID,
  p_edited_invoice_id UUID,
  p_edited_invoice_data JSONB,
  p_balancing_updates JSONB
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
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  -- Lock the batch for the duration of this transaction. Concurrent callers wait
  -- here and subsequently see the current state rather than a partial update.
  SELECT total_amount, batch_type, batch_status
  INTO v_batch_total, v_batch_type, v_batch_status
  FROM public.invoice_batch
  WHERE id = p_batch_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Purchase batch not found.';
  END IF;
  IF v_batch_type <> 'PURCHASE' THEN
    RAISE EXCEPTION 'Atomic auto balance is available only for purchase batches.';
  END IF;
  IF v_batch_status = 'FINALIZED' THEN
    RAISE EXCEPTION 'Batch is finalized and read-only.';
  END IF;

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
    RAISE EXCEPTION 'Edited invoice does not belong to this purchase batch.';
  END IF;

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
      RAISE EXCEPTION 'A balancing invoice does not belong to this purchase batch.';
    END IF;
  END LOOP;

  SELECT COALESCE(SUM(total_amount), 0)
  INTO v_calculated_total
  FROM public.invoice
  WHERE invoice_batch_id = p_batch_id;

  IF v_calculated_total <> v_batch_total THEN
    RAISE EXCEPTION 'Batch total mismatch: expected %, calculated %.', v_batch_total, v_calculated_total;
  END IF;
END;
$$;
