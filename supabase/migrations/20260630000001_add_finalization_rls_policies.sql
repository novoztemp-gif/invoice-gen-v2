-- Add RLS policy to prevent updating invoices in a FINALIZED batch
CREATE POLICY "Prevent updates to invoices in finalized batches"
    ON public.invoice
    FOR UPDATE
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.invoice_batch
            WHERE public.invoice_batch.id = public.invoice.invoice_batch_id
            AND public.invoice_batch.batch_status != 'FINALIZED'
        )
    );
