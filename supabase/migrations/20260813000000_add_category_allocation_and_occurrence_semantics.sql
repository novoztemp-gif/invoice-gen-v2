-- Sprint 1.7I — schema-only groundwork for the category-aware Product
-- Occurrence system designed in Sprints 1.7A-1.7H. Adds two new, fully
-- nullable columns to invoice_batch. Nothing in the application reads or
-- writes these columns yet — validation, UI, and generation wiring are all
-- explicitly deferred to later sprints. Every existing row remains valid
-- and completely unaffected: both new columns default to NULL, and NULL is
-- the correct, PERMANENT state for any batch created before this feature
-- existed (Sprint 1.7H's approved recommendation — old batches keep GLOBAL
-- occurrence semantics forever, signaled by occurrence_semantics staying
-- NULL rather than being backfilled to 'GLOBAL'; a NULL value IS the
-- "legacy/global" marker, not a placeholder awaiting a value).

-- category_allocation: JSONB, mirroring this same table's existing
-- convention for batch-level configuration (products, major_customers,
-- recurring_products are all JSONB — no separate typed columns are used
-- for config of this shape anywhere on invoice_batch). Intended shape
-- (NOT enforced by any constraint in this migration, per Sprint 1.7I's
-- explicit scope — percentage validation belongs to the service layer in
-- a future sprint):
--   {"Meat": 60, "Fruits": 40}
ALTER TABLE public.invoice_batch
ADD COLUMN IF NOT EXISTS category_allocation JSONB;

COMMENT ON COLUMN public.invoice_batch.category_allocation IS
  'Sprint 1.7 category-aware occurrence: target percentage of invoices per category, e.g. {"Meat": 60, "Fruits": 40}. NULL for every batch created before this feature existed. Not yet validated or consumed anywhere in the application — see ProductOccurrenceService and the Sprint 1.7A-1.7H design reports for the approved contract this will implement.';

-- occurrence_semantics: plain TEXT, deliberately NOT a native PostgreSQL
-- ENUM. This project has zero precedent for ENUM types anywhere in its
-- migration history (verified: no `CREATE TYPE ... AS ENUM` statement
-- exists in any existing migration file). Every comparable status/type
-- column on this exact table (invoice_type, batch_type, status) uses
-- plain TEXT, and where the value set needs to be fixed, a CHECK
-- constraint is used instead (e.g. invoice_sequences.invoice_type CHAR(1)
-- CHECK (invoice_type IN ('P','S')) in the invoice-numbering migration).
-- Matching that established convention here, not introducing an ENUM
-- because it looks cleaner in isolation.
ALTER TABLE public.invoice_batch
ADD COLUMN IF NOT EXISTS occurrence_semantics TEXT;

ALTER TABLE public.invoice_batch
DROP CONSTRAINT IF EXISTS chk_invoice_batch_occurrence_semantics;

ALTER TABLE public.invoice_batch
ADD CONSTRAINT chk_invoice_batch_occurrence_semantics
  CHECK (occurrence_semantics IS NULL OR occurrence_semantics IN ('GLOBAL', 'CATEGORY'));

COMMENT ON COLUMN public.invoice_batch.occurrence_semantics IS
  'Sprint 1.7 category-aware occurrence: ''GLOBAL'' or ''CATEGORY''. NULL for every batch created before this feature existed — NULL is the permanent, correct "legacy GLOBAL" marker for those rows and must never be backfilled to a non-NULL value (see Sprint 1.7H). New batches will set this explicitly once the batch-creation flow is updated in a future sprint; this migration does not populate it for any row, existing or otherwise.';
