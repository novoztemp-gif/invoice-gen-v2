-- Create suppliers table for Supplier Master
CREATE TABLE IF NOT EXISTS public.suppliers (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    company_name TEXT NOT NULL,
    contact_person TEXT,
    mobile_number TEXT,
    email TEXT,
    gstin TEXT,
    pan TEXT,
    address TEXT,
    address_line_2 TEXT,
    city TEXT,
    state TEXT,
    pincode TEXT,
    country TEXT DEFAULT 'India',
    supplier_code TEXT,
    status TEXT DEFAULT 'Active',
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- Create indexes for performance optimization
CREATE INDEX IF NOT EXISTS idx_suppliers_company_name ON public.suppliers (company_name);
CREATE INDEX IF NOT EXISTS idx_suppliers_gstin ON public.suppliers (gstin);
CREATE INDEX IF NOT EXISTS idx_suppliers_status ON public.suppliers (status);

-- Enable Row Level Security
ALTER TABLE public.suppliers ENABLE ROW LEVEL SECURITY;

-- Allow authenticated and anon users to perform operations
CREATE POLICY "Allow all operations for authenticated users on suppliers" 
ON public.suppliers
FOR ALL 
TO authenticated 
USING (true) 
WITH CHECK (true);

CREATE POLICY "Allow read for anon on suppliers" 
ON public.suppliers
FOR SELECT 
TO anon 
USING (true);

CREATE POLICY "Allow all for anon on suppliers" 
ON public.suppliers
FOR ALL 
TO anon 
USING (true) 
WITH CHECK (true);
