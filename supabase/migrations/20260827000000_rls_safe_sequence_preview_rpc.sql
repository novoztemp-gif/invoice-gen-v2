-- Root cause fix: InvoiceNumberingService.fetchSequencePreview (the
-- "Invoice Sequence Preview" panel on the generate-invoice pages) used to
-- decide whether ANY real invoice exists for a given company/financial
-- year/invoice type prefix by running a plain client-side SELECT against
-- public.invoice with a `.like()` filter. That table's RLS only grants
-- SELECT to the `authenticated` role (see 20251020175900_create_invoice_table.sql)
-- -- unlike invoice_sequences, which grants SELECT to both `authenticated`
-- AND `anon`. If that browser query ever runs before the Supabase client's
-- auth session has finished hydrating (a real, observed race on page load),
-- it goes out effectively as `anon`, gets silently filtered to zero rows by
-- RLS (no error -- an empty result looks identical to "genuinely no
-- invoices exist"), and the preview shows "Next: 1" even though the batch
-- already has real invoices and a correct, much higher counter value.
--
-- Real generation was never affected by this -- commit_invoice_batch_with_sequences
-- is SECURITY DEFINER and reads/writes public.invoice directly server-side,
-- bypassing RLS entirely, which is exactly why "it previews wrong but
-- generates correctly" was the reported symptom.
--
-- Fix: move the existence/self-heal check itself server-side into this
-- SECURITY DEFINER, read-only RPC -- it mirrors EXACTLY the same forward/
-- backward self-heal decision commit_invoice_batch_with_sequences makes
-- (20260823000000_self_heal_sequence_to_zero_when_empty.sql, steps 3b/3c),
-- just without taking the row lock or writing anything, since this is only
-- ever used for display. Because it's SECURITY DEFINER, it always sees the
-- true state of public.invoice regardless of the calling client's auth
-- timing -- the exact class of bug this migration fixes can't recur here.
CREATE OR REPLACE FUNCTION public.get_invoice_sequence_preview(
    p_issuing_company_id UUID,
    p_financial_year TEXT,
    p_invoice_type CHAR(1)
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_clean_fy TEXT;
    v_abbreviation VARCHAR(10);
    v_prefix TEXT;
    v_stored_seq BIGINT;
    v_real_max_seq BIGINT;
BEGIN
    IF p_invoice_type NOT IN ('P', 'S') THEN
        RETURN 0;
    END IF;

    v_clean_fy := p_financial_year;
    IF v_clean_fy ~ '^FY' THEN
        v_clean_fy := SUBSTRING(v_clean_fy FROM 3);
    END IF;
    IF NOT (v_clean_fy ~ '^(20|21)\d{2}-\d{2}$') THEN
        RETURN 0;
    END IF;

    SELECT abbreviation INTO v_abbreviation
    FROM public.issuing_companies
    WHERE id = p_issuing_company_id;

    IF v_abbreviation IS NULL OR v_abbreviation = '' THEN
        RETURN 0;
    END IF;

    v_abbreviation := UPPER(v_abbreviation);
    v_prefix := v_abbreviation || '-' || v_clean_fy || '-' || p_invoice_type;

    SELECT last_sequence_number INTO v_stored_seq
    FROM public.invoice_sequences
    WHERE issuing_company_id = p_issuing_company_id
      AND financial_year = v_clean_fy
      AND invoice_type = p_invoice_type;

    -- Same real-max scan commit_invoice_batch_with_sequences does under
    -- its lock -- here it's read-only, so no lock is needed.
    SELECT MAX(substring(invoice_number FROM '(\d+)$')::BIGINT)
    INTO v_real_max_seq
    FROM public.invoice
    WHERE invoice_number LIKE (v_prefix || '-%');

    -- Mirrors 3c exactly: zero real invoices anywhere for this prefix means
    -- no stored counter value can possibly be correct except zero.
    IF v_real_max_seq IS NULL THEN
        RETURN 0;
    END IF;

    -- Mirrors 3b: whichever of the stored counter or the real max is
    -- higher is the true current sequence.
    RETURN GREATEST(COALESCE(v_stored_seq, 0), v_real_max_seq);
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_invoice_sequence_preview(UUID, TEXT, CHAR)
TO authenticated, anon;
