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
    recurringProducts,
    recurringProductOpen,
    setRecurringProductOpen,
    tempRecurringProduct,
    setTempRecurringProduct,
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
    handleAddRecurringProduct,
    handleRemoveRecurringProduct,
    handleSubmit,
  } = useInvoiceForm({ batchType: "PURCHASE" });

  return (
    <div>
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
                                          monthlyQty: "",
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
                        monthlyQty: "",
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

        {/* Monthly Purchase Quantities */}
        {selectedProducts.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Monthly Purchase Quantities</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <p className="text-sm text-slate-500">
                  Enter the actual total quantity purchased for each selected
                  product during this month.
                </p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {selectedProducts.map((item, idx) => (
                    <div
                      key={item.product.id}
                      className="space-y-2 p-3 border rounded-lg bg-slate-50/50"
                    >
                      <Label
                        htmlFor={`monthly-qty-${item.product.id}`}
                        className="font-semibold text-slate-700"
                      >
                        {item.product.product_name} (
                        {item.product.unit_of_measure})
                      </Label>
                      <Input
                        type="number"
                        id={`monthly-qty-${item.product.id}`}
                        placeholder={`Enter quantity in ${item.product.unit_of_measure}`}
                        value={item.monthlyQty || ""}
                        onChange={(e) => {
                          const updated = [...selectedProducts];
                          updated[idx] = {
                            ...updated[idx],
                            monthlyQty: e.target.value,
                          };
                          setSelectedProducts(updated);
                        }}
                        className="bg-white border-slate-200"
                        min="0.01"
                        step="0.01"
                        required
                      />
                    </div>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Recurring Products */}
        <Card>
          <CardHeader>
            <CardTitle>Recurring Products</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="flex flex-col md:flex-row items-end gap-3 p-4 rounded-lg border border-slate-200 bg-slate-50">
              <div className="w-full md:flex-1 space-y-1">
                <Label className="text-xs">Search Product *</Label>
                <Popover
                  open={recurringProductOpen}
                  onOpenChange={setRecurringProductOpen}
                >
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      role="combobox"
                      aria-expanded={recurringProductOpen}
                      className="w-full justify-between h-10 bg-white"
                    >
                      {tempRecurringProduct.product_id
                        ? products.find(
                            (c) => c.id === tempRecurringProduct.product_id,
                          )?.product_name
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
                                !recurringProducts.some(
                                  (r) => r.product_id === item.product.id,
                                ),
                            )
                            .map((item) => (
                              <CommandItem
                                key={item.product.id}
                                value={`${item.product.product_name} ${item.product.hsn_code}`}
                                onSelect={() => {
                                  setTempRecurringProduct({
                                    ...tempRecurringProduct,
                                    product_id: item.product.id,
                                  });
                                  setRecurringProductOpen(false);
                                }}
                              >
                                <Check
                                  className={cn(
                                    "mr-2 h-4 w-4",
                                    tempRecurringProduct.product_id ===
                                      item.product.id
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
                <Label className="text-xs">Percentage *</Label>
                <div className="relative">
                  <Input
                    type="number"
                    min="1"
                    max="100"
                    step="1"
                    placeholder="e.g. 60"
                    value={tempRecurringProduct.percentage}
                    onChange={(e) =>
                      setTempRecurringProduct({
                        ...tempRecurringProduct,
                        percentage: e.target.value,
                      })
                    }
                    className="h-10 bg-white pr-8"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500">
                    %
                  </span>
                </div>
              </div>

              <Button
                type="button"
                onClick={handleAddRecurringProduct}
                className="w-full md:w-auto h-10 px-6 gap-2"
              >
                <Plus className="h-4 w-4" /> Add
              </Button>
            </div>

            {/* List of Added Recurring Products */}
            {recurringProducts.length > 0 ? (
              <div className="space-y-3">
                {recurringProducts.map((rp, index) => {
                  const product = products.find((p) => p.id === rp.product_id);
                  return (
                    <div
                      key={index}
                      className="flex items-center justify-between p-3 rounded-lg border border-slate-200"
                    >
                      <div>
                        <p className="font-semibold text-slate-900">
                          {product?.product_name}
                        </p>
                        <p className="text-sm text-slate-500">
                          {rp.percentage}% Likelihood
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          handleRemoveRecurringProduct(rp.product_id)
                        }
                        className="text-red-500 hover:text-red-700 hover:bg-red-50"
                      >
                        Remove
                      </Button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-center py-6 text-slate-500 text-sm border border-dashed rounded-lg border-slate-200">
                No recurring products configured.
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
            "Create Purchase Batch"
          )}
        </Button>
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
