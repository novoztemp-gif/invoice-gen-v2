-- Two related numbering fixes found during a full audit of the Purchase
-- edit path:
--
-- 1. Edit-time new-invoice numbering (product-quantity-conservation's
--    last-resort "create a brand-new invoice" path) used to compute its
--    next invoice number by scanning public.invoice for the current max
--    and adding 1 (findMaxInvoiceSequenceForPrefix), entirely bypassing
--    invoice_sequences and its FOR UPDATE lock. Two edits landing at the
--    same moment on batches sharing a company+financial_year+invoice_type
--    could compute the same "next" number — invoice_number's UNIQUE
--    constraint would catch the collision (a clean database error, not
--    silent corruption), but it's a real, avoidable race window. This adds
--    an atomic reservation RPC, mirroring the exact same lock/self-heal
--    pattern commit_invoice_batch_with_sequences already uses, so edit-time
--    numbering goes through the same serialized counter as generation does.
--
-- 2. Because that edit-time path never updated invoice_sequences, the
--    counter went stale (behind the true max) the moment an edit created a
--    new invoice. delete_invoice_batch_and_reclaim_sequence compares a
--    batch's own max directly against that counter to decide whether it's
--    safe to roll back — once they no longer match, it conservatively
--    refuses to reclaim even when it legitimately could, leaving the next
--    invoice number higher than necessary after such a batch is deleted.
--    Fixed the same way commit_invoice_batch_with_sequences already
--    self-heals: reconcile the counter against the TRUE max for this exact
--    prefix (under the same lock) before comparing, so a stale counter can
--    never block a reclaim that's actually safe. Fix #1 above makes this
--    staleness far less likely going forward, but this closes the gap for
--    any batch that still has an edit-created invoice from before it, and
--    for any other reason the counter could ever drift behind reality.

CREATE OR REPLACE FUNCTION public.reserve_invoice_sequence_range(
    p_issuing_company_id UUID,
    p_financial_year TEXT,
    p_invoice_type CHAR(1),
    p_count INT
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
    v_start_seq BIGINT;
    v_real_max_seq BIGINT;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Unauthorized';
    END IF;

    IF p_invoice_type NOT IN ('P', 'S') THEN
        RAISE EXCEPTION 'Invalid Invoice Type: %. Expected ''P'' (Purchase) or ''S'' (Sales).', p_invoice_type;
    END IF;

    IF p_count IS NULL OR p_count <= 0 THEN
        RAISE EXCEPTION 'Invalid reservation count: %.', p_count;
    END IF;

    v_clean_fy := p_financial_year;
    IF v_clean_fy ~ '^FY' THEN
        v_clean_fy := SUBSTRING(v_clean_fy FROM 3);
    END IF;

    IF NOT (v_clean_fy ~ '^(20|21)\d{2}-\d{2}$') THEN
        RAISE EXCEPTION 'Invalid Financial Year format: %. Expected format: YYYY-YY (e.g. 2026-27)', p_financial_year;
    END IF;

    SELECT abbreviation INTO v_abbreviation
    FROM public.issuing_companies
    WHERE id = p_issuing_company_id;

    IF v_abbreviation IS NULL OR v_abbreviation = '' THEN
        RAISE EXCEPTION 'Issuing company abbreviation is missing or empty.';
    END IF;

    v_abbreviation := UPPER(v_abbreviation);
    v_prefix := v_abbreviation || '-' || v_clean_fy || '-' || p_invoice_type;

    -- Same lock commit_invoice_batch_with_sequences uses — a reservation
    -- can never race a concurrent generation, delete/reclaim, or another
    -- reservation for this exact company+financial_year+invoice_type.
    INSERT INTO public.invoice_sequences (issuing_company_id, financial_year, invoice_type, last_sequence_number)
    VALUES (p_issuing_company_id, v_clean_fy, p_invoice_type, 0)
    ON CONFLICT (issuing_company_id, financial_year, invoice_type) DO NOTHING;

    SELECT last_sequence_number INTO v_start_seq
    FROM public.invoice_sequences
    WHERE issuing_company_id = p_issuing_company_id
      AND financial_year = v_clean_fy
      AND invoice_type = p_invoice_type
    FOR UPDATE;

    -- Same self-heal as commit_invoice_batch_with_sequences: reconcile
    -- against the TRUE max invoice_number for this exact prefix before
    -- handing anything out, so a reservation can never collide with a
    -- number that already exists.
    SELECT MAX(substring(invoice_number FROM '(\d+)$')::BIGINT)
    INTO v_real_max_seq
    FROM public.invoice
    WHERE invoice_number LIKE (v_prefix || '-%');

    IF v_real_max_seq IS NOT NULL AND v_real_max_seq > v_start_seq THEN
        v_start_seq := v_real_max_seq;
    END IF;

    UPDATE public.invoice_sequences
    SET last_sequence_number = v_start_seq + p_count,
        updated_at = now()
    WHERE issuing_company_id = p_issuing_company_id
      AND financial_year = v_clean_fy
      AND invoice_type = p_invoice_type;

    -- Caller uses v_start_seq+1 .. v_start_seq+p_count. Any reserved
    -- numbers it doesn't end up using are simply never assigned to an
    -- invoice — a small permanent gap, never a collision.
    RETURN v_start_seq;
END;
$$;

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
    v_real_max_seq BIGINT;
    v_reclaimed BOOLEAN := FALSE;
BEGIN
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

    -- Lock the sequence counter row for this exact
    -- company+financial_year+invoice_type -- the same lock
    -- commit_invoice_batch_with_sequences and reserve_invoice_sequence_range
    -- take, so a delete can never race a concurrent generation or
    -- reservation for this same prefix.
    SELECT last_sequence_number INTO v_current_last_seq
    FROM public.invoice_sequences
    WHERE issuing_company_id = v_issuing_company_id
      AND financial_year = v_clean_fy
      AND invoice_type = v_invoice_type
    FOR UPDATE;

    -- Hotfix — self-heal the counter against the TRUE max for this exact
    -- prefix before comparing, mirroring commit_invoice_batch_with_sequences'
    -- own self-heal. Without this, any drift that left the stored counter
    -- behind reality (e.g. an edit that created a new invoice through a
    -- path that didn't yet advance this counter) made the ownership
    -- comparison below fail even when this batch genuinely does own the
    -- trailing end, silently skipping a reclaim that was actually safe.
    IF v_current_last_seq IS NOT NULL THEN
        SELECT MAX(substring(invoice_number FROM '(\d+)$')::BIGINT)
        INTO v_real_max_seq
        FROM public.invoice
        WHERE invoice_number LIKE (v_prefix || '-%');

        IF v_real_max_seq IS NOT NULL AND v_real_max_seq > v_current_last_seq THEN
            v_current_last_seq := v_real_max_seq;
            UPDATE public.invoice_sequences
            SET last_sequence_number = v_current_last_seq,
                updated_at = now()
            WHERE issuing_company_id = v_issuing_company_id
              AND financial_year = v_clean_fy
              AND invoice_type = v_invoice_type;
        END IF;
    END IF;

    -- This batch's own sequence range under this exact prefix (before
    -- anything is deleted).
    SELECT
        MIN(substring(invoice_number FROM '(\d+)$')::BIGINT),
        MAX(substring(invoice_number FROM '(\d+)$')::BIGINT)
    INTO v_batch_min_seq, v_batch_max_seq
    FROM public.invoice
    WHERE invoice_batch_id = p_batch_id
      AND invoice_number LIKE (v_prefix || '-%');

    -- Reclaim iff this batch owns the true trailing end of the sequence
    -- (its max equals the live, now-reconciled counter) -- always safe:
    -- nothing else can be relying on numbers above it if nothing higher
    -- exists.
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

    -- Delete the batch's invoices and the batch itself, still under the
    -- same lock/transaction as the reclaim decision above.
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
