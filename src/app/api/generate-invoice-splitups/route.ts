import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { InvoiceEngine } from "@/lib/services/InvoiceEngine";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  try {
    const { batchId } = await request.json();

    if (!batchId) {
      return NextResponse.json(
        { message: "Batch ID is required" },
        { status: 400 },
      );
    }

    const supabase = await createClient();

    const count = await InvoiceEngine.generateAndSaveInvoices(
      supabase,
      batchId,
    );

    return NextResponse.json({
      message: `Successfully generated ${count} invoice(s)!`,
      count,
    });
  } catch (error: any) {
    console.error("Error generating invoice splitups:", error);
    return NextResponse.json(
      {
        message:
          error?.message || "An error occurred while generating invoices",
      },
      { status: 500 },
    );
  }
}
