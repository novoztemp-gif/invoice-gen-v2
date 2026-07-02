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
    }
  }, [invoice, batch, isOpen]);

  if (!invoice) return null;

  // Live Calculations
  let totalAmountBeforeTax = 0;
  const productRows = products.map((p) => {
    const qty = Number(p.quantity) || 0;
    const rate = Number(p.rate) || 0;
    const amount = qty * rate;
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
    const newProducts = [...products];
    newProducts.push({
      product_id: batchProduct.product_id,
      product_name: batchProduct.product_name,
      hsn_code: batchProduct.hsn_code,
      quantity: 1,
      rate: Number(batchProduct.perDayRateMin) || 0,
      amount: 0,
    });
    setProducts(newProducts);
  };

  const handleRemoveProduct = (index: number) => {
    if (window.confirm("Remove this product?")) {
      const newProducts = [...products];
      newProducts.splice(index, 1);
      setProducts(newProducts);
    }
  };

  const handleSave = async () => {
    if (!products.length) return alert("At least one product is required.");
    for (const p of products) {
      if (Number(p.quantity) <= 0) return alert("All quantities must be > 0");
      if (Number(p.rate) <= 0) return alert("All rates must be > 0");
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
          products: productRows,
          total_amount: totalAmountBeforeTax,
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
      <DialogContent className="max-w-5xl sm:max-w-5xl md:max-w-6xl p-0 overflow-hidden bg-slate-50 flex flex-col h-[90vh]">
        <DialogHeader className="p-6 border-b bg-white shrink-0">
          <DialogTitle className="text-2xl font-semibold">
            Edit Invoice: {invoice.invoice_number}
          </DialogTitle>
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
                <span className="text-sm font-medium text-slate-500">
                  Quick Add:
                </span>
                {batch?.products?.map((bp: any) => (
                  <Button
                    key={bp.product_id}
                    variant="outline"
                    size="sm"
                    className="border-dashed border-2 hover:border-solid"
                    onClick={() => handleAddProduct(bp)}
                  >
                    <Plus className="h-3 w-3 mr-1" /> {bp.product_name}
                  </Button>
                ))}
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
                          step="0.01"
                          value={p.rate}
                          onChange={(e) =>
                            handleProductChange(idx, "rate", e.target.value)
                          }
                          className="h-9 w-full text-right"
                        />
                      </td>
                      <td className="px-4 py-3 text-right font-medium text-slate-900">
                        {(
                          Number(p.quantity) * Number(p.rate) || 0
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
