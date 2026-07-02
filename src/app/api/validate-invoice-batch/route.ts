import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { InvoiceEngine } from "@/lib/services/InvoiceEngine";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      products,
      recurring_products = [],
      invoiceDateFrom,
      invoiceDateTo,
      minimum_invoice_amount,
      maximum_invoice_amount,
      totalAmount,
    } = body;

    const result = InvoiceEngine.validateBatchParams({
      products,
      recurringProducts: recurring_products,
      invoiceDateFrom,
      invoiceDateTo,
      minimumInvoiceAmount: minimum_invoice_amount,
      maximumInvoiceAmount: maximum_invoice_amount,
      totalAmount,
    });

    return NextResponse.json(result);
  } catch (error) {
    console.error("Validation error:", error);
    return NextResponse.json(
      {
        isValid: false,
        message:
          "An error occurred during validation. Please check your inputs.",
      },
      { status: 500 },
    );
  }
}
