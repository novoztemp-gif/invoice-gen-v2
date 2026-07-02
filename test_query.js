const fs = require("fs");
const env = fs.readFileSync(".env.local", "utf8");
const envVars = Object.fromEntries(
  env
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("=")),
);

const { createClient } = require("@supabase/supabase-js");

const supabaseUrl = envVars.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = envVars.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function run() {
  const batchId = "ecdf8319-9a3b-4134-a292-9365ff25e50d";

  const { data: batch, error: batchError } = await supabase
    .from("invoice_batch")
    .select(`
      *,
      issuing_company:issuing_company_id (
        id, company_name, gstin, pan, state, state_code, address,
        bank_name, account_number, ifsc_code, branch_name
      )
    `)
    .eq("id", batchId)
    .single();

  console.log("OLD BATCH QUERY ERROR:", batchError);

  const { data: batch2, error: batchError2 } = await supabase
    .from("invoice_batch")
    .select(`
      *,
      issuing_companies (
        id, company_name, gstin, pan, state, state_code, address,
        bank_name, account_number, ifsc_code, branch_name
      )
    `)
    .eq("id", batchId)
    .single();

  console.log("NEW BATCH QUERY ERROR:", batchError2);
}

run();
