-- Create jobs table
CREATE TABLE jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  worker_id UUID,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  metadata JSONB
);

-- Create index on invoice_id for faster lookups
CREATE INDEX idx_jobs_invoice_id ON jobs(invoice_id);

-- Create index on worker_id for faster lookups
CREATE INDEX idx_jobs_worker_id ON jobs(worker_id);

-- Create index on status for faster queries
CREATE INDEX idx_jobs_status ON jobs(status);

-- Enable Row Level Security
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;

-- Policy: Authenticated users can perform all operations
CREATE POLICY "Authenticated users can manage jobs" ON jobs
  FOR ALL
  USING (auth.uid() IS NOT NULL)
  WITH CHECK (auth.uid() IS NOT NULL);
