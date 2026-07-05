-- Create RPC function to update multiple invoices inside a single database transaction block
CREATE OR REPLACE FUNCTION public.atomic_balance_invoices(updates jsonb)
RETURNS void AS $$
DECLARE
  item jsonb;
BEGIN
  FOR item IN SELECT * FROM jsonb_array_elements(updates) LOOP
    UPDATE public.invoice
    SET 
      products = (item->'products'),
      total_amount = (item->>'total_amount')::numeric,
      is_edited = (item->>'is_edited')::boolean,
      edited_at = (item->>'edited_at')::timestamp with time zone
    WHERE id = (item->>'id')::uuid;
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create RPC function to atomically update the edited invoice AND all balanced invoices
CREATE OR REPLACE FUNCTION public.save_and_balance_invoices(
  edited_invoice_id uuid,
  edited_invoice_data jsonb,
  balancing_updates jsonb
)
RETURNS void AS $$
DECLARE
  item jsonb;
BEGIN
  -- 1. Update the edited invoice
  UPDATE public.invoice
  SET 
    products = (edited_invoice_data->'products'),
    total_amount = (edited_invoice_data->>'total_amount')::numeric,
    is_edited = (edited_invoice_data->>'is_edited')::boolean,
    edited_at = (edited_invoice_data->>'edited_at')::timestamp with time zone
  WHERE id = edited_invoice_id;

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
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
