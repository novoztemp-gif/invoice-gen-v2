-- Create invoice table
CREATE TABLE IF NOT EXISTS public.invoice (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    invoice_batch_id UUID NOT NULL,
    invoice_number TEXT NOT NULL UNIQUE,
    invoice_date DATE NOT NULL,
    products JSONB NOT NULL, -- Array of {product_id, product_name, hsn_code, quantity, rate, amount}
    total_amount NUMERIC(15, 2) NOT NULL,
    status TEXT,
    sheet_link TEXT,
    pdf_link TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW())
);

-- Create indexes for faster queries
CREATE INDEX idx_invoice_batch_id ON public.invoice(invoice_batch_id);
CREATE INDEX idx_invoice_number ON public.invoice(invoice_number);
CREATE INDEX idx_invoice_date ON public.invoice(invoice_date);
CREATE INDEX idx_invoice_status ON public.invoice(status);
CREATE INDEX idx_invoice_products ON public.invoice USING GIN(products);

-- Enable Row Level Security
ALTER TABLE public.invoice ENABLE ROW LEVEL SECURITY;

-- Create RLS policies - Allow all authenticated users
CREATE POLICY "Allow authenticated users to view all invoices"
    ON public.invoice
    FOR SELECT
    TO authenticated
    USING (true);

CREATE POLICY "Allow authenticated users to insert invoices"
    ON public.invoice
    FOR INSERT
    TO authenticated
    WITH CHECK (true);

CREATE POLICY "Allow authenticated users to update invoices"
    ON public.invoice
    FOR UPDATE
    TO authenticated
    USING (true)
    WITH CHECK (true);

CREATE POLICY "Allow authenticated users to delete invoices"
    ON public.invoice
    FOR DELETE
    TO authenticated
    USING (true);

-- Add comment to table
COMMENT ON TABLE public.invoice IS 'Stores individual invoices generated from invoice batches';
COMMENT ON COLUMN public.invoice.products IS 'JSONB array containing product details: [{product_id, product_name, hsn_code, quantity, rate, amount}]';
