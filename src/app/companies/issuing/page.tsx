import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AddIssuingCompanyDialog } from "@/components/AddIssuingCompanyDialog";
import { IssuingCompaniesTable } from "@/components/IssuingCompaniesTable";

export default async function IssuingCompaniesPage() {
  const supabase = await createClient();

  const { data: companies, error } = await supabase
    .from("issuing_companies")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    return (
      <div>
        <h1 className="text-3xl font-bold text-slate-900 mb-6">
          Issuing Companies
        </h1>
        <Card>
          <CardContent className="pt-6">
            <p className="text-red-600">
              Error loading companies: {error.message}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-3xl font-bold text-slate-900">Issuing Companies</h1>
        <AddIssuingCompanyDialog />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>All Companies That Issue Invoices</CardTitle>
        </CardHeader>
        <CardContent>
          <IssuingCompaniesTable companies={companies || []} />
        </CardContent>
      </Card>
    </div>
  );
}
