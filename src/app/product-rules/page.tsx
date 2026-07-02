import { ProductRulesTable } from "@/components/ProductRulesTable";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { createClient } from "@/lib/supabase/server";

export default async function ProductRulesPage() {
  const supabase = await createClient();

  const { data: products, error: productsError } = await supabase
    .from("products")
    .select("*")
    .order("product_name", { ascending: true });

  const { data: rules, error: rulesError } = await supabase
    .from("product_rules")
    .select("*");

  if (productsError || rulesError) {
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
              Error loading data:{" "}
              {productsError?.message || rulesError?.message}
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
