"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

function formatDateForStorage(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
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
  const [errorPopup, setErrorPopup] = useState<string | null>(null);

  const [selectedIssuingCompany, setSelectedIssuingCompany] =
    useState<IssuingCompany | null>(null);
  const [selectedCustomers, setSelectedCustomers] = useState<string[]>([]);
  const [majorCustomers, setMajorCustomers] = useState<
    Array<{
      customer_id: string;
      amount: string;
      invoice_count: string;
    }>
  >([]);

  const [customerOpen, setCustomerOpen] = useState(false);
  const [majorCustomerOpen, setMajorCustomerOpen] = useState(false);
  const [tempMajorCustomer, setTempMajorCustomer] = useState({
    customer_id: "",
    amount: "",
    invoice_count: "1",
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
  });

  useEffect(() => {
    const fetchData = async () => {
      const [issuingRes, receivingRes, productsRes, rulesRes] =
        await Promise.all([
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
          supabase.from("product_rules").select("*"),
        ]);

      if (issuingRes.data) setIssuingCompanies(issuingRes.data);
      if (receivingRes.data) setReceivingCompanies(receivingRes.data);
      if (productsRes.data) setProducts(productsRes.data);
      if (rulesRes.data) setProductRules(rulesRes.data);
    };

    fetchData();
  }, []);

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
    if (!tempMajorCustomer.customer_id) return;
    if (
      !tempMajorCustomer.amount ||
      parseFloat(tempMajorCustomer.amount) <= 0
    ) {
      setErrorPopup("Amount must be greater than 0");
      return;
    }
    if (
      !tempMajorCustomer.invoice_count ||
      parseInt(tempMajorCustomer.invoice_count, 10) < 1
    ) {
      setErrorPopup("Invoices must be at least 1");
      return;
    }
    setMajorCustomers([...majorCustomers, { ...tempMajorCustomer }]);
    setSelectedCustomers(
      selectedCustomers.filter((id) => id !== tempMajorCustomer.customer_id),
    );
    setTempMajorCustomer({ customer_id: "", amount: "", invoice_count: "1" });
  };

  const handleRemoveMajorCustomer = (index: number) => {
    setMajorCustomers(majorCustomers.filter((_, i) => i !== index));
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

      let result;
      try {
        const text = await response.text();
        result = JSON.parse(text);
      } catch (parseError) {
        throw new Error(
          `Invalid server response (Status: ${response.status}). Expected JSON.`,
        );
      }

      if (!response.ok) {
        throw new Error(result.message || `Server Error ${response.status}`);
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
        setIsValidating(true);
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
            recurringProducts: [],
            stockSourceBatchId: formData.stockSourceBatchId,
            userId: user.id,
          }),
        });

        const result = await res.json();
        setIsValidating(false);

        if (!res.ok) {
          setErrorPopup(result.message || "Failed to run sales dry-run.");
          return;
        }

        const invalidRow = (result.reviewRows || []).find(
          (row: any) => row.remaining_stock > 15 || row.remaining_stock < 0,
        );
        if (invalidRow) {
          console.error(
            "VERIFICATION FAILED: Invalid remaining stock generated!",
          );
          console.error("Product:", invalidRow.product_name);
          console.error("Date:", invalidRow.date);
          console.error("Opening:", invalidRow.opening_stock);
          console.error("Purchased:", invalidRow.purchased_quantity);
          console.error(
            "Available:",
            invalidRow.opening_stock + invalidRow.purchased_quantity,
          );
          console.error("Proposed Sold:", invalidRow.proposed_sold);
          console.error("Remaining:", invalidRow.remaining_stock);
          console.error(
            "Last modified by: InvoiceEngine.generateInvoiceSplitupsInternal",
          );

          setErrorPopup(
            `Verification failed: Invalid remaining stock generated for ${invalidRow.product_name} on ${invalidRow.date}. Remaining: ${invalidRow.remaining_stock}. Check developer console for details.`,
          );
          return;
        }

        setProposedInvoices(result.invoices || []);
        setReviewRows(result.reviewRows || []);
        setIsReviewOpen(true);
        return;
      }

      // PURCHASE path (unchanged)
      const { data, error } = await supabase
        .from("invoice_batch")
        .insert({
          issuing_company_id: selectedIssuingCompany?.id,
          stock_source_batch_id: null,
          receiving_company_id:
            selectedCustomers[0] ||
            (majorCustomers[0] ? majorCustomers[0].customer_id : null),
          selected_customers: selectedCustomers,
          major_customers: majorCustomers.map((m) => ({
            customer_id: m.customer_id,
            amount: parseFloat(m.amount) || 0,
            invoice_count: parseInt(m.invoice_count, 10) || 1,
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
          products: selectedProducts.map((item) => ({
            product_id: item.product.id,
            product_name: item.product.product_name,
            hsn_code: item.product.hsn_code,
            unit_of_measure: item.product.unit_of_measure,
            perDayQtyMin: item.perDayQtyMin,
            perDayQtyMax: item.perDayQtyMax,
            perDayRateMin: item.perDayRateMin,
            perDayRateMax: item.perDayRateMax,
            occurrencePercentage: item.occurrencePercentage
              ? parseFloat(item.occurrencePercentage)
              : null,
          })),
          recurring_products: [],
          status: "pending",
          created_by: user.id,
        })
        .select()
        .single();

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
    if (!selectedIssuingCompany) {
      setErrorPopup("Please select an issuing company!");
      return;
    }

    if (selectedCustomers.length === 0 && majorCustomers.length === 0) {
      setErrorPopup(
        "Please select at least one customer or configure a major customer!",
      );
      return;
    }

    if (selectedProducts.length === 0) {
      setErrorPopup("Please add at least one product!");
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
      if (product.occurrencePercentage) {
        const occPct = parseFloat(product.occurrencePercentage);
        if (isNaN(occPct) || occPct < 0 || occPct > 100) {
          setErrorPopup(
            `Product "${product.product.product_name}": Occurrence percentage must be a number between 0 and 100!`,
          );
          return;
        }
      }
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

    validateInvoiceBatch();
  };

  const handleSaveSalesBatch = async (
    adjustedInvoices: any[],
    finalReviewRows: any[],
  ) => {
    try {
      console.log("adjustedInvoices length:", adjustedInvoices?.length);
      const stringifiedInvoices = JSON.stringify(adjustedInvoices);
      console.log(
        "adjustedInvoices stringified length:",
        stringifiedInvoices?.length,
      );
      if (adjustedInvoices && adjustedInvoices.length > 0) {
        console.log(
          "Sample Invoice:",
          JSON.stringify(adjustedInvoices[0]).slice(0, 1000),
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
          recurringProducts: [],
          stockSourceBatchId: formData.stockSourceBatchId,
          userId: user.id,
          invoicesOverride: adjustedInvoices,
        }),
      });

      const result = await res.json();
      setIsSavingSales(false);

      if (!res.ok) {
        setErrorPopup(
          result.message || "Failed to save transactional Sales batch.",
        );
        return;
      }

      setIsReviewOpen(false);
      setErrorPopup("Sales batch and invoices created atomically!");
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
    resetForm,
    isReviewOpen,
    setIsReviewOpen,
    reviewRows,
    proposedInvoices,
    isSavingSales,
    handleSaveSalesBatch,
  };
}
