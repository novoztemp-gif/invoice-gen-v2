import { DebtorsCreditorsClient } from "@/components/reports/debtors-creditors/DebtorsCreditorsClient";
import { PartnerCategory } from "@/lib/services/debtors-creditors/types";
import { createClient } from "@/lib/supabase/server";
import { fetchAllQueryRows } from "@/lib/supabase/fetchAll";

export default async function DebtorsCreditorsPage() {
  const supabase = await createClient();

  // A plain `.select()` here silently truncates at PostgREST's default
  // 1000-row cap on a large supplier list — the same class of bug fixed
  // on the Suppliers and Receiving Customers list pages.
  const suppliers = await fetchAllQueryRows<{
    id: string;
    company_name: string;
    category: string | null;
  }>((from, to) =>
    supabase
      .from("suppliers")
      .select("id, company_name, category")
      .order("company_name")
      .range(from, to),
  );

  const people = (suppliers ?? []).map((s) => ({
    id: s.id,
    companyName: s.company_name,
    category: (s.category as PartnerCategory) ?? "Meat",
  }));

  return <DebtorsCreditorsClient people={people} />;
}
