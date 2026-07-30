import { NextRequest, NextResponse } from "next/server";
import { InvoiceEngine } from "@/lib/services/InvoiceEngine";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { batchId, editedInvoiceId, updates } = body;

    if (!batchId || !editedInvoiceId || !updates) {
      return NextResponse.json(
        { message: "batchId, editedInvoiceId, and updates are required" },
        { status: 400 },
      );
    }

    const supabase = await createClient();

    // Get current user
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
    }

    // Check batch_type and batch_status
    const { data: batchCheck } = await supabase
      .from("invoice_batch")
      .select("batch_type, batch_status")
      .eq("id", batchId)
      .single();

    if (batchCheck?.batch_status === "FINALIZED") {
      return NextResponse.json(
        { message: "Batch is finalized and read-only." },
        { status: 403 },
      );
    }

    const result = await InvoiceEngine.saveInvoiceAndRebalance(
      supabase,
      batchId,
      editedInvoiceId,
      updates,
      user.id,
    );

    return NextResponse.json(result);
  } catch (error: any) {
    console.error("Auto Balance Engine Error:", error);

    // Return 409 Conflict if it's a lock error
    if (error.message && error.message.includes("currently being updated")) {
      return NextResponse.json({ message: error.message }, { status: 409 });
    }

    return NextResponse.json(
      {
        message:
          error.message || "An unexpected error occurred during balancing",
      },
      { status: 500 },
    );
  }
}
