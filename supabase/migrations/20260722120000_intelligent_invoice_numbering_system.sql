-- 1. Add abbreviation column to issuing_companies
ALTER TABLE public.issuing_companies 
ADD COLUMN IF NOT EXISTS abbreviation VARCHAR(10);

-- Automatically populate unique abbreviations for all existing companies
DO $$
DECLARE
    rec RECORD;
    v_base TEXT;
    v_cand TEXT;
    v_counter INT;
    v_exists BOOLEAN;
BEGIN
    FOR rec IN 
        SELECT id, company_name, abbreviation 
        FROM public.issuing_companies 
        ORDER BY created_at ASC, id ASC 
    LOOP
        -- If abbreviation already exists and is non-empty, clean it
        IF rec.abbreviation IS NOT NULL AND rec.abbreviation <> '' THEN
            v_base := UPPER(REGEXP_REPLACE(rec.abbreviation, '[^A-Za-z0-9]', '', 'g'));
        ELSE
            v_base := UPPER(REGEXP_REPLACE(rec.company_name, '[^A-Za-z0-9]', '', 'g'));
        END IF;

        IF v_base IS NULL OR v_base = '' THEN
            v_base := 'IC';
        END IF;

        -- Cap base string at 8 characters to allow room for numeric deduplication suffix
        IF LENGTH(v_base) > 8 THEN
            v_base := SUBSTRING(v_base FROM 1 FOR 8);
        END IF;

        v_cand := v_base;
        v_counter := 1;

        -- Loop until a unique candidate abbreviation is found
        LOOP
            SELECT EXISTS (
                SELECT 1 FROM public.issuing_companies 
                WHERE abbreviation = v_cand AND id <> rec.id
            ) INTO v_exists;

            EXIT WHEN NOT v_exists;

            v_cand := SUBSTRING(v_base FROM 1 FOR 7) || v_counter::text;
            v_counter := v_counter + 1;
        END LOOP;

        UPDATE public.issuing_companies 
        SET abbreviation = v_cand 
        WHERE id = rec.id;
    END LOOP;
END $$;

-- Add uppercase alphanumeric constraint on issuing_companies.abbreviation
ALTER TABLE public.issuing_companies DROP CONSTRAINT IF EXISTS chk_issuing_companies_abbreviation;
ALTER TABLE public.issuing_companies ADD CONSTRAINT chk_issuing_companies_abbreviation 
CHECK (abbreviation ~ '^[A-Z0-9]{1,10}$');

-- Add UNIQUE constraint on issuing_companies.abbreviation safely
ALTER TABLE public.issuing_companies DROP CONSTRAINT IF EXISTS uq_issuing_companies_abbreviation;
ALTER TABLE public.issuing_companies ADD CONSTRAINT uq_issuing_companies_abbreviation 
UNIQUE (abbreviation);

-- 2. Create invoice_sequences table with strict FY format check (2000-2199)
CREATE TABLE IF NOT EXISTS public.invoice_sequences (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    issuing_company_id UUID NOT NULL
        REFERENCES public.issuing_companies(id)
        ON DELETE CASCADE,
    financial_year TEXT NOT NULL
        CHECK (financial_year ~ '^(20|21)\d{2}-\d{2}$'),
    invoice_type CHAR(1) NOT NULL
        CHECK (invoice_type IN ('P','S')),
    last_sequence_number BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_invoice_sequence
    UNIQUE
    (
        issuing_company_id,
        financial_year,
        invoice_type
    )
);

CREATE INDEX IF NOT EXISTS idx_invoice_sequences_company
ON public.invoice_sequences(issuing_company_id);

CREATE INDEX IF NOT EXISTS idx_invoice_sequences_financial_year
ON public.invoice_sequences(financial_year);

-- 3. Add UNIQUE constraint on invoice.invoice_number column
ALTER TABLE public.invoice DROP CONSTRAINT IF EXISTS uq_invoice_number;
ALTER TABLE public.invoice ADD CONSTRAINT uq_invoice_number UNIQUE (invoice_number);

-- 4. Secure RLS & Permissions for invoice_sequences
-- Normal users (authenticated / anon) can only SELECT sequence rows (for UI preview).
-- Direct INSERT/UPDATE/DELETE is revoked. Only SECURITY DEFINER RPCs can modify sequence counters.
ALTER TABLE public.invoice_sequences ENABLE ROW LEVEL SECURITY;

REVOKE INSERT, UPDATE, DELETE ON public.invoice_sequences FROM authenticated, anon;
GRANT SELECT ON public.invoice_sequences TO authenticated, anon;

DROP POLICY IF EXISTS "Allow all operations for authenticated users on invoice_sequences" ON public.invoice_sequences;
DROP POLICY IF EXISTS "Allow all for anon on invoice_sequences" ON public.invoice_sequences;
DROP POLICY IF EXISTS "Allow SELECT for authenticated users on invoice_sequences" ON public.invoice_sequences;
DROP POLICY IF EXISTS "Allow SELECT for anon on invoice_sequences" ON public.invoice_sequences;

CREATE POLICY "Allow SELECT for authenticated users on invoice_sequences" 
ON public.invoice_sequences FOR SELECT TO authenticated USING (true);

CREATE POLICY "Allow SELECT for anon on invoice_sequences" 
ON public.invoice_sequences FOR SELECT TO anon USING (true);

-- 5. Production-Grade Atomic Stored Procedure (RPC)
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
    v_start_seq BIGINT;
    v_inv_count INT;
    v_i INT;
    v_inv JSONB;
    v_assigned_number TEXT;
    v_seq_num BIGINT;
    v_inserted_invoices JSONB := '[]'::jsonb;
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
    v_inv_count := jsonb_array_length(p_invoices);

    IF v_inv_count = 0 THEN
        RETURN '[]'::jsonb;
    END IF;

    -- 3. Lock & Upsert sequence row for atomic concurrency control within this transaction
    INSERT INTO public.invoice_sequences (issuing_company_id, financial_year, invoice_type, last_sequence_number)
    VALUES (p_issuing_company_id, v_clean_fy, p_invoice_type, 0)
    ON CONFLICT (issuing_company_id, financial_year, invoice_type) DO NOTHING;

    -- Exclusive FOR UPDATE lock
    SELECT last_sequence_number INTO v_start_seq
    FROM public.invoice_sequences
    WHERE issuing_company_id = p_issuing_company_id
      AND financial_year = v_clean_fy
      AND invoice_type = p_invoice_type
    FOR UPDATE;

    -- 4. Loop through invoice JSON objects, assign sequence, insert into public.invoice table
    FOR v_i IN 0..(v_inv_count - 1) LOOP
        v_inv := p_invoices->v_i;
        v_seq_num := v_start_seq + v_i + 1;
        v_assigned_number := v_abbreviation || '-' || v_clean_fy || '-' || p_invoice_type || '-' || LPAD(v_seq_num::text, 7, '0');

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

    -- 5. Update sequence count ONLY AFTER all invoices successfully inserted
    UPDATE public.invoice_sequences
    SET last_sequence_number = v_start_seq + v_inv_count,
        updated_at = now()
    WHERE issuing_company_id = p_issuing_company_id
      AND financial_year = v_clean_fy
      AND invoice_type = p_invoice_type;

    RETURN v_inserted_invoices;
EXCEPTION
    WHEN UNIQUE_VIOLATION THEN
        RAISE EXCEPTION 'Invoice number collision detected. Invoice generation has been rolled back. Please retry.';
END;
$$;
