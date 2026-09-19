import { ProductRulesTable } from "@/components/ProductRulesTable";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { createClient } from "@/lib/supabase/server";
import { fetchAllQueryRows } from "@/lib/supabase/fetchAll";

export default async function ProductRulesPage() {
  const supabase = await createClient();

  // Plain `.select("*")` here silently truncates at PostgREST's default
  // 1000-row cap — the same bug already fixed on the Suppliers and
  // Receiving Customers list pages.
  let products: any[] = [];
  let rules: any[] = [];
  let loadError: any = null;
  try {
    [products, rules] = await Promise.all([
      fetchAllQueryRows<any>((from, to) =>
        supabase
          .from("products")
          .select("*")
          .order("product_name", { ascending: true })
          .range(from, to),
      ),
      fetchAllQueryRows<any>((from, to) =>
        supabase.from("product_rules").select("*").range(from, to),
      ),
    ]);
  } catch (err: any) {
    loadError = err;
  }

  if (loadError) {
    return (
      <div>
        <h1 className="text-3xl font-bold text-slate-900 mb-2">
          Product Rules
        </h1>
        <p className="text-slate-600 mb-6">
          Configure default quantity and pricing rules used during Sales Invoice
          generation.
        </p>
        <Card>
          <CardContent className="pt-6">
            <p className="text-red-600">
              Error loading data: {loadError?.message}
            </p>
            <p className="text-sm text-slate-500 mt-2">
              Note: If product_rules does not exist, please ensure you have
              applied the database migrations.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Map products to their rules
  const productsWithRules =
    products?.map((product) => {
      const rule = rules?.find((r) => r.product_id === product.id);
      return {
        ...product,
        rule: rule || null,
      };
    }) || [];

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-slate-900">Product Rules</h1>
        <p className="text-slate-600 mt-1">
          Configure default quantity and pricing rules used during Sales Invoice
          generation.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Configuration</CardTitle>
        </CardHeader>
        <CardContent>
          <ProductRulesTable productsWithRules={productsWithRules} />
        </CardContent>
      </Card>
    </div>
  );
}
