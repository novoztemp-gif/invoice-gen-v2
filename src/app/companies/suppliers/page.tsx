import { AddSupplierDialog } from "@/components/AddSupplierDialog";
import { BulkUploadSuppliersDialog } from "@/components/BulkUploadSuppliersDialog";
import { SuppliersTable } from "@/components/SuppliersTable";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { createClient } from "@/lib/supabase/server";

export default async function SuppliersPage() {
  const supabase = await createClient();

  const { data: suppliers, error } = await supabase
    .from("suppliers")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    return (
      <div>
        <h1 className="text-3xl font-bold text-slate-900 mb-6">Suppliers</h1>
        <Card>
          <CardContent className="pt-6">
            <p className="text-red-600">
              Error loading suppliers: {error.message}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-3xl font-bold text-slate-900">Suppliers</h1>
        <div className="flex gap-2">
          <BulkUploadSuppliersDialog />
          <AddSupplierDialog />
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>All Registered Suppliers</CardTitle>
        </CardHeader>
        <CardContent>
          <SuppliersTable suppliers={suppliers || []} />
        </CardContent>
      </Card>
    </div>
  );
}
