-- Sample data for testing the invoice generator

-- Insert sample issuing companies
INSERT INTO issuing_companies (
  company_name, 
  address, 
  gstin, 
  phone, 
  bank_account_name, 
  bank_name, 
  account_number, 
  ifsc_code, 
  pan
) VALUES 
(
  'ABC Industries Pvt Ltd',
  '123 Industrial Area, Phase 2, Mumbai, Maharashtra - 400001',
  '27AABCT1234A1Z5',
  '+91-9876543210',
  'ABC Industries Pvt Ltd',
  'State Bank of India',
  '12345678901234',
  'SBIN0001234',
  'AABCT1234A'
),
(
  'TechCorp Solutions',
  '45 Tech Park, Whitefield, Bangalore, Karnataka - 560066',
  '29AATCT5678B1Z3',
  '+91-9988776655',
  'TechCorp Solutions',
  'HDFC Bank',
  '98765432109876',
  'HDFC0001234',
  'AATCT5678B'
);

-- Insert sample receiving companies
INSERT INTO receiving_companies (
  company_name, 
  address, 
  gstin, 
  pan, 
  state
) VALUES 
(
  'XYZ Corporation Ltd',
  '456 Business Park, Electronic City, Bangalore, Karnataka - 560100',
  '29XYZCO5678B1Z3',
  'XYZCO5678B',
  'Karnataka'
),
(
  'BuildRight Constructions',
  '789 Commercial Complex, Bandra, Mumbai, Maharashtra - 400050',
  '27BLDRT9876C1Z5',
  'BLDRT9876C',
  'Maharashtra'
);

-- Insert sample products
INSERT INTO products (
  product_name, 
  hsn_code, 
  unit_of_measure
) VALUES 
('Steel Rods (8mm)', '72142000', 'MT'),
('Steel Rods (12mm)', '72142000', 'MT'),
('Cement (OPC 53 Grade)', '25232900', 'Bags'),
('Sand (M-Sand)', '25051000', 'Tonnes'),
('Bricks (Red Clay)', '69041000', 'Pieces'),
('Concrete Mix', '38249090', 'Cubic Meters'),
('Paint (Exterior)', '32099090', 'Liters');
