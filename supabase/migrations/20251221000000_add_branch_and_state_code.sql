-- Add branch column to issuing_companies table
ALTER TABLE issuing_companies
ADD COLUMN branch TEXT;

-- Add state_code column to receiving_companies table
ALTER TABLE receiving_companies
ADD COLUMN state_code TEXT;

-- Create indexes for the new columns for better query performance
CREATE INDEX IF NOT EXISTS idx_issuing_companies_branch ON issuing_companies(branch);
CREATE INDEX IF NOT EXISTS idx_receiving_companies_state_code ON receiving_companies(state_code);
