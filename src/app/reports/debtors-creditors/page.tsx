import { DebtorsCreditorsClient } from "@/components/reports/debtors-creditors/DebtorsCreditorsClient";
import { PartnerCategory } from "@/lib/services/debtors-creditors/types";
import { createClient } from "@/lib/supabase/server";

export default async function DebtorsCreditorsPage() {
  const supabase = await createClient();

  const { data: suppliers } = await supabase
    .from("suppliers")
    .select("id, company_name, category")
    .order("company_name");

  const people = (suppliers ?? []).map((s) => ({
    id: s.id,
    companyName: s.company_name,
    category: (s.category as PartnerCategory) ?? "Meat",
  }));

  return <DebtorsCreditorsClient people={people} />;
}
