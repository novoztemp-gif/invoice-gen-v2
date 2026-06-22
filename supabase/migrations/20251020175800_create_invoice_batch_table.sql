-- Create invoice_batch table
CREATE TABLE IF NOT EXISTS public.invoice_batch (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    issuing_company_id UUID REFERENCES public.issuing_companies(id) ON DELETE CASCADE,
    receiving_company_id UUID REFERENCES public.receiving_companies(id) ON DELETE CASCADE,
    transport_mode TEXT NOT NULL,
    vehicle_number TEXT NOT NULL,
    date_of_supply DATE NOT NULL,
    invoice_date_from DATE NOT NULL,
    invoice_date_to DATE NOT NULL,
    threshold_limit NUMERIC(15, 2) NOT NULL,
    total_amount NUMERIC(15, 2) NOT NULL,
    status TEXT,
    sheet_link TEXT,
    pdf_link TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()),
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

-- Create index for faster queries
CREATE INDEX idx_invoice_batch_created_by ON public.invoice_batch(created_by);
CREATE INDEX idx_invoice_batch_status ON public.invoice_batch(status);
CREATE INDEX idx_invoice_batch_date_range ON public.invoice_batch(invoice_date_from, invoice_date_to);

-- Enable Row Level Security
ALTER TABLE public.invoice_batch ENABLE ROW LEVEL SECURITY;

-- Create RLS policies - Allow all authenticated users
CREATE POLICY "Allow authenticated users to view all invoice batches"
    ON public.invoice_batch
    FOR SELECT
    TO authenticated
    USING (true);

CREATE POLICY "Allow authenticated users to insert invoice batches"
    ON public.invoice_batch
    FOR INSERT
    TO authenticated
    WITH CHECK (true);

CREATE POLICY "Allow authenticated users to update invoice batches"
    ON public.invoice_batch
    FOR UPDATE
    TO authenticated
    USING (true)
    WITH CHECK (true);

CREATE POLICY "Allow authenticated users to delete invoice batches"
    ON public.invoice_batch
    FOR DELETE
    TO authenticated
    USING (true);

-- Add comment to table
COMMENT ON TABLE public.invoice_batch IS 'Stores invoice batch information for bulk invoice generation';
