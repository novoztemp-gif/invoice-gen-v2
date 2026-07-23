import { AddIssuingCompanyDialog } from "@/components/AddIssuingCompanyDialog";
import { AddProductDialog } from "@/components/AddProductDialog";
import { AddReceivingCompanyDialog } from "@/components/AddReceivingCompanyDialog";
import { BulkUploadCustomersDialog } from "@/components/BulkUploadCustomersDialog";
import { BulkUploadIssuingCompaniesDialog } from "@/components/BulkUploadIssuingCompaniesDialog";
import { BulkUploadProductsDialog } from "@/components/BulkUploadProductsDialog";
import { IssuingCompaniesTable } from "@/components/IssuingCompaniesTable";
import { ProductRulesTable } from "@/components/ProductRulesTable";
import { ProductsTable } from "@/components/ProductsTable";
import { ReceivingCompaniesTable } from "@/components/ReceivingCompaniesTable";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { createClient } from "@/lib/supabase/server";
import { Building2, Package, Users, Sliders } from "lucide-react";

interface MastersPageProps {
  searchParams?: Promise<{ tab?: string }>;
}

export default async function MastersPage({ searchParams }: MastersPageProps) {
  const params = searchParams ? await searchParams : {};
  const activeTab = params.tab || "issuing";
  const supabase = await createClient();

  const [
    { data: issuingCompanies, error: issuingError },
    { data: receivingCompanies, error: receivingError },
    { data: products, error: productsError },
    { data: rules, error: rulesError },
  ] = await Promise.all([
    supabase
      .from("issuing_companies")
      .select("*")
      .order("created_at", { ascending: false }),
    supabase
      .from("receiving_companies")
      .select("*")
      .order("created_at", { ascending: false }),
    supabase
      .from("products")
      .select("*")
      .order("product_name", { ascending: true }),
    supabase.from("product_rules").select("*"),
  ]);

  if (issuingError || receivingError || productsError || rulesError) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-bold text-slate-900">
          Masters Configuration
        </h1>
        <Card className="border-red-200 bg-red-50/70 rounded-md">
          <CardContent className="p-4">
            <p className="text-xs text-red-700 font-medium">
              Error loading master data:{" "}
              {issuingError?.message ||
                receivingError?.message ||
                productsError?.message ||
                rulesError?.message}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const productsWithRules =
    products?.map((product) => {
      const rule = rules?.find((r) => r.product_id === product.id);
      return {
        ...product,
        rule: rule || null,
      };
    }) || [];

  return (
    <div className="space-y-4 pb-10">
      <div>
        <h1 className="text-xl font-bold text-slate-900 tracking-tight">
          Masters
        </h1>
        <p className="text-slate-500 text-xs mt-0.5">
          Master data configuration for Issuing Companies, Receiving Customers,
          Products, and Product Rules
        </p>
      </div>

      <Tabs defaultValue={activeTab} className="space-y-4">
        <TabsList className="bg-slate-100 border border-slate-200 p-1 rounded-md grid grid-cols-2 sm:grid-cols-4 max-w-xl h-9">
          <TabsTrigger
            value="issuing"
            className="gap-1.5 text-xs font-medium rounded-xs"
          >
            <Building2 className="w-3.5 h-3.5 text-slate-600 stroke-[1.5]" />
            Issuing Companies
          </TabsTrigger>
          <TabsTrigger
            value="receiving"
            className="gap-1.5 text-xs font-medium rounded-xs"
          >
            <Users className="w-3.5 h-3.5 text-slate-600 stroke-[1.5]" />
            Receiving Customers
          </TabsTrigger>
          <TabsTrigger
            value="products"
            className="gap-1.5 text-xs font-medium rounded-xs"
          >
            <Package className="w-3.5 h-3.5 text-slate-600 stroke-[1.5]" />
            Products
          </TabsTrigger>
          <TabsTrigger
            value="rules"
            className="gap-1.5 text-xs font-medium rounded-xs"
          >
            <Sliders className="w-3.5 h-3.5 text-slate-600 stroke-[1.5]" />
            Product Rules
          </TabsTrigger>
        </TabsList>

        {/* Tab 1: Issuing Companies */}
        <TabsContent value="issuing" className="space-y-3">
          <div className="flex justify-between items-center">
            <div>
              <h2 className="text-sm font-bold text-slate-900">
                Issuing Companies
              </h2>
              <p className="text-[11px] text-slate-500">
                Companies that issue invoices in the system
              </p>
            </div>
            <div className="flex gap-2">
              <BulkUploadIssuingCompaniesDialog />
              <AddIssuingCompanyDialog />
            </div>
          </div>
          <Card className="border border-slate-200 shadow-2xs bg-white rounded-md">
            <CardHeader className="p-3 pb-2 border-b border-slate-100">
              <CardTitle className="text-xs font-semibold text-slate-700 uppercase tracking-wider">
                Registered Issuing Companies ({issuingCompanies?.length || 0})
              </CardTitle>
            </CardHeader>
            <CardContent className="p-3">
              <IssuingCompaniesTable companies={issuingCompanies || []} />
            </CardContent>
          </Card>
        </TabsContent>

        {/* Tab 2: Receiving Customers */}
        <TabsContent value="receiving" className="space-y-3">
          <div className="flex justify-between items-center">
            <div>
              <h2 className="text-sm font-bold text-slate-900">
                Receiving Customers
              </h2>
              <p className="text-[11px] text-slate-500">
                Customers that receive invoices
              </p>
            </div>
            <div className="flex gap-2">
              <BulkUploadCustomersDialog />
              <AddReceivingCompanyDialog />
            </div>
          </div>
          <Card className="border border-slate-200 shadow-2xs bg-white rounded-md">
            <CardHeader className="p-3 pb-2 border-b border-slate-100">
              <CardTitle className="text-xs font-semibold text-slate-700 uppercase tracking-wider">
                Registered Receiving Customers (
                {receivingCompanies?.length || 0})
              </CardTitle>
            </CardHeader>
            <CardContent className="p-3">
              <ReceivingCompaniesTable companies={receivingCompanies || []} />
            </CardContent>
          </Card>
        </TabsContent>

        {/* Tab 3: Products */}
        <TabsContent value="products" className="space-y-3">
          <div className="flex justify-between items-center">
            <div>
              <h2 className="text-sm font-bold text-slate-900">
                Product Catalog
              </h2>
              <p className="text-[11px] text-slate-500">
                Master products inventory items
              </p>
            </div>
            <div className="flex gap-2">
              <BulkUploadProductsDialog />
              <AddProductDialog />
            </div>
          </div>
          <Card className="border border-slate-200 shadow-2xs bg-white rounded-md">
            <CardHeader className="p-3 pb-2 border-b border-slate-100">
              <CardTitle className="text-xs font-semibold text-slate-700 uppercase tracking-wider">
                Master Products ({products?.length || 0})
              </CardTitle>
            </CardHeader>
            <CardContent className="p-3">
              <ProductsTable products={products || []} />
            </CardContent>
          </Card>
        </TabsContent>

        {/* Tab 4: Product Rules */}
        <TabsContent value="rules" className="space-y-3">
          <div>
            <h2 className="text-sm font-bold text-slate-900">Product Rules</h2>
            <p className="text-[11px] text-slate-500">
              Default quantity and pricing rules used during Sales Invoice
              generation
            </p>
          </div>
          <Card className="border border-slate-200 shadow-2xs bg-white rounded-md">
            <CardHeader className="p-3 pb-2 border-b border-slate-100">
              <CardTitle className="text-xs font-semibold text-slate-700 uppercase tracking-wider">
                Configured Product Rules ({productsWithRules.length})
              </CardTitle>
            </CardHeader>
            <CardContent className="p-3">
              <ProductRulesTable productsWithRules={productsWithRules} />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
