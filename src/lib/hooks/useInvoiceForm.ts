"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { CategorySplitItem } from "@/components/CategorySplitSection";
import type { ValidationGuidanceData } from "@/components/ValidationGuidanceModal";
import { MAX_INVOICES_PER_BATCH } from "@/lib/constants/invoice";
import {
  InvoiceNumberingService,
  type InvoiceSequencePreview,
  type InvoiceType,
} from "@/lib/services/InvoiceNumberingService";
import { validateCategoryOccurrenceConfiguration } from "@/lib/services/ProductOccurrenceService";
import { createClient } from "@/lib/supabase/client";
import { fetchAllQueryRows } from "@/lib/supabase/fetchAll";
import {
  enforceMinimumInvoiceAmount,
  reconcileInvoicesToTargets,
  solveRatesToHitTotal,
} from "@/lib/utils/reconcile-invoice-quantities";

function formatDateForStorage(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/**
 * By Category mode intentionally has no per-product occurrence UI — the
 * user only picks products and sets an overall Meat/Fruits %. The
 * generation engine still needs each product's occurrence percentage
 * (interpreted within its own category's invoice pool) to sum to exactly
 * 100% per category, so this splits each category's 100% evenly across
 * its own selected products, in hundredths-of-a-percent units so the sum
 * is always exact (never off by floating-point rounding).
 */
function computeEqualCategoryOccurrence(
  products: Array<{ product: { id: string; category_name?: string; category?: string } }>,
): Map<string, number> {
  const byCategory = new Map<string, string[]>();
  for (const item of products) {
    const cat =
      (item.product as any).category_name ||
      (item.product as any).category ||
      "Meat";
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(item.product.id);
  }

  const result = new Map<string, number>();
  for (const ids of byCategory.values()) {
    const n = ids.length;
    if (n === 0) continue;
    const totalHundredths = 10000; // 100.00%
    const base = Math.floor(totalHundredths / n);
    const remainder = totalHundredths - base * n;
    ids.forEach((id, idx) => {
      const hundredths = idx < remainder ? base + 1 : base;
      result.set(id, hundredths / 100);
    });
  }
  return result;
}

export type IssuingCompany = {
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

export type ReceivingCompany = {
  id: string;
  company_name: string;
  address: string;
  gstin?: string | null;
  pan?: string | null;
  state: string;
  state_code?: string;
};

export type Product = {
  id: string;
  product_name: string;
  hsn_code: string;
  unit_of_measure: string;
  category_id?: string | null;
};

export type SelectedProductItem = {
  product: Product;
  perDayQtyMin: string;
  perDayQtyMax: string;
  perDayRateMin: string;
  perDayRateMax: string;
  monthlyQty?: string;
  occurrencePercentage?: string;
};

export interface UseInvoiceFormParams {
  batchType: "SALES" | "PURCHASE";
}

export function useInvoiceForm({ batchType }: UseInvoiceFormParams) {
  const router = useRouter();
  const supabase = createClient();

  const [issuingCompanies, setIssuingCompanies] = useState<IssuingCompany[]>(
    [],
  );
  const [receivingCompanies, setReceivingCompanies] = useState<
    ReceivingCompany[]
  >([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [productRules, setProductRules] = useState<any[]>([]);
  const [categorySplits, setCategorySplits] = useState<CategorySplitItem[]>([
    { category_name: "Meat", percentage: 70, amount: 0 },
    { category_name: "Fruits", percentage: 30, amount: 0 },
  ]);
  // Sprint 1.7S — Product Occurrence quota configuration. `null` (the
  // default) preserves legacy behavior exactly: InvoiceEngine/
  // ProductOccurrenceService treat NULL occurrence_semantics identically to
  // "GLOBAL", never auto-promoting it to CATEGORY (Sprint 1.7I/1.7J), and
  // an existing batch created before this sprint has both fields NULL in
  // the database — nothing about that batch's stored config or generation
  // behavior changes just because this UI now exists.
  const [occurrenceSemantics, setOccurrenceSemantics] = useState<
    "GLOBAL" | "CATEGORY" | null
  >(null);
  const [categoryAllocation, setCategoryAllocation] = useState<{
    Meat: string;
    Fruits: string;
  }>({ Meat: "70", Fruits: "30" });
  const [errorPopup, setErrorPopup] = useState<string | null>(null);
  const [errorField, setErrorField] = useState<string | null>(null);
  const [validationGuidance, setValidationGuidance] =
    useState<ValidationGuidanceData | null>(null);

  const [selectedIssuingCompany, setSelectedIssuingCompany] =
    useState<IssuingCompany | null>(null);
  const [sequencePreview, setSequencePreview] =
    useState<InvoiceSequencePreview | null>(null);
  const [selectedCustomers, setSelectedCustomers] = useState<string[]>([]);
  const [majorCustomers, setMajorCustomers] = useState<
    Array<{
      customer_id: string;
      amount: string;
      invoice_count: string;
      max_invoice_amount: string;
    }>
  >([]);

  const [customerOpen, setCustomerOpen] = useState(false);
  const [majorCustomerOpen, setMajorCustomerOpen] = useState(false);
  const [tempMajorCustomer, setTempMajorCustomer] = useState({
    customer_id: "",
    amount: "",
    invoice_count: "1",
    max_invoice_amount: "",
  });

  // Anticipated Major Customer Demand — Purchase batches only, and
  // entirely optional. Lets the user pre-declare a Sales Major Customer's
  // expected amount/invoice_count/max/category at Purchase time, purely to
  // bias Purchase generation into concentrating enough same-day stock for
  // it later — a Sales Major Customer invoice can only ever draw from ONE
  // day, and Purchase generation otherwise spreads stock randomly and
  // evenly across every day, which can leave no single day with enough
  // concentrated stock even when the total across the whole range is
  // plenty. Deliberately a SEPARATE field from `majorCustomers` above,
  // which on Purchase batches means major SUPPLIERS — a different concept.
  const [anticipatedMajorCustomers, setAnticipatedMajorCustomers] = useState<
    Array<{
      customer_id: string;
      amount: string;
      invoice_count: string;
      max_invoice_amount: string;
    }>
  >([]);
  // Sourced from the real Sales customer master (`receiving_companies`) —
  // distinct from `receivingCompanies` above, which for a PURCHASE batch
  // holds SUPPLIERS, not Sales customers. Only fetched for PURCHASE.
  const [anticipatedCustomers, setAnticipatedCustomers] = useState<
    ReceivingCompany[]
  >([]);
  const [anticipatedMajorCustomerOpen, setAnticipatedMajorCustomerOpen] =
    useState(false);
  const [tempAnticipatedMajorCustomer, setTempAnticipatedMajorCustomer] =
    useState({
      customer_id: "",
      amount: "",
      invoice_count: "1",
      max_invoice_amount: "",
    });

  const [selectedProducts, setSelectedProducts] = useState<
    SelectedProductItem[]
  >([]);
  const [tempProduct, setTempProduct] = useState<Product | null>(null);
  const [issuingCompanyOpen, setIssuingCompanyOpen] = useState(false);
  const [productOpen, setProductOpen] = useState(false);

  const [isValidating, setIsValidating] = useState(false);
  const [isReviewOpen, setIsReviewOpen] = useState(false);
  const [reviewRows, setReviewRows] = useState<any[]>([]);
  const [proposedInvoices, setProposedInvoices] = useState<any[]>([]);
  const [isSavingSales, setIsSavingSales] = useState(false);

  const currentYear = new Date().getFullYear();

  const [formData, setFormData] = useState<{
    invoiceType: string;
    transportMode: string;
    vehicleNumber: string;
    dateOfSupply: Date | undefined;
    invoiceDateFrom: Date | undefined;
    invoiceDateTo: Date | undefined;
    minimumInvoiceAmount: string;
    maximumInvoiceAmount: string;
    totalAmount: string;
    financialYearStart: number;
    financialYearEnd: number;
    stockSourceBatchId?: string;
    previousEndingSequenceNumber?: string;
  }>({
    invoiceType: batchType.toUpperCase(),
    transportMode: "In Hand Delivery",
    vehicleNumber: "",
    dateOfSupply: undefined,
    invoiceDateFrom: undefined,
    invoiceDateTo: undefined,
    minimumInvoiceAmount: "",
    maximumInvoiceAmount: "",
    totalAmount: "",
    financialYearStart: currentYear,
    financialYearEnd: currentYear + 1,
    stockSourceBatchId: "",
    previousEndingSequenceNumber: "",
  });

  useEffect(() => {
    const fetchData = async () => {
      const partyTable =
        batchType === "PURCHASE" ? "suppliers" : "receiving_companies";

      // Real, reported bug: plain `.select("*")` caps at PostgREST's
      // default 1000-row limit. A supplier/customer sorted alphabetically
      // past row 1000 (easily hit after a large bulk upload) would just
      // silently be missing from every picker on this page, while still
      // showing up fine on the master list pages (which sort by
      // created_at, not name, so a *recently added* row still lands in the
      // first 1000 there even when it's absent here). Paginated with
      // fetchAllQueryRows — same fix already applied to daily_stock_ledger
      // reads elsewhere in this app for the identical reason.
      const [
        issuingRows,
        receivingRows,
        productsRows,
        rulesRows,
        anticipatedRows,
      ] = await Promise.all([
        fetchAllQueryRows<any>((from, to) =>
          supabase
            .from("issuing_companies")
            .select("*")
            .order("company_name", { ascending: true })
            .range(from, to),
        ),
        fetchAllQueryRows<any>((from, to) =>
          supabase
            .from(partyTable)
            .select("*")
            .order("company_name", { ascending: true })
            .range(from, to),
        ),
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
        // Anticipated Major Customer Demand (PURCHASE only) picks from
        // the real Sales customer master, not `partyTable` (suppliers,
        // for Purchase) — a separate fetch since the two lists differ.
        batchType === "PURCHASE"
          ? fetchAllQueryRows<any>((from, to) =>
              supabase
                .from("receiving_companies")
                .select("*")
                .order("company_name", { ascending: true })
                .range(from, to),
            )
          : Promise.resolve([]),
      ]);

      setIssuingCompanies(issuingRows);
      setReceivingCompanies(receivingRows);
      setProducts(productsRows);
      setProductRules(rulesRows);
      setAnticipatedCustomers(anticipatedRows as any);
    };

    fetchData();
  }, [batchType]);

  useEffect(() => {
    if (
      !selectedIssuingCompany?.id ||
      !formData.financialYearStart ||
      !formData.financialYearEnd
    ) {
      setSequencePreview(null);
      return;
    }
    const fyString = `${formData.financialYearStart}-${String(formData.financialYearEnd).slice(-2)}`;
    const invType: InvoiceType = batchType === "PURCHASE" ? "P" : "S";
    InvoiceNumberingService.fetchSequencePreview(
      supabase,
      selectedIssuingCompany.id,
      fyString,
      invType,
    ).then((res) => setSequencePreview(res));
  }, [
    selectedIssuingCompany?.id,
    formData.financialYearStart,
    formData.financialYearEnd,
    batchType,
  ]);

  // Clear the red-border error highlight on a field as soon as the user
  // fixes it, without waiting for another submit attempt.
  useEffect(() => {
    if (!errorField) return;
    const isNowValid: Record<string, boolean> = {
      "issuing-company": !!selectedIssuingCompany,
      customers: selectedCustomers.length > 0 || majorCustomers.length > 0,
      products: selectedProducts.length > 0,
      "stock-source": !!formData.stockSourceBatchId,
      "transport-mode": !!formData.transportMode,
      "invoice-date-from": !!formData.invoiceDateFrom,
      "invoice-date-to": !!formData.invoiceDateTo,
      "minimum-invoice-amount": !!formData.minimumInvoiceAmount,
      "maximum-invoice-amount": !!formData.maximumInvoiceAmount,
      "total-amount": !!formData.totalAmount,
    };
    if (isNowValid[errorField]) {
      setErrorField(null);
    }
  }, [
    errorField,
    selectedIssuingCompany,
    selectedCustomers,
    majorCustomers,
    selectedProducts,
    formData.stockSourceBatchId,
    formData.transportMode,
    formData.invoiceDateFrom,
    formData.invoiceDateTo,
    formData.minimumInvoiceAmount,
    formData.maximumInvoiceAmount,
    formData.totalAmount,
  ]);

  const handleIssuingCompanyChange = (companyId: string) => {
    const company = issuingCompanies.find((c) => c.id === companyId);
    setSelectedIssuingCompany(company || null);
    setIssuingCompanyOpen(false);
  };

  const handleProductChange = (productId: string) => {
    const product = products.find((p) => p.id === productId);
    setTempProduct(product || null);
    setProductOpen(false);
  };

  const handleAddMajorCustomer = () => {
    console.log(
      "[Major Supplier/Customer] State before validation:",
      tempMajorCustomer,
    );
    console.log(
      "[Major Supplier/Customer] Raw input value (amount):",
      tempMajorCustomer.amount,
    );
    if (!tempMajorCustomer.customer_id) return;
    const amt = parseFloat(tempMajorCustomer.amount);
    console.log("[Major Supplier/Customer] Parsed value (amount):", amt);
    if (!tempMajorCustomer.amount || isNaN(amt) || amt <= 0) {
      console.log(
        "[Major Supplier/Customer] Validation failed: Amount must be greater than 0",
      );
      setErrorPopup("Amount must be greater than 0");
      return;
    }
    const invCount = parseInt(tempMajorCustomer.invoice_count, 10);
    console.log(
      "[Major Supplier/Customer] Raw input value (invoice_count):",
      tempMajorCustomer.invoice_count,
    );
    console.log(
      "[Major Supplier/Customer] Parsed value (invoice_count):",
      invCount,
    );
    if (!tempMajorCustomer.invoice_count || isNaN(invCount) || invCount < 1) {
      setErrorPopup("Invoices must be at least 1");
      return;
    }
    const maxAmt = parseFloat(tempMajorCustomer.max_invoice_amount);
    console.log(
      "[Major Supplier/Customer] Raw input value (max_invoice_amount):",
      tempMajorCustomer.max_invoice_amount,
    );
    console.log(
      "[Major Supplier/Customer] Parsed value (max_invoice_amount):",
      maxAmt,
    );
    if (!tempMajorCustomer.max_invoice_amount || isNaN(maxAmt) || maxAmt <= 0) {
      setErrorPopup(
        "Maximum amount per invoice is required and must be greater than 0",
      );
      return;
    }

    if (maxAmt * invCount < amt) {
      setErrorPopup(
        "The specified maximum invoice amount is too low to distribute the total amount across the selected number of invoices. Please increase the invoice limit or the number of invoices.",
      );
      return;
    }

    // Hard mathematical ceiling check — a single invoice line can NEVER
    // exceed its product's own configured maximum quantity, no matter how
    // much stock accumulates for it, so a single invoice's total can never
    // exceed the sum of every eligible (non-zero Occurrence Percentage)
    // product's own maximum-quantity x maximum-rate line, for WHICHEVER
    // category that invoice ends up in. Since this customer/supplier isn't
    // locked to one category, this only blocks when EVERY category is
    // individually below the target — if at least one category can reach
    // it, generation's own category rescue can still find it.
    if (selectedProducts.length > 0) {
      const capacityByCategory = new Map<string, number>();
      for (const item of selectedProducts) {
        const occ = parseFloat(item.occurrencePercentage || "0");
        if (isNaN(occ) || occ <= 0) continue;
        const cat = (item.product as any).category_name || "Meat";
        const q = parseFloat(item.perDayQtyMax) || 0;
        const r = parseFloat(item.perDayRateMax) || 0;
        capacityByCategory.set(
          cat,
          (capacityByCategory.get(cat) || 0) + q * r,
        );
      }
      const bestCategoryCapacity = Math.max(
        0,
        ...Array.from(capacityByCategory.values()),
      );
      if (capacityByCategory.size > 0 && maxAmt > bestCategoryCapacity) {
        const breakdown = Array.from(capacityByCategory.entries())
          .map(
            ([cat, cap]) => `${cat}: ₹${Math.round(cap).toLocaleString("en-IN")}`,
          )
          .join(", ");
        setErrorPopup(
          `The maximum invoice amount (₹${maxAmt.toLocaleString("en-IN")}) can never be reached in ANY configured category — even selling every eligible product at its absolute maximum quantity and rate in a single day tops out at ${breakdown}. A single invoice line can never exceed a product's own configured maximum quantity, no matter how much stock accumulates. Lower the max amount per invoice, raise Quantity/Rate maximums, give more products a non-zero Occurrence Percentage, or split into more invoices.`,
        );
        return;
      }
    }

    // A customer/supplier can only ever receive ONE invoice per day —
    // generation has no mechanism to place more than one of this same
    // customer's invoices on the same day. Catch this here, at
    // configuration time, instead of letting generation silently double
    // up invoices on a day once invoice_count exceeds the days available.
    const fromDateForDayCheck = formData.invoiceDateFrom
      ? new Date(formData.invoiceDateFrom)
      : undefined;
    const toDateForDayCheck = formData.invoiceDateTo
      ? new Date(formData.invoiceDateTo)
      : undefined;
    const numberOfDaysForMajorCheck =
      fromDateForDayCheck && toDateForDayCheck
        ? Math.ceil(
            Math.abs(
              toDateForDayCheck.getTime() - fromDateForDayCheck.getTime(),
            ) /
              (1000 * 3600 * 24),
          ) + 1
        : undefined;
    if (
      numberOfDaysForMajorCheck !== undefined &&
      invCount > numberOfDaysForMajorCheck
    ) {
      setErrorPopup(
        `This customer requests ${invCount} invoices, but the batch's date range only has ${numberOfDaysForMajorCheck} day(s) — a customer can only receive one invoice per day. Either reduce the invoice count to ${numberOfDaysForMajorCheck} or fewer, raise the Maximum Invoice Amount per invoice so fewer, larger invoices cover the same total, or widen the date range.`,
      );
      return;
    }

    const addedObj = { ...tempMajorCustomer };
    console.log(
      "[Major Supplier/Customer] Object passed to Add handler:",
      addedObj,
    );
    setMajorCustomers([...majorCustomers, addedObj]);
    setSelectedCustomers(
      selectedCustomers.filter((id) => id !== tempMajorCustomer.customer_id),
    );
    setTempMajorCustomer({
      customer_id: "",
      amount: "",
      invoice_count: "1",
      max_invoice_amount: "",
    });
    console.log("[Major Supplier/Customer] State after validation (reset):", {
      customer_id: "",
      amount: "",
      invoice_count: "1",
      max_invoice_amount: "",
    });
  };

  const handleRemoveMajorCustomer = (index: number) => {
    setMajorCustomers(majorCustomers.filter((_, i) => i !== index));
  };

  const handleAddAnticipatedMajorCustomer = () => {
    if (!tempAnticipatedMajorCustomer.customer_id) return;
    const amt = parseFloat(tempAnticipatedMajorCustomer.amount);
    if (!tempAnticipatedMajorCustomer.amount || isNaN(amt) || amt <= 0) {
      setErrorPopup("Anticipated amount must be greater than 0");
      return;
    }
    const invCount = parseInt(tempAnticipatedMajorCustomer.invoice_count, 10);
    if (
      !tempAnticipatedMajorCustomer.invoice_count ||
      isNaN(invCount) ||
      invCount < 1
    ) {
      setErrorPopup("Anticipated invoice count must be at least 1");
      return;
    }
    const maxAmt = parseFloat(
      tempAnticipatedMajorCustomer.max_invoice_amount,
    );
    if (
      !tempAnticipatedMajorCustomer.max_invoice_amount ||
      isNaN(maxAmt) ||
      maxAmt <= 0
    ) {
      setErrorPopup(
        "Anticipated maximum amount per invoice is required and must be greater than 0",
      );
      return;
    }
    if (maxAmt * invCount < amt) {
      setErrorPopup(
        "The specified maximum invoice amount is too low to cover the anticipated total across the given invoice count. Please increase the max per invoice or the invoice count.",
      );
      return;
    }

    // Hard mathematical ceiling check — a single Sales invoice line can
    // NEVER exceed its product's own configured maximum quantity, no
    // matter how much stock Purchase accumulates for it (confirmed as a
    // real failure: a customer configured to match this exact category
    // still failed after 15 auto-retries because only a handful of
    // products in the category had any non-zero Occurrence Percentage in
    // this batch, capping the category's true achievable single-day/
    // single-invoice ceiling far below the anticipated amount). Catching
    // this here, at config time, surfaces it immediately instead of after
    // a silent Purchase generation and a much later, confusing Sales
    // failure.
    //
    // A reservation is no longer pinned to one category — unlike a
    // supplier, the Sales customer this anticipates isn't category-locked
    // (can buy both, just never both on one bill), so Purchase now decides
    // each reservation invoice's category day by day, the same way every
    // other invoice's category gets decided. This only needs to confirm AT
    // LEAST ONE category can actually support the configured amount, not a
    // single user-picked one.
    const capacityByCategory = (["Meat", "Fruits"] as const).map((cat) => {
      // In By Category mode, per-product occurrencePercentage is unused —
      // the batch's Meat/Fruits % split decides what gets bought instead,
      // so every selected product in a category with a non-zero split is
      // eligible. In Global mode, only products with a configured
      // non-zero occurrence % can actually be bought.
      const productsWithOccurrence = selectedProducts.filter((item) => {
        const productCat = (item.product as any).category_name || "Meat";
        if (productCat !== cat) return false;
        if (occurrenceSemantics === "CATEGORY") {
          return (parseFloat(categoryAllocation[cat]) || 0) > 0;
        }
        const occ = parseFloat(item.occurrencePercentage || "0");
        return !isNaN(occ) && occ > 0;
      });
      const maxDailyCapacity = productsWithOccurrence.reduce((sum, item) => {
        const q = parseFloat(item.perDayQtyMax) || 0;
        const r = parseFloat(item.perDayRateMax) || 0;
        return sum + q * r;
      }, 0);
      return {
        category: cat,
        hasProducts: productsWithOccurrence.length > 0,
        maxDailyCapacity,
      };
    });
    const viableCategory = capacityByCategory.find(
      (c) => c.hasProducts && maxAmt <= c.maxDailyCapacity,
    );
    if (!viableCategory) {
      if (!capacityByCategory.some((c) => c.hasProducts)) {
        setErrorPopup(
          occurrenceSemantics === "CATEGORY"
            ? "No Meat or Fruits products are eligible in this batch — Purchase generation will never buy anything, so no stock can ever be reserved for this demand. Set the Meat/Fruits % split above 0% for at least one category in the Category Split card first."
            : "No Meat or Fruits products have a non-zero Occurrence Percentage in this batch — Purchase generation will never buy anything, so no stock can ever be reserved for this demand. Set an Occurrence Percentage above 0% for at least one product first.",
        );
      } else {
        const bestCapacity = Math.max(
          ...capacityByCategory.map((c) => c.maxDailyCapacity),
        );
        setErrorPopup(
          `The maximum invoice amount (₹${maxAmt.toLocaleString("en-IN")}) can never be reached in either category — even the best category tops out at ₹${Math.round(bestCapacity).toLocaleString("en-IN")} (a single invoice line can never exceed a product's own configured maximum quantity, no matter how much stock Purchase accumulates for it). Lower the max amount per invoice, raise the Quantity/Rate maximums in Product Rules, give more products a non-zero Occurrence Percentage, or split this demand into more invoices.`,
        );
      }
      return;
    }

    // Hard mathematical ceiling check #2 — a supplier can never receive
    // two invoices on the same day (real, mandatory business rule), so
    // reserving enough stock for ONE day can never exceed
    // `(suppliers available that day) x (this batch's own Maximum
    // Invoice Amount)` — no matter how much room the product Quantity/
    // Rate maximums leave. Uses the batch's TOTAL selected supplier count
    // as a necessary-condition upper bound (the real per-category count
    // may be smaller, in which case this can still fail later even after
    // passing here — but it can never wrongly block a config that would
    // actually have worked).
    const perDayAverage = amt / invCount;
    const batchMaxInvoiceAmount = parseFloat(formData.maximumInvoiceAmount) || 0;
    const supplierDayCeiling = selectedCustomers.length * batchMaxInvoiceAmount;
    if (
      selectedCustomers.length > 0 &&
      batchMaxInvoiceAmount > 0 &&
      perDayAverage > supplierDayCeiling
    ) {
      setErrorPopup(
        `The anticipated amount needs ~₹${Math.round(perDayAverage).toLocaleString("en-IN")} concentrated on a single day, but this batch only has ${selectedCustomers.length} supplier(s) selected and a supplier can never receive two invoices on the same day — even giving every selected supplier one invoice at this batch's own Maximum Invoice Amount (₹${batchMaxInvoiceAmount.toLocaleString("en-IN")}) tops out at ₹${Math.round(supplierDayCeiling).toLocaleString("en-IN")} for one day. Select more suppliers for this batch, raise the batch's Maximum Invoice Amount, or increase this entry's invoice count so the amount spreads across more days.`,
      );
      return;
    }

    setAnticipatedMajorCustomers([
      ...anticipatedMajorCustomers,
      { ...tempAnticipatedMajorCustomer },
    ]);
    setTempAnticipatedMajorCustomer({
      customer_id: "",
      amount: "",
      invoice_count: "1",
      max_invoice_amount: "",
    });
  };

  const handleRemoveAnticipatedMajorCustomer = (index: number) => {
    setAnticipatedMajorCustomers(
      anticipatedMajorCustomers.filter((_, i) => i !== index),
    );
  };

  const handleToggleCustomer = (customerId: string) => {
    if (selectedCustomers.includes(customerId)) {
      setSelectedCustomers(selectedCustomers.filter((id) => id !== customerId));
    } else {
      setSelectedCustomers([...selectedCustomers, customerId]);
    }
  };

  const handleSelectAllCustomers = () => {
    const regularCompanies = receivingCompanies.filter(
      (c) => !majorCustomers.some((m) => m.customer_id === c.id),
    );
    if (selectedCustomers.length === regularCompanies.length) {
      setSelectedCustomers([]);
    } else {
      setSelectedCustomers(regularCompanies.map((c) => c.id));
    }
  };

  const handleAddProduct = () => {
    if (!tempProduct) return;

    const rule = productRules.find((r) => r.product_id === tempProduct.id);
    if (!rule) {
      setErrorPopup(
        `The product "${tempProduct.product_name}" does not have any rules configured. Please configure its Quantity and Rate limits in the Product Rules module before adding it.`,
      );
      return;
    }

    if (selectedProducts.some((p) => p.product.id === tempProduct.id)) {
      setErrorPopup("This product has already been added!");
      return;
    }

    setSelectedProducts([
      ...selectedProducts,
      {
        product: tempProduct,
        perDayQtyMin: rule.quantity_min.toString(),
        perDayQtyMax: rule.quantity_max.toString(),
        perDayRateMin: rule.rate_min.toString(),
        perDayRateMax: rule.rate_max.toString(),
        monthlyQty: "",
        occurrencePercentage: "",
      },
    ]);
    setTempProduct(null);
  };

  const handleRemoveProduct = (productId: string) => {
    setSelectedProducts(
      selectedProducts.filter((p) => p.product.id !== productId),
    );
  };

  const resetForm = () => {
    setSelectedIssuingCompany(null);
    setSelectedCustomers([]);
    setMajorCustomers([]);
    setSelectedProducts([]);
    setTempProduct(null);
    setFormData({
      invoiceType: batchType.toUpperCase(),
      transportMode: "In Hand Delivery",
      vehicleNumber: "",
      dateOfSupply: undefined,
      invoiceDateFrom: undefined,
      invoiceDateTo: undefined,
      minimumInvoiceAmount: "",
      maximumInvoiceAmount: "",
      totalAmount: "",
      financialYearStart: currentYear,
      financialYearEnd: currentYear + 1,
    });
    setOccurrenceSemantics(null);
    setCategoryAllocation({ Meat: "70", Fruits: "30" });
  };

  const validateInvoiceBatch = async () => {
    if (batchType === "SALES") {
      await createInvoiceBatch();
      return;
    }

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
          minimum_invoice_amount: formData.minimumInvoiceAmount,
          maximum_invoice_amount: formData.maximumInvoiceAmount,
          totalAmount: formData.totalAmount,
        }),
      });

      let result: any;
      const resText = await response.text();
      try {
        result = JSON.parse(resText);
      } catch (parseError) {
        if (!response.ok) {
          throw new Error(
            `Server Error ${response.status}: ${resText.slice(0, 150)}`,
          );
        }
        result = { isValid: true };
      }

      if (!response.ok) {
        throw new Error(result?.message || `Server Error ${response.status}`);
      }

      if (result.isValid) {
        await createInvoiceBatch();
      } else {
        setErrorPopup(result.message);
      }
    } catch (error: any) {
      console.error("Validation error:", error);
      setErrorPopup(
        `Validation failed: ${error?.message || "Unknown error occurred"}`,
      );
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
        setErrorPopup("You must be logged in to create an invoice batch.");
        return;
      }

      if (batchType === "SALES") {
        console.log("[FLOW 1] Starting Sales Dry-Run validation process...");
        setIsValidating(true);
        try {
          console.log(
            "[FLOW 2] Sending POST to /api/generate-sales-dry-run...",
          );
          const res = await fetch("/api/generate-sales-dry-run", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              issuingCompanyId: selectedIssuingCompany?.id,
              receivingCompanyId:
                selectedCustomers[0] ||
                (majorCustomers[0] ? majorCustomers[0].customer_id : null),
              selectedCustomers: selectedCustomers,
              majorCustomers: majorCustomers.map((m) => ({
                customer_id: m.customer_id,
                amount: parseFloat(m.amount) || 0,
                invoice_count: parseInt(m.invoice_count, 10) || 1,
                max_invoice_amount: m.max_invoice_amount
                  ? parseFloat(m.max_invoice_amount)
                  : undefined,
              })),
              transportMode: formData.transportMode,
              vehicleNumber: formData.vehicleNumber || "",
              dateOfSupply: formData.invoiceDateTo
                ? formatDateForStorage(formData.invoiceDateTo)
                : null,
              invoiceDateFrom: formData.invoiceDateFrom
                ? formatDateForStorage(formData.invoiceDateFrom)
                : null,
              invoiceDateTo: formData.invoiceDateTo
                ? formatDateForStorage(formData.invoiceDateTo)
                : null,
              minimumInvoiceAmount: formData.minimumInvoiceAmount,
              maximumInvoiceAmount: formData.maximumInvoiceAmount,
              totalAmount: formData.totalAmount,
              financialYearStart: formData.financialYearStart,
              financialYearEnd: formData.financialYearEnd,
              previousEndingSequenceNumber:
                formData.previousEndingSequenceNumber,
              products: selectedProducts.map((item) => ({
                product_id: item.product.id,
                product_name: item.product.product_name,
                category:
                  (item.product as any).category_name ||
                  (item.product as any).category ||
                  "Meat",
                hsn_code: item.product.hsn_code,
                unit_of_measure: item.product.unit_of_measure,
                perDayQtyMin: item.perDayQtyMin,
                perDayQtyMax: item.perDayQtyMax,
                perDayRateMin: item.perDayRateMin,
                perDayRateMax: item.perDayRateMax,
                occurrencePercentage: item.occurrencePercentage,
              })),
              recurringProducts: [],
              stockSourceBatchId: formData.stockSourceBatchId,
              userId: user.id,
            }),
          });
          console.log("[FLOW 3] Received response status:", res.status);

          let result: any = {};
          const resText = await res.text();
          console.log("[FLOW 4] Response text length:", resText.length);
          try {
            result = JSON.parse(resText);
          } catch (e) {
            result = { message: resText || `Server Error ${res.status}` };
          }

          if (!res.ok) {
            console.error(
              "[FLOW 5] Dry-run failed with error:",
              result?.message,
            );
            setErrorPopup(result?.message || "Failed to run sales dry-run.");
            return;
          }

          console.log(
            "[FLOW 6] Dry-run succeeded. Invoices count:",
            result.invoices?.length,
            "Review rows count:",
            result.reviewRows?.length,
          );

          const invalidRow = (result.reviewRows || []).find(
            (row: any) => row.remaining_stock > 15 || row.remaining_stock < 0,
          );
          if (invalidRow) {
            console.error(
              "VERIFICATION FAILED: Invalid remaining stock generated!",
            );
            setErrorPopup(
              `Verification failed: Invalid remaining stock generated for ${invalidRow.product_name} on ${invalidRow.date}. Remaining: ${invalidRow.remaining_stock}.`,
            );
            return;
          }

          setProposedInvoices(result.invoices || []);
          setReviewRows(result.reviewRows || []);
          setIsReviewOpen(true);
          console.log("[FLOW 7] Opening review modal.");
        } catch (err: any) {
          console.error("[FLOW ERROR] Sales dry-run validation error:", err);
          setErrorPopup(
            `Sales validation error: ${err?.message || "An error occurred during validation"}`,
          );
        } finally {
          console.log("[FLOW FINALLY] Resetting isValidating to false.");
          setIsValidating(false);
        }
        return;
      }

      // PURCHASE path
      const selectedSupplierId =
        selectedCustomers[0] ||
        (majorCustomers[0] ? majorCustomers[0].customer_id : null);

      // STEP 1: Immediately before frontend submit
      console.log("=========================");
      console.log("PURCHASE BATCH CREATION - STEP 1 (Frontend Submit)");
      console.log("=========================");
      console.log({
        previousEndingSequenceNumber: formData.previousEndingSequenceNumber,
        parsedPreviousEndingSequence: formData.previousEndingSequenceNumber
          ? parseInt(formData.previousEndingSequenceNumber, 10)
          : null,
      });

      // By Category mode: each product's occurrence within its own
      // category is an automatic equal split, never user-entered — see
      // computeEqualCategoryOccurrence's doc comment.
      const equalCategorySplitForSubmit =
        occurrenceSemantics === "CATEGORY"
          ? computeEqualCategoryOccurrence(selectedProducts)
          : null;

      const payloadToInsert = {
        issuing_company_id: selectedIssuingCompany?.id,
        stock_source_batch_id: null,
        supplier_id: selectedSupplierId,
        receiving_company_id: null,
        selected_customers: selectedCustomers,
        major_customers: majorCustomers.map((m) => ({
          customer_id: m.customer_id,
          amount: parseFloat(m.amount) || 0,
          invoice_count: parseInt(m.invoice_count, 10) || 1,
          max_invoice_amount: m.max_invoice_amount
            ? parseFloat(m.max_invoice_amount)
            : undefined,
        })),
        anticipated_major_customers: anticipatedMajorCustomers.map((m) => ({
          customer_id: m.customer_id,
          amount: parseFloat(m.amount) || 0,
          invoice_count: parseInt(m.invoice_count, 10) || 1,
          max_invoice_amount: m.max_invoice_amount
            ? parseFloat(m.max_invoice_amount)
            : undefined,
        })),
        batch_type: formData.invoiceType,
        transport_mode: formData.transportMode,
        vehicle_number: formData.vehicleNumber || "",
        date_of_supply: formData.invoiceDateTo
          ? formatDateForStorage(formData.invoiceDateTo)
          : formatDateForStorage(new Date()),
        invoice_date_from: formData.invoiceDateFrom
          ? formatDateForStorage(formData.invoiceDateFrom)
          : null,
        invoice_date_to: formData.invoiceDateTo
          ? formatDateForStorage(formData.invoiceDateTo)
          : null,
        minimum_invoice_amount: parseFloat(formData.minimumInvoiceAmount),
        maximum_invoice_amount: parseFloat(formData.maximumInvoiceAmount),
        total_amount: parseFloat(formData.totalAmount),
        financial_year: `FY${formData.financialYearStart}-${String(formData.financialYearEnd).slice(2)}`,
        previous_ending_sequence:
          formData.previousEndingSequenceNumber !== undefined &&
          formData.previousEndingSequenceNumber !== null &&
          formData.previousEndingSequenceNumber !== "" &&
          !isNaN(Number(formData.previousEndingSequenceNumber))
            ? parseInt(formData.previousEndingSequenceNumber, 10)
            : null,
        products: selectedProducts.map((item) => ({
          product_id: item.product.id,
          product_name: item.product.product_name,
          category:
            (item.product as any).category_name ||
            (item.product as any).category ||
            "Meat",
          hsn_code: item.product.hsn_code,
          unit_of_measure: item.product.unit_of_measure,
          perDayQtyMin: item.perDayQtyMin,
          perDayQtyMax: item.perDayQtyMax,
          perDayRateMin: item.perDayRateMin,
          perDayRateMax: item.perDayRateMax,
          occurrencePercentage: equalCategorySplitForSubmit
            ? equalCategorySplitForSubmit.get(item.product.id) ?? 0
            : item.occurrencePercentage
              ? parseFloat(item.occurrencePercentage)
              : null,
        })),
        recurring_products: [],
        // Sprint 1.7S — NULL (the default, unless the user explicitly
        // picks CATEGORY below) preserves exactly what every pre-1.7S
        // batch already has stored: both columns NULL, which
        // InvoiceEngine/ProductOccurrenceService treat as legacy GLOBAL,
        // never auto-promoted to CATEGORY.
        category_allocation:
          occurrenceSemantics === "CATEGORY"
            ? {
                Meat: parseFloat(categoryAllocation.Meat) || 0,
                Fruits: parseFloat(categoryAllocation.Fruits) || 0,
              }
            : null,
        occurrence_semantics: occurrenceSemantics,
        status: "pending",
        batch_status: "REOPENED",
        created_by: user.id,
      };

      // STEP 2 & STEP 3: Immediately before insert
      console.log("=========================");
      console.log("PURCHASE BATCH CREATION - STEP 2 & 3 (Before Insert)");
      console.log("=========================");
      console.log({
        requestBodyPreviousEndingSequence:
          formData.previousEndingSequenceNumber,
        payloadPreviousEndingSequence: payloadToInsert.previous_ending_sequence,
        fullPayloadToInsert: payloadToInsert,
      });

      const { data, error } = await supabase
        .from("invoice_batch")
        .insert(payloadToInsert)
        .select()
        .single();

      // STEP 4: Immediately after insert
      console.log("=========================");
      console.log("PURCHASE BATCH CREATION - STEP 4 (After Insert Read Back)");
      console.log("=========================");
      console.log({
        insertedBatchId: data?.id,
        insertedPreviousEndingSequence: data?.previous_ending_sequence,
        fullInsertedBatchRow: data,
      });

      if (error) {
        console.error("Error creating invoice batch:", error);
        setErrorPopup(`Failed to create invoice batch: ${error.message}`);
        return;
      }

      console.log("Invoice batch created:", data);
      setErrorPopup("Invoice batch created successfully! Redirecting...");

      resetForm();

      router.push(
        batchType === "PURCHASE"
          ? "/purchase-invoice-batches"
          : "/invoice-batches",
      );
    } catch (error: any) {
      console.error("Error creating invoice batch:", error);
      setErrorPopup(
        `An error occurred while creating the batch: ${error?.message || error}`,
      );
    }
  };

  const handleSubmit = () => {
    setErrorField(null);

    if (!selectedIssuingCompany) {
      setErrorPopup("Please select an issuing company!");
      setErrorField("issuing-company");
      return;
    }

    if (selectedCustomers.length === 0 && majorCustomers.length === 0) {
      setErrorPopup(
        "Please select at least one customer or configure a major customer!",
      );
      setErrorField("customers");
      return;
    }

    if (selectedProducts.length === 0) {
      setErrorPopup("Please add at least one product!");
      setErrorField("products");
      return;
    }

    for (let i = 0; i < selectedProducts.length; i++) {
      const product = selectedProducts[i];

      const minQty = parseFloat(product.perDayQtyMin);
      const maxQty = parseFloat(product.perDayQtyMax);
      const minRate = parseFloat(product.perDayRateMin);
      const maxRate = parseFloat(product.perDayRateMax);

      if (minQty < 0 || maxQty < 0) {
        setErrorPopup(
          `Product "${product.product.product_name}": Quantities cannot be negative!`,
        );
        return;
      }

      if (minRate < 0 || maxRate < 0) {
        setErrorPopup(
          `Product "${product.product.product_name}": Rates cannot be negative!`,
        );
        return;
      }

      if (minQty > maxQty) {
        setErrorPopup(
          `Product "${product.product.product_name}": Minimum quantity (${minQty}) cannot be greater than maximum quantity (${maxQty})!`,
        );
        return;
      }

      if (minRate > maxRate) {
        setErrorPopup(
          `Product "${product.product.product_name}": Minimum rate (${minRate}) cannot be greater than maximum rate (${maxRate})!`,
        );
        return;
      }
      // By Category mode doesn't use per-product occurrence at all — the
      // Meat/Fruits % split is validated separately below, and each
      // product's own share within its category is computed automatically
      // (computeEqualCategoryOccurrence, used in formattedProductsForVal
      // and the submit payload below). Only Global mode (and Sales, which
      // inherits from its source batch) needs a per-product value here.
      if (occurrenceSemantics !== "CATEGORY") {
        if (
          product.occurrencePercentage === undefined ||
          product.occurrencePercentage === null ||
          product.occurrencePercentage === ""
        ) {
          if (batchType === "SALES") {
            const inherited =
              (product as any).occurrencePercentage ??
              (product.product as any).occurrencePercentage ??
              "0";
            product.occurrencePercentage = String(inherited);
          } else {
            setErrorPopup(
              `Product "${product.product.product_name}": Please enter a valid Occurrence Percentage between 0% and 100%.`,
            );
            return;
          }
        }
        const occPct = parseFloat(product.occurrencePercentage);
        if (isNaN(occPct) || occPct < 0 || occPct > 100) {
          setErrorPopup(
            `Product "${product.product.product_name}": Occurrence percentage must be a number between 0 and 100!`,
          );
          return;
        }
      }
    }

    // By Category mode: each product's occurrence within its own category
    // is an automatic equal split, never user-entered.
    const equalCategorySplitForVal =
      occurrenceSemantics === "CATEGORY"
        ? computeEqualCategoryOccurrence(selectedProducts)
        : null;

    // Enforce 100% Total Product Occurrence Distribution
    const formattedProductsForVal = selectedProducts.map((p) => ({
      product_id: p.product.id,
      product_name: p.product.product_name,
      hsn_code: p.product.hsn_code,
      unit_of_measure: p.product.unit_of_measure,
      perDayQtyMin: p.perDayQtyMin,
      perDayQtyMax: p.perDayQtyMax,
      perDayRateMin: p.perDayRateMin,
      perDayRateMax: p.perDayRateMax,
      category:
        (p.product as any).category_name ||
        (p.product as any).category ||
        "Meat",
      occurrencePercentage: equalCategorySplitForVal
        ? equalCategorySplitForVal.get(p.product.id) ?? 0
        : parseFloat(p.occurrencePercentage || "0") || 0,
    }));

    // Sprint 1.7S: semantics-aware — under CATEGORY, per-category
    // percentages legitimately sum to 100% WITHIN each category (and can
    // sum to e.g. 200% across the whole batch), which the old GLOBAL-only
    // InvoiceEngine.validateOccurrenceDistribution would incorrectly
    // reject. validateCategoryOccurrenceConfiguration is the single
    // existing authoritative validator for both cases (delegates straight
    // to the GLOBAL check when occurrenceSemantics is "GLOBAL" or null) —
    // reused as-is, no percentage/category math duplicated here.
    const categoryAllocationForValidation =
      occurrenceSemantics === "CATEGORY"
        ? {
            Meat: parseFloat(categoryAllocation.Meat) || 0,
            Fruits: parseFloat(categoryAllocation.Fruits) || 0,
          }
        : null;
    const occValidation = validateCategoryOccurrenceConfiguration(
      formattedProductsForVal,
      categoryAllocationForValidation,
      occurrenceSemantics,
    );
    if (!occValidation.valid) {
      setErrorPopup(
        occValidation.errors.join(" ") ||
          "Invalid Product Occurrence Distribution.",
      );
      return;
    }

    if (batchType === "SALES" && !formData.stockSourceBatchId) {
      setErrorPopup("Please select a Stock Source!");
      return;
    }

    if (!formData.transportMode) {
      setErrorPopup("Please enter transportation mode!");
      return;
    }

    if (
      !formData.invoiceDateFrom ||
      !formData.invoiceDateTo ||
      !formData.minimumInvoiceAmount ||
      !formData.maximumInvoiceAmount ||
      !formData.totalAmount
    ) {
      setErrorPopup("Please fill in all Invoice Configuration fields!");
      return;
    }

    if (formData.invoiceDateFrom > formData.invoiceDateTo) {
      setErrorPopup(
        "Invoice 'From Date' must be less than or equal to 'To Date'!",
      );
      return;
    }

    const minimumInvoiceAmount = parseFloat(formData.minimumInvoiceAmount);
    const maximumInvoiceAmount = parseFloat(formData.maximumInvoiceAmount);
    const totalAmount = parseFloat(formData.totalAmount);

    if (minimumInvoiceAmount < 0 || maximumInvoiceAmount < 0) {
      setErrorPopup("Invoice amounts cannot be negative!");
      return;
    }

    if (maximumInvoiceAmount < minimumInvoiceAmount) {
      setErrorPopup(
        "Maximum Invoice Amount cannot be less than Minimum Invoice Amount!",
      );
      return;
    }

    if (totalAmount < 0) {
      setErrorPopup("Total amount cannot be negative!");
      return;
    }

    const totalMajor = majorCustomers.reduce(
      (sum, m) => sum + (parseFloat(m.amount) || 0),
      0,
    );
    if (totalMajor > totalAmount) {
      setErrorPopup("Major customer allocation exceeds total amount.");
      return;
    }

    if (batchType === "PURCHASE") {
      const totalAnticipated = anticipatedMajorCustomers.reduce(
        (sum, m) => sum + (parseFloat(m.amount) || 0),
        0,
      );
      if (totalMajor + totalAnticipated > totalAmount) {
        setErrorPopup(
          "Major Supplier allocation plus Anticipated Major Customer Demand exceeds the batch's total amount.",
        );
        return;
      }
    }

    for (let i = 0; i < majorCustomers.length; i++) {
      const major = majorCustomers[i];
      if (!major.customer_id) {
        setErrorPopup("Please select a customer for all major customer rows!");
        return;
      }
      const amt = parseFloat(major.amount);
      const invs = parseInt(major.invoice_count, 10);
      if (isNaN(amt) || amt <= 0) {
        setErrorPopup("Amount for all major customers must be greater than 0!");
        return;
      }
      if (isNaN(invs) || invs < 1) {
        setErrorPopup(
          "Number of invoices for all major customers must be at least 1!",
        );
        return;
      }
    }

    // ── General Party & Product Availability Validation ──
    const partyTerm =
      batchType === "PURCHASE" ? "Supplier" : "Receiving Customer";
    let availableParties = receivingCompanies;

    if (batchType === "PURCHASE") {
      if (!receivingCompanies || receivingCompanies.length === 0) {
        setErrorPopup(
          "No Suppliers are available. Please create at least one Supplier or perform a Bulk Upload.",
        );
        return;
      }

      const firstProd = selectedProducts[0]?.product;
      const rawCat = (
        (firstProd as any)?.category_name ||
        (firstProd as any)?.category ||
        "Meat"
      ).toUpperCase();
      const targetCategory = rawCat.includes("FRUIT") ? "FRUITS" : "MEAT";

      const matchedSuppliers = receivingCompanies.filter((p: any) => {
        const cat = (p.category || "Meat").toUpperCase();
        return cat === targetCategory;
      });

      if (matchedSuppliers.length === 0) {
        const displayCat = targetCategory === "FRUITS" ? "Fruit" : "Meat";
        setErrorPopup(
          `No ${displayCat} Suppliers are available. Please create at least one ${displayCat} Supplier.`,
        );
        return;
      }
      availableParties = matchedSuppliers;
    } else {
      if (!availableParties || availableParties.length === 0) {
        setErrorPopup(
          `No ${partyTerm}s are available. Please create at least one ${partyTerm} before generating invoices.`,
        );
        return;
      }
    }

    if (!products || products.length === 0) {
      setErrorPopup(
        "No products are available in the selected category. Please create products before generating invoices.",
      );
      return;
    }

    // ── Intelligent Pre-Generation Capacity Check (Daily Billing Rule) ──
    const fromDate = new Date(formData.invoiceDateFrom);
    const toDate = new Date(formData.invoiceDateTo);
    const timeDiff = Math.abs(toDate.getTime() - fromDate.getTime());
    const numberOfDays = Math.ceil(timeDiff / (1000 * 3600 * 24)) + 1;

    const remainingAmount = totalAmount - totalMajor;
    const regCustomerCount = selectedCustomers.length;

    if (remainingAmount > 0.01 && regCustomerCount > 0) {
      const avgInvoiceAmount =
        (minimumInvoiceAmount + maximumInvoiceAmount) / 2;
      const estimatedRequiredInvoices = Math.round(
        remainingAmount / Math.max(1, avgInvoiceAmount),
      );

      if (estimatedRequiredInvoices > MAX_INVOICES_PER_BATCH) {
        setErrorPopup(
          `Estimated batch size (${estimatedRequiredInvoices.toLocaleString()} invoices) exceeds maximum capacity of ${MAX_INVOICES_PER_BATCH.toLocaleString()} invoices per batch. Please adjust total amount, invoice thresholds, or date range.`,
        );
        return;
      }

      // Under daily billing rule: max capacity = regCustomerCount * numberOfDays
      const maxCapacity = regCustomerCount * numberOfDays;

      if (estimatedRequiredInvoices > maxCapacity) {
        const partyTerm =
          batchType === "PURCHASE" ? "Suppliers" : "Receiving Customers";
        const singlePartyTerm =
          batchType === "PURCHASE" ? "Supplier" : "Receiving Customer";

        const requiredCustomersCount = Math.ceil(
          estimatedRequiredInvoices / numberOfDays,
        );
        const deficitCustomers = Math.max(
          0,
          requiredCustomersCount - regCustomerCount,
        );

        const targetAvgAmount = remainingAmount / Math.max(1, maxCapacity);
        const rawMin = targetAvgAmount * 0.8;
        const rawMax = targetAvgAmount * 1.2;
        const suggestedMin =
          Math.round(rawMin / 100) * 100 || Math.round(rawMin);
        const suggestedMax =
          Math.round(rawMax / 100) * 100 || Math.round(rawMax);

        setValidationGuidance({
          title: "Invoice Generation Cannot Proceed",
          reason: `Under the Daily Billing Rule, each ${singlePartyTerm} can be billed at most once per day on any specific date.`,
          partyTerm,
          singlePartyTerm,
          numberOfDays,
          totalAmount: remainingAmount,
          minAmount: minimumInvoiceAmount,
          maxAmount: maximumInvoiceAmount,
          avgAmount: avgInvoiceAmount,
          estimatedRequiredInvoices,
          availableCustomers: regCustomerCount,
          maxCapacity,
          deficitCustomers,
          requiredCustomersCount,
          suggestedMin,
          suggestedMax,
        });
        return;
      }
    }

    validateInvoiceBatch();
  };

  const handleApplySuggestedLimits = (
    suggestedMin: number,
    suggestedMax: number,
  ) => {
    setFormData((prev) => ({
      ...prev,
      minimumInvoiceAmount: String(suggestedMin),
      maximumInvoiceAmount: String(suggestedMax),
    }));
  };

  const handleSaveSalesBatch = async (
    adjustedInvoices: any[],
    finalReviewRows: any[],
  ) => {
    try {
      // Reconcile the dry-run invoices against the user's final Daily Stock
      // Ledger selections (Null / Auto Allocate / manual per-cell edits) so
      // that what gets saved actually reflects what was reviewed & approved.
      const targetQtyMap = new Map<string, number>();
      for (const row of finalReviewRows || []) {
        targetQtyMap.set(
          `${row.date}_${row.product_id}`,
          Number(row.proposed_sold || 0),
        );
      }
      const productConfigs = selectedProducts.map((item) => ({
        product_id: item.product.id,
        product_name: item.product.product_name,
        hsn_code: item.product.hsn_code,
        unit_of_measure: item.product.unit_of_measure,
        perDayRateMin: item.perDayRateMin,
        perDayRateMax: item.perDayRateMax,
        category:
          (item.product as any).category_name ||
          (item.product as any).category ||
          undefined,
      }));
      // Major Customer invoices already carry their own exact,
      // separately-configured amount/category from generation and must
      // never be touched by Null mode/Auto Allocate reconciliation below
      // — computed up front so it can be threaded through every pass.
      const majorCustomerIds = new Set(
        majorCustomers.map((m) => m.customer_id).filter(Boolean),
      );
      const fallbackCustomerId = selectedCustomers[0] || null;
      const reconciledInvoicesRaw = reconcileInvoicesToTargets(
        JSON.parse(JSON.stringify(adjustedInvoices || [])),
        targetQtyMap,
        productConfigs,
        fallbackCustomerId,
        parseFloat(formData.maximumInvoiceAmount) || undefined,
        majorCustomerIds,
        parseFloat(formData.minimumInvoiceAmount) || undefined,
      );
      let reconciledInvoices = enforceMinimumInvoiceAmount(
        reconciledInvoicesRaw,
        parseFloat(formData.minimumInvoiceAmount) || 0,
        parseFloat(formData.maximumInvoiceAmount) || Infinity,
        majorCustomerIds,
      );

      // Quantities are now final (Null mode's 100% sell, Auto Allocate's
      // leftover pacing, or manual per-cell edits — whichever the user
      // picked). Solve a single price per product, within its configured
      // Product Rule [rate_min, rate_max], so the batch's total value
      // actually matches the Total Amount the user entered, instead of
      // random per-line rates from the dry-run producing an unrelated
      // total. Major Customer invoices already have their own
      // separately-configured amount and are excluded, with their total
      // subtracted out of the target.
      const majorCustomersTotal = majorCustomers.reduce(
        (sum, m) => sum + (parseFloat(m.amount) || 0),
        0,
      );
      const regularTargetTotal = Math.max(
        0,
        (parseFloat(formData.totalAmount) || 0) - majorCustomersTotal,
      );
      const majorInvoices = reconciledInvoices.filter((inv: any) =>
        majorCustomerIds.has(inv.customer_id),
      );
      const regularInvoicesForSolve = reconciledInvoices.filter(
        (inv: any) => !majorCustomerIds.has(inv.customer_id),
      );
      // solveRatesToHitTotal can open brand-new invoices (never sheds sold
      // quantity — Null mode/Auto Allocate already decided exactly how
      // much gets sold) — its return value is the source of truth, not
      // the array reference passed in.
      const solvedRegularInvoices = solveRatesToHitTotal(
        regularInvoicesForSolve,
        productConfigs,
        regularTargetTotal,
        parseFloat(formData.maximumInvoiceAmount) || undefined,
        fallbackCustomerId,
      );
      reconciledInvoices = [...majorInvoices, ...solvedRegularInvoices];
      reconciledInvoices = enforceMinimumInvoiceAmount(
        reconciledInvoices,
        parseFloat(formData.minimumInvoiceAmount) || 0,
        parseFloat(formData.maximumInvoiceAmount) || Infinity,
        majorCustomerIds,
      );

      console.log("reconciledInvoices length:", reconciledInvoices?.length);
      const stringifiedInvoices = JSON.stringify(reconciledInvoices);
      console.log(
        "reconciledInvoices stringified length:",
        stringifiedInvoices?.length,
      );
      if (reconciledInvoices && reconciledInvoices.length > 0) {
        console.log(
          "Sample Invoice:",
          JSON.stringify(reconciledInvoices[0]).slice(0, 1000),
        );
      }

      setIsSavingSales(true);
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        setErrorPopup("You must be logged in to save the sales batch.");
        return;
      }

      const res = await fetch("/api/create-sales-batch-transactional", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          issuingCompanyId: selectedIssuingCompany?.id,
          receivingCompanyId:
            selectedCustomers[0] ||
            (majorCustomers[0] ? majorCustomers[0].customer_id : null),
          selectedCustomers: selectedCustomers,
          majorCustomers: majorCustomers.map((m) => ({
            customer_id: m.customer_id,
            amount: parseFloat(m.amount) || 0,
            invoice_count: parseInt(m.invoice_count, 10) || 1,
            max_invoice_amount: m.max_invoice_amount
              ? parseFloat(m.max_invoice_amount)
              : undefined,
          })),
          transportMode: formData.transportMode,
          vehicleNumber: formData.vehicleNumber || "",
          dateOfSupply: formData.invoiceDateTo
            ? formatDateForStorage(formData.invoiceDateTo)
            : null,
          invoiceDateFrom: formData.invoiceDateFrom
            ? formatDateForStorage(formData.invoiceDateFrom)
            : null,
          invoiceDateTo: formData.invoiceDateTo
            ? formatDateForStorage(formData.invoiceDateTo)
            : null,
          minimumInvoiceAmount: formData.minimumInvoiceAmount,
          maximumInvoiceAmount: formData.maximumInvoiceAmount,
          totalAmount: formData.totalAmount,
          financialYearStart: formData.financialYearStart,
          financialYearEnd: formData.financialYearEnd,
          previousEndingSequenceNumber: formData.previousEndingSequenceNumber,
          products: selectedProducts.map((item) => ({
            product_id: item.product.id,
            product_name: item.product.product_name,
            category:
              (item.product as any).category_name ||
              (item.product as any).category ||
              "Meat",
            hsn_code: item.product.hsn_code,
            unit_of_measure: item.product.unit_of_measure,
            perDayQtyMin: item.perDayQtyMin,
            perDayQtyMax: item.perDayQtyMax,
            perDayRateMin: item.perDayRateMin,
            perDayRateMax: item.perDayRateMax,
            // Sprint 1.7S — this final-save payload previously dropped
            // occurrencePercentage entirely (unlike the Purchase payload
            // and Sales' own dry-run payload, both of which already carry
            // it), which meant CATEGORY's own per-category occurrence
            // check (validateCategoryOccurrenceConfiguration ->
            // validateOccurrenceConfiguration on each category's product
            // subset) could never be satisfied for a Sales batch. Wired
            // through here to match Purchase exactly (item 6).
            occurrencePercentage: item.occurrencePercentage
              ? parseFloat(item.occurrencePercentage)
              : null,
          })),
          recurringProducts: [],
          stockSourceBatchId: formData.stockSourceBatchId,
          userId: user.id,
          invoicesOverride: reconciledInvoices,
          // Sprint 1.7S — same fields, same shape as the Purchase path
          // (Sales and Purchase share this configuration).
          occurrenceSemantics,
          categoryAllocation:
            occurrenceSemantics === "CATEGORY"
              ? {
                  Meat: parseFloat(categoryAllocation.Meat) || 0,
                  Fruits: parseFloat(categoryAllocation.Fruits) || 0,
                }
              : null,
        }),
      });

      let result: any = {};
      const resText = await res.text();
      try {
        result = JSON.parse(resText);
      } catch (e) {
        result = { message: resText || `Server Error ${res.status}` };
      }
      setIsSavingSales(false);

      if (!res.ok) {
        setErrorPopup(
          result?.message || "Failed to save transactional Sales batch.",
        );
        return;
      }

      setIsReviewOpen(false);
      setErrorPopup(
        result?.message || "Sales batch and invoices created successfully!",
      );
      resetForm();
      router.push("/invoice-batches");
    } catch (err: any) {
      setIsSavingSales(false);
      console.error("Error saving sales batch:", err);
      setErrorPopup(`Failed to save sales batch: ${err.message}`);
    }
  };

  return {
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
    anticipatedMajorCustomers,
    anticipatedCustomers,
    anticipatedMajorCustomerOpen,
    setAnticipatedMajorCustomerOpen,
    tempAnticipatedMajorCustomer,
    setTempAnticipatedMajorCustomer,
    handleAddAnticipatedMajorCustomer,
    handleRemoveAnticipatedMajorCustomer,
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
    resetForm,
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
  };
}
