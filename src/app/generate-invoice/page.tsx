"use client";

import {
  Calendar,
  Check,
  CheckCircle2,
  ChevronsUpDown,
  Loader2,
  Package,
  Plus,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { CategorySplitSection } from "@/components/CategorySplitSection";
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
import { ValidationGuidanceModal } from "@/components/ValidationGuidanceModal";
import { useInvoiceForm } from "@/lib/hooks/useInvoiceForm";
import {
  getFinalClosingStockByProduct,
  type StockLedgerRow,
} from "@/lib/services/StockCalculationService";
import { fetchAllQueryRows } from "@/lib/supabase/fetchAll";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

interface InventorySourceItem {
  id: string;
  title: string;
  remainingQty: number;
  dateLabel: string;
  sourceType: "Purchase Batch" | "Carry Forward" | "Leftover Stock";
}

export default function GenerateInvoice() {
  const {
    issuingCompanies,
    receivingCompanies,
    products,
    productRules,
    errorPopup,
    setErrorPopup,
    errorField,
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
    applyAnticipatedMajorCustomers,
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
    occurrenceSemantics,
    setOccurrenceSemantics,
    categoryAllocation,
    setCategoryAllocation,
  } = useInvoiceForm({ batchType: "SALES" });

  const errorBorderClass = "border-red-500 ring-1 ring-red-500";

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
      const [{ data: batches }, ledgerRows] = await Promise.all([
        supabase
          .from("invoice_batch")
          .select(
            "id, total_amount, invoice_date_from, invoice_date_to, financial_year, products, status, batch_status",
          )
          .eq("batch_type", "PURCHASE")
          .order("invoice_date_from", { ascending: false }),
        // Paginated — this is a global fetch across every purchase batch's
        // ledger rows, which easily exceeds PostgREST's default 1000-row
        // cap. Ordering is required, not optional: without it, Postgres has
        // no defined row order across separate .range() calls at all, so
        // pagination can silently skip or duplicate rows non-deterministically
        // — this was producing wildly wrong (too-low) purchased/sold sums,
        // showing a fraction of the real leftover stock until a
        // properly-ordered endpoint recomputed it after selection.
        fetchAllQueryRows((from, to) =>
          supabase
            .from("daily_stock_ledger")
            .select(
              "purchase_batch_id, product_id, purchased_quantity, sold_quantity, opening_stock, ledger_date",
            )
            .order("purchase_batch_id", { ascending: true })
            .order("ledger_date", { ascending: true })
            .order("product_id", { ascending: true })
            .range(from, to),
        ),
      ]);

      // Paginate through invoice table to fetch ALL purchase invoices without PostgREST 1000-row cap
      const purchaseInvoices: any[] = [];
      let invPage = 0;
      const invPageSize = 1000;
      let hasMoreInvoices = true;

      while (hasMoreInvoices) {
        const { data: pageInvoices } = await supabase
          .from("invoice")
          .select("invoice_batch_id, products")
          .eq("batch_type", "PURCHASE")
          .order("id", { ascending: true })
          .range(invPage * invPageSize, (invPage + 1) * invPageSize - 1);

        if (pageInvoices && pageInvoices.length > 0) {
          purchaseInvoices.push(...pageInvoices);
          if (pageInvoices.length < invPageSize) {
            hasMoreInvoices = false;
          } else {
            invPage++;
          }
        } else {
          hasMoreInvoices = false;
        }
      }

      const allBatches = batches || [];
      setFinalizedPurchaseBatches(allBatches);

      // Group every ledger row by its own purchase_batch_id first (each
      // batch's remaining stock must be computed from ONLY its own rows,
      // never blended with another batch's), then run the shared
      // StockCalculationService's chronological recurrence per product
      // within that batch, and sum the resulting per-product closing
      // stocks into one batch-level total for the source card. `purchased`
      // / `sold` stay as simple raw sums purely to answer "does this batch
      // have any ledger activity at all" below — the actual remaining
      // quantity comes from the chronological calculation, not from them.
      const rowsByBatch = new Map<string, StockLedgerRow[]>();
      for (const r of ledgerRows || []) {
        if (!r.purchase_batch_id) continue;
        const list = rowsByBatch.get(r.purchase_batch_id);
        if (list) {
          list.push(r as StockLedgerRow);
        } else {
          rowsByBatch.set(r.purchase_batch_id, [r as StockLedgerRow]);
        }
      }

      const batchLedgerMap = new Map<
        string,
        { purchased: number; sold: number; remaining: number }
      >();

      for (const [batchId, rows] of rowsByBatch.entries()) {
        let purchased = 0;
        let sold = 0;
        for (const r of rows) {
          purchased += Number(r.purchased_quantity || 0);
          sold += Number(r.sold_quantity || 0);
        }
        const closingByProduct = getFinalClosingStockByProduct(rows);
        let remaining = 0;
        for (const closing of closingByProduct.values()) {
          remaining += closing;
        }
        batchLedgerMap.set(batchId, { purchased, sold, remaining });
      }

      // Sum purchased quantities directly from Purchase invoices across ALL invoices
      const invoiceQtyMap = new Map<string, number>();
      for (const inv of purchaseInvoices || []) {
        if (inv.invoice_batch_id && Array.isArray(inv.products)) {
          let invQty = 0;
          for (const p of inv.products) {
            invQty += Number(p.quantity || 0);
          }
          invoiceQtyMap.set(
            inv.invoice_batch_id,
            (invoiceQtyMap.get(inv.invoice_batch_id) || 0) + invQty,
          );
        }
      }

      const sources: InventorySourceItem[] = [];

      // Purchase Batches with real remaining stock. A batch is only left off
      // the list once it's genuinely exhausted (net remaining ~0 per the
      // daily_stock_ledger) — partial consumption keeps it visible with its
      // true remaining quantity, and this applies uniformly to every batch,
      // not just the most recently sold-against one.
      for (const b of allBatches) {
        const ledgerInfo = batchLedgerMap.get(b.id);
        const hasLedgerData =
          !!ledgerInfo && (ledgerInfo.purchased > 0 || ledgerInfo.sold > 0);

        let totalPurchased = 0;

        if (hasLedgerData) {
          // Ledger is the authoritative source once a purchase batch has
          // been finalized/posted: remaining stock comes from the shared
          // StockCalculationService's chronological calculation (computed
          // above, per product, then summed for this batch), never a raw
          // purchased-minus-sold on the totals.
          totalPurchased = ledgerInfo?.remaining || 0;
        } else if (
          invoiceQtyMap.has(b.id) &&
          (invoiceQtyMap.get(b.id) || 0) > 0
        ) {
          // No ledger data yet (not posted): fall back to gross purchase invoices.
          totalPurchased = invoiceQtyMap.get(b.id) || 0;
        } else if (b.products && Array.isArray(b.products)) {
          // Last resort estimate from the batch's configured product rules.
          for (const p of b.products) {
            const pQty = Number(
              p.monthly_quantity || p.purchased_quantity || p.quantity || 0,
            );
            if (pQty > 0) {
              totalPurchased += pQty;
            } else {
              const minQ = Number(p.perDayQtyMin || 10);
              const maxQ = Number(p.perDayQtyMax || 25);
              totalPurchased += (minQ + maxQ) / 2;
            }
          }
        }

        totalPurchased = Math.round(totalPurchased * 100) / 100;

        // Once ledger data exists, trust it strictly (a fully consumed batch
        // must disappear even if it still carries a positive total_amount).
        // Without ledger data yet, keep the previous lenient fallback so
        // freshly created/un-posted batches still show up.
        const shouldShow = hasLedgerData
          ? totalPurchased > 0.001
          : totalPurchased > 0.001 || Number(b.total_amount) > 0;

        // A purchase batch can only be a Sales stock source once Finalized
        // — that's the action that writes its real, per-day
        // daily_stock_ledger rows (InvoiceEngine.postPurchaseBatchStockLedger).
        // Before that, there's nothing authoritative to build the Daily
        // Stock Ledger from, so it must not be selectable yet.
        const isFinalized = b.batch_status === "FINALIZED";

        if (shouldShow && isFinalized) {
          const monthLabel = b.invoice_date_from
            ? b.invoice_date_from.slice(0, 7)
            : "N/A";
          // A batch that's already been sold against (any sold_quantity in
          // its ledger) is never shown as a fresh "Purchase Batch" again —
          // it's relabeled "Leftover Stock" in the exact same list slot, so
          // the original card is effectively gone and this one takes its
          // place (never both at once). Untouched batches keep the
          // original label. Fully-consumed batches are already excluded by
          // shouldShow above.
          const hasBeenSoldAgainst =
            hasLedgerData && (ledgerInfo?.sold || 0) > 0.001;
          sources.push({
            id: b.id,
            title: hasBeenSoldAgainst
              ? `Leftover Stock - ${monthLabel}`
              : `Purchase Batch - ${monthLabel}`,
            remainingQty: totalPurchased,
            dateLabel: `${b.invoice_date_from || "N/A"} (${b.financial_year || "FY"})`,
            sourceType: hasBeenSoldAgainst ? "Leftover Stock" : "Purchase Batch",
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
        const realBatchIds = (formData.stockSourceBatchId || "")
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean);

        const targetBatchIdParam =
          realBatchIds.length > 0
            ? realBatchIds.join(",")
            : formData.stockSourceBatchId;

        const res = await fetch(
          `/api/get-purchase-batch-stock-summary?batchId=${targetBatchIdParam}`,
        );
        const result = await res.json();
        if (res.ok) {
          const summaryList = result.summary || [];
          setStockSummary(summaryList);
          setPurchaseBatchDetails(result.batchDetails || null);

          // Inherit Financial Year + Invoice Date range from the selected
          // Purchase Batch — only when exactly ONE source is selected.
          // With multiple sources, batchDetails only ever reflects the
          // first-selected batch (a pre-existing behavior, not something
          // introduced here — see the API route's own comment), so
          // auto-filling from it in that case would silently pick an
          // arbitrary batch's dates when the selected batches could span
          // different ranges. Never overwrites a value the user already
          // typed themselves beyond this single-selection moment (Sales
          // form fields stay ordinary controlled inputs otherwise).
          if (realBatchIds.length === 1 && result.batchDetails) {
            const bd = result.batchDetails;
            const fyMatch =
              typeof bd.financial_year === "string"
                ? bd.financial_year.match(/^FY(\d{4})-(\d{2})$/)
                : null;

            const parseLocalDate = (dateStr: string): Date | undefined => {
              const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || "");
              if (!m) return undefined;
              return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
            };

            const dateFrom = parseLocalDate(bd.invoice_date_from);
            const dateTo = parseLocalDate(bd.invoice_date_to);

            setFormData((prev) => {
              const next = { ...prev };
              if (fyMatch) {
                const startYear = Number(fyMatch[1]);
                let endYear = startYear - (startYear % 100) + Number(fyMatch[2]);
                if (endYear <= startYear) endYear += 100;
                next.financialYearStart = startYear;
                next.financialYearEnd = endYear;
              }
              if (dateFrom) next.invoiceDateFrom = dateFrom;
              if (dateTo) next.invoiceDateTo = dateTo;
              return next;
            });

            // Auto-fill Major Customers from this Purchase batch's own
            // Anticipated Major Customer entries — same customer/amount/
            // invoice-count/max-per-invoice the user already configured
            // there, so it doesn't have to be typed in twice. Isolated in
            // its own try/catch — this block runs BEFORE the product
            // occurrence inheritance below in the same effect, so any
            // throw here (this app's target platform, Safari/older
            // browsers, or unexpected data shape) would otherwise silently
            // skip that inheritance too, since both share the same
            // surrounding try/catch further up.
            try {
              if (
                Array.isArray(bd.anticipated_major_customers) &&
                bd.anticipated_major_customers.length > 0
              ) {
                applyAnticipatedMajorCustomers(bd.anticipated_major_customers);
              }
            } catch (err) {
              console.error("Error auto-filling Major Customers:", err);
            }
          }

          // Inherit Product Occurrence Distribution & Category Split from Purchase Batch
          if (
            result.batchDetails &&
            Array.isArray(result.batchDetails.products)
          ) {
            const batchProducts = result.batchDetails.products;
            const numericTotal = parseFloat(formData.totalAmount) || 0;

            // Hotfix — real bug: the source Purchase batch's own "By
            // Category" mode was never reflected here at all. This block
            // used to always sum each product's OWN occurrencePercentage
            // by category — but in By Category mode, per-product
            // occurrence isn't the user's real configured split; it's an
            // auto-computed EQUAL share within each category (so
            // generation has something concrete to work with), which
            // always sums to exactly 100% per category regardless of the
            // real Meat/Fruits split — summing Meat's 100% and Fruits'
            // 100% together produced the nonsensical "Total Split: 200%"
            // the client saw. The real split lives in the batch's own
            // category_allocation field. Also failed to select "By
            // Category" on this page at all, leaving it silently stuck on
            // Global even though the source was clearly configured
            // otherwise.
            if (
              result.batchDetails.occurrence_semantics === "CATEGORY" &&
              result.batchDetails.category_allocation
            ) {
              const meatPct =
                Number(result.batchDetails.category_allocation.Meat) || 0;
              const fruitPct =
                Number(result.batchDetails.category_allocation.Fruits) || 0;
              const meatAmt =
                Math.round(numericTotal * (meatPct / 100) * 100) / 100;
              const fruitAmt = Math.round((numericTotal - meatAmt) * 100) / 100;

              setOccurrenceSemantics("CATEGORY");
              setCategoryAllocation({
                Meat: String(meatPct),
                Fruits: String(fruitPct),
              });
              setCategorySplits([
                { category_name: "Meat", percentage: meatPct, amount: meatAmt },
                {
                  category_name: "Fruits",
                  percentage: fruitPct,
                  amount: fruitAmt,
                },
              ]);
            } else {
              setOccurrenceSemantics("GLOBAL");
              let meatSum = 0;
              let fruitSum = 0;
              for (const p of batchProducts) {
                const occ = Number(p.occurrencePercentage || 0);
                const cat = String(
                  p.category || p.category_name || "Meat",
                ).toUpperCase();
                if (cat.includes("FRUIT")) {
                  fruitSum += occ;
                } else {
                  meatSum += occ;
                }
              }
              meatSum = Math.round(meatSum * 100) / 100;
              fruitSum = Math.round(fruitSum * 100) / 100;

              const meatAmt =
                Math.round(numericTotal * (meatSum / 100) * 100) / 100;
              const fruitAmt = Math.round((numericTotal - meatAmt) * 100) / 100;

              setCategorySplits([
                { category_name: "Meat", percentage: meatSum, amount: meatAmt },
                {
                  category_name: "Fruits",
                  percentage: fruitSum,
                  amount: fruitAmt,
                },
              ]);
            }

            // Auto-populate selectedProducts with occurrence percentages from the Purchase Batch
            const batchProdMap = new Map<string, any>();
            for (const bp of batchProducts) {
              const bpId = bp.product_id || bp.id;
              if (bpId) batchProdMap.set(bpId, bp);
            }

            if (products && products.length > 0) {
              const inheritedSelections = products
                .filter((p) => batchProdMap.has(p.id))
                .map((product) => {
                  const rule = productRules.find(
                    (r) => r.product_id === product.id,
                  );
                  const bp = batchProdMap.get(product.id);
                  const occ =
                    bp?.occurrencePercentage !== undefined &&
                    bp?.occurrencePercentage !== null
                      ? String(bp.occurrencePercentage)
                      : "0";

                  return {
                    product,
                    perDayQtyMin: rule?.quantity_min?.toString() || "",
                    perDayQtyMax: rule?.quantity_max?.toString() || "",
                    perDayRateMin: rule?.rate_min?.toString() || "",
                    perDayRateMax: rule?.rate_max?.toString() || "",
                    occurrencePercentage: occ,
                  };
                });

              if (inheritedSelections.length > 0) {
                setSelectedProducts(inheritedSelections);
              }
            }
          }

          // Synchronize Leftover Stock Card to match live total_available in
          // summary table (preserving Purchase Batch cards). This endpoint's
          // summary is the COMBINED total across every selected source when
          // more than one is picked — it must only ever be stamped onto a
          // card's own number when that card is the SOLE selected source,
          // otherwise a Leftover card ends up displaying leftover + every
          // other selected source's stock as if it were its own remaining
          // quantity. With multiple sources selected, each card keeps
          // whatever fetchAvailableSources already computed for it
          // individually; the combined total still shows correctly in the
          // "Aggregated Available Inventory Summary" table below.
          const exactSum = summaryList.reduce(
            (sum: number, item: any) =>
              sum + Number(item.total_available || item.purchased || 0),
            0,
          );

          if (exactSum > 0 && realBatchIds.length === 1) {
            const soleSelectedId = realBatchIds[0];
            setAvailableSources((prevSources) =>
              prevSources.map((src) => {
                // Business Rule: Purchase Batch cards represent ORIGINAL purchased quantity and must NEVER be overwritten.
                if (src.sourceType === "Purchase Batch") {
                  return src;
                }
                if (src.id === soleSelectedId) {
                  return {
                    ...src,
                    remainingQty: Math.round(exactSum * 100) / 100,
                  };
                }
                return src;
              }),
            );
          }
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

  // Live Category Monetary Split Calculation based on Total Amount & Category Percentages
  useEffect(() => {
    const numericTotal = parseFloat(formData.totalAmount) || 0;
    setCategorySplits((prevSplits) => {
      if (!prevSplits || prevSplits.length === 0) return prevSplits;

      const meatItem = prevSplits.find((c) =>
        c.category_name.toUpperCase().includes("MEAT"),
      );
      const fruitItem = prevSplits.find((c) =>
        c.category_name.toUpperCase().includes("FRUIT"),
      );

      const meatPct = meatItem ? meatItem.percentage : 0;
      const fruitPct = fruitItem ? fruitItem.percentage : 0;

      let meatAmt = 0;
      let fruitAmt = 0;

      if (numericTotal > 0) {
        meatAmt = Math.round(numericTotal * (meatPct / 100));
        fruitAmt = Math.round(numericTotal - meatAmt);
      }

      if (meatItem?.amount === meatAmt && fruitItem?.amount === fruitAmt) {
        return prevSplits; // Return same array reference if amounts haven't changed (0 re-renders)
      }

      return [
        { category_name: "Meat", percentage: meatPct, amount: meatAmt },
        { category_name: "Fruits", percentage: fruitPct, amount: fruitAmt },
      ];
    });
  }, [formData.totalAmount]);

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
        <Card
          className={cn(
            "border border-slate-200 shadow-2xs bg-white rounded-md",
            errorField === "stock-source" && errorBorderClass,
          )}
        >
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
                            {source.sourceType === "Purchase Batch"
                              ? "Total Stock"
                              : "Leftover Stock"}
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
                {/* This table can run to 40-50+ rows on a large batch catalogue,
                    which is the single heaviest chunk of DOM on this page.
                    content-visibility skips layout/paint for rows currently
                    scrolled out of view, so a fast scroll through this long
                    form doesn't outrun the browser's paint budget and show
                    blank/unpainted content — contain-intrinsic-size keeps the
                    scrollbar's size estimate stable before rows are measured. */}
                <table
                  className="w-full text-xs text-left text-slate-600 border-collapse [content-visibility:auto] [contain-intrinsic-size:auto_1200px]">
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
                      className={cn(
                        "w-full justify-between h-8 text-xs rounded-md",
                        errorField === "issuing-company" && errorBorderClass,
                      )}
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
                      <p className="text-[10px] text-slate-500">
                        Numbering continues automatically from the last
                        invoice generated for this company, financial year,
                        and invoice type.
                      </p>
                      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                        <div className="space-y-1 sm:col-span-2">
                          <Label className="text-[11px] text-slate-500 font-medium">
                            Next Invoice Number
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
                  className={
                    errorField === "invoice-date-from"
                      ? errorBorderClass
                      : undefined
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
                  className={
                    errorField === "invoice-date-to"
                      ? errorBorderClass
                      : undefined
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
                  className={cn(
                    "h-8 text-xs rounded-md",
                    errorField === "minimum-invoice-amount" &&
                      errorBorderClass,
                  )}
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
                  className={cn(
                    "h-8 text-xs rounded-md",
                    errorField === "maximum-invoice-amount" &&
                      errorBorderClass,
                  )}
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
                  className={cn(
                    "h-8 text-xs rounded-md",
                    errorField === "total-amount" && errorBorderClass,
                  )}
                />
              </div>
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
                  className={cn(
                    "w-full justify-between h-8 text-xs rounded-md",
                    errorField === "customers" && errorBorderClass,
                  )}
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
                                    setTempMajorCustomer((prev) => ({
                                      ...prev,
                                      customer_id: company.id,
                                    }));
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
                      setTempMajorCustomer((prev) => ({
                        ...prev,
                        amount: e.target.value,
                      }))
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
                      setTempMajorCustomer((prev) => ({
                        ...prev,
                        invoice_count: e.target.value,
                      }))
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
                      setTempMajorCustomer((prev) => ({
                        ...prev,
                        max_invoice_amount: e.target.value,
                      }))
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


        {/* Category Split Card */}
        <CategorySplitSection
          totalAmount={formData.totalAmount}
          value={categorySplits}
          onChange={setCategorySplits}
        />

        {/* Product Occurrence Quota Card (Sprint 1.7S) */}
        <Card className="border border-slate-200 shadow-2xs bg-white rounded-md">
          <CardHeader className="p-3 pb-2 border-b border-slate-100">
            <CardTitle className="text-xs font-semibold text-slate-700 uppercase tracking-wider">
              Product Occurrence Quota
            </CardTitle>
          </CardHeader>
          <CardContent className="p-3 space-y-3">
            <div className="flex gap-4 text-xs">
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="radio"
                  name="occurrence-semantics"
                  checked={occurrenceSemantics !== "CATEGORY"}
                  onChange={() => setOccurrenceSemantics(null)}
                />
                Global (default — occurrence % applies across the whole batch)
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="radio"
                  name="occurrence-semantics"
                  checked={occurrenceSemantics === "CATEGORY"}
                  onChange={() => setOccurrenceSemantics("CATEGORY")}
                />
                By Category (split Meat/Fruits invoice quota separately)
              </label>
            </div>
            {occurrenceSemantics === "CATEGORY" && (
              <div className="flex gap-3">
                <div className="flex-1">
                  <Label className="text-[11px] text-slate-500">Meat %</Label>
                  <Input
                    type="number"
                    min="0"
                    max="100"
                    step="0.01"
                    value={categoryAllocation.Meat}
                    onChange={(e) =>
                      setCategoryAllocation({
                        ...categoryAllocation,
                        Meat: e.target.value,
                      })
                    }
                    className="h-8 text-xs rounded-md"
                  />
                </div>
                <div className="flex-1">
                  <Label className="text-[11px] text-slate-500">
                    Fruits %
                  </Label>
                  <Input
                    type="number"
                    min="0"
                    max="100"
                    step="0.01"
                    value={categoryAllocation.Fruits}
                    onChange={(e) =>
                      setCategoryAllocation({
                        ...categoryAllocation,
                        Fruits: e.target.value,
                      })
                    }
                    className="h-8 text-xs rounded-md"
                  />
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Products Card */}
        <Card className="border border-slate-200 shadow-2xs bg-white rounded-md">
          <CardHeader className="p-3 pb-2 border-b border-slate-100 flex flex-row items-center justify-between">
            <CardTitle className="text-xs font-semibold text-slate-700 uppercase tracking-wider">
              Products
            </CardTitle>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                if (
                  selectedProducts.length === products.length &&
                  products.length > 0
                ) {
                  setSelectedProducts([]);
                } else {
                  const newSelections = products.map((product) => {
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
                }
              }}
              className="h-6 text-xs px-2"
            >
              {selectedProducts.length === products.length &&
              products.length > 0
                ? "Deselect All"
                : "Select All"}
            </Button>
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
                      className={cn(
                        "flex-1 justify-between h-8 text-xs rounded-md",
                        errorField === "products" && errorBorderClass,
                      )}
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
                                    const bp =
                                      purchaseBatchDetails?.products?.find(
                                        (p: any) =>
                                          (p.product_id || p.id) === product.id,
                                      );
                                    const occ =
                                      bp?.occurrencePercentage !== undefined &&
                                      bp?.occurrencePercentage !== null
                                        ? String(bp.occurrencePercentage)
                                        : (product as any)
                                            .occurrencePercentage || "0";

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
                                        occurrencePercentage: occ,
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

      {/* Generation wait dialog — the server now auto-retries generation
          internally (fresh randomness each attempt) whenever a Major
          Customer's invoice(s) don't quite fit on the first roll, instead
          of surfacing that as an error for the user to manually retry.
          This can take noticeably longer than a single attempt, so a
          dedicated dialog (rather than just the button's inline spinner)
          sets the right expectation instead of looking stuck. */}
      <Dialog open={isValidating}>
        <DialogContent
          className="sm:max-w-[425px]"
          onInteractOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
          showCloseButton={false}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm font-bold text-slate-800">
              <Loader2 className="w-4 h-4 animate-spin" />
              Optimizing Invoice Allocation
            </DialogTitle>
          </DialogHeader>
          <div className="py-2 text-xs text-slate-600">
            Generating a batch that fits every configured amount and Major
            Customer requirement — this can take a few moments if the first
            few attempts don't quite fit. Please wait...
          </div>
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
        productRules={productRules}
      />

      <ValidationGuidanceModal
        data={validationGuidance}
        onClose={() => setValidationGuidance(null)}
        onApplySuggestedLimits={handleApplySuggestedLimits}
      />
    </div>
  );
}
