import { AddReceivingCompanyDialog } from "@/components/AddReceivingCompanyDialog";
import { BulkUploadCustomersDialog } from "@/components/BulkUploadCustomersDialog";
import { ReceivingCompaniesTable } from "@/components/ReceivingCompaniesTable";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { createClient } from "@/lib/supabase/server";
import { fetchAllQueryRows } from "@/lib/supabase/fetchAll";

export default async function ReceivingCompaniesPage() {
  const supabase = await createClient();

  // A plain `.select("*")` here silently truncates at PostgREST's default
  // 1000-row cap — confirmed as the real cause of a customer existing (and
  // selectable on the invoice generation form, which already paginates)
  // yet being invisible/unsearchable on this list page once the table
  // passed 1000 rows.
  let companies: any[] = [];
  let error: any = null;
  try {
    companies = await fetchAllQueryRows<any>((from, to) =>
      supabase
        .from("receiving_companies")
        .select("*")
        .order("created_at", { ascending: false })
        .range(from, to),
    );
  } catch (err: any) {
    error = err;
  }

  if (error) {
    return (
      <div>
        <h1 className="text-3xl font-bold text-slate-900 mb-6">
          Receiving Customers
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
          Receiving Customers
        </h1>
        <div className="flex gap-2">
          <BulkUploadCustomersDialog />
          <AddReceivingCompanyDialog />
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>All Customers That Receive Invoices</CardTitle>
        </CardHeader>
        <CardContent>
          <ReceivingCompaniesTable companies={companies || []} />
        </CardContent>
      </Card>
    </div>
  );
}
