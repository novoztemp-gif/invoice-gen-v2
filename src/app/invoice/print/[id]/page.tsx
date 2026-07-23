"use client";

import { ArrowLeft, Loader2, Printer } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { numberToWords } from "@/lib/numberToWords";
import { createClient } from "@/lib/supabase/client";

export default function PrintInvoicePage() {
  const params = useParams();
  const router = useRouter();
  const invoiceId = params.id as string;
  const isChallan =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("isChallan") === "true";

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [invoice, setInvoice] = useState<any>(null);
  const [batch, setBatch] = useState<any>(null);
  const [issuingCompany, setIssuingCompany] = useState<any>(null);
  const [receivingCompany, setReceivingCompany] = useState<any>(null);

  useEffect(() => {
    async function fetchData() {
      try {
        const supabase = createClient();

        // 1. Fetch invoice
        const { data: inv, error: invError } = await supabase
          .from("invoice")
          .select("*")
          .eq("id", invoiceId)
          .single();

        if (invError || !inv) {
          throw new Error("Invoice not found");
        }

        // 2. Fetch batch
        const { data: b, error: bError } = await supabase
          .from("invoice_batch")
          .select("*")
          .eq("id", inv.invoice_batch_id)
          .single();

        if (bError || !b) {
          throw new Error("Batch not found");
        }

        // 3. Fetch issuing company
        const { data: issuing, error: issuingError } = await supabase
          .from("issuing_companies")
          .select("*")
          .eq("id", b.issuing_company_id)
          .single();

        // 4. Fetch receiving company
        const customerId =
          inv.products?.[0]?.customer_id || b.receiving_company_id;
        const { data: receiving, error: receivingError } = await supabase
          .from("receiving_companies")
          .select("*")
          .eq("id", customerId)
          .single();

        setInvoice(inv);
        setBatch(b);
        setIssuingCompany(issuing);
        setReceivingCompany(receiving);
      } catch (err: any) {
        setError(err.message || "Failed to fetch invoice details");
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, [invoiceId]);

  useEffect(() => {
    if (invoice && batch && issuingCompany && receivingCompany) {
      const timer = setTimeout(() => {
        window.print();
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [invoice, batch, issuingCompany, receivingCompany]);

  if (loading) {
    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center bg-white text-slate-900">
        <Loader2 className="h-8 w-8 animate-spin text-slate-500 mb-2" />
        <p className="text-sm font-medium">Loading Invoice Layout...</p>
      </div>
    );
  }

  if (error || !invoice) {
    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center bg-white text-slate-900">
        <h1 className="text-lg font-bold text-red-600 mb-2">
          Error Loading Invoice
        </h1>
        <p className="text-sm text-slate-500 mb-4">
          {error || "Invoice details missing."}
        </p>
        <Button onClick={() => router.back()} variant="outline" size="sm">
          <ArrowLeft className="h-4 w-4 mr-2" /> Go Back
        </Button>
      </div>
    );
  }

  let totalAmountBeforeTax = 0;
  const productRows =
    invoice.products?.map((p: any) => {
      const qty = Number(p.quantity) || 0;
      const rate = Number(p.rate) || 0;
      const amount = qty * rate;
      totalAmountBeforeTax += amount;
      return { ...p, amount };
    }) || [];

  const cgst = "Nil";
  const sgst = "Nil";
  const totalAmountAfterTax = Math.round(totalAmountBeforeTax);

  const isPurchase = batch?.batch_type === "PURCHASE";

  const transportMode =
    invoice.transport_mode || batch?.transport_mode || "In hand Delivery";
  const vehicleNumber = invoice.vehicle_number || batch?.vehicle_number || "NA";
  const dateOfSupply = invoice.date_of_supply || invoice.invoice_date || "";

  // For Sales invoice padding
  const minProductRows = 16;
  const renderRows = [...productRows];
  while (renderRows.length < minProductRows) {
    renderRows.push({
      product_name: "",
      hsn_code: "",
      quantity: "",
      rate: "",
      amount: "",
    } as any);
  }

  return (
    <div className="min-h-screen bg-white text-black p-0 flex flex-col items-center relative">
      {/* Print styles */}
      <style jsx global>{`
        @media print {
          body {
            background: white !important;
            color: black !important;
            margin: 0 !important;
            padding: 0 !important;
            -webkit-print-color-adjust: exact !important;
            print-color-adjust: exact !important;
          }
          .no-print {
            display: none !important;
          }
          .print-content {
            border: none !important;
            box-shadow: none !important;
            margin: 0 !important;
            padding: 0 !important;
            transform: none !important;
          }
        }
        @page {
          size: ${isPurchase ? "A5 landscape" : "A4 portrait"};
          margin: 0;
        }
      `}</style>

      {/* Control bar */}
      <div className="no-print w-full bg-slate-900 text-white py-3 px-6 flex justify-between items-center fixed top-0 left-0 right-0 z-50 shadow-md">
        <div className="flex items-center gap-2">
          <Button
            onClick={() => router.back()}
            variant="ghost"
            className="text-white hover:bg-slate-800 hover:text-white"
          >
            <ArrowLeft className="h-4 w-4 mr-2" /> Back
          </Button>
          <span className="font-bold text-sm">
            {invoice.invoice_number} (
            {isPurchase ? "Purchase Voucher" : "Sales Invoice"})
          </span>
        </div>
        <Button
          onClick={() => window.print()}
          className="bg-blue-600 hover:bg-blue-700 text-white font-bold"
        >
          <Printer className="h-4 w-4 mr-2" /> Print / Save PDF
        </Button>
      </div>

      {/* Sheet Container */}
      <div className="pt-20 pb-8 no-print" />

      <div className="print-content bg-white">
        {isPurchase ? (
          /* A5 Landscape Purchase Voucher */
          <div
            className="p-5 flex flex-col justify-between text-black bg-white"
            style={{
              fontFamily: "Arial, sans-serif",
              border: "1.5px solid black",
              height: "148mm",
              width: "210mm",
              boxSizing: "border-box",
            }}
          >
            <div className="space-y-3">
              {/* Header */}
              <div className="text-center">
                <h2 className="text-xl font-bold tracking-wider text-black border-b border-black pb-1 uppercase">
                  Purchase Invoice
                </h2>
              </div>

              {/* No. and Date */}
              <div className="flex justify-between items-center text-xs font-bold">
                <div>
                  No.{" "}
                  <span className="underline ml-1">
                    {invoice.invoice_number}
                  </span>
                </div>
                <div>
                  Date.{" "}
                  <span className="underline ml-1">
                    {invoice.invoice_date
                      ? new Date(invoice.invoice_date).toLocaleDateString(
                          "en-GB",
                        )
                      : "—"}
                  </span>
                </div>
              </div>

              {/* Rs Box */}
              <div className="flex items-center">
                <div className="border border-black flex items-center h-8 bg-white">
                  <span className="px-2 border-r border-black font-bold h-full flex items-center bg-gray-50 text-xs">
                    Rs
                  </span>
                  <span className="px-3 font-bold text-sm">
                    {Number(invoice.total_amount).toFixed(2)}
                  </span>
                </div>
              </div>

              {/* Pay To Box */}
              <div className="space-y-0.5">
                <label className="text-[10px] font-bold text-slate-700 uppercase tracking-wider">
                  Pay to
                </label>
                <div className="border border-black p-2 font-bold bg-white text-sm">
                  {receivingCompany?.company_name || "—"}
                </div>
              </div>

              {/* Rs. in Words Box */}
              <div className="space-y-0.5">
                <label className="text-[10px] font-bold text-slate-700 uppercase tracking-wider">
                  Rs. in Words
                </label>
                <div className="border border-black p-2 font-bold bg-white text-xs">
                  Rupees {numberToWords(Math.round(invoice.total_amount))} Only
                </div>
              </div>

              {/* Description Details (being and debit) */}
              <div className="space-y-2 pt-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-xs font-bold whitespace-nowrap">
                    being
                  </span>
                  <div className="flex-1 border-b border-dashed border-black pb-0.5 text-xs font-medium">
                    Purchase of{" "}
                    {invoice.products
                      ?.map((p: any) => p.product_name)
                      .join(", ") || "raw materials"}
                  </div>
                </div>
                <div className="flex items-baseline gap-2">
                  <span className="text-xs font-bold whitespace-nowrap">
                    and debit
                  </span>
                  <div className="flex-1 border-b border-dashed border-black pb-0.5 text-xs"></div>
                </div>
              </div>
            </div>

            <div className="space-y-3 mt-4">
              {/* Authorised by and Recd. Sum */}
              <div className="flex justify-between items-end">
                <div className="space-y-1">
                  <span className="text-[10px] font-bold block text-slate-700 uppercase tracking-wider">
                    Authorised by
                  </span>
                  <div className="border border-black w-48 h-12 bg-white" />
                </div>
                <div className="text-xs font-bold pb-1">
                  Recd. above sum of Rs.{" "}
                  <span className="underline ml-1">
                    {Number(invoice.total_amount).toFixed(2)}
                  </span>
                </div>
              </div>

              {/* Footer Payment Block & Receiver Signature */}
              <div className="flex gap-4 items-stretch">
                {/* Payment info */}
                <div className="flex-1 border border-black p-2 flex gap-4 bg-white">
                  <div className="flex flex-col justify-center items-center pr-4 border-r border-slate-200">
                    <span className="text-[10px] font-bold underline">
                      cash
                    </span>
                    <span className="text-[9px] text-slate-500 my-0.5">or</span>
                    <span className="text-[10px] font-bold underline">
                      cheque
                    </span>
                  </div>
                  <div className="flex-1 text-[10px] space-y-0.5 font-medium">
                    <div>
                      <span className="font-bold">Drawn on Bank:</span>{" "}
                      {issuingCompany?.bank_name || "—"}
                    </div>
                    <div>
                      <span className="font-bold">A/c No.</span>{" "}
                      {issuingCompany?.account_number || "—"}
                    </div>
                    <div>
                      <span className="font-bold">IFSC:</span>{" "}
                      {issuingCompany?.ifsc_code || "—"}
                    </div>
                  </div>
                </div>

                {/* Receiver signature */}
                <div className="border border-black w-48 p-2 flex flex-col justify-between items-center bg-white">
                  <div className="w-full h-12" />
                  <div className="text-[9px] font-bold text-center border-t border-slate-200 w-full pt-1">
                    Receiver's Signature
                  </div>
                </div>
              </div>
            </div>
          </div>
        ) : (
          /* A4 Portrait Sales Invoice Table Layout */
          <table
            className="text-[11px] border-collapse bg-white"
            style={{
              fontFamily: "Arial, sans-serif",
              border: "1.5px solid black",
              width: "210mm",
              minHeight: "297mm",
            }}
          >
            <colgroup>
              <col style={{ width: "8%" }} />
              <col style={{ width: "2%" }} />
              <col style={{ width: "32%" }} />
              <col style={{ width: "18%" }} />
              <col style={{ width: "12%" }} />
              <col style={{ width: "2%" }} />
              <col style={{ width: "11%" }} />
              <col style={{ width: "15%" }} />
            </colgroup>
            <tbody>
              <tr>
                <td
                  colSpan={8}
                  className="text-center font-bold text-lg text-blue-900 bg-gray-200 py-2 border-b border-black"
                >
                  {issuingCompany?.company_name}
                </td>
              </tr>
              <tr>
                <td
                  colSpan={8}
                  className="text-center font-bold bg-gray-200 py-1 border-b border-black"
                >
                  {issuingCompany?.address}
                </td>
              </tr>
              <tr>
                <td
                  colSpan={8}
                  className="text-center font-bold underline bg-gray-200 py-1 border-b border-black uppercase"
                >
                  {isChallan ? "DELIVERY CHALLAN" : "INVOICE"}
                </td>
              </tr>

              <tr>
                <td
                  colSpan={3}
                  className="font-bold bg-gray-200 border-r border-b border-black px-1 py-1"
                >
                  Delivery Details
                </td>
                <td
                  colSpan={5}
                  className="font-bold bg-gray-200 border-b border-black px-1 py-1"
                >
                  Seller Details
                </td>
              </tr>

              <tr>
                <td colSpan={2} className="px-1 border-r border-black">
                  Transportation Mode
                </td>
                <td className="px-1 font-medium border-r border-black">
                  {transportMode}
                </td>
                <td
                  colSpan={5}
                  className="px-1 font-bold text-blue-900 border-black border-r"
                >
                  GSTIN : {issuingCompany?.gstin}
                </td>
              </tr>
              <tr>
                <td colSpan={2} className="px-1 border-r border-black border-t">
                  Vehicle Number
                </td>
                <td className="px-1 font-medium border-r border-black border-t">
                  {vehicleNumber}
                </td>
                <td colSpan={5} className="px-1 border-r border-black"></td>
              </tr>
              <tr>
                <td
                  colSpan={2}
                  className="px-1 border-r border-black border-t border-b"
                >
                  Date of Supply (on or Before)
                </td>
                <td className="px-1 font-medium border-r border-black border-t border-b">
                  {dateOfSupply}
                </td>
                <td
                  colSpan={5}
                  className="px-1 font-bold text-blue-900 border-b border-r border-black"
                >
                  Phone : {issuingCompany?.phone}
                </td>
              </tr>

              <tr>
                <td
                  colSpan={3}
                  className="font-bold bg-gray-200 border-r border-b border-black px-1 py-1"
                >
                  Details of Receiver / Billed to :
                </td>
                <td
                  colSpan={5}
                  className="font-bold bg-gray-200 border-b border-black px-1 py-1"
                >
                  Original for Recipient
                </td>
              </tr>

              <tr>
                <td className="px-1 border-l border-black">Name</td>
                <td className="text-center">:</td>
                <td className="px-1 font-bold border-r border-black">
                  {receivingCompany?.company_name}
                </td>
                <td className="px-1">Invoice No</td>
                <td className="text-center">:</td>
                <td
                  colSpan={3}
                  className="px-1 font-bold border-r border-black"
                >
                  {invoice.invoice_number}
                </td>
              </tr>
              <tr>
                <td className="px-1 border-l border-black align-top border-t">
                  Address
                </td>
                <td className="text-center align-top border-t">:</td>
                <td className="px-1 align-top border-r border-black border-t pb-4 pt-1 whitespace-pre-wrap">
                  {receivingCompany?.address}
                </td>
                <td className="px-1 border-t">Date</td>
                <td className="text-center border-t">:</td>
                <td
                  colSpan={3}
                  className="px-1 font-bold border-r border-black border-t"
                >
                  {invoice.invoice_date}
                </td>
              </tr>
              <tr>
                <td className="px-1 border-l border-black border-t">GSTIN</td>
                <td className="text-center border-t">:</td>
                <td className="px-1 font-bold border-r border-black border-t">
                  {receivingCompany?.gstin || "Unregistered"}
                </td>
                <td colSpan={5} className="px-1 border-t border-r border-black">
                  Financial Year: {batch?.financial_year}
                </td>
              </tr>
              <tr>
                <td className="px-1 border-l border-black border-t">PAN</td>
                <td className="text-center border-t">:</td>
                <td className="px-1 font-bold border-r border-black border-t">
                  {receivingCompany?.pan}
                </td>
                <td
                  colSpan={5}
                  className="px-1 border-t border-r border-black"
                ></td>
              </tr>
              <tr>
                <td className="px-1 border-l border-black border-t border-b">
                  State
                </td>
                <td className="text-center border-t border-b">:</td>
                <td className="px-1 font-bold border-r border-black border-t border-b">
                  {receivingCompany?.state}
                </td>
                <td
                  colSpan={5}
                  className="px-1 font-bold border-t border-r border-b border-black"
                >
                  {receivingCompany?.state_code
                    ? `State Code : ${receivingCompany.state_code}`
                    : ""}
                </td>
              </tr>

              <tr className="bg-gray-200 font-bold text-center">
                <td rowSpan={2} className="border border-black px-1">
                  Sl.
                  <br />
                  No.
                </td>
                <td
                  colSpan={2}
                  rowSpan={2}
                  className="border border-black px-1"
                >
                  Name of the Product / Service
                </td>
                <td rowSpan={2} className="border border-black px-1">
                  HSN/ ACS
                </td>
                <td rowSpan={2} className="border border-black px-1">
                  Qty in KG
                </td>
                <td colSpan={2} className="border border-black px-1">
                  Rate Per KG
                </td>
                <td rowSpan={2} className="border border-black px-1">
                  Total Amount
                </td>
              </tr>
              <tr className="bg-gray-200 font-bold text-center">
                <td colSpan={2} className="border border-black px-1">
                  Rs.
                </td>
              </tr>

              {renderRows.map((p, idx) => {
                const isRealProduct = idx < productRows.length;
                return (
                  <tr key={idx} className="h-6">
                    <td className="border border-black text-center px-1">
                      {isRealProduct ? idx + 1 : ""}
                    </td>
                    <td colSpan={2} className="border border-black px-1">
                      {p.product_name}
                    </td>
                    <td className="border border-black text-center px-1">
                      {p.hsn_code}
                    </td>
                    <td className="border border-black text-center px-1">
                      {p.quantity}
                    </td>
                    <td
                      colSpan={2}
                      className="border border-black text-right px-1"
                    >
                      {p.rate ? Math.round(Number(p.rate)) : ""}
                    </td>
                    <td className="border border-black text-right px-1 font-medium bg-slate-50/50">
                      {p.amount ? Number(p.amount).toFixed(2) : ""}
                    </td>
                  </tr>
                );
              })}

              <tr>
                <td
                  colSpan={7}
                  className="border border-black bg-gray-200 font-bold text-center py-1"
                >
                  Total
                </td>
                <td className="border border-black bg-gray-200 font-bold text-right px-1">
                  {totalAmountBeforeTax.toFixed(2)}
                </td>
              </tr>

              <tr>
                <td
                  colSpan={3}
                  className="border border-black font-bold text-center text-emerald-700 py-1 uppercase"
                >
                  ✅ GOODS DISPATCHED
                </td>
                <td colSpan={2} className="border border-black px-1 py-1">
                  Total Amount Before Tax
                </td>
                <td colSpan={2} className="border border-black px-1">
                  Rs.
                </td>
                <td className="border border-black text-right font-bold px-1">
                  {totalAmountBeforeTax.toFixed(2)}
                </td>
              </tr>
              <tr>
                <td
                  colSpan={3}
                  rowSpan={2}
                  className="border border-black font-bold text-blue-900 px-1 py-1 align-top"
                >
                  Rupees in words: {numberToWords(totalAmountAfterTax)}
                </td>
                <td colSpan={2} className="border border-black px-1 py-1">
                  Add : CGST*
                </td>
                <td colSpan={2} className="border border-black px-1">
                  Rs.
                </td>
                <td className="border border-black text-right font-bold px-1">
                  {cgst}
                </td>
              </tr>
              <tr>
                <td colSpan={2} className="border border-black px-1 py-1">
                  Add : SGST*
                </td>
                <td colSpan={2} className="border border-black px-1">
                  Rs.
                </td>
                <td className="border border-black text-right font-bold px-1">
                  {sgst}
                </td>
              </tr>

              <tr>
                <td
                  colSpan={3}
                  className="border border-black font-bold px-1 py-1"
                >
                  Company's Bank Details :
                </td>
                <td colSpan={2} className="border border-black px-1 py-1">
                  Total Amount After GST
                </td>
                <td colSpan={2} className="border border-black px-1">
                  Rs.
                </td>
                <td className="border border-black text-right font-bold px-1">
                  {totalAmountAfterTax.toFixed(2)}
                </td>
              </tr>
              <tr>
                <td className="border-l border-black px-1">Name of Account</td>
                <td className="text-center">:</td>
                <td className="border-r border-black font-bold px-1">
                  {issuingCompany?.company_name}
                </td>
                <td colSpan={2} className="border border-black px-1">
                  Forwarding
                </td>
                <td colSpan={2} className="border border-black px-1">
                  Rs.
                </td>
                <td className="border border-black text-right px-1">0.00</td>
              </tr>
              <tr>
                <td className="border-l border-black px-1">Name of Bank</td>
                <td className="text-center">:</td>
                <td className="border-r border-black font-bold px-1">
                  {issuingCompany?.bank_name}
                </td>
                <td colSpan={2} className="border border-black px-1">
                  Postage
                </td>
                <td colSpan={2} className="border border-black px-1">
                  Rs.
                </td>
                <td className="border border-black text-right px-1">0.00</td>
              </tr>
              <tr>
                <td className="border-l border-black px-1">Branch Name</td>
                <td className="text-center">:</td>
                <td className="border-r border-black font-bold px-1">
                  {issuingCompany?.branch}
                </td>
                <td colSpan={2} className="border border-black px-1">
                  Other charges if any
                </td>
                <td colSpan={2} className="border border-black px-1">
                  Rs.
                </td>
                <td className="border border-black text-right px-1">0.00</td>
              </tr>
              <tr>
                <td className="border-l border-black px-1">Account No.</td>
                <td className="text-center">:</td>
                <td className="border-r border-black font-bold px-1">
                  {issuingCompany?.account_number}
                </td>
                <td colSpan={2} className="border border-black px-1">
                  Ps.Rounded Off
                </td>
                <td colSpan={2} className="border border-black px-1">
                  Rs.
                </td>
                <td className="border border-black text-right px-1">0.00</td>
              </tr>
              <tr>
                <td className="border-l border-black px-1 border-b">
                  IFSC Code
                </td>
                <td className="text-center border-b">:</td>
                <td className="border-r border-black font-bold px-1 border-b">
                  {issuingCompany?.ifsc_code}
                </td>
                <td
                  colSpan={3}
                  className="border border-black font-bold text-lg bg-gray-200 px-1 py-1"
                >
                  Net Total
                </td>
                <td
                  colSpan={2}
                  className="border border-black font-bold text-lg bg-gray-200 text-right px-1"
                >
                  {totalAmountAfterTax.toFixed(2)}
                </td>
              </tr>
              <tr>
                <td className="border-l border-black px-1 border-b">PAN</td>
                <td className="text-center border-b">:</td>
                <td className="border-r border-black font-bold px-1 border-b">
                  {issuingCompany?.pan}
                </td>
                <td colSpan={5} className="border-r border-black border-b"></td>
              </tr>

              <tr>
                <td
                  colSpan={4}
                  className="border border-black align-top px-1 py-1 text-[9px]"
                >
                  Terms & Conditions :<br />
                  1. Interest @ 24% p.a. Will be charged for overdue bills (more
                  than 30 days).
                  <br />
                  2. All disputes are subject to Chennai Jurisdiction
                </td>
                <td
                  colSpan={4}
                  className="border border-black align-top text-center px-1 py-1 font-bold text-blue-900 pb-12"
                >
                  Certified that the particulars given above are true and
                  correct
                  <br />
                  For {issuingCompany?.company_name}
                  <div className="mt-8 text-[10px]">Authorised Signatory</div>
                </td>
              </tr>
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
