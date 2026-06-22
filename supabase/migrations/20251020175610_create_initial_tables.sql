-- Table 1: Issuing Companies (Companies that issue invoices)
CREATE TABLE IF NOT EXISTS issuing_companies (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  company_name TEXT NOT NULL,
  address TEXT NOT NULL,
  gstin TEXT NOT NULL,
  phone TEXT NOT NULL,
  bank_account_name TEXT NOT NULL,
  bank_name TEXT NOT NULL,
  account_number TEXT NOT NULL,
  ifsc_code TEXT NOT NULL,
  pan TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Table 2: Receiving Companies (Companies that receive invoices)
CREATE TABLE IF NOT EXISTS receiving_companies (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  company_name TEXT NOT NULL,
  address TEXT NOT NULL,
  gstin TEXT NOT NULL,
  pan TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Table 3: Products (Product catalog with HSN code and unit)
CREATE TABLE IF NOT EXISTS products (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  product_name TEXT NOT NULL,
  hsn_code TEXT NOT NULL,
  unit_of_measure TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_issuing_companies_name ON issuing_companies(company_name);
CREATE INDEX IF NOT EXISTS idx_issuing_companies_gstin ON issuing_companies(gstin);

CREATE INDEX IF NOT EXISTS idx_receiving_companies_name ON receiving_companies(company_name);
CREATE INDEX IF NOT EXISTS idx_receiving_companies_gstin ON receiving_companies(gstin);

CREATE INDEX IF NOT EXISTS idx_products_name ON products(product_name);
CREATE INDEX IF NOT EXISTS idx_products_hsn ON products(hsn_code);

-- Create updated_at trigger function
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Add triggers to automatically update updated_at timestamp
CREATE TRIGGER update_issuing_companies_updated_at
  BEFORE UPDATE ON issuing_companies
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_receiving_companies_updated_at
  BEFORE UPDATE ON receiving_companies
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_products_updated_at
  BEFORE UPDATE ON products
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Enable Row Level Security (RLS)
ALTER TABLE issuing_companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE receiving_companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;

-- Create policies (adjust based on your authentication requirements)
-- For now, allowing all authenticated users to read and write
CREATE POLICY "Allow all operations for authenticated users" 
  ON issuing_companies 
  FOR ALL 
  TO authenticated 
  USING (true) 
  WITH CHECK (true);

CREATE POLICY "Allow all operations for authenticated users" 
  ON receiving_companies 
  FOR ALL 
  TO authenticated 
  USING (true) 
  WITH CHECK (true);

CREATE POLICY "Allow all operations for authenticated users" 
  ON products 
  FOR ALL 
  TO authenticated 
  USING (true) 
  WITH CHECK (true);
