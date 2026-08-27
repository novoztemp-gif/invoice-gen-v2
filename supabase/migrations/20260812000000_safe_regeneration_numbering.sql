-- Sprint 1.6E — Root Cause D fix: safe regeneration numbering.
--
-- Problem (Sprint 1.6D audit): commit_invoice_batch_with_sequences always
-- allocated a brand-new range from invoice_sequences.last_sequence_number,
-- even when the caller was simply regenerating a batch whose own previous
-- invoices were about to be deleted and replaced. Since invoice_sequences
-- is never decremented by that delete, every regeneration permanently
-- advanced the sequence and orphaned the batch's previous numbers.
--
-- Fix: while still holding the same FOR UPDATE lock on invoice_sequences
-- used for allocation, inspect the regenerating batch's CURRENT invoices
-- (for this exact company+financial_year+invoice_type prefix) before
-- deleting them. If they form a contiguous block whose max is exactly the
-- current last_sequence_number (i.e. this batch owns the true trailing
-- end of the sequence — no other batch consumed a number after it) AND
-- the invoice count is unchanged, the batch safely reuses its own
-- previous range and last_sequence_number is left untouched. Otherwise
-- (first-ever generation, another batch consumed higher numbers since,
-- or the invoice count changed) a fresh range is allocated exactly as
-- before Sprint 1.6E — no behavior change for those cases.
--
-- The batch's old invoices are now deleted INSIDE this function (after
-- the above inspection, still under the same lock) rather than by the
-- caller beforehand — this is what makes the whole
-- inspect -> decide -> delete -> insert -> (maybe) advance sequence
-- operation a single atomic unit, safe under concurrent regeneration of
-- the same batch and consistent on failure (a failure anywhere in this
-- function rolls back the delete too, so a failed regeneration leaves the
-- batch's PREVIOUS invoices intact rather than empty).
--
-- Function signature is unchanged — no caller needs to change how it
-- invokes this RPC.

CREATE OR REPLACE FUNCTION public.commit_invoice_batch_with_sequences(
    p_batch_id UUID,
    p_issuing_company_id UUID,
    p_financial_year TEXT,
    p_invoice_type CHAR(1),
    p_invoices JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_clean_fy TEXT;
    v_abbreviation VARCHAR(10);
    v_prefix TEXT;
    v_start_seq BIGINT;
    v_inv_count INT;
    v_i INT;
    v_inv JSONB;
    v_assigned_number TEXT;
    v_seq_num BIGINT;
    v_inserted_invoices JSONB := '[]'::jsonb;
    v_old_min_seq BIGINT;
    v_old_max_seq BIGINT;
    v_old_count INT;
    v_reuse_trailing_range BOOLEAN := FALSE;
BEGIN
    -- 1. Validate Input Parameters
    IF p_invoice_type NOT IN ('P', 'S') THEN
        RAISE EXCEPTION 'Invalid Invoice Type: %. Expected ''P'' (Purchase) or ''S'' (Sales).', p_invoice_type;
    END IF;

    -- Canonical FY normalization check
    v_clean_fy := p_financial_year;
    IF v_clean_fy ~ '^FY' THEN
        v_clean_fy := SUBSTRING(v_clean_fy FROM 3);
    END IF;

    IF NOT (v_clean_fy ~ '^(20|21)\d{2}-\d{2}$') THEN
        RAISE EXCEPTION 'Invalid Financial Year format: %. Expected format: YYYY-YY (e.g. 2026-27)', p_financial_year;
    END IF;

    -- 2. Fetch issuing company abbreviation
    SELECT abbreviation INTO v_abbreviation
    FROM public.issuing_companies
    WHERE id = p_issuing_company_id;

    IF v_abbreviation IS NULL OR v_abbreviation = '' THEN
        RAISE EXCEPTION 'Issuing company abbreviation is missing or empty.';
    END IF;

    v_abbreviation := UPPER(v_abbreviation);
    v_prefix := v_abbreviation || '-' || v_clean_fy || '-' || p_invoice_type;
    v_inv_count := jsonb_array_length(p_invoices);

    -- 3. Lock & Upsert sequence row for atomic concurrency control within this transaction
    INSERT INTO public.invoice_sequences (issuing_company_id, financial_year, invoice_type, last_sequence_number)
    VALUES (p_issuing_company_id, v_clean_fy, p_invoice_type, 0)
    ON CONFLICT (issuing_company_id, financial_year, invoice_type) DO NOTHING;

    -- Exclusive FOR UPDATE lock — held for the rest of this function, so
    -- the inspect/decide/delete/insert/advance sequence below is one
    -- atomic unit with respect to any other commit for this exact
    -- company+financial_year+invoice_type.
    SELECT last_sequence_number INTO v_start_seq
    FROM public.invoice_sequences
    WHERE issuing_company_id = p_issuing_company_id
      AND financial_year = v_clean_fy
      AND invoice_type = p_invoice_type
    FOR UPDATE;

    -- 4. Sprint 1.6E — Root Cause D: inspect this batch's CURRENT
    -- invoices for this exact prefix (still present — nothing has
    -- deleted them yet) while still holding the lock above.
    SELECT
        MIN(substring(invoice_number FROM '(\d+)$')::BIGINT),
        MAX(substring(invoice_number FROM '(\d+)$')::BIGINT),
        COUNT(*)
    INTO v_old_min_seq, v_old_max_seq, v_old_count
    FROM public.invoice
    WHERE invoice_batch_id = p_batch_id
      AND invoice_number LIKE (v_prefix || '-%');

    -- Safe trailing-range reuse iff ALL of the following hold:
    --   - this batch already has invoices under this exact prefix;
    --   - they form a CONTIGUOUS block (max - min + 1 = count — no
    --     gaps, so it is genuinely one clean range);
    --   - that block's max is EXACTLY the current last_sequence_number
    --     — this batch owns the true trailing end of the sequence, so
    --     no other batch has consumed any number after it;
    --   - the regenerated invoice count is UNCHANGED — reusing a range
    --     of a different size could overlap whatever immediately
    --     follows it (if growing) or permanently strand numbers within
    --     this same range (if shrinking); a fresh allocation is the
    --     only safe choice once the count changes, exactly like a
    --     first-ever generation.
    IF v_old_count IS NOT NULL
       AND v_old_count > 0
       AND v_old_count = v_inv_count
       AND (v_old_max_seq - v_old_min_seq + 1) = v_old_count
       AND v_old_max_seq = v_start_seq
    THEN
        v_reuse_trailing_range := TRUE;
        v_start_seq := v_old_min_seq - 1;
    END IF;

    -- 5. Replace this batch's own invoices. Safe here — everything
    -- needed from the old rows was already captured above, under the
    -- same lock, before they are removed.
    DELETE FROM public.invoice WHERE invoice_batch_id = p_batch_id;

    IF v_inv_count = 0 THEN
        RETURN '[]'::jsonb;
    END IF;

    -- 6. Loop through invoice JSON objects, assign sequence, insert into public.invoice table
    FOR v_i IN 0..(v_inv_count - 1) LOOP
        v_inv := p_invoices->v_i;
        v_seq_num := v_start_seq + v_i + 1;
        v_assigned_number := v_prefix || '-' || LPAD(v_seq_num::text, 7, '0');

        -- Insert invoice into public.invoice using full production schema
        INSERT INTO public.invoice (
            invoice_batch_id,
            invoice_number,
            invoice_date,
            products,
            total_amount,
            status,
            batch_type,
            pdf_link,
            transport_mode,
            vehicle_number,
            date_of_supply,
            is_edited,
            edited_at
        ) VALUES (
            p_batch_id,
            v_assigned_number,
            (v_inv->>'invoice_date')::DATE,
            v_inv->'products',
            (v_inv->>'total_amount')::NUMERIC,
            COALESCE(v_inv->>'status', 'generated'),
            COALESCE(v_inv->>'batch_type', CASE WHEN p_invoice_type = 'P' THEN 'PURCHASE' ELSE 'SALES' END),
            v_inv->>'pdf_link',
            v_inv->>'transport_mode',
            v_inv->>'vehicle_number',
            CASE WHEN (v_inv->>'date_of_supply') IS NOT NULL AND (v_inv->>'date_of_supply') <> '' THEN (v_inv->>'date_of_supply')::DATE ELSE NULL END,
            COALESCE((v_inv->>'is_edited')::BOOLEAN, false),
            CASE WHEN (v_inv->>'edited_at') IS NOT NULL AND (v_inv->>'edited_at') <> '' THEN (v_inv->>'edited_at')::TIMESTAMPTZ ELSE NULL END
        );

        v_inserted_invoices := v_inserted_invoices || jsonb_build_object(
            'invoice_number', v_assigned_number,
            'sequence_number', v_seq_num
        );
    END LOOP;

    -- 7. Only advance the counter when new numbers were actually
    -- consumed. Reusing the exact same trailing range leaves
    -- last_sequence_number exactly as it was — this is the fix: a
    -- same-count immediate regeneration no longer advances the global
    -- sequence at all.
    IF NOT v_reuse_trailing_range THEN
        UPDATE public.invoice_sequences
        SET last_sequence_number = v_start_seq + v_inv_count,
            updated_at = now()
        WHERE issuing_company_id = p_issuing_company_id
          AND financial_year = v_clean_fy
          AND invoice_type = p_invoice_type;
    END IF;

    RETURN v_inserted_invoices;
EXCEPTION
    WHEN UNIQUE_VIOLATION THEN
        RAISE EXCEPTION 'Invoice number collision detected. Invoice generation has been rolled back. Please retry.';
END;
$$;
