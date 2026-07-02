import { NextRequest, NextResponse } from "next/server";
import { AutoBalanceEngine } from "@/lib/services/AutoBalanceEngine";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { batchId, editedInvoiceId, originalTotal, newTotal } = body;

    if (
      !batchId ||
      !editedInvoiceId ||
      originalTotal === undefined ||
      newTotal === undefined
    ) {
      return NextResponse.json(
        { message: "Missing required parameters" },
        { status: 400 },
      );
    }

    const targetDiff = originalTotal - newTotal;

    const supabase = await createClient();

    // Get current user
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();
    const userId = user?.id || "unknown";

    const engine = new AutoBalanceEngine(supabase);

    // Check if finalized
    const { data: batchCheck } = await supabase
      .from("invoice_batch")
      .select("batch_status")
      .eq("id", batchId)
      .single();

    if (batchCheck?.batch_status === "FINALIZED") {
      return NextResponse.json(
        { message: "Batch is finalized and read-only." },
        { status: 403 },
      );
    }

    const result = await engine.balanceBatch(
      batchId,
      editedInvoiceId,
      targetDiff,
      userId,
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
