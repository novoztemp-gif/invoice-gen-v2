const { createClient } = require("@supabase/supabase-js");
require("dotenv").config({ path: ".env.local" });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
);

async function check() {
  const { data, error } = await supabase
    .from("receiving_companies")
    .select("*");
  console.log("Error:", error);
  console.log("Data:", data);
}
check();
