"use client";

import { Loader2, Plus, Save, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { numberToWords } from "@/lib/numberToWords";
import { BALANCE_LIMITS } from "@/lib/services/purchase-balance/types";
import {
  computeLineAmount,
  isValidWholeNumber,
} from "@/lib/utils/quantity-rate-utils";

type InvoiceEditorProps = {
  isOpen: boolean;
  onClose: () => void;
  invoice: any;
  batch: any;
  onSave: (
    id: string,
    updates: any,
    setStatus: (status: string) => void,
  ) => Promise<void>;
};

export default function InvoiceEditor({
  isOpen,
  onClose,
  invoice,
  batch,
  onSave,
}: InvoiceEditorProps) {
  const [isSaving, setIsSaving] = useState(false);
  const [savingStatus, setSavingStatus] = useState("Saving...");

  const [transportMode, setTransportMode] = useState("");
  const [vehicleNumber, setVehicleNumber] = useState("");
  const [dateOfSupply, setDateOfSupply] = useState("");
  const [products, setProducts] = useState<any[]>([]);

  // Read-only "how much of this product could be added cleanly right now"
  // estimate per batch product, shown on the Quick Add buttons so a
  // shortfall (like adding a product with nowhere for its cost to come
  // from) is visible before Save instead of surfacing as a surprise
  // cross-invoice change afterward. Undefined while loading, present once
  // fetched; a missing key just renders no badge for that product.
  const [capacities, setCapacities] = useState<Record<string, number>>({});
  const [capacitiesLoading, setCapacitiesLoading] = useState(false);
  const [capacityDate, setCapacityDate] = useState<string | null>(null);

  const refreshCapacities = async (draftProducts?: any[]) => {
    if (!batch?.id || !invoice?.id) return;
    setCapacitiesLoading(true);
    try {
      const endpoint =
        batch?.batch_type === "SALES"
          ? "/api/sales-invoice-product-capacity"
          : "/api/purchase-invoice-product-capacity";
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          batchId: batch.id,
          invoiceId: invoice.id,
          draftProducts,
        }),
      });
      const data = await res.json();
      if (res.ok && data.capacities) setCapacities(data.capacities);
      if (res.ok && data.date) setCapacityDate(data.date);
    } catch {
      // Purely advisory — a failed fetch just means no badges are shown.
      // Save-time validation is the real safety net either way.
    } finally {
      setCapacitiesLoading(false);
    }
  };

  useEffect(() => {
    if (invoice && isOpen) {
      setTransportMode(
        invoice.transport_mode || batch?.transport_mode || "In hand Delivery",
      );
      setVehicleNumber(invoice.vehicle_number || batch?.vehicle_number || "NA");
      setDateOfSupply(invoice.date_of_supply || invoice.invoice_date || "");
      setProducts(
        invoice.products ? JSON.parse(JSON.stringify(invoice.products)) : [],
      );
      setCapacities({});
      refreshCapacities();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoice, batch, isOpen]);

  if (!invoice) return null;

  // Major customer invoices are exempt from the max-products-per-invoice
  // cap (see FinalValidator/PurchaseInvoiceValidator) since they're never
  // part of the balancing solver's combinatorial search and can
  // legitimately need many more lines to reach a large configured amount.
  const invoicePartyId =
    invoice.customer_id || invoice.products?.[0]?.customer_id;
  const isMajorCustomerInvoice = !!(
    invoicePartyId &&
    batch?.major_customers?.some(
      (m: any) => m.customer_id === invoicePartyId,
    )
  );

  // Major customer invoices can never be edited or used as a rebalancing
  // target (Sales, this round — Purchase is a planned follow-up). Blocked
  // here as the primary UX; InvoiceListPage disables the Edit button
  // entirely, and SalesDayScopedEditEngine itself rejects it server-side
  // as a backstop.
  if (isMajorCustomerInvoice && batch?.batch_type === "SALES") {
    return (
      <Dialog
        open={isOpen}
        onOpenChange={(open) => !open && onClose()}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Invoice {invoice.invoice_number}</DialogTitle>
          </DialogHeader>
          <p className="text-slate-600">
            This invoice belongs to a major customer and cannot be edited.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              <X className="h-4 w-4 mr-2" /> Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  // Live Calculations
  let totalAmountBeforeTax = 0;
  const productRows = products.map((p) => {
    const qty = Number(p.quantity) || 0;
    const rate = Number(p.rate) || 0;
    // Whole-rupee, matching computeLineAmount used server-side — a raw
    // qty*rate here can show e.g. 2,251.50 while the backend actually
    // persists/validates 2,252, confusing users and (for Sales) tripping
    // the line-amount validation rule.
    const amount = computeLineAmount(qty, rate);
    totalAmountBeforeTax += amount;
    return { ...p, amount };
  });

  const cgst = "Nil";
  const sgst = "Nil";
  const totalAmountAfterTax = Math.round(totalAmountBeforeTax);

  const handleProductChange = (index: number, field: string, value: string) => {
    const newProducts = [...products];
    newProducts[index] = { ...newProducts[index], [field]: value };
    setProducts(newProducts);
  };

  const handleAddProduct = (batchProduct: any) => {
    if (products.some((p) => p.product_id === batchProduct.product_id)) {
      alert(
        `${batchProduct.product_name} is already on this invoice — edit its Quantity field directly instead of adding it again.`,
      );
      return;
    }
    if (
      !isMajorCustomerInvoice &&
      products.length >= BALANCE_LIMITS.maxInvoiceLines
    ) {
      alert(
        `A purchase invoice can contain at most ${BALANCE_LIMITS.maxInvoiceLines} products. Remove a product before adding another.`,
      );
      return;
    }
    const capacity = capacities[batchProduct.product_id];
    if (capacity === 0) {
      const proceed = window.confirm(
        batch?.batch_type === "SALES"
          ? `No stock of ${batchProduct.product_name} is available on ${capacityDate || "this invoice's date"} — saving will likely fail. Add it anyway?`
          : `${batchProduct.product_name} currently has no available room in this batch to add cleanly — saving may require rebalancing an unrelated invoice, or fail if there's genuinely no capacity anywhere. Add it anyway?`,
      );
      if (!proceed) return;
    }
    const newProducts = [...products];
    newProducts.push({
      product_id: batchProduct.product_id,
      product_name: batchProduct.product_name,
      hsn_code: batchProduct.hsn_code,
      quantity: capacity && capacity > 0 ? Math.min(1, capacity) : 1,
      rate: Number(batchProduct.perDayRateMin) || 0,
      amount: 0,
    });
    setProducts(newProducts);
    refreshCapacities(newProducts);
  };

  const handleRemoveProduct = (index: number) => {
    if (window.confirm("Remove this product?")) {
      const newProducts = [...products];
      newProducts.splice(index, 1);
      setProducts(newProducts);
      refreshCapacities(newProducts);
    }
  };

  const handleSave = async () => {
    if (!products.length) return alert("At least one product is required.");
    if (
      !isMajorCustomerInvoice &&
      products.length > BALANCE_LIMITS.maxInvoiceLines
    ) {
      return alert(
        `This invoice has ${products.length} products, exceeding the maximum of ${BALANCE_LIMITS.maxInvoiceLines}. Remove products before saving.`,
      );
    }
    for (const p of products) {
      const qty = Number(p.quantity);
      const rate = Number(p.rate);
      if (isNaN(qty) || qty <= 0) return alert("All quantities must be > 0");
      if (isNaN(rate) || rate <= 0) return alert("All rates must be > 0");
      if (!isValidWholeNumber(rate)) {
        return alert(
          "Rate must be a whole number.\n\nDecimal rates are not permitted.",
        );
      }
      const uom = String(p.unit_of_measure || "kg").toLowerCase();
      const isWeight = /kg|ton|g/.test(uom);
      const isQuarterStep = Math.abs(qty * 4 - Math.round(qty * 4)) < 0.001;
      if (isWeight && !isQuarterStep) {
        return alert(
          `Quantity for "${p.product_name}" must be in quarter-kg steps (e.g. 0.25, 0.50, 0.75, 1.00).`,
        );
      }
    }
    if (totalAmountBeforeTax <= 0) return alert("Invoice total must be > 0");
    if (!transportMode) return alert("Transportation mode is required.");
    if (!dateOfSupply) return alert("Date of supply is required.");

    setIsSaving(true);
    setSavingStatus("Updating Invoice...");
    try {
      await onSave(
        invoice.id,
        {
          transport_mode: transportMode,
          vehicle_number: vehicleNumber,
          date_of_supply: dateOfSupply,
          products: productRows.map((pr) => ({
            ...pr,
            quantity: Number(pr.quantity) || 0,
            rate: Number(pr.rate) || 0,
            amount: Number(pr.amount) || 0,
          })),
          total_amount: Number(totalAmountBeforeTax) || 0,
        },
        setSavingStatus,
      );
      onClose();
    } catch (err: any) {
      console.error(err);
      alert(err.message || "Failed to save invoice.");
    } finally {
      setIsSaving(false);
      setSavingStatus("Saving...");
    }
  };

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => !open && !isSaving && onClose()}
    >
      <DialogContent className="max-w-5xl sm:max-w-5xl md:max-w-6xl lg:max-w-[90vw] xl:max-w-[1600px] p-0 overflow-hidden bg-slate-50 flex flex-col h-[95vh]">
        <DialogHeader className="p-6 border-b bg-white shrink-0">
          <DialogTitle className="text-2xl font-semibold">
            Edit Invoice: {invoice.invoice_number}
          </DialogTitle>
          {batch?.batch_type === "SALES" && invoice.invoice_date && (
            <p className="text-sm text-slate-500">
              Invoice date: {invoice.invoice_date} — edits can only use stock
              available on this day.
            </p>
          )}
        </DialogHeader>

        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Transport Details Section */}
          <div className="bg-white rounded-lg border shadow-sm p-6">
            <h3 className="text-lg font-semibold mb-4 text-slate-800">
              Transport Details
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-700">
                  Transportation Mode
                </label>
                <Input
                  value={transportMode}
                  onChange={(e) => setTransportMode(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-700">
                  Vehicle Number
                </label>
                <Input
                  value={vehicleNumber}
                  onChange={(e) => setVehicleNumber(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-700">
                  Date of Supply
                </label>
                <Input
                  value={dateOfSupply}
                  onChange={(e) => setDateOfSupply(e.target.value)}
                />
              </div>
            </div>
          </div>

          {/* Products Section */}
          <div className="bg-white rounded-lg border shadow-sm p-6">
            <div className="flex flex-col md:flex-row md:items-center justify-between mb-6 gap-4">
              <h3 className="text-lg font-semibold text-slate-800">Products</h3>
              <div className="flex items-center gap-3 flex-wrap">
                {!isMajorCustomerInvoice &&
                products.length >= BALANCE_LIMITS.maxInvoiceLines ? (
                  <span className="text-sm font-medium text-amber-600">
                    Maximum of {BALANCE_LIMITS.maxInvoiceLines} products
                    reached. Remove one to add another.
                  </span>
                ) : (
                  <>
                    <span className="text-sm font-medium text-slate-500">
                      Quick Add:
                    </span>
                    {batch?.products?.map((bp: any) => {
                      const capacity = capacities[bp.product_id];
                      const hasNoRoom = capacity === 0;
                      return (
                        <Button
                          key={bp.product_id}
                          variant="outline"
                          size="sm"
                          className={
                            hasNoRoom
                              ? "border-dashed border-2 border-amber-300 text-amber-700 hover:border-solid"
                              : "border-dashed border-2 hover:border-solid"
                          }
                          title={
                            hasNoRoom
                              ? batch?.batch_type === "SALES"
                                ? `No stock of ${bp.product_name} is available on ${capacityDate || "this invoice's date"}.`
                                : `${bp.product_name} currently has no room to be added cleanly without rebalancing an unrelated invoice.`
                              : capacity !== undefined
                                ? batch?.batch_type === "SALES"
                                  ? `Up to ~${capacity}kg available on ${capacityDate || "this invoice's date"} (may need to pull from another invoice that day — saving will confirm).`
                                  : `Up to ~${capacity} available to add cleanly right now.`
                                : undefined
                          }
                          onClick={() => handleAddProduct(bp)}
                        >
                          <Plus className="h-3 w-3 mr-1" /> {bp.product_name}
                          {capacitiesLoading && capacity === undefined ? (
                            <span className="ml-1.5 text-slate-400">
                              &hellip;
                            </span>
                          ) : capacity !== undefined ? (
                            <span
                              className={
                                hasNoRoom
                                  ? "ml-1.5 text-amber-600 font-normal"
                                  : "ml-1.5 text-emerald-600 font-normal"
                              }
                            >
                              ({capacity})
                            </span>
                          ) : null}
                        </Button>
                      );
                    })}
                  </>
                )}
              </div>
            </div>

            <div className="rounded-md border overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="bg-slate-50 text-slate-700 border-b">
                  <tr>
                    <th className="px-4 py-3 font-medium whitespace-nowrap">
                      Product Name
                    </th>
                    <th className="px-4 py-3 font-medium whitespace-nowrap">
                      HSN
                    </th>
                    <th className="px-4 py-3 font-medium whitespace-nowrap w-32">
                      Quantity
                    </th>
                    <th className="px-4 py-3 font-medium whitespace-nowrap w-40">
                      Rate (₹)
                    </th>
                    <th className="px-4 py-3 font-medium whitespace-nowrap text-right w-32">
                      Amount (₹)
                    </th>
                    <th className="px-4 py-3 w-16"></th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {products.map((p, idx) => (
                    <tr
                      key={idx}
                      className="bg-white hover:bg-slate-50/50 transition-colors"
                    >
                      <td className="px-4 py-3 font-medium text-slate-900">
                        {p.product_name}
                      </td>
                      <td className="px-4 py-3 text-slate-500">{p.hsn_code}</td>
                      <td className="px-4 py-3">
                        <Input
                          type="number"
                          min="0"
                          step="0.25"
                          value={p.quantity}
                          onChange={(e) =>
                            handleProductChange(idx, "quantity", e.target.value)
                          }
                          className="h-9 w-full text-center"
                        />
                      </td>
                      <td className="px-4 py-3">
                        <Input
                          type="number"
                          min="0"
                          step="1"
                          value={p.rate}
                          onChange={(e) =>
                            handleProductChange(idx, "rate", e.target.value)
                          }
                          className="h-9 w-full text-right"
                        />
                      </td>
                      <td className="px-4 py-3 text-right font-medium text-slate-900">
                        {computeLineAmount(
                          Number(p.quantity) || 0,
                          Number(p.rate) || 0,
                        ).toLocaleString("en-IN", {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleRemoveProduct(idx)}
                          className="text-slate-400 hover:text-red-600 hover:bg-red-50 h-8 w-8"
                          title="Remove Product"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                  {products.length === 0 && (
                    <tr>
                      <td
                        colSpan={6}
                        className="px-4 py-12 text-center text-slate-500"
                      >
                        No products added. Use the quick add buttons above.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Totals Summary */}
            <div className="flex justify-end mt-6">
              <div className="w-full max-w-sm bg-slate-50 p-6 rounded-lg border">
                <div className="space-y-3">
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-600 font-medium">Subtotal</span>
                    <span className="font-semibold text-slate-900">
                      ₹
                      {totalAmountBeforeTax.toLocaleString("en-IN", {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}
                    </span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-600 font-medium">
                      CGST (9%)
                    </span>
                    <span className="font-semibold text-slate-900">{cgst}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-600 font-medium">
                      SGST (9%)
                    </span>
                    <span className="font-semibold text-slate-900">{sgst}</span>
                  </div>
                  <div className="flex justify-between items-center text-lg font-bold pt-4 border-t border-slate-200 mt-4">
                    <span className="text-slate-900">Net Total</span>
                    <span className="text-blue-700">
                      ₹
                      {totalAmountAfterTax.toLocaleString("en-IN", {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}
                    </span>
                  </div>
                  <div className="text-xs text-slate-500 text-right mt-1 italic">
                    {numberToWords(totalAmountAfterTax)}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <DialogFooter className="p-6 border-t bg-white shrink-0">
          <Button variant="outline" onClick={onClose} disabled={isSaving}>
            <X className="h-4 w-4 mr-2" /> Cancel
          </Button>
          <Button onClick={handleSave} disabled={isSaving}>
            {isSaving ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Save className="h-4 w-4 mr-2" />
            )}
            {isSaving ? "Saving..." : "Save Changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
