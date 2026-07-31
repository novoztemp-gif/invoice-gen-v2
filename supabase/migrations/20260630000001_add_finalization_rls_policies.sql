-- Fix RLS policy on public.invoice to handle NULL batch_status and support UPSERT (USING + WITH CHECK)
DROP POLICY IF EXISTS "Prevent updates to invoices in finalized batches" ON public.invoice;

CREATE POLICY "Prevent updates to invoices in finalized batches"
    ON public.invoice
    FOR UPDATE
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.invoice_batch
            WHERE public.invoice_batch.id = public.invoice.invoice_batch_id
            AND (public.invoice_batch.batch_status IS NULL OR public.invoice_batch.batch_status != 'FINALIZED')
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.invoice_batch
            WHERE public.invoice_batch.id = public.invoice.invoice_batch_id
            AND (public.invoice_batch.batch_status IS NULL OR public.invoice_batch.batch_status != 'FINALIZED')
        )
    );
