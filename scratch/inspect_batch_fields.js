const fs = require("fs");
const env = fs.readFileSync(".env.local", "utf8");
const envVars = Object.fromEntries(
  env
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("=")),
);

const { createClient } = require("@supabase/supabase-js");

const supabaseUrl = envVars.NEXT_PUBLIC_SUPABASE_URL.trim();
const supabaseKey = envVars.NEXT_PUBLIC_SUPABASE_ANON_KEY.trim();
const supabase = createClient(supabaseUrl, supabaseKey);

async function run() {
  const { error } = await supabase
    .from("invoice_batch")
    .select("updated_at")
    .limit(1);

  console.log("Querying updated_at column error:", error);
}

run();
