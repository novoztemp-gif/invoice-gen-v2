"use client";

import {
  Check,
  CheckCircle2,
  ChevronsUpDown,
  Loader2,
  Plus,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { DatePicker } from "@/components/ui/date-picker";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useInvoiceForm } from "@/lib/hooks/useInvoiceForm";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

export default function GeneratePurchaseInvoice() {
  const {
    issuingCompanies,
    receivingCompanies,
    products,
    productRules,
    errorPopup,
    setErrorPopup,
    selectedIssuingCompany,
    selectedCustomers,
    majorCustomers,
    customerOpen,
    setCustomerOpen,
    majorCustomerOpen,
    setMajorCustomerOpen,
    tempMajorCustomer,
    setTempMajorCustomer,
    selectedProducts,
    setSelectedProducts,
    tempProduct,
    setTempProduct,
    issuingCompanyOpen,
    setIssuingCompanyOpen,
    productOpen,
    setProductOpen,
    isValidating,
    formData,
    setFormData,
    handleIssuingCompanyChange,
    handleProductChange,
    handleAddMajorCustomer,
    handleRemoveMajorCustomer,
    handleToggleCustomer,
    handleSelectAllCustomers,
    handleAddProduct,
    handleRemoveProduct,
    handleSubmit,
  } = useInvoiceForm({ batchType: "PURCHASE" });

  const [occurrenceProductOpen, setOccurrenceProductOpen] = useState(false);
  const [selectedOccurProduct, setSelectedOccurProduct] = useState("");
  const [occurPercent, setOccurPercent] = useState("");

  // Live Purchase Value Calculator
  const calcValues = () => {
    const T = parseFloat(formData.totalAmount || "") || 0;
    const I_min = parseFloat(formData.minimumInvoiceAmount || "") || 0;
    const I_max = parseFloat(formData.maximumInvoiceAmount || "") || 0;

    let N = 0;
    let N_min = 0;
    let N_max = 0;
    if (I_min > 0 && I_max > 0) {
      const I_avg = (I_min + I_max) / 2;
      N = Math.round(T / I_avg);
      N_min = Math.ceil(T / I_max);
      N_max = Math.floor(T / I_min);
      N = Math.max(N_min, Math.min(N_max, N));
      if (N < 1 && T > 0) {
        N = 1;
      }
    }

    let minSingleProdVal = 0;
    let maxSingleProdSum = 0;

    if (selectedProducts.length > 0) {
      const prodVals = selectedProducts.map((p) => {
        const qMin = parseFloat(p.perDayQtyMin) || 0;
        const qMax = parseFloat(p.perDayQtyMax) || 0;
        const rMin = parseFloat(p.perDayRateMin) || 0;
        const rMax = parseFloat(p.perDayRateMax) || 0;
        return {
          minVal: qMin * rMin,
          maxVal: qMax * rMax,
        };
      });

      minSingleProdVal = Math.min(...prodVals.map((pv) => pv.minVal));
      maxSingleProdSum = prodVals.reduce((sum, pv) => sum + pv.maxVal, 0);
    }

    const V_min_single = Math.max(I_min, minSingleProdVal);
    const V_max_single = Math.min(I_max, maxSingleProdSum);

    const E_min = N * V_min_single;
    const E_max = N * V_max_single;

    const productBreakdown = selectedProducts.map((item) => {
      const qMin = parseFloat(item.perDayQtyMin) || 0;
      const qMax = parseFloat(item.perDayQtyMax) || 0;
      const rMin = parseFloat(item.perDayRateMin) || 0;
      const rMax = parseFloat(item.perDayRateMax) || 0;
      return {
        product_id: item.product.id,
        product_name: item.product.product_name,
        occurrence_percentage: item.occurrencePercentage || "",
        min_qty: qMin,
        max_qty: qMax,
        min_rate: rMin,
        max_rate: rMax,
        min_val: qMin * rMin,
        max_val: qMax * rMax,
        unit: item.product.unit_of_measure,
      };
    });

    let status: "incomplete" | "valid" | "invalid" = "incomplete";
    if (T > 0 && I_min > 0 && I_max > 0 && selectedProducts.length > 0) {
      if (N_min > N_max || T < E_min || T > E_max) {
        status = "invalid";
      } else {
        status = "valid";
      }
    }

    return {
      totalAmount: T,
      estimatedInvoices: N,
      selectedCount: selectedProducts.length,
      batchMin: E_min,
      batchMax: E_max,
      status,
      productBreakdown,
    };
  };

  const {
    totalAmount,
    estimatedInvoices,
    selectedCount,
    batchMin,
    batchMax,
    status,
    productBreakdown,
  } = calcValues();
  const isInvalid = status === "invalid";

  const handleProductRowClick = (productId: string) => {
    const element = document.getElementById(`product-qty-card-${productId}`);
    if (element) {
      element.scrollIntoView({ behavior: "smooth", block: "center" });

      element.classList.remove("animate-highlight");
      void element.offsetWidth; // force reflow
      element.classList.add("animate-highlight");

      setTimeout(() => {
        element.classList.remove("animate-highlight");
      }, 1500);
    }
  };

  return (
    <div>
      <style>{`
        @keyframes highlight-flash {
          0% { background-color: rgb(187 247 208); border-color: rgb(34 197 94); box-shadow: 0 0 0 4px rgba(34, 197, 94, 0.4); }
          100% { background-color: transparent; border-color: inherit; box-shadow: none; }
        }
        .animate-highlight {
          animation: highlight-flash 1.5s ease-out;
        }
      `}</style>
      <h1 className="text-3xl font-bold text-slate-900 mb-6">
        Purchase Invoice
      </h1>

      <div
        className={cn(
          "space-y-6",
          isValidating && "opacity-60 pointer-events-none",
        )}
      >
        {/* Financial Year */}
        <Card>
          <CardHeader>
            <CardTitle>Financial Year</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="financial-year-start">Start Year *</Label>
                <Input
                  id="financial-year-start"
                  type="number"
                  placeholder="Enter start year"
                  value={formData.financialYearStart}
                  onChange={(e) => {
                    const val = parseInt(e.target.value) || 0;
                    setFormData({
                      ...formData,
                      financialYearStart: val,
                      financialYearEnd: val + 1,
                    });
                  }}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="financial-year-end">End Year</Label>
                <Input
                  id="financial-year-end"
                  type="number"
                  value={formData.financialYearEnd}
                  disabled
                  className="bg-slate-50"
                />
              </div>
              <div className="md:col-span-2 mt-2">
                <span className="text-sm font-medium text-slate-500">
                  Live Preview:{" "}
                </span>
                <span className="text-sm font-bold text-slate-900">
                  FY{formData.financialYearStart}-
                  {String(formData.financialYearEnd).slice(2)}
                </span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Company Making Purchase */}
        <Card>
          <CardHeader>
            <CardTitle>Company Making Purchase</CardTitle>
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
                        : "Select company making purchase..."}
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

        {/* Suppliers */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle>Suppliers</CardTitle>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleSelectAllCustomers}
            >
              {(() => {
                const regularCompanies = receivingCompanies.filter(
                  (c) => !majorCustomers.some((m) => m.customer_id === c.id),
                );
                return selectedCustomers.length === regularCompanies.length &&
                  regularCompanies.length > 0
                  ? "Deselect All"
                  : "Select All";
              })()}
            </Button>
          </CardHeader>
          <CardContent className="space-y-4">
            <Popover open={customerOpen} onOpenChange={setCustomerOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  role="combobox"
                  aria-expanded={customerOpen}
                  className="w-full justify-between"
                >
                  Search & Select Suppliers...
                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-full p-0" align="start">
                <Command>
                  <CommandInput placeholder="Search by name, GSTIN, or state..." />
                  <CommandList>
                    <CommandEmpty>No supplier found.</CommandEmpty>
                    <CommandGroup>
                      {receivingCompanies
                        .filter(
                          (c) =>
                            !majorCustomers.some((m) => m.customer_id === c.id),
                        )
                        .map((company) => {
                          const isSelected = selectedCustomers.includes(
                            company.id,
                          );
                          return (
                            <CommandItem
                              key={company.id}
                              value={`${company.company_name} ${company.gstin || ""} ${company.state || ""}`}
                              onSelect={() => handleToggleCustomer(company.id)}
                            >
                              <Check
                                className={cn(
                                  "mr-2 h-4 w-4",
                                  isSelected ? "opacity-100" : "opacity-0",
                                )}
                              />
                              <div className="flex flex-col">
                                <span>{company.company_name}</span>
                                <span className="text-xs text-slate-500">
                                  {company.state}{" "}
                                  {company.gstin ? `| ${company.gstin}` : ""}
                                </span>
                              </div>
                            </CommandItem>
                          );
                        })}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>

            {/* Selected Suppliers Chips */}
            {selectedCustomers.length > 0 && (
              <div className="space-y-2">
                <Label className="text-sm font-medium text-slate-700">
                  Selected Suppliers ({selectedCustomers.length})
                </Label>
                <div className="flex flex-wrap gap-2">
                  {selectedCustomers.map((id) => {
                    const company = receivingCompanies.find((c) => c.id === id);
                    if (!company) return null;
                    return (
                      <div
                        key={company.id}
                        className="flex items-center gap-1 bg-slate-100 text-slate-800 px-3 py-1.5 rounded-full text-sm border border-slate-200"
                      >
                        <span className="font-medium truncate max-w-[200px]">
                          {company.company_name}
                        </span>
                        <button
                          type="button"
                          onClick={() => handleToggleCustomer(company.id)}
                          className="text-slate-500 hover:text-red-500 focus:outline-none ml-1"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <p className="text-xs text-slate-500 mt-2">
              Can't find the supplier you're looking for?{" "}
              <a
                href="/companies/receiving"
                className="text-slate-800 hover:underline"
              >
                Add or edit receiving companies here
              </a>
            </p>
          </CardContent>
        </Card>

        {/* Major Suppliers Allocation */}
        <Card>
          <CardHeader>
            <CardTitle>Major Suppliers</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="flex flex-col md:flex-row items-end gap-3 p-4 rounded-lg border border-slate-200 bg-slate-50">
              <div className="w-full md:flex-1 space-y-1">
                <Label className="text-xs">Search Supplier *</Label>
                <Popover
                  open={majorCustomerOpen}
                  onOpenChange={setMajorCustomerOpen}
                >
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      role="combobox"
                      aria-expanded={majorCustomerOpen}
                      className="w-full justify-between h-10"
                    >
                      {tempMajorCustomer.customer_id
                        ? receivingCompanies.find(
                            (c) => c.id === tempMajorCustomer.customer_id,
                          )?.company_name
                        : "Select supplier..."}
                      <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent
                    className="w-[300px] md:w-[400px] p-0"
                    align="start"
                  >
                    <Command>
                      <CommandInput placeholder="Search by name, GSTIN, or state..." />
                      <CommandList>
                        <CommandEmpty>No supplier found.</CommandEmpty>
                        <CommandGroup>
                          {receivingCompanies
                            .filter(
                              (company) =>
                                !majorCustomers.some(
                                  (m) => m.customer_id === company.id,
                                ),
                            )
                            .map((company) => (
                              <CommandItem
                                key={company.id}
                                value={`${company.company_name} ${company.gstin || ""} ${company.state || ""}`}
                                onSelect={() => {
                                  setTempMajorCustomer({
                                    ...tempMajorCustomer,
                                    customer_id: company.id,
                                  });
                                  setMajorCustomerOpen(false);
                                }}
                              >
                                <Check
                                  className={cn(
                                    "mr-2 h-4 w-4",
                                    tempMajorCustomer.customer_id === company.id
                                      ? "opacity-100"
                                      : "opacity-0",
                                  )}
                                />
                                <div className="flex flex-col">
                                  <span>{company.company_name}</span>
                                  <span className="text-xs text-slate-500">
                                    {company.state}{" "}
                                    {company.gstin ? `| ${company.gstin}` : ""}
                                  </span>
                                </div>
                              </CommandItem>
                            ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
              </div>

              <div className="w-full md:w-32 space-y-1">
                <Label className="text-xs">Amount *</Label>
                <Input
                  type="number"
                  min="0.01"
                  step="0.01"
                  placeholder="₹"
                  value={tempMajorCustomer.amount}
                  onChange={(e) =>
                    setTempMajorCustomer({
                      ...tempMajorCustomer,
                      amount: e.target.value,
                    })
                  }
                  className="h-10 bg-white"
                />
              </div>

              <div className="w-full md:w-24 space-y-1">
                <Label className="text-xs">Invoices *</Label>
                <Input
                  type="number"
                  min="1"
                  step="1"
                  placeholder="#"
                  value={tempMajorCustomer.invoice_count}
                  onChange={(e) =>
                    setTempMajorCustomer({
                      ...tempMajorCustomer,
                      invoice_count: e.target.value,
                    })
                  }
                  className="h-10 bg-white"
                />
              </div>

              <Button
                type="button"
                onClick={handleAddMajorCustomer}
                className="w-full md:w-auto h-10 px-6 gap-2"
              >
                <Plus className="h-4 w-4" /> Add
              </Button>
            </div>

            {/* List of Added Major Suppliers */}
            {majorCustomers.length > 0 ? (
              <div className="space-y-3">
                {majorCustomers.map((major, index) => {
                  const company = receivingCompanies.find(
                    (c) => c.id === major.customer_id,
                  );
                  return (
                    <div
                      key={index}
                      className="flex items-center justify-between p-3 rounded-lg border border-slate-200"
                    >
                      <div>
                        <p className="font-semibold text-slate-900">
                          {company?.company_name}
                        </p>
                        <p className="text-sm text-slate-500">
                          ₹{parseFloat(major.amount).toLocaleString()} •{" "}
                          {major.invoice_count} Invoices
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => handleRemoveMajorCustomer(index)}
                        className="text-red-500 hover:text-red-700 hover:bg-red-50"
                      >
                        Remove
                      </Button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-center py-6 text-slate-500 text-sm">
                No major supplier allocations configured.
              </div>
            )}
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

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="minimum-invoice-amount">
                    Minimum Invoice Amount *
                  </Label>
                  <Input
                    id="minimum-invoice-amount"
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="Enter minimum invoice amount"
                    value={formData.minimumInvoiceAmount}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        minimumInvoiceAmount: e.target.value,
                      })
                    }
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="maximum-invoice-amount">
                    Maximum Invoice Amount *
                  </Label>
                  <Input
                    id="maximum-invoice-amount"
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="Enter maximum invoice amount"
                    value={formData.maximumInvoiceAmount}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        maximumInvoiceAmount: e.target.value,
                      })
                    }
                    required
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="total-amount">Target Purchase Amount *</Label>
                  <Input
                    id="total-amount"
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="Enter target purchase amount"
                    value={formData.totalAmount}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        totalAmount: e.target.value,
                      })
                    }
                    required
                  />
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Products */}
        <Card>
          <CardHeader>
            <CardTitle>Products</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-2">
              <Label className="text-xs font-semibold">
                Search & Select Products
              </Label>
              <div className="flex gap-2">
                <Popover open={productOpen} onOpenChange={setProductOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      role="combobox"
                      aria-expanded={productOpen}
                      className="flex-1 justify-between h-10"
                    >
                      Search & Select Products...
                      <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-full p-0" align="start">
                    <Command>
                      <CommandInput placeholder="Search by name, HSN code, or unit..." />
                      <CommandList>
                        <CommandEmpty>No product found.</CommandEmpty>
                        <CommandGroup>
                          {products
                            .filter((p) =>
                              productRules.some((r) => r.product_id === p.id),
                            )
                            .map((product) => {
                              const isSelected = selectedProducts.some(
                                (p) => p.product.id === product.id,
                              );
                              return (
                                <CommandItem
                                  key={product.id}
                                  value={`${product.product_name} ${product.hsn_code} ${product.unit_of_measure}`}
                                  onSelect={() => {
                                    if (isSelected) {
                                      setSelectedProducts(
                                        selectedProducts.filter(
                                          (p) => p.product.id !== product.id,
                                        ),
                                      );
                                    } else {
                                      const rule = productRules.find(
                                        (r) => r.product_id === product.id,
                                      );
                                      setSelectedProducts([
                                        ...selectedProducts,
                                        {
                                          product,
                                          perDayQtyMin:
                                            rule?.quantity_min?.toString() ||
                                            "",
                                          perDayQtyMax:
                                            rule?.quantity_max?.toString() ||
                                            "",
                                          perDayRateMin:
                                            rule?.rate_min?.toString() || "",
                                          perDayRateMax:
                                            rule?.rate_max?.toString() || "",
                                        },
                                      ]);
                                    }
                                  }}
                                >
                                  <Check
                                    className={cn(
                                      "mr-2 h-4 w-4",
                                      isSelected ? "opacity-100" : "opacity-0",
                                    )}
                                  />
                                  <div className="flex flex-col">
                                    <span>{product.product_name}</span>
                                    <span className="text-xs text-slate-500">
                                      HSN: {product.hsn_code} | Unit:{" "}
                                      {product.unit_of_measure}
                                    </span>
                                  </div>
                                </CommandItem>
                              );
                            })}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
                <Button
                  variant="secondary"
                  className="h-10 shrink-0"
                  onClick={() => {
                    const configuredProducts = products.filter((p) =>
                      productRules.some((r) => r.product_id === p.id),
                    );
                    const newSelections = configuredProducts.map((product) => {
                      const rule = productRules.find(
                        (r) => r.product_id === product.id,
                      );
                      return {
                        product,
                        perDayQtyMin: rule?.quantity_min?.toString() || "",
                        perDayQtyMax: rule?.quantity_max?.toString() || "",
                        perDayRateMin: rule?.rate_min?.toString() || "",
                        perDayRateMax: rule?.rate_max?.toString() || "",
                      };
                    });
                    setSelectedProducts(newSelections);
                  }}
                >
                  Select All
                </Button>
              </div>
            </div>

            {/* Selected Products Cards */}
            {selectedProducts.length > 0 && (
              <div className="space-y-3">
                <Label className="text-sm font-medium text-slate-700">
                  Selected Products ({selectedProducts.length})
                </Label>
                <div className="flex flex-wrap gap-2">
                  {selectedProducts.map((item) => (
                    <div
                      key={item.product.id}
                      className="flex items-center gap-2 pl-3 pr-1 py-1 bg-slate-100 border border-slate-200 rounded-full text-sm"
                    >
                      <span className="font-medium text-slate-800">
                        {item.product.product_name}
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => handleRemoveProduct(item.product.id)}
                        className="h-5 w-5 p-0 rounded-full hover:bg-slate-200 text-slate-500 hover:text-slate-700"
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Product Occurrence Configuration Card */}
        {selectedProducts.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Product Occurrence Configuration</CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-4">
                <p className="text-sm text-slate-500">
                  Configure the frequency (occurrence percentage) for each
                  product to appear in the generated invoices. Products without
                  an occurrence configuration will automatically use the default
                  random probability (50%).
                </p>

                {/* Add Occurrence Configuration Form */}
                <div className="flex flex-col md:flex-row items-end gap-3 p-4 rounded-lg border border-slate-200 bg-slate-50">
                  <div className="w-full md:flex-1 space-y-1">
                    <Label className="text-xs">Search Product *</Label>
                    <Popover
                      open={occurrenceProductOpen}
                      onOpenChange={setOccurrenceProductOpen}
                    >
                      <PopoverTrigger asChild>
                        <Button
                          variant="outline"
                          role="combobox"
                          aria-expanded={occurrenceProductOpen}
                          className="w-full justify-between h-10 bg-white"
                        >
                          {selectedOccurProduct
                            ? selectedProducts.find(
                                (c) => c.product.id === selectedOccurProduct,
                              )?.product.product_name
                            : "Select product..."}
                          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent
                        className="w-[300px] md:w-[400px] p-0"
                        align="start"
                      >
                        <Command>
                          <CommandInput placeholder="Search selected products..." />
                          <CommandList>
                            <CommandEmpty>No product found.</CommandEmpty>
                            <CommandGroup>
                              {selectedProducts
                                .filter(
                                  (item) =>
                                    item.product.id !== selectedOccurProduct &&
                                    !item.occurrencePercentage,
                                )
                                .map((item) => (
                                  <CommandItem
                                    key={item.product.id}
                                    value={`${item.product.product_name} ${item.product.hsn_code}`}
                                    onSelect={() => {
                                      setSelectedOccurProduct(item.product.id);
                                      setOccurrenceProductOpen(false);
                                    }}
                                  >
                                    <Check
                                      className={cn(
                                        "mr-2 h-4 w-4",
                                        selectedOccurProduct === item.product.id
                                          ? "opacity-100"
                                          : "opacity-0",
                                      )}
                                    />
                                    <div className="flex flex-col">
                                      <span>{item.product.product_name}</span>
                                      <span className="text-xs text-slate-500">
                                        HSN: {item.product.hsn_code}
                                      </span>
                                    </div>
                                  </CommandItem>
                                ))}
                            </CommandGroup>
                          </CommandList>
                        </Command>
                      </PopoverContent>
                    </Popover>
                  </div>

                  <div className="w-full md:w-32 space-y-1">
                    <Label className="text-xs">Occurrence % *</Label>
                    <div className="relative">
                      <Input
                        type="number"
                        min="0"
                        max="100"
                        step="1"
                        placeholder="e.g. 80"
                        value={occurPercent}
                        onChange={(e) => setOccurPercent(e.target.value)}
                        className="h-10 bg-white pr-8"
                      />
                      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500">
                        %
                      </span>
                    </div>
                  </div>

                  <Button
                    type="button"
                    onClick={() => {
                      if (!selectedOccurProduct) {
                        setErrorPopup("Please select a product first.");
                        return;
                      }
                      const pct = parseFloat(occurPercent);
                      if (isNaN(pct) || pct < 0 || pct > 100) {
                        setErrorPopup(
                          "Occurrence percentage must be between 0 and 100.",
                        );
                        return;
                      }
                      setSelectedProducts(
                        selectedProducts.map((item) =>
                          item.product.id === selectedOccurProduct
                            ? { ...item, occurrencePercentage: occurPercent }
                            : item,
                        ),
                      );
                      setSelectedOccurProduct("");
                      setOccurPercent("");
                    }}
                    className="w-full md:w-auto h-10 px-6 gap-2"
                  >
                    <Plus className="h-4 w-4" /> Add Configuration
                  </Button>
                </div>

                {/* Configured Occurrences List */}
                <div className="space-y-3">
                  {selectedProducts.filter(
                    (item) =>
                      item.occurrencePercentage !== undefined &&
                      item.occurrencePercentage !== null &&
                      item.occurrencePercentage !== "",
                  ).length > 0 ? (
                    <div className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
                      {selectedProducts
                        .filter(
                          (item) =>
                            item.occurrencePercentage !== undefined &&
                            item.occurrencePercentage !== null &&
                            item.occurrencePercentage !== "",
                        )
                        .map((item) => (
                          <div
                            key={item.product.id}
                            className="flex items-center justify-between p-3"
                          >
                            <div>
                              <p className="font-semibold text-slate-900">
                                {item.product.product_name}
                              </p>
                              <p className="text-sm text-indigo-600 font-medium">
                                {item.occurrencePercentage}% Occurrence
                              </p>
                            </div>
                            <div className="flex items-center gap-2">
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() => {
                                  setSelectedOccurProduct(item.product.id);
                                  setOccurPercent(
                                    item.occurrencePercentage || "",
                                  );
                                  setSelectedProducts(
                                    selectedProducts.map((p) =>
                                      p.product.id === item.product.id
                                        ? {
                                            ...p,
                                            occurrencePercentage: undefined,
                                          }
                                        : p,
                                    ),
                                  );
                                }}
                                className="text-slate-600 hover:text-slate-900 hover:bg-slate-50"
                              >
                                Edit
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() => {
                                  setSelectedProducts(
                                    selectedProducts.map((p) =>
                                      p.product.id === item.product.id
                                        ? {
                                            ...p,
                                            occurrencePercentage: undefined,
                                          }
                                        : p,
                                    ),
                                  );
                                }}
                                className="text-red-500 hover:text-red-700 hover:bg-red-50"
                              >
                                Remove
                              </Button>
                            </div>
                          </div>
                        ))}
                    </div>
                  ) : (
                    <div className="text-center py-6 text-slate-500 text-sm border border-dashed rounded-lg border-slate-200 bg-slate-50/50">
                      No custom product occurrences configured. All products
                      will default to random probability (50%).
                    </div>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Other Details */}
        <Card>
          <CardHeader>
            <CardTitle>Other Details</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="transport-mode">Transportation Mode</Label>
                <Input
                  id="transport-mode"
                  value={formData.transportMode}
                  disabled
                  readOnly
                  className="bg-slate-50"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="vehicle-number">Vehicle Number</Label>
                <Input
                  id="vehicle-number"
                  placeholder="Enter vehicle number"
                  value={formData.vehicleNumber}
                  onChange={(e) =>
                    setFormData({ ...formData, vehicleNumber: e.target.value })
                  }
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="date-of-supply">
                  Date of Supply (On or Before)
                </Label>
                <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-slate-500 flex flex-col justify-center min-h-[44px]">
                  <span className="text-[10px] font-bold text-slate-400 tracking-wide uppercase">
                    AUTO GENERATED
                  </span>
                  <span className="text-xs mt-0.5">
                    Date of Supply will automatically match each generated
                    invoice date.
                  </span>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Purchase Value Calculator Card */}
        <Card
          className={cn(
            "border shadow-sm transition-colors duration-200",
            status === "valid" &&
              "bg-green-50/70 border-green-200 text-green-950",
            status === "incomplete" &&
              "bg-amber-50/70 border-amber-200 text-amber-900",
            status === "invalid" && "bg-red-50/70 border-red-200 text-red-950",
          )}
        >
          <CardHeader className="pb-3 border-b border-slate-100">
            <CardTitle className="text-base font-semibold flex items-center gap-2">
              Purchase Planning Assistant - Summary
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-4 space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-6 text-sm">
              <div className="space-y-1">
                <span className="text-xs text-slate-500 font-medium block">
                  Target Purchase Amount
                </span>
                <span className="text-lg font-mono font-semibold text-slate-900">
                  ₹
                  {totalAmount.toLocaleString("en-IN", {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </span>
              </div>
              <div className="space-y-1">
                <span className="text-xs text-slate-500 font-medium block">
                  Estimated Invoice Count
                </span>
                <span className="text-lg font-semibold text-slate-900">
                  {estimatedInvoices} Invoices
                </span>
              </div>
              <div className="space-y-1">
                <span className="text-xs text-slate-500 font-medium block">
                  Selected Products
                </span>
                <span className="text-lg font-semibold text-slate-900">
                  {selectedCount} Products
                </span>
              </div>
              <div className="space-y-1">
                <span className="text-xs text-slate-500 font-medium block">
                  Est. Minimum Purchase Value
                </span>
                <span className="text-lg font-mono font-semibold text-slate-900">
                  ₹
                  {batchMin.toLocaleString("en-IN", {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </span>
              </div>
              <div className="space-y-1">
                <span className="text-xs text-slate-500 font-medium block">
                  Est. Maximum Purchase Value
                </span>
                <span className="text-lg font-mono font-semibold text-slate-900">
                  ₹
                  {batchMax.toLocaleString("en-IN", {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </span>
              </div>
              <div className="space-y-1">
                <span className="text-xs text-slate-500 font-medium block mb-1">
                  Validation Status
                </span>
                <span
                  className={cn(
                    "font-semibold text-xs px-2.5 py-1 rounded-full inline-block uppercase tracking-wider",
                    status === "valid" && "bg-green-100 text-green-800",
                    status === "incomplete" && "bg-amber-100 text-amber-800",
                    status === "invalid" && "bg-red-100 text-red-800",
                  )}
                >
                  {status === "valid" && "✅ Ready to Generate"}
                  {status === "incomplete" && "⚠️ Incomplete Details"}
                  {status === "invalid" && "❌ Invalid Budget Range"}
                </span>
              </div>
            </div>

            {status === "invalid" && (
              <div className="p-3 bg-red-100/80 rounded-lg border border-red-200 text-xs text-red-800 font-medium mt-4">
                The requested Target Purchase Amount cannot be achieved using
                the configured Product Rules. Please adjust either the Target
                Purchase Amount or the Min/Max Invoice limits.
              </div>
            )}
          </CardContent>
        </Card>

        {/* Product Contribution Breakdown Card */}
        {selectedProducts.length > 0 && (
          <Card className="border shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-semibold">
                Product Constraints & Occurrence
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Desktop Table View */}
              <div className="hidden sm:block overflow-x-auto border rounded-lg border-slate-200">
                <table className="w-full text-xs text-left text-slate-600 border-collapse">
                  <thead className="bg-slate-50 font-medium text-slate-500 border-b border-slate-200">
                    <tr>
                      <th className="px-4 py-2.5">Product Name</th>
                      <th className="px-4 py-2.5 text-right">Occurrence %</th>
                      <th className="px-4 py-2.5 text-right">Min Qty / Day</th>
                      <th className="px-4 py-2.5 text-right">Max Qty / Day</th>
                      <th className="px-4 py-2.5 text-right">Min Rate</th>
                      <th className="px-4 py-2.5 text-right">Max Rate</th>
                      <th className="px-4 py-2.5 text-right font-medium text-slate-800">
                        Min Val / Day
                      </th>
                      <th className="px-4 py-2.5 text-right font-medium text-slate-800">
                        Max Val / Day
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {productBreakdown.map((item) => (
                      <tr
                        key={item.product_id}
                        onClick={() => handleProductRowClick(item.product_id)}
                        className="hover:bg-slate-50/80 cursor-pointer transition-colors"
                      >
                        <td className="px-4 py-2.5 font-medium text-slate-800 flex items-center gap-1.5">
                          <span>{item.product_name}</span>
                          <span className="text-[10px] text-slate-400 font-normal">
                            ({item.unit})
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono">
                          {item.occurrence_percentage
                            ? `${item.occurrence_percentage}%`
                            : "Default (50%)"}
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono">
                          {item.min_qty.toFixed(2)}
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono">
                          {item.max_qty.toFixed(2)}
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono">
                          ₹{item.min_rate.toFixed(2)}
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono">
                          ₹{item.max_rate.toFixed(2)}
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono font-medium text-slate-900 bg-slate-50/30">
                          ₹
                          {item.min_val.toLocaleString("en-IN", {
                            minimumFractionDigits: 2,
                          })}
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono font-medium text-slate-900 bg-slate-50/30">
                          ₹
                          {item.max_val.toLocaleString("en-IN", {
                            minimumFractionDigits: 2,
                          })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Mobile Card-based View */}
              <div className="block sm:hidden space-y-3">
                {productBreakdown.map((item) => (
                  <div
                    key={item.product_id}
                    onClick={() => handleProductRowClick(item.product_id)}
                    className="p-3 border rounded-lg bg-slate-50/50 hover:bg-slate-50 cursor-pointer transition-colors space-y-2"
                  >
                    <div className="flex justify-between items-center">
                      <span className="font-semibold text-slate-800">
                        {item.product_name}
                      </span>
                      <span className="text-[11px] text-slate-500 font-mono">
                        Occurrence:{" "}
                        {item.occurrence_percentage
                          ? `${item.occurrence_percentage}%`
                          : "Default (50%)"}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-[11px]">
                      <div>
                        <span className="text-slate-400 block">
                          Min Val/Day ({item.min_qty} {item.unit})
                        </span>
                        <span className="font-bold font-mono text-slate-800">
                          ₹
                          {item.min_val.toLocaleString("en-IN", {
                            minimumFractionDigits: 2,
                          })}
                        </span>
                      </div>
                      <div>
                        <span className="text-slate-400 block">
                          Max Val/Day ({item.max_qty} {item.unit})
                        </span>
                        <span className="font-bold font-mono text-slate-800">
                          ₹
                          {item.max_val.toLocaleString("en-IN", {
                            minimumFractionDigits: 2,
                          })}
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Contribution Totals Section */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pt-3 border-t border-slate-200 text-sm">
                <span className="text-slate-500 font-medium">
                  Batch Possible Range
                </span>
                <div className="flex flex-col sm:flex-row gap-4 sm:text-right">
                  <div>
                    <span className="text-xs text-slate-400 block">
                      Total Minimum Achievable Value
                    </span>
                    <span className="font-semibold font-mono text-slate-800">
                      ₹
                      {batchMin.toLocaleString("en-IN", {
                        minimumFractionDigits: 2,
                      })}
                    </span>
                  </div>
                  <div>
                    <span className="text-xs text-slate-400 block">
                      Total Maximum Achievable Value
                    </span>
                    <span className="font-semibold font-mono text-slate-800">
                      ₹
                      {batchMax.toLocaleString("en-IN", {
                        minimumFractionDigits: 2,
                      })}
                    </span>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Submit Button */}
      <div className="mt-8 flex flex-col items-end gap-2">
        <Button
          onClick={handleSubmit}
          size="lg"
          className="px-8"
          type="button"
          disabled={isValidating || isInvalid}
          title={
            isInvalid
              ? "Purchase amount is outside the mathematically achievable range."
              : undefined
          }
        >
          {isValidating ? (
            <>
              <Loader2 className="mr-2 h-5 w-5 animate-spin" />
              Validating...
            </>
          ) : (
            "Generate Purchase Split-ups"
          )}
        </Button>
        {isInvalid && (
          <p className="text-xs text-red-600 font-medium">
            Purchase amount is outside the mathematically achievable range.
          </p>
        )}
      </div>

      {/* Popup Dialog */}
      <Dialog
        open={!!errorPopup}
        onOpenChange={(open) => !open && setErrorPopup(null)}
      >
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle
              className={cn(
                "flex items-center gap-2",
                errorPopup?.includes("successfully")
                  ? "text-green-600"
                  : "text-red-600",
              )}
            >
              {errorPopup?.includes("successfully") ? (
                <CheckCircle2 className="w-5 h-5" />
              ) : (
                <svg
                  className="w-5 h-5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  xmlns="http://www.w3.org/2000/svg"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
              )}
              {errorPopup?.includes("successfully")
                ? "Success"
                : "Validation Error"}
            </DialogTitle>
          </DialogHeader>
          <div className="py-2">
            <p className="text-sm text-slate-700">{errorPopup}</p>
          </div>
          <DialogFooter>
            <Button onClick={() => setErrorPopup(null)}>OK</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
