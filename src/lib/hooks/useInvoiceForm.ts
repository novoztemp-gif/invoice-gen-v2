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

  const [recurringProducts, setRecurringProducts] = useState<
    { product_id: string; percentage: string }[]
  >([]);
  const [recurringProductOpen, setRecurringProductOpen] = useState(false);
  const [tempRecurringProduct, setTempRecurringProduct] = useState({
    product_id: "",
    percentage: "",
  });

  const [isValidating, setIsValidating] = useState(false);

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
      },
    ]);
    setTempProduct(null);
  };

  const handleRemoveProduct = (productId: string) => {
    setSelectedProducts(
      selectedProducts.filter((p) => p.product.id !== productId),
    );
  };

  const handleAddRecurringProduct = () => {
    if (!tempRecurringProduct.product_id) return;
    const percentage = parseFloat(tempRecurringProduct.percentage);
    if (isNaN(percentage) || percentage < 1 || percentage > 100) {
      setErrorPopup("Percentage must be between 1 and 100");
      return;
    }
    const exists = recurringProducts.some(
      (p) => p.product_id === tempRecurringProduct.product_id,
    );
    if (exists) {
      setErrorPopup("This product is already in the recurring list.");
      return;
    }

    const isSelected = selectedProducts.some(
      (p) => p.product.id === tempRecurringProduct.product_id,
    );
    if (!isSelected) {
      setErrorPopup(
        "Recurring products must be selected in the main Products list first.",
      );
      return;
    }

    const currentTotal = recurringProducts.reduce(
      (sum, p) => sum + parseFloat(p.percentage),
      0,
    );
    if (currentTotal + percentage > 100) {
      setErrorPopup(
        `Total percentage cannot exceed 100%. Current total is ${currentTotal}%.`,
      );
      return;
    }

    setRecurringProducts([...recurringProducts, { ...tempRecurringProduct }]);
    setTempRecurringProduct({ product_id: "", percentage: "" });
  };

  const handleRemoveRecurringProduct = (productId: string) => {
    setRecurringProducts(
      recurringProducts.filter((p) => p.product_id !== productId),
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

      const { data, error } = await supabase
        .from("invoice_batch")
        .insert({
          issuing_company_id: selectedIssuingCompany?.id,
          stock_source_batch_id:
            batchType === "SALES" ? formData.stockSourceBatchId || null : null,
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
          })),
          recurring_products: recurringProducts.map((rp) => ({
            product_id: rp.product_id,
            percentage: parseFloat(rp.percentage),
          })),
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

      // If PURCHASE batch, insert actual quantities into purchase_batch_products table
      if (batchType === "PURCHASE" && data) {
        const purchaseProductsToInsert = selectedProducts.map((item) => ({
          batch_id: data.id,
          product_id: item.product.id,
          monthly_quantity: parseFloat(item.monthlyQty || "0"),
        }));

        const { error: purchaseProductsError } = await supabase
          .from("purchase_batch_products")
          .insert(purchaseProductsToInsert);

        if (purchaseProductsError) {
          console.error(
            "Error saving purchase batch products:",
            purchaseProductsError,
          );
          setErrorPopup(
            `Batch created, but failed to save monthly quantities: ${purchaseProductsError.message}`,
          );
          return;
        }
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

      if (batchType === "PURCHASE") {
        const monthlyQty = parseFloat(product.monthlyQty || "");
        if (isNaN(monthlyQty) || monthlyQty <= 0) {
          setErrorPopup(
            `Product "${product.product.product_name}": Please enter a valid Monthly Purchase Quantity greater than 0!`,
          );
          return;
        }
      }

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
    resetForm,
  };
}
