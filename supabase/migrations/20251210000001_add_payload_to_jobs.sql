-- Add payload field to jobs table
ALTER TABLE jobs ADD COLUMN payload JSONB;