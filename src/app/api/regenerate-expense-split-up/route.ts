import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { batchId } = body;

    if (!batchId) {
      return NextResponse.json(
        { message: "Batch ID parameter is required" },
        { status: 400 },
      );
    }

    const supabase = await createClient();

    // Verify session
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
    }

    // Call RPC to delete splits and revert status to pending
    const { data: success, error: rpcError } = await supabase.rpc(
      "regenerate_expense_split_up_transactional",
      {
        p_batch_id: batchId,
      },
    );

    if (rpcError || !success) {
      return NextResponse.json(
        {
          message: `Database error: ${rpcError?.message || "Failed to reset batch split-ups"}`,
        },
        { status: 500 },
      );
    }

    return NextResponse.json({
      success: true,
      message: "Expense batch reset to pending status successfully",
    });
  } catch (error: any) {
    console.error("Error resetting expense batch split-ups:", error);
    return NextResponse.json(
      { message: error?.message || "An unexpected error occurred" },
      { status: 500 },
    );
  }
}
