const fs = require("fs");
const env = fs.readFileSync(".env.local", "utf8");
const envVars = Object.fromEntries(
  env
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("=");
      return [parts[0].trim(), parts.slice(1).join("=").trim()];
    }),
);

const { createClient } = require("@supabase/supabase-js");

const supabaseUrl = envVars.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = envVars.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function run() {
  const { data, error } = await supabase
    .from("invoice_batch")
    .select("id, batch_type, total_amount, status, created_at")
    .order("created_at", { ascending: false })
    .limit(10);

  if (error) {
    console.error("Error fetching invoice batches:", error);
    return;
  }

  console.log(`Total batches returned: ${data.length}`);
  for (const row of data || []) {
    console.log(
      `ID: ${row.id} | Type: ${row.batch_type} | Total: ${row.total_amount} | Status: ${row.status} | Created: ${row.created_at}`,
    );
  }
}

run();
