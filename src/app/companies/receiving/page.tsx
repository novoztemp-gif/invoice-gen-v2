import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AddReceivingCompanyDialog } from "@/components/AddReceivingCompanyDialog";
import { ReceivingCompaniesTable } from "@/components/ReceivingCompaniesTable";

export default async function ReceivingCompaniesPage() {
  const supabase = await createClient();

  const { data: companies, error } = await supabase
    .from("receiving_companies")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    return (
      <div>
        <h1 className="text-3xl font-bold text-slate-900 mb-6">
          Receiving Companies
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
        <h1 className="text-3xl font-bold text-slate-900">
          Receiving Companies
        </h1>
        <AddReceivingCompanyDialog />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>All Companies That Receive Invoices</CardTitle>
        </CardHeader>
        <CardContent>
          <ReceivingCompaniesTable companies={companies || []} />
        </CardContent>
      </Card>
    </div>
  );
}
