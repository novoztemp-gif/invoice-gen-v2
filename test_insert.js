const { createClient } = require("@supabase/supabase-js");
// Hardcode the keys for testing purposes if possible, but actually we can just read them from .env.local manually
const fs = require("fs");
const env = fs.readFileSync(".env.local", "utf8");
let url = "",
  key = "";
for (const line of env.split("\n")) {
  if (line.startsWith("NEXT_PUBLIC_SUPABASE_URL="))
    url = line.split("=")[1].trim();
  if (line.startsWith("NEXT_PUBLIC_SUPABASE_ANON_KEY="))
    key = line.split("=")[1].trim();
}
const supabase = createClient(url, key);

async function check() {
  const { data: batchData, error: batchError } = await supabase
    .from("invoice_batch")
    .select("*")
    .limit(1);
  const { data: invoiceData, error: invoiceError } = await supabase
    .from("invoice")
    .select("*")
    .limit(1);
  console.log(
    "Batch Keys:",
    batchData && batchData.length > 0 ? Object.keys(batchData[0]) : null,
    batchError,
  );
  console.log(
    "Invoice Keys:",
    invoiceData && invoiceData.length > 0 ? Object.keys(invoiceData[0]) : null,
    invoiceError,
  );
}
check();
