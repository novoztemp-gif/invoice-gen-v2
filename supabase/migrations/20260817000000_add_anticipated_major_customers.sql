-- Anticipated Major Customer Demand — Purchase batches only. Optional,
-- fully nullable JSONB column, following the same convention as
-- category_allocation/major_customers/products/recurring_products on this
-- table (batch-level config lives in JSONB, not separate typed columns).
--
-- Root cause this feature addresses: a Sales "Major Customer" invoice must
-- draw its entire value from a SINGLE day (one invoice = one day, by
-- construction). Purchase generation spreads purchased quantity randomly
-- and evenly across every day in the batch's date range, with zero
-- awareness of what a LATER Sales batch's Major Customers will need — so
-- even when total stock across the whole range is more than enough, no
-- single day may have enough concentrated stock for a big Major Customer
-- invoice. This column lets the user pre-declare that demand at Purchase
-- time so generation can deliberately concentrate enough same-day stock
-- for it, instead of leaving it to chance.
--
-- Explicitly a DIFFERENT field from the existing major_customers column,
-- which on Purchase batches means major SUPPLIERS (a completely different
-- concept: real purchase invoices generated FOR those suppliers) — must
-- never be conflated with this one.
--
-- Shape (NOT enforced by any DB constraint, matching this table's existing
-- convention of leaving JSONB config shape validation to the service
-- layer — see category_allocation's own migration for the same choice):
--   [{"customer_id": "...", "amount": 856345, "invoice_count": 20,
--     "max_invoice_amount": 49900, "category": "Meat"}, ...]
--
-- NULL/empty for every batch created before this feature existed and for
-- any batch where the user leaves this optional section blank — generation
-- is byte-identical to before this feature whenever this column is
-- NULL/empty.
ALTER TABLE public.invoice_batch
ADD COLUMN IF NOT EXISTS anticipated_major_customers JSONB;

COMMENT ON COLUMN public.invoice_batch.anticipated_major_customers IS
  'Purchase batches only. Optional array of {customer_id, amount, invoice_count, max_invoice_amount, category} — the Sales Major Customer demand this Purchase batch is anticipating, purely to bias generation into concentrating enough same-day stock for it later. NULL/empty = no anticipation, generation behaves exactly as before this feature existed. Distinct from major_customers, which on Purchase batches means major suppliers, not anticipated Sales demand.';
