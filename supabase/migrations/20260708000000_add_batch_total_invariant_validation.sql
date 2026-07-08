-- Create updated RPC function to atomically update multiple invoices with batch total invariant check
CREATE OR REPLACE FUNCTION public.atomic_balance_invoices(updates jsonb)
RETURNS void AS $$
DECLARE
  item jsonb;
  batch_id uuid;
  expected_total numeric;
  calculated_total numeric;
BEGIN
  FOR item IN SELECT * FROM jsonb_array_elements(updates) LOOP
    UPDATE public.invoice
    SET 
      products = (item->'products'),
      total_amount = (item->>'total_amount')::numeric,
      is_edited = (item->>'is_edited')::boolean,
      edited_at = (item->>'edited_at')::timestamp with time zone
    WHERE id = (item->>'id')::uuid
    RETURNING invoice_batch_id INTO batch_id;
  END LOOP;

  -- Fetch the expected batch total
  SELECT total_amount INTO expected_total
  FROM public.invoice_batch
  WHERE id = batch_id;

  -- Calculate the actual sum of all invoices for the batch
  SELECT SUM(total_amount) INTO calculated_total
  FROM public.invoice
  WHERE invoice_batch_id = batch_id;

  -- Hard validation check (allowing tiny rounding tolerance of 0.01)
  IF ABS(calculated_total - expected_total) > 0.01 THEN
    RAISE EXCEPTION 'Batch total mismatch: expected %, calculated % (difference: %)', 
      expected_total, calculated_total, (calculated_total - expected_total);
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create updated RPC function to atomically update edited invoice AND balanced invoices with batch total invariant check
CREATE OR REPLACE FUNCTION public.save_and_balance_invoices(
  edited_invoice_id uuid,
  edited_invoice_data jsonb,
  balancing_updates jsonb
)
RETURNS void AS $$
DECLARE
  item jsonb;
  batch_id uuid;
  expected_total numeric;
  calculated_total numeric;
BEGIN
  -- 1. Update the edited invoice
  UPDATE public.invoice
  SET 
    products = (edited_invoice_data->'products'),
    total_amount = (edited_invoice_data->>'total_amount')::numeric,
    is_edited = (edited_invoice_data->>'is_edited')::boolean,
    edited_at = (edited_invoice_data->>'edited_at')::timestamp with time zone
  WHERE id = edited_invoice_id
  RETURNING invoice_batch_id INTO batch_id;

  -- 2. Update all balanced invoices
  FOR item IN SELECT * FROM jsonb_array_elements(balancing_updates) LOOP
    UPDATE public.invoice
    SET 
      products = (item->'products'),
      total_amount = (item->>'total_amount')::numeric,
      is_edited = (item->>'is_edited')::boolean,
      edited_at = (item->>'edited_at')::timestamp with time zone
    WHERE id = (item->>'id')::uuid;
  END LOOP;

  -- 3. Fetch the expected batch total
  SELECT total_amount INTO expected_total
  FROM public.invoice_batch
  WHERE id = batch_id;

  -- 4. Calculate the actual sum of all invoices for the batch
  SELECT SUM(total_amount) INTO calculated_total
  FROM public.invoice
  WHERE invoice_batch_id = batch_id;

  -- 5. Hard validation check (allowing tiny rounding tolerance of 0.01)
  IF ABS(calculated_total - expected_total) > 0.01 THEN
    RAISE EXCEPTION 'Batch total mismatch: expected %, calculated % (difference: %)', 
      expected_total, calculated_total, (calculated_total - expected_total);
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
