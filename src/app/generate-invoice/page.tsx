"use client";

import {
  Check,
  CheckCircle2,
  ChevronsUpDown,
  Loader2,
  Plus,
  X,
  Package,
  Calendar,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { DailyStockReviewModal } from "@/components/DailyStockReviewModal";
import { SalesPlanningAssistant } from "@/components/SalesPlanningAssistant";
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
import { ValidationGuidanceModal } from "@/components/ValidationGuidanceModal";
import { CategorySplitSection } from "@/components/CategorySplitSection";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

interface InventorySourceItem {
  id: string;
  title: string;
  remainingQty: number;
  dateLabel: string;
  sourceType: "Purchase Batch" | "Carry Forward";
}

export default function GenerateInvoice() {
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
    isReviewOpen,
    setIsReviewOpen,
    reviewRows,
    setReviewRows,
    proposedInvoices,
    isSavingSales,
    handleSaveSalesBatch,
    validationGuidance,
    setValidationGuidance,
    handleApplySuggestedLimits,
    categorySplits,
    setCategorySplits,
    sequencePreview,
  } = useInvoiceForm({ batchType: "SALES" });

  const [finalizedPurchaseBatches, setFinalizedPurchaseBatches] = useState<
    any[]
  >([]);
  const [availableSources, setAvailableSources] = useState<
    InventorySourceItem[]
  >([]);
  const [selectedSourceIds, setSelectedSourceIds] = useState<string[]>([]);
  const [stockSummary, setStockSummary] = useState<any[]>([]);
  const [purchaseBatchDetails, setPurchaseBatchDetails] = useState<any | null>(
    null,
  );
  const [isLoadingSummary, setIsLoadingSummary] = useState(false);

  // Fetch active finalized purchase batches & ledger to build non-depleted inventory sources
  useEffect(() => {
    const fetchAvailableSources = async () => {
      const supabase = createClient();
      const [{ data: batches }, { data: ledgerRows }] = await Promise.all([
        supabase
          .from("invoice_batch")
          .select(
            "id, total_amount, invoice_date_from, invoice_date_to, financial_year, products",
          )
          .eq("batch_type", "PURCHASE")
          .eq("batch_status", "FINALIZED")
          .order("invoice_date_from", { ascending: false }),
        supabase
          .from("daily_stock_ledger")
          .select(
            "purchase_batch_id, purchased_quantity, sold_quantity, opening_stock, ledger_date",
          ),
      ]);

      const allBatches = batches || [];
      setFinalizedPurchaseBatches(allBatches);

      const batchLedgerMap = new Map<
        string,
        { purchased: number; sold: number }
      >();
      const monthlyCarryMap = new Map<string, number>();

      for (const r of ledgerRows || []) {
        if (r.purchase_batch_id) {
          const item = batchLedgerMap.get(r.purchase_batch_id) || {
            purchased: 0,
            sold: 0,
          };
          item.purchased += Number(r.purchased_quantity || 0);
          item.sold += Number(r.sold_quantity || 0);
          batchLedgerMap.set(r.purchase_batch_id, item);
        }

        if (r.ledger_date && Number(r.opening_stock) > 0) {
          const mKey = r.ledger_date.slice(0, 7);
          monthlyCarryMap.set(
            mKey,
            (monthlyCarryMap.get(mKey) || 0) + Number(r.opening_stock || 0),
          );
        }
      }

      const sources: InventorySourceItem[] = [];

      // 1. Purchase Batches with remaining stock > 0
      for (const b of allBatches) {
        const item = batchLedgerMap.get(b.id) || { purchased: 0, sold: 0 };
        const rem = Math.max(0, item.purchased - item.sold);
        if (rem > 0.001) {
          const monthLabel = b.invoice_date_from
            ? b.invoice_date_from.slice(0, 7)
            : "N/A";
          sources.push({
            id: b.id,
            title: `Purchase Batch - ${monthLabel}`,
            remainingQty: Math.round(rem * 100) / 100,
            dateLabel: `${b.invoice_date_from || "N/A"} (${b.financial_year || "FY"})`,
            sourceType: "Purchase Batch",
          });
        }
      }

      // 2. Carry Forward Sources with remaining stock > 0
      for (const [mKey, cfQty] of monthlyCarryMap.entries()) {
        if (cfQty > 0.001) {
          sources.push({
            id: `CARRY_FORWARD_${mKey}`,
            title: `Carry Forward - ${mKey}`,
            remainingQty: Math.round(cfQty * 100) / 100,
            dateLabel: "Previous Period Carry Forward",
            sourceType: "Carry Forward",
          });
        }
      }

      setAvailableSources(sources);
    };

    fetchAvailableSources();
  }, []);

  // Sync selectedSourceIds with formData.stockSourceBatchId
  const toggleSourceSelection = (sourceId: string) => {
    let updated: string[];
    if (selectedSourceIds.includes(sourceId)) {
      updated = selectedSourceIds.filter((id) => id !== sourceId);
    } else {
      updated = [...selectedSourceIds, sourceId];
    }
    setSelectedSourceIds(updated);

    const joinedIds = updated.join(",");
    setFormData({
      ...formData,
      stockSourceBatchId: joinedIds,
    });
  };

  useEffect(() => {
    if (!formData.stockSourceBatchId) {
      setStockSummary([]);
      setPurchaseBatchDetails(null);
      return;
    }

    const fetchStockSummary = async () => {
      setIsLoadingSummary(true);
      try {
        const res = await fetch(
          `/api/get-purchase-batch-stock-summary?batchId=${formData.stockSourceBatchId}`,
        );
        const result = await res.json();
        if (res.ok) {
          setStockSummary(result.summary || []);
          setPurchaseBatchDetails(result.batchDetails || null);
        } else {
          console.error(result.message);
        }
      } catch (err) {
        console.error(err);
      } finally {
        setIsLoadingSummary(false);
      }
    };

    fetchStockSummary();
  }, [formData.stockSourceBatchId]);

  return (
    <div className="space-y-4 pb-10">
      <h1 className="text-xl font-bold text-slate-900 tracking-tight">
        Sales Invoice
      </h1>

      <div
        className={cn(
          "space-y-4",
          isValidating && "opacity-60 pointer-events-none",
        )}
      >
        {/* Financial Year */}
        <Card className="border border-slate-200 shadow-2xs bg-white rounded-md">
          <CardHeader className="p-3 pb-2 border-b border-slate-100">
            <CardTitle className="text-xs font-semibold text-slate-700 uppercase tracking-wider">
              Financial Year
            </CardTitle>
          </CardHeader>
          <CardContent className="p-3.5">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
              <div className="space-y-1">
                <Label htmlFor="financial-year-start" className="text-xs">
                  Start Year *
                </Label>
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
                  className="h-8 text-xs rounded-md"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="financial-year-end" className="text-xs">
                  End Year
                </Label>
                <Input
                  id="financial-year-end"
                  type="number"
                  value={formData.financialYearEnd}
                  disabled
                  className="bg-slate-50 h-8 text-xs rounded-md"
                />
              </div>
              <div className="md:col-span-2 mt-1">
                <span className="text-xs font-medium text-slate-500">
                  Live Preview:{" "}
                </span>
                <span className="text-xs font-bold text-slate-900 font-mono">
                  FY{formData.financialYearStart}-
                  {String(formData.financialYearEnd).slice(2)}
                </span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Inventory Source Configuration (Cards / Chips) */}
        <Card className="border border-slate-200 shadow-2xs bg-white rounded-md">
          <CardHeader className="p-3 pb-2 border-b border-slate-100 flex flex-row items-center justify-between">
            <CardTitle className="text-xs font-semibold text-slate-700 uppercase tracking-wider">
              Inventory Sources (Select One or Multiple) *
            </CardTitle>
            {selectedSourceIds.length > 0 && (
              <span className="text-[11px] font-semibold text-slate-700 bg-slate-100 px-2 py-0.5 rounded-xs">
                {selectedSourceIds.length} Selected
              </span>
            )}
          </CardHeader>
          <CardContent className="p-3.5 space-y-3">
            {availableSources.length === 0 ? (
              <div className="p-4 border border-slate-200 rounded-md bg-slate-50 text-xs text-slate-500 text-center">
                No active inventory sources with available stock found. Please
                generate and finalize a Purchase Batch first.
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
                {availableSources.map((source) => {
                  const isSelected = selectedSourceIds.includes(source.id);
                  return (
                    <div
                      key={source.id}
                      onClick={() => toggleSourceSelection(source.id)}
                      className={cn(
                        "p-3 rounded-md border text-xs cursor-pointer transition-all space-y-2 select-none",
                        isSelected
                          ? "border-slate-800 bg-slate-900 text-white shadow-2xs"
                          : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50/60 text-slate-800",
                      )}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 font-semibold truncate">
                          <span
                            className={cn(
                              "w-4 h-4 rounded-xs border flex items-center justify-center text-[10px] shrink-0",
                              isSelected
                                ? "bg-white border-white text-slate-900 font-bold"
                                : "border-slate-300 bg-white text-transparent",
                            )}
                          >
                            ✓
                          </span>
                          <span className="truncate">{source.title}</span>
                        </div>
                        <span
                          className={cn(
                            "text-[10px] font-bold px-1.5 py-0.5 rounded-xs shrink-0",
                            isSelected
                              ? "bg-slate-800 text-slate-200"
                              : "bg-slate-100 text-slate-700",
                          )}
                        >
                          {source.sourceType}
                        </span>
                      </div>

                      <div className="flex justify-between items-end">
                        <div>
                          <span
                            className={cn(
                              "text-[10px] uppercase font-semibold block",
                              isSelected ? "text-slate-400" : "text-slate-500",
                            )}
                          >
                            Remaining Stock
                          </span>
                          <span className="font-mono font-bold text-sm">
                            {source.remainingQty.toLocaleString("en-IN")} KG
                          </span>
                        </div>
                        <span
                          className={cn(
                            "text-[11px]",
                            isSelected ? "text-slate-400" : "text-slate-500",
                          )}
                        >
                          {source.dateLabel}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {isLoadingSummary && (
              <div className="text-xs text-slate-500 py-1 flex items-center gap-2">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Loading aggregated stock summary...
              </div>
            )}

            {!isLoadingSummary && stockSummary.length > 0 && (
              <div className="mt-3 border rounded-md border-slate-200 overflow-hidden">
                <div className="bg-slate-50 border-b border-slate-200 px-3 py-1.5 font-semibold text-[11px] text-slate-700 uppercase tracking-wider">
                  Aggregated Available Inventory Summary (Read-Only)
                </div>
                <table className="w-full text-xs text-left text-slate-600 border-collapse">
                  <thead className="bg-slate-50/50 font-medium text-slate-500 border-b border-slate-100">
                    <tr>
                      <th className="px-3 py-1.5">Product</th>
                      <th className="px-3 py-1.5 text-right">
                        Carry Forward Stock
                      </th>
                      <th className="px-3 py-1.5 text-right">
                        Purchased Stock
                      </th>
                      <th className="px-3 py-1.5 text-right font-semibold text-slate-900">
                        Total Available
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {stockSummary.map((item) => (
                      <tr
                        key={item.product_id}
                        className="hover:bg-slate-50/30"
                      >
                        <td className="px-3 py-1.5 font-medium text-slate-800">
                          {item.product_name}
                        </td>
                        <td className="px-3 py-1.5 text-right font-mono">
                          {item.carry_forward.toFixed(2)} {item.unit}
                        </td>
                        <td className="px-3 py-1.5 text-right font-mono">
                          {item.purchased.toFixed(2)} {item.unit}
                        </td>
                        <td className="px-3 py-1.5 text-right font-mono font-semibold text-slate-900">
                          {item.total_available.toFixed(2)} {item.unit}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Sender Company (Issuing Invoice) */}
        <Card className="border border-slate-200 shadow-2xs bg-white rounded-md">
          <CardHeader className="p-3 pb-2 border-b border-slate-100">
            <CardTitle className="text-xs font-semibold text-slate-700 uppercase tracking-wider">
              Company Issuing Invoice
            </CardTitle>
          </CardHeader>
          <CardContent className="p-3.5">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
              <div className="space-y-1 md:col-span-2">
                <Label htmlFor="issuing-company">Select Company *</Label>
                <Popover
                  open={issuingCompanyOpen}
                  onOpenChange={setIssuingCompanyOpen}
                >
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      role="combobox"
                      aria-expanded={issuingCompanyOpen}
                      className="w-full justify-between h-8 text-xs rounded-md"
                    >
                      {selectedIssuingCompany
                        ? selectedIssuingCompany.company_name
                        : "Select issuing company..."}
                      <ChevronsUpDown className="ml-2 h-3.5 w-3.5 shrink-0 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent
                    className="w-[300px] md:w-[500px] p-0"
                    align="start"
                  >
                    <Command>
                      <CommandInput placeholder="Search by name, GSTIN, or state..." />
                      <CommandList>
                        <CommandEmpty>No issuing company found.</CommandEmpty>
                        <CommandGroup>
                          {issuingCompanies.map((company) => (
                            <CommandItem
                              key={company.id}
                              value={`${company.company_name} ${company.gstin || ""} ${company.branch || ""}`}
                              onSelect={() => {
                                handleIssuingCompanyChange(company.id);
                                setIssuingCompanyOpen(false);
                              }}
                            >
                              <Check
                                className={cn(
                                  "mr-2 h-4 w-4",
                                  selectedIssuingCompany?.id === company.id
                                    ? "opacity-100"
                                    : "opacity-0",
                                )}
                              />
                              <div className="flex flex-col">
                                <span>{company.company_name}</span>
                                <span className="text-xs text-slate-500">
                                  {company.branch || company.address}{" "}
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

              {selectedIssuingCompany && (
                <>
                  <div className="space-y-1">
                    <Label>Branch</Label>
                    <Input
                      value={selectedIssuingCompany.branch || ""}
                      disabled
                      className="bg-slate-50 h-8 text-xs rounded-md"
                    />
                  </div>

                  <div className="space-y-1">
                    <Label>GSTIN</Label>
                    <Input
                      value={selectedIssuingCompany.gstin}
                      disabled
                      className="bg-slate-50 h-8 text-xs rounded-md"
                    />
                  </div>

                  <div className="space-y-1">
                    <Label>Address</Label>
                    <Input
                      value={selectedIssuingCompany.address}
                      disabled
                      className="bg-slate-50 h-8 text-xs rounded-md"
                    />
                  </div>

                  <div className="space-y-1">
                    <Label>PAN</Label>
                    <Input
                      value={selectedIssuingCompany.pan}
                      disabled
                      className="bg-slate-50 h-8 text-xs rounded-md"
                    />
                  </div>

                  {sequencePreview && (
                    <div className="col-span-1 md:col-span-2 pt-2 border-t border-slate-100 space-y-2">
                      <Label className="text-xs font-semibold text-slate-700">
                        Invoice Sequence Preview
                      </Label>
                      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                        <div className="space-y-1 sm:col-span-2">
                          <Label className="text-[11px] text-slate-500 font-medium">
                            Invoice Number
                          </Label>
                          <Input
                            value={sequencePreview.nextInvoiceNumber}
                            disabled
                            className="bg-slate-50 h-8 text-xs font-mono font-semibold text-slate-900 rounded-md"
                          />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-[11px] text-slate-500 font-medium">
                            Current Sequence
                          </Label>
                          <Input
                            value={
                              sequencePreview.currentSequenceNumber > 0
                                ? sequencePreview.currentSequenceNumber
                                : "—"
                            }
                            disabled
                            className="bg-slate-50 h-8 text-xs font-mono text-slate-700 rounded-md"
                          />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-[11px] text-slate-500 font-medium">
                            Next Sequence
                          </Label>
                          <Input
                            value={sequencePreview.nextSequenceNumber}
                            disabled
                            className="bg-slate-50 h-8 text-xs font-mono text-slate-700 rounded-md"
                          />
                        </div>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Customers */}
        <Card className="border border-slate-200 shadow-2xs bg-white rounded-md">
          <CardHeader className="p-3 pb-2 border-b border-slate-100 flex flex-row items-center justify-between">
            <CardTitle className="text-xs font-semibold text-slate-700 uppercase tracking-wider">
              Customers
            </CardTitle>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleSelectAllCustomers}
              className="h-6 text-xs px-2"
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
          <CardContent className="p-3.5 space-y-3">
            <Popover open={customerOpen} onOpenChange={setCustomerOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  role="combobox"
                  aria-expanded={customerOpen}
                  className="w-full justify-between h-8 text-xs rounded-md"
                >
                  Search & Select Customers...
                  <ChevronsUpDown className="ml-2 h-3.5 w-3.5 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-full p-0" align="start">
                <Command>
                  <CommandInput placeholder="Search by name, GSTIN, or state..." />
                  <CommandList>
                    <CommandEmpty>No customer found.</CommandEmpty>
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

            {/* Selected Customers Chips */}
            {selectedCustomers.length > 0 && (
              <div className="space-y-1">
                <Label className="text-xs font-medium text-slate-700">
                  Selected Customers ({selectedCustomers.length})
                </Label>
                <div className="flex flex-wrap gap-1.5">
                  {selectedCustomers.map((id) => {
                    const company = receivingCompanies.find((c) => c.id === id);
                    if (!company) return null;
                    return (
                      <div
                        key={company.id}
                        className="flex items-center gap-1 bg-slate-100 text-slate-800 px-2.5 py-1 rounded-md text-xs border border-slate-200"
                      >
                        <span className="font-medium truncate max-w-[180px]">
                          {company.company_name}
                        </span>
                        <button
                          type="button"
                          onClick={() => handleToggleCustomer(company.id)}
                          className="text-slate-500 hover:text-red-500 focus:outline-none ml-0.5"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Major Customers Allocation Section */}
            <div className="pt-3 border-t border-slate-100 space-y-3">
              <Label className="text-xs font-semibold text-slate-700 uppercase tracking-wider">
                Major Customers Allocation
              </Label>
              <div className="flex flex-col md:flex-row items-end gap-2 p-3 rounded-md border border-slate-200 bg-slate-50 text-xs">
                <div className="w-full md:flex-1 space-y-1">
                  <Label className="text-xs">Search Customer</Label>
                  <Popover
                    open={majorCustomerOpen}
                    onOpenChange={setMajorCustomerOpen}
                  >
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        role="combobox"
                        aria-expanded={majorCustomerOpen}
                        className="w-full justify-between h-8 text-xs bg-white"
                      >
                        {tempMajorCustomer.customer_id
                          ? receivingCompanies.find(
                              (c) => c.id === tempMajorCustomer.customer_id,
                            )?.company_name
                          : "Select customer..."}
                        <ChevronsUpDown className="ml-2 h-3.5 w-3.5 shrink-0 opacity-50" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-[300px] p-0" align="start">
                      <Command>
                        <CommandInput placeholder="Search customer..." />
                        <CommandList>
                          <CommandEmpty>No customer found.</CommandEmpty>
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
                                      tempMajorCustomer.customer_id ===
                                        company.id
                                        ? "opacity-100"
                                        : "opacity-0",
                                    )}
                                  />
                                  <div className="flex flex-col">
                                    <span>{company.company_name}</span>
                                  </div>
                                </CommandItem>
                              ))}
                          </CommandGroup>
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                </div>

                <div className="w-full md:w-28 space-y-1">
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
                    className="h-8 bg-white"
                  />
                </div>

                <div className="w-full md:w-20 space-y-1">
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
                    className="h-8 bg-white"
                  />
                </div>

                <div className="w-full md:w-28 space-y-1">
                  <Label className="text-xs">Max / Invoice *</Label>
                  <Input
                    type="number"
                    min="0.01"
                    step="0.01"
                    placeholder="₹"
                    value={tempMajorCustomer.max_invoice_amount}
                    onChange={(e) =>
                      setTempMajorCustomer({
                        ...tempMajorCustomer,
                        max_invoice_amount: e.target.value,
                      })
                    }
                    className="h-8 bg-white"
                  />
                </div>

                <Button
                  type="button"
                  onClick={handleAddMajorCustomer}
                  className="w-full md:w-auto h-8 px-4 gap-1 text-xs"
                >
                  <Plus className="h-3.5 w-3.5" /> Add
                </Button>
              </div>

              {/* Major Customers List */}
              {majorCustomers.length > 0 && (
                <div className="space-y-2">
                  {majorCustomers.map((major, index) => {
                    const company = receivingCompanies.find(
                      (c) => c.id === major.customer_id,
                    );
                    return (
                      <div
                        key={index}
                        className="flex items-center justify-between p-2.5 rounded-md border border-slate-200 bg-slate-50 text-xs"
                      >
                        <div>
                          <p className="font-semibold text-slate-900">
                            {company?.company_name}
                          </p>
                          <p className="text-xs text-slate-500">
                            ₹{parseFloat(major.amount).toLocaleString()} •{" "}
                            {major.invoice_count} Invoices
                            {major.max_invoice_amount && (
                              <>
                                {" "}
                                • Max: ₹
                                {parseFloat(
                                  major.max_invoice_amount,
                                ).toLocaleString()}
                                /inv
                              </>
                            )}
                          </p>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => handleRemoveMajorCustomer(index)}
                          className="h-7 text-xs text-red-500 hover:text-red-700 hover:bg-red-50"
                        >
                          Remove
                        </Button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Invoice Configuration Card */}
        <Card className="border border-slate-200 shadow-2xs bg-white rounded-md">
          <CardHeader className="p-3 pb-2 border-b border-slate-100">
            <CardTitle className="text-xs font-semibold text-slate-700 uppercase tracking-wider">
              Invoice Configuration
            </CardTitle>
          </CardHeader>
          <CardContent className="p-3.5">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
              <div className="space-y-1">
                <Label htmlFor="date-from">Invoice Date From *</Label>
                <DatePicker
                  date={formData.invoiceDateFrom}
                  onDateChange={(date) =>
                    setFormData({
                      ...formData,
                      invoiceDateFrom: date,
                    })
                  }
                />
              </div>

              <div className="space-y-1">
                <Label htmlFor="date-to">Invoice Date To *</Label>
                <DatePicker
                  date={formData.invoiceDateTo}
                  onDateChange={(date) =>
                    setFormData({
                      ...formData,
                      invoiceDateTo: date,
                    })
                  }
                />
              </div>

              <div className="space-y-1">
                <Label htmlFor="min-amount">Minimum Amount per Invoice *</Label>
                <Input
                  id="min-amount"
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="Enter min amount"
                  value={formData.minimumInvoiceAmount}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      minimumInvoiceAmount: e.target.value,
                    })
                  }
                  required
                  className="h-8 text-xs rounded-md"
                />
              </div>

              <div className="space-y-1">
                <Label htmlFor="max-amount">Maximum Amount per Invoice *</Label>
                <Input
                  id="max-amount"
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="Enter max amount"
                  value={formData.maximumInvoiceAmount}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      maximumInvoiceAmount: e.target.value,
                    })
                  }
                  required
                  className="h-8 text-xs rounded-md"
                />
              </div>

              <div className="space-y-1 md:col-span-2">
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
                  className="h-8 text-xs rounded-md"
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Category Split Card */}
        <CategorySplitSection
          totalAmount={formData.totalAmount}
          value={categorySplits}
          onChange={setCategorySplits}
        />

        {/* Products Card */}
        <Card className="border border-slate-200 shadow-2xs bg-white rounded-md">
          <CardHeader className="p-3 pb-2 border-b border-slate-100">
            <CardTitle className="text-xs font-semibold text-slate-700 uppercase tracking-wider">
              Products
            </CardTitle>
          </CardHeader>
          <CardContent className="p-3.5 space-y-3">
            <div className="space-y-1">
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
                      className="flex-1 justify-between h-8 text-xs rounded-md"
                    >
                      Search & Select Products...
                      <ChevronsUpDown className="ml-2 h-3.5 w-3.5 shrink-0 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-full p-0" align="start">
                    <Command>
                      <CommandInput placeholder="Search by name, HSN code, or unit..." />
                      <CommandList>
                        <CommandEmpty>No product found.</CommandEmpty>
                        <CommandGroup>
                          {products.map((product) => {
                            const isSelected = selectedProducts.some(
                              (p) => p.product.id === product.id,
                            );
                            return (
                              <CommandItem
                                key={product.id}
                                value={`${product.product_name} ${product.hsn_code}`}
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
                                          rule?.quantity_min?.toString() || "",
                                        perDayQtyMax:
                                          rule?.quantity_max?.toString() || "",
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
                                    HSN: {product.hsn_code}
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
              </div>
            </div>

            {selectedProducts.length > 0 && (
              <div className="space-y-1">
                <Label className="text-xs font-medium text-slate-700">
                  Selected Products ({selectedProducts.length})
                </Label>
                <div className="flex flex-wrap gap-1.5">
                  {selectedProducts.map((item) => (
                    <div
                      key={item.product.id}
                      className="flex items-center gap-1 bg-slate-100 text-slate-800 px-2.5 py-1 rounded-md text-xs border border-slate-200"
                    >
                      <span className="font-medium">
                        {item.product.product_name}
                      </span>
                      <button
                        type="button"
                        onClick={() => handleRemoveProduct(item.product.id)}
                        className="text-slate-500 hover:text-red-500 focus:outline-none ml-0.5"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Sales Planning Assistant - Final Review Panel */}
        <SalesPlanningAssistant
          selectedPurchaseBatch={finalizedPurchaseBatches.find((b) =>
            selectedSourceIds.includes(b.id),
          )}
          purchaseBatchDetails={purchaseBatchDetails}
          stockSummary={stockSummary}
          formData={formData}
          selectedCustomers={selectedCustomers}
          majorCustomers={majorCustomers}
          selectedProducts={selectedProducts}
          reviewRows={reviewRows}
          isLoadingSummary={isLoadingSummary}
        />
      </div>

      {/* Submit Button */}
      <div className="mt-6 flex justify-end">
        <Button
          onClick={handleSubmit}
          size="sm"
          className="px-6 h-9 text-xs bg-slate-900 hover:bg-slate-800"
          type="button"
          disabled={isValidating}
        >
          {isValidating ? (
            <>
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              Validating...
            </>
          ) : (
            "Create a Batch"
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
                "flex items-center gap-2 text-sm font-bold",
                errorPopup?.includes("successfully")
                  ? "text-emerald-600"
                  : "text-red-600",
              )}
            >
              {errorPopup?.includes("successfully") ? (
                <CheckCircle2 className="w-4 h-4" />
              ) : (
                <X className="w-4 h-4" />
              )}
              {errorPopup?.includes("successfully")
                ? "Success"
                : "Validation Error"}
            </DialogTitle>
          </DialogHeader>
          <div className="py-2 text-xs text-slate-700">
            <p>{errorPopup}</p>
          </div>
          <DialogFooter>
            <Button
              size="sm"
              onClick={() => setErrorPopup(null)}
              className="h-8 text-xs"
            >
              OK
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <DailyStockReviewModal
        isOpen={isReviewOpen}
        onClose={() => setIsReviewOpen(false)}
        initialRows={reviewRows}
        originalInvoices={proposedInvoices}
        onRowsChange={(updatedRows) => setReviewRows(updatedRows)}
        onSave={handleSaveSalesBatch}
        isSaving={isSavingSales}
      />

      <ValidationGuidanceModal
        data={validationGuidance}
        onClose={() => setValidationGuidance(null)}
        onApplySuggestedLimits={handleApplySuggestedLimits}
      />
    </div>
  );
}
