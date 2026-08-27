-- Root cause fix: deleting an invoice batch removes its `invoice` rows and
-- the `invoice_batch` row, but never touches `invoice_sequences.last_sequence_number`
-- -- that counter only ever moves FORWARD (see the self-heal fix in
-- 20260813010000_self_heal_stale_sequence_counter.sql). So deleting even the
-- MOST RECENT batch leaves the counter exactly where it was: the next
-- generated batch still starts from the old high-water mark, as if the
-- deleted invoices still existed. Confirmed as a real report: deleting the
-- latest Purchase batch didn't change the next invoice number at all.
--
-- Both `purchase-invoice-batches/page.tsx` and `invoice-batches/page.tsx`
-- already fetch the batch's issuing_company_id/financial_year/batch_type
-- "for sequence rollback" before deleting -- but never actually used it;
-- the rollback was never implemented. This RPC is that missing piece.
--
-- Fix: an atomic RPC that, under the SAME row lock used by
-- commit_invoice_batch_with_sequences, checks whether this batch's
-- invoices form the TRUE TRAILING END of the sequence (its highest number
-- equals the counter). If so, it's always safe to roll the counter back to
-- just below this batch's lowest number -- nothing else can be relying on
-- those numbers, since nothing higher exists. If this batch is NOT the
-- trailing end (some other, newer batch already claimed higher numbers),
-- the counter is left untouched -- rolling it back in that case would let
-- a future generation reuse numbers that a still-existing invoice already
-- has, causing collisions. Same reasoning as the existing self-heal fix,
-- just the mirror-image direction (backward instead of forward).

CREATE OR REPLACE FUNCTION public.delete_invoice_batch_and_reclaim_sequence(
    p_batch_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_issuing_company_id UUID;
    v_financial_year TEXT;
    v_batch_type TEXT;
    v_invoice_type CHAR(1);
    v_clean_fy TEXT;
    v_abbreviation VARCHAR(10);
    v_prefix TEXT;
    v_batch_min_seq BIGINT;
    v_batch_max_seq BIGINT;
    v_current_last_seq BIGINT;
    v_reclaimed BOOLEAN := FALSE;
BEGIN
    -- 1. Look up the batch's own metadata. If it's already gone, just make
    -- sure any orphaned invoice rows are cleaned up (idempotent) and return
    -- -- nothing to reconcile against without a real batch row.
    SELECT issuing_company_id, financial_year, batch_type
    INTO v_issuing_company_id, v_financial_year, v_batch_type
    FROM public.invoice_batch
    WHERE id = p_batch_id;

    IF v_issuing_company_id IS NULL THEN
        DELETE FROM public.invoice WHERE invoice_batch_id = p_batch_id;
        RETURN jsonb_build_object('reclaimed', false, 'reason', 'batch_not_found');
    END IF;

    v_invoice_type := CASE WHEN v_batch_type = 'PURCHASE' THEN 'P' ELSE 'S' END;

    v_clean_fy := v_financial_year;
    IF v_clean_fy ~ '^FY' THEN
        v_clean_fy := SUBSTRING(v_clean_fy FROM 3);
    END IF;

    SELECT abbreviation INTO v_abbreviation
    FROM public.issuing_companies
    WHERE id = v_issuing_company_id;

    IF v_abbreviation IS NULL OR v_abbreviation = '' THEN
        DELETE FROM public.invoice WHERE invoice_batch_id = p_batch_id;
        DELETE FROM public.invoice_batch WHERE id = p_batch_id;
        RETURN jsonb_build_object('reclaimed', false, 'reason', 'no_abbreviation');
    END IF;

    v_abbreviation := UPPER(v_abbreviation);
    v_prefix := v_abbreviation || '-' || v_clean_fy || '-' || v_invoice_type;

    -- 2. Lock the sequence counter row for this exact
    -- company+financial_year+invoice_type -- the same lock
    -- commit_invoice_batch_with_sequences takes, so a delete can never
    -- race a concurrent generation for this same prefix.
    SELECT last_sequence_number INTO v_current_last_seq
    FROM public.invoice_sequences
    WHERE issuing_company_id = v_issuing_company_id
      AND financial_year = v_clean_fy
      AND invoice_type = v_invoice_type
    FOR UPDATE;

    -- 3. This batch's own sequence range under this exact prefix (before
    -- anything is deleted).
    SELECT
        MIN(substring(invoice_number FROM '(\d+)$')::BIGINT),
        MAX(substring(invoice_number FROM '(\d+)$')::BIGINT)
    INTO v_batch_min_seq, v_batch_max_seq
    FROM public.invoice
    WHERE invoice_batch_id = p_batch_id
      AND invoice_number LIKE (v_prefix || '-%');

    -- 4. Reclaim iff this batch owns the true trailing end of the
    -- sequence (its max equals the live counter) -- see comment above for
    -- why this direction is always safe.
    IF v_batch_max_seq IS NOT NULL
       AND v_current_last_seq IS NOT NULL
       AND v_batch_max_seq = v_current_last_seq
    THEN
        UPDATE public.invoice_sequences
        SET last_sequence_number = v_batch_min_seq - 1,
            updated_at = now()
        WHERE issuing_company_id = v_issuing_company_id
          AND financial_year = v_clean_fy
          AND invoice_type = v_invoice_type;
        v_reclaimed := TRUE;
    END IF;

    -- 5. Delete the batch's invoices and the batch itself, still under
    -- the same lock/transaction as the reclaim decision above.
    DELETE FROM public.invoice WHERE invoice_batch_id = p_batch_id;
    DELETE FROM public.invoice_batch WHERE id = p_batch_id;

    RETURN jsonb_build_object(
        'reclaimed', v_reclaimed,
        'batch_min_seq', v_batch_min_seq,
        'batch_max_seq', v_batch_max_seq,
        'prior_last_seq', v_current_last_seq
    );
END;
$$;
