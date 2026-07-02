import { NextRequest, NextResponse } from "next/server";
import { InvoiceEngine } from "@/lib/services/InvoiceEngine";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  try {
    const { batchId, action } = await request.json();

    if (!batchId || !action) {
      return NextResponse.json(
        { message: "Missing batchId or action" },
        { status: 400 },
      );
    }

    if (action !== "FINALIZE" && action !== "REOPEN") {
      return NextResponse.json({ message: "Invalid action" }, { status: 400 });
    }

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
    }

    await InvoiceEngine.updateBatchStatus(supabase, batchId, action, user.id);

    return NextResponse.json({
      success: true,
      message: `Batch successfully ${action === "FINALIZE" ? "finalized" : "reopened"}.`,
    });
  } catch (error: any) {
    console.error("Batch Status API Error:", error);
    return NextResponse.json(
      { message: error.message || "An unexpected error occurred" },
      { status: 500 },
    );
  }
}
