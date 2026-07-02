import { AddProductDialog } from "@/components/AddProductDialog";
import { BulkUploadProductsDialog } from "@/components/BulkUploadProductsDialog";
import { ProductsTable } from "@/components/ProductsTable";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { createClient } from "@/lib/supabase/server";

export default async function ProductsPage() {
  const supabase = await createClient();

  const { data: products, error } = await supabase
    .from("products")
    .select("*")
    .order("product_name", { ascending: true });

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
