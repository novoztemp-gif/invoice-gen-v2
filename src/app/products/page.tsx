import { AddProductDialog } from "@/components/AddProductDialog";
import { BulkUploadProductsDialog } from "@/components/BulkUploadProductsDialog";
import { ProductsTable } from "@/components/ProductsTable";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { createClient } from "@/lib/supabase/server";
import { fetchAllQueryRows } from "@/lib/supabase/fetchAll";

export default async function ProductsPage() {
  const supabase = await createClient();

  // A plain `.select("*")` here silently truncates at PostgREST's default
  // 1000-row cap — the same bug already fixed on the Suppliers and
  // Receiving Customers list pages.
  let products: any[] = [];
  let error: any = null;
  try {
    products = await fetchAllQueryRows<any>((from, to) =>
      supabase
        .from("products")
        .select("*")
        .order("product_name", { ascending: true })
        .range(from, to),
    );
  } catch (err: any) {
    error = err;
  }

  if (error) {
    return (
      <div>
        <h1 className="text-3xl font-bold text-slate-900 mb-6">Products</h1>
        <Card>
          <CardContent className="pt-6">
            <p className="text-red-600">
              Error loading products: {error.message}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-3xl font-bold text-slate-900">Products</h1>
        <div className="flex gap-2">
          <BulkUploadProductsDialog />
          <AddProductDialog />
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Product Catalog</CardTitle>
        </CardHeader>
        <CardContent>
          <ProductsTable products={products || []} />
        </CardContent>
      </Card>
    </div>
  );
}
