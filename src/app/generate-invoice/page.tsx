"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Check, ChevronsUpDown, Plus, X, Loader2 } from "lucide-react";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { cn } from "@/lib/utils";
import { DatePicker } from "@/components/ui/date-picker";

function formatDateForStorage(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

type IssuingCompany = {
  id: string;
  company_name: string;
  address: string;
  gstin: string;
  pan: string;
  phone: string;
  branch?: string;
  bank_account_name: string;
  bank_name: string;
  account_number: string;
  ifsc_code: string;
};

type ReceivingCompany = {
  id: string;
  company_name: string;
  address: string;
  gstin: string;
  pan: string;
  state: string;
  state_code?: string;
};

type Product = {
  id: string;
  product_name: string;
  hsn_code: string;
  unit_of_measure: string;
};

type SelectedProductItem = {
  product: Product;
  perDayQtyMin: string;
  perDayQtyMax: string;
  perDayRateMin: string;
  perDayRateMax: string;
};

export default function GenerateInvoice() {
  const router = useRouter();
  const supabase = createClient();

  const [issuingCompanies, setIssuingCompanies] = useState<IssuingCompany[]>(
    [],
  );
  const [receivingCompanies, setReceivingCompanies] = useState<
    ReceivingCompany[]
  >([]);
  const [products, setProducts] = useState<Product[]>([]);

  const [selectedIssuingCompany, setSelectedIssuingCompany] =
    useState<IssuingCompany | null>(null);
  const [selectedReceivingCompany, setSelectedReceivingCompany] =
    useState<ReceivingCompany | null>(null);
  const [selectedProducts, setSelectedProducts] = useState<
    SelectedProductItem[]
  >([]);

  const [tempProduct, setTempProduct] = useState<Product | null>(null);
  const [tempProductData, setTempProductData] = useState({
    perDayQtyMin: "",
    perDayQtyMax: "",
    perDayRateMin: "",
    perDayRateMax: "",
  });

  const [issuingCompanyOpen, setIssuingCompanyOpen] = useState(false);
  const [receivingCompanyOpen, setReceivingCompanyOpen] = useState(false);
  const [productOpen, setProductOpen] = useState(false);
  const [isValidating, setIsValidating] = useState(false);

  const currentYear = new Date().getFullYear();

  const [formData, setFormData] = useState({
    invoiceType: "",
    transportMode: "",
    vehicleNumber: "",
    dateOfSupply: undefined,
    invoiceDateFrom: undefined,
    invoiceDateTo: undefined,
    thresholdLimit: "",
    totalAmount: "",
    financialYearStart: currentYear,
    financialYearEnd: currentYear + 1,
  });

  useEffect(() => {
    const fetchData = async () => {
      const supabase = createClient();

      const [issuingRes, receivingRes, productsRes] = await Promise.all([
        supabase
          .from("issuing_companies")
          .select("*")
          .order("company_name", { ascending: true }),
        supabase
          .from("receiving_companies")
          .select("*")
          .order("company_name", { ascending: true }),
        supabase
          .from("products")
          .select("*")
          .order("product_name", { ascending: true }),
      ]);

      if (issuingRes.data) setIssuingCompanies(issuingRes.data);
      if (receivingRes.data) setReceivingCompanies(receivingRes.data);
      if (productsRes.data) setProducts(productsRes.data);
    };

    fetchData();
  }, []);

  const handleIssuingCompanyChange = (companyId: string) => {
    const company = issuingCompanies.find((c) => c.id === companyId);
    setSelectedIssuingCompany(company || null);
    setIssuingCompanyOpen(false);
  };

  const handleReceivingCompanyChange = (companyId: string) => {
    const company = receivingCompanies.find((c) => c.id === companyId);
    setSelectedReceivingCompany(company || null);
    setReceivingCompanyOpen(false);
  };

  const handleProductChange = (productId: string) => {
    const product = products.find((p) => p.id === productId);
    setTempProduct(product || null);
    setProductOpen(false);
  };

  const handleAddProduct = () => {
    if (!tempProduct) return;

    if (
      !tempProductData.perDayQtyMin ||
      !tempProductData.perDayQtyMax ||
      !tempProductData.perDayRateMin ||
      !tempProductData.perDayRateMax
    ) {
      alert("Please fill in all product fields before adding!");
      return;
    }

    if (selectedProducts.some((p) => p.product.id === tempProduct.id)) {
      alert("This product has already been added!");
      return;
    }

    setSelectedProducts([
      ...selectedProducts,
      {
        product: tempProduct,
        perDayQtyMin: tempProductData.perDayQtyMin,
        perDayQtyMax: tempProductData.perDayQtyMax,
        perDayRateMin: tempProductData.perDayRateMin,
        perDayRateMax: tempProductData.perDayRateMax,
      },
    ]);

    setTempProduct(null);
    setTempProductData({
      perDayQtyMin: "",
      perDayQtyMax: "",
      perDayRateMin: "",
      perDayRateMax: "",
    });
  };

  const handleRemoveProduct = (productId: string) => {
    setSelectedProducts(
      selectedProducts.filter((p) => p.product.id !== productId),
    );
  };

  const handleSubmit = () => {
    if (!formData.invoiceType) {
      alert("Please select an invoice type!");
      return;
    }

    if (!selectedIssuingCompany) {
      alert("Please select an issuing company!");
      return;
    }

    if (!selectedReceivingCompany) {
      alert("Please select a receiving company!");
      return;
    }

    if (selectedProducts.length === 0) {
      alert("Please add at least one product!");
      return;
    }

    for (let i = 0; i < selectedProducts.length; i++) {
      const product = selectedProducts[i];
      const minQty = parseFloat(product.perDayQtyMin);
      const maxQty = parseFloat(product.perDayQtyMax);
      const minRate = parseFloat(product.perDayRateMin);
      const maxRate = parseFloat(product.perDayRateMax);

      // Check for negative values
      if (minQty < 0 || maxQty < 0) {
        alert(
          `Product "${product.product.product_name}": Quantities cannot be negative!`,
        );
        return;
      }

      if (minRate < 0 || maxRate < 0) {
        alert(
          `Product "${product.product.product_name}": Rates cannot be negative!`,
        );
        return;
      }

      // Check min <= max
      if (minQty > maxQty) {
        alert(
          `Product "${product.product.product_name}": Minimum quantity (${minQty}) cannot be greater than maximum quantity (${maxQty})!`,
        );
        return;
      }

      if (minRate > maxRate) {
        alert(
          `Product "${product.product.product_name}": Minimum rate (${minRate}) cannot be greater than maximum rate (${maxRate})!`,
        );
        return;
      }
    }

    if (
      !formData.transportMode ||
      !formData.vehicleNumber ||
      !formData.dateOfSupply
    ) {
      alert("Please fill in all Other Details fields!");
      return;
    }

    if (
      !formData.invoiceDateFrom ||
      !formData.invoiceDateTo ||
      !formData.thresholdLimit ||
      !formData.totalAmount
    ) {
      alert("Please fill in all Invoice Configuration fields!");
      return;
    }

    if (formData.invoiceDateFrom > formData.invoiceDateTo) {
      alert("Invoice 'From Date' must be less than or equal to 'To Date'!");
      return;
    }

    const thresholdLimit = parseFloat(formData.thresholdLimit);
    const totalAmount = parseFloat(formData.totalAmount);

    if (thresholdLimit < 0) {
      alert("Threshold limit cannot be negative!");
      return;
    }

    if (totalAmount < 0) {
      alert("Total amount cannot be negative!");
      return;
    }

    validateInvoiceBatch();
  };

  const resetForm = () => {
    setSelectedIssuingCompany(null);
    setSelectedReceivingCompany(null);
    setSelectedProducts([]);
    setTempProduct(null);
    setTempProductData({
      perDayQtyMin: "",
      perDayQtyMax: "",
      perDayRateMin: "",
      perDayRateMax: "",
    });
    setFormData({
      invoiceType: "",
      transportMode: "",
      vehicleNumber: "",
      dateOfSupply: undefined,
      invoiceDateFrom: undefined,
      invoiceDateTo: undefined,
      thresholdLimit: "",
      totalAmount: "",
    });
  };

  const validateInvoiceBatch = async () => {
    setIsValidating(true);
    try {
      const response = await fetch("/api/validate-invoice-batch", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          products: selectedProducts,
          invoiceDateFrom: formData.invoiceDateFrom
            ? formatDateForStorage(formData.invoiceDateFrom)
            : null,
          invoiceDateTo: formData.invoiceDateTo
            ? formatDateForStorage(formData.invoiceDateTo)
            : null,
          thresholdLimit: formData.thresholdLimit,
          totalAmount: formData.totalAmount,
        }),
      });

      const result = await response.json();

      if (result.isValid) {
        await createInvoiceBatch();
      } else {
        alert(result.message);
      }
    } catch (error) {
      console.error("Validation error:", error);
      alert("An error occurred while validating. Please try again.");
    } finally {
      setIsValidating(false);
    }
  };

  const createInvoiceBatch = async () => {
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        alert("You must be logged in to create an invoice batch.");
        return;
      }

      const { data, error } = await supabase
        .from("invoice_batch")
        .insert({
          issuing_company_id: selectedIssuingCompany?.id,
          receiving_company_id: selectedReceivingCompany?.id,
          invoice_type: formData.invoiceType,
          transport_mode: formData.transportMode,
          vehicle_number: formData.vehicleNumber,
          date_of_supply: formData.dateOfSupply
            ? formatDateForStorage(formData.dateOfSupply)
            : null,
          invoice_date_from: formData.invoiceDateFrom
            ? formatDateForStorage(formData.invoiceDateFrom)
            : null,
          invoice_date_to: formData.invoiceDateTo
            ? formatDateForStorage(formData.invoiceDateTo)
            : null,
          threshold_limit: parseFloat(formData.thresholdLimit),
          total_amount: parseFloat(formData.totalAmount),
          products: selectedProducts.map((item) => ({
            product_id: item.product.id,
            product_name: item.product.product_name,
            hsn_code: item.product.hsn_code,
            unit_of_measure: item.product.unit_of_measure,
            perDayQtyMin: item.perDayQtyMin,
            perDayQtyMax: item.perDayQtyMax,
            perDayRateMin: item.perDayRateMin,
            perDayRateMax: item.perDayRateMax,
          })),
          status: "pending",
          created_by: user.id,
        })
        .select()
        .single();

      if (error) {
        console.error("Error creating invoice batch:", error);
        alert("Failed to create invoice batch. Please try again.");
        return;
      }

      console.log("Invoice batch created:", data);
      alert("Invoice batch created successfully! Redirecting...");

      resetForm();

      router.push("/invoice-batches");
    } catch (error) {
      console.error("Error creating invoice batch:", error);
      alert("An error occurred while creating the batch. Please try again.");
    }
  };

  return (
    <div>
      <h1 className="text-3xl font-bold text-slate-900 mb-6">
        Generate Invoice
      </h1>

      <div className="mb-6">
        <RadioGroup
          value={formData.invoiceType}
          onValueChange={(value) =>
            setFormData({ ...formData, invoiceType: value })
          }
          className="flex gap-6 mt-2"
        >
          <div className="flex items-center space-x-2">
            <RadioGroupItem value="sales" id="sales" />
            <Label htmlFor="sales">Sales</Label>
          </div>
          <div className="flex items-center space-x-2">
            <RadioGroupItem value="purchase" id="purchase" />
            <Label htmlFor="purchase">Purchase</Label>
          </div>
        </RadioGroup>
      </div>

      <div
        className={cn(
          "space-y-6",
          isValidating && "opacity-60 pointer-events-none",
        )}
      >
        {/* Sender Company (Issuing Invoice) */}
        <Card>
          <CardHeader>
            <CardTitle>Company Issuing Invoice</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2 md:col-span-2">
                <Label htmlFor="issuing-company">Company Name *</Label>
                <Popover
                  open={issuingCompanyOpen}
                  onOpenChange={setIssuingCompanyOpen}
                >
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      role="combobox"
                      aria-expanded={issuingCompanyOpen}
                      className="w-full justify-between"
                    >
                      {selectedIssuingCompany
                        ? selectedIssuingCompany.company_name
                        : "Select issuing company..."}
                      <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-full p-0" align="start">
                    <Command>
                      <CommandInput placeholder="Search company..." />
                      <CommandList>
                        <CommandEmpty>No company found.</CommandEmpty>
                        <CommandGroup>
                          {issuingCompanies.map((company) => (
                            <CommandItem
                              key={company.id}
                              value={company.company_name}
                              onSelect={() =>
                                handleIssuingCompanyChange(company.id)
                              }
                            >
                              <Check
                                className={cn(
                                  "mr-2 h-4 w-4",
                                  selectedIssuingCompany?.id === company.id
                                    ? "opacity-100"
                                    : "opacity-0",
                                )}
                              />
                              {company.company_name}
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
                <p className="text-xs text-slate-500">
                  Can't find the company you're looking for?{" "}
                  <a
                    href="/companies/issuing"
                    className="text-slate-800 hover:underline"
                  >
                    Add or edit issuing companies here
                  </a>
                </p>
              </div>

              {selectedIssuingCompany && (
                <>
                  <div className="space-y-2 md:col-span-2">
                    <Label>Address</Label>
                    <Input
                      value={selectedIssuingCompany.address}
                      disabled
                      className="bg-slate-50"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label>GSTIN</Label>
                    <Input
                      value={selectedIssuingCompany.gstin}
                      disabled
                      className="bg-slate-50"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label>PAN</Label>
                    <Input
                      value={selectedIssuingCompany.pan}
                      disabled
                      className="bg-slate-50"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label>Phone</Label>
                    <Input
                      value={selectedIssuingCompany.phone}
                      disabled
                      className="bg-slate-50"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label>Branch</Label>
                    <Input
                      value={selectedIssuingCompany.branch || ""}
                      disabled
                      className="bg-slate-50"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label>Bank Account Name</Label>
                    <Input
                      value={selectedIssuingCompany.bank_account_name}
                      disabled
                      className="bg-slate-50"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label>Bank Name</Label>
                    <Input
                      value={selectedIssuingCompany.bank_name}
                      disabled
                      className="bg-slate-50"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label>Account Number</Label>
                    <Input
                      value={selectedIssuingCompany.account_number}
                      disabled
                      className="bg-slate-50"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label>IFSC Code</Label>
                    <Input
                      value={selectedIssuingCompany.ifsc_code}
                      disabled
                      className="bg-slate-50"
                    />
                  </div>
                </>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Receiver Company (Receiving Invoice) */}
        <Card>
          <CardHeader>
            <CardTitle>Company Receiving Invoice</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2 md:col-span-2">
                <Label htmlFor="receiving-company">Company Name *</Label>
                <Popover
                  open={receivingCompanyOpen}
                  onOpenChange={setReceivingCompanyOpen}
                >
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      role="combobox"
                      aria-expanded={receivingCompanyOpen}
                      className="w-full justify-between"
                    >
                      {selectedReceivingCompany
                        ? selectedReceivingCompany.company_name
                        : "Select receiving company..."}
                      <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-full p-0" align="start">
                    <Command>
                      <CommandInput placeholder="Search company..." />
                      <CommandList>
                        <CommandEmpty>No company found.</CommandEmpty>
                        <CommandGroup>
                          {receivingCompanies.map((company) => (
                            <CommandItem
                              key={company.id}
                              value={company.company_name}
                              onSelect={() =>
                                handleReceivingCompanyChange(company.id)
                              }
                            >
                              <Check
                                className={cn(
                                  "mr-2 h-4 w-4",
                                  selectedReceivingCompany?.id === company.id
                                    ? "opacity-100"
                                    : "opacity-0",
                                )}
                              />
                              {company.company_name}
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
                <p className="text-xs text-slate-500">
                  Can't find the company you're looking for?{" "}
                  <a
                    href="/companies/receiving"
                    className="text-slate-800 hover:underline"
                  >
                    Add or edit receiving companies here
                  </a>
                </p>
              </div>

              {selectedReceivingCompany && (
                <>
                  <div className="space-y-2 md:col-span-2">
                    <Label>Address</Label>
                    <Input
                      value={selectedReceivingCompany.address}
                      disabled
                      className="bg-slate-50"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label>GSTIN</Label>
                    <Input
                      value={selectedReceivingCompany.gstin}
                      disabled
                      className="bg-slate-50"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label>PAN</Label>
                    <Input
                      value={selectedReceivingCompany.pan}
                      disabled
                      className="bg-slate-50"
                    />
                  </div>

                  <div className="space-y-2 md:col-span-2">
                    <Label>State</Label>
                    <Input
                      value={selectedReceivingCompany.state}
                      disabled
                      className="bg-slate-50"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label>State Code</Label>
                    <Input
                      value={selectedReceivingCompany.state_code || ""}
                      disabled
                      className="bg-slate-50"
                    />
                  </div>
                </>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Product Details */}
        <Card>
          <CardHeader>
            <CardTitle>Product Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Added Products List */}
            {selectedProducts.length > 0 && (
              <div className="space-y-3">
                <Label className="text-base font-semibold">
                  Added Products ({selectedProducts.length})
                </Label>
                <div className="space-y-3">
                  {selectedProducts.map((item, index) => (
                    <div
                      key={item.product.id}
                      className="p-4 border rounded-lg bg-slate-50 space-y-3"
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-slate-900">
                              {index + 1}. {item.product.product_name}
                            </span>
                            <span className="text-xs text-slate-500 font-mono">
                              HSN: {item.product.hsn_code}
                            </span>
                          </div>
                          <p className="text-sm text-slate-600 mt-1">
                            Unit: {item.product.unit_of_measure}
                          </p>
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleRemoveProduct(item.product.id)}
                          className="text-red-600 hover:text-red-700 hover:bg-red-50"
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <div>
                          <Label className="text-xs text-slate-600">
                            Quantity Range (per day)
                          </Label>
                          <p className="text-sm font-medium">
                            {item.perDayQtyMin || "—"} to{" "}
                            {item.perDayQtyMax || "—"}
                          </p>
                        </div>
                        <div>
                          <Label className="text-xs text-slate-600">
                            Rate Range (per unit per day)
                          </Label>
                          <p className="text-sm font-medium">
                            ₹{item.perDayRateMin || "—"} to ₹
                            {item.perDayRateMax || "—"}
                          </p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Add New Product Form */}
            <div className="space-y-4 pt-4 border-t">
              <Label className="text-base font-semibold">Add Product</Label>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2 md:col-span-2">
                  <Label htmlFor="product">Product Name *</Label>
                  <Popover open={productOpen} onOpenChange={setProductOpen}>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        role="combobox"
                        aria-expanded={productOpen}
                        className="w-full justify-between"
                      >
                        {tempProduct
                          ? tempProduct.product_name
                          : "Select product..."}
                        <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-full p-0" align="start">
                      <Command>
                        <CommandInput placeholder="Search product..." />
                        <CommandList>
                          <CommandEmpty>No product found.</CommandEmpty>
                          <CommandGroup>
                            {products.map((product) => (
                              <CommandItem
                                key={product.id}
                                value={`${product.product_name} ${product.hsn_code}`}
                                onSelect={() => handleProductChange(product.id)}
                              >
                                <Check
                                  className={cn(
                                    "mr-2 h-4 w-4",
                                    tempProduct?.id === product.id
                                      ? "opacity-100"
                                      : "opacity-0",
                                  )}
                                />
                                <div className="flex flex-col">
                                  <span>{product.product_name}</span>
                                  <span className="text-xs text-slate-500">
                                    HSN: {product.hsn_code}
                                  </span>
                                </div>
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                  <p className="text-xs text-slate-500">
                    Can't find the product you're looking for?{" "}
                    <a
                      href="/products"
                      className="text-slate-800 hover:underline"
                    >
                      Add or edit products here
                    </a>
                  </p>
                </div>

                {tempProduct && (
                  <>
                    <div className="space-y-2">
                      <Label>HSN Code</Label>
                      <Input
                        value={tempProduct.hsn_code}
                        disabled
                        className="bg-slate-50"
                      />
                    </div>

                    <div className="space-y-2">
                      <Label>Unit of Measure</Label>
                      <Input
                        value={tempProduct.unit_of_measure}
                        disabled
                        className="bg-slate-50"
                      />
                    </div>

                    <div className="space-y-2">
                      <Label>Per Day Quantity Range *</Label>
                      <div className="grid grid-cols-2 gap-2">
                        <Input
                          type="number"
                          placeholder="Min"
                          min="0"
                          step="0.01"
                          value={tempProductData.perDayQtyMin}
                          onChange={(e) =>
                            setTempProductData({
                              ...tempProductData,
                              perDayQtyMin: e.target.value,
                            })
                          }
                          required
                        />
                        <Input
                          type="number"
                          placeholder="Max"
                          min="0"
                          step="0.01"
                          value={tempProductData.perDayQtyMax}
                          onChange={(e) =>
                            setTempProductData({
                              ...tempProductData,
                              perDayQtyMax: e.target.value,
                            })
                          }
                          required
                        />
                      </div>
                    </div>

                    <div className="space-y-2">
                      <Label>Per Day Rate Per Unit Range *</Label>
                      <div className="grid grid-cols-2 gap-2">
                        <Input
                          type="number"
                          placeholder="Min"
                          min="0"
                          step="0.01"
                          value={tempProductData.perDayRateMin}
                          onChange={(e) =>
                            setTempProductData({
                              ...tempProductData,
                              perDayRateMin: e.target.value,
                            })
                          }
                          required
                        />
                        <Input
                          type="number"
                          placeholder="Max"
                          min="0"
                          step="0.01"
                          value={tempProductData.perDayRateMax}
                          onChange={(e) =>
                            setTempProductData({
                              ...tempProductData,
                              perDayRateMax: e.target.value,
                            })
                          }
                          required
                        />
                      </div>
                    </div>

                    <div className="md:col-span-2 flex justify-end">
                      <Button
                        onClick={handleAddProduct}
                        className="gap-2"
                        type="button"
                      >
                        <Plus className="h-4 w-4" />
                        Add Product to Invoice
                      </Button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Invoice Configuration & Limits */}
        <Card>
          <CardHeader>
            <CardTitle>Invoice Configuration & Limits</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2 md:col-span-2">
                <Label>Invoice Date Range *</Label>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label
                      htmlFor="invoice-date-from"
                      className="text-sm text-slate-600"
                    >
                      From Date *
                    </Label>
                    <DatePicker
                      date={formData.invoiceDateFrom}
                      onDateChange={(date) =>
                        setFormData({
                          ...formData,
                          invoiceDateFrom: date,
                        })
                      }
                      placeholder="Select from date"
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label
                      htmlFor="invoice-date-to"
                      className="text-sm text-slate-600"
                    >
                      To Date *
                    </Label>
                    <DatePicker
                      date={formData.invoiceDateTo}
                      onDateChange={(date) =>
                        setFormData({
                          ...formData,
                          invoiceDateTo: date,
                        })
                      }
                      placeholder="Select to date"
                      required
                    />
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="threshold-limit">
                  Threshold Limit (Per Invoice) *
                </Label>
                <Input
                  id="threshold-limit"
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="Enter maximum amount per invoice"
                  value={formData.thresholdLimit}
                  onChange={(e) =>
                    setFormData({ ...formData, thresholdLimit: e.target.value })
                  }
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="total-amount">
                  Total Amount (All Invoices) *
                </Label>
                <Input
                  id="total-amount"
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="Enter total amount for all invoices"
                  value={formData.totalAmount}
                  onChange={(e) =>
                    setFormData({ ...formData, totalAmount: e.target.value })
                  }
                  required
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Other Details */}
        <Card>
          <CardHeader>
            <CardTitle>Other Details</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="transport-mode">Transportation Mode *</Label>
                <Input
                  id="transport-mode"
                  placeholder="Enter transportation mode"
                  value={formData.transportMode}
                  onChange={(e) =>
                    setFormData({ ...formData, transportMode: e.target.value })
                  }
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="vehicle-number">Vehicle Number *</Label>
                <Input
                  id="vehicle-number"
                  placeholder="Enter vehicle number"
                  value={formData.vehicleNumber}
                  onChange={(e) =>
                    setFormData({ ...formData, vehicleNumber: e.target.value })
                  }
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="date-of-supply">
                  Date of Supply (On or Before) *
                </Label>
                <DatePicker
                  date={formData.dateOfSupply}
                  onDateChange={(date) =>
                    setFormData({ ...formData, dateOfSupply: date })
                  }
                  placeholder="Select date of supply"
                  required
                />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Submit Button */}
      <div className="mt-8 flex justify-end">
        <Button
          onClick={handleSubmit}
          size="lg"
          className="px-8"
          type="button"
          disabled={isValidating}
        >
          {isValidating ? (
            <>
              <Loader2 className="mr-2 h-5 w-5 animate-spin" />
              Validating...
            </>
          ) : (
            "Create a Batch"
          )}
        </Button>
      </div>
    </div>
  );
}
