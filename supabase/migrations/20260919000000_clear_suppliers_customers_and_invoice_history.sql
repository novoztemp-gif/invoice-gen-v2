-- Migration: Clear suppliers and receiving customers only — every other
-- table (invoices, invoice batches, stock ledger, etc.) stays intact.
--
-- Uses DELETE, not TRUNCATE. Verified against a real Postgres instance:
-- TRUNCATE ... CASCADE ignores each column's own ON DELETE behavior and
-- unconditionally empties every table with ANY foreign key pointing at the
-- truncated table — including invoice_batch, wiping invoice history along
-- with it, regardless of whether those FK columns were already nulled out
-- first. Plain DELETE does NOT have that problem: it correctly honors each
-- foreign key's own ON DELETE action (SET NULL vs CASCADE) per row.
--
-- invoice_batch.supplier_id is ON DELETE SET NULL, so DELETE FROM suppliers
-- would already leave it null on its own — nulling it out first is just
-- belt-and-braces. invoice_batch.receiving_company_id is ON DELETE CASCADE,
-- so nulling THAT one out first is required — otherwise DELETE FROM
-- receiving_companies would genuinely cascade-delete every invoice_batch
-- (and its invoices) still pointing at a deleted customer.

UPDATE public.invoice_batch SET supplier_id = NULL WHERE supplier_id IS NOT NULL;
UPDATE public.invoice_batch SET receiving_company_id = NULL WHERE receiving_company_id IS NOT NULL;

DELETE FROM public.suppliers;
DELETE FROM public.receiving_companies;
