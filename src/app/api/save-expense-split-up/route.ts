import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { batchId, ledgerRows, distributionMethod } = body;

    if (
      !batchId ||
      !ledgerRows ||
      !Array.isArray(ledgerRows) ||
      ledgerRows.length === 0 ||
      !distributionMethod
    ) {
      return NextResponse.json(
        {
          message:
            "Batch ID, ledger rows array, and distribution method are required",
        },
        { status: 400 },
      );
    }

    const supabase = await createClient();

    // Verify session user for audit logging
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
    }

    // 1. Fetch batch metadata
    const { data: batch, error: batchErr } = await supabase
      .from("expense_batch")
      .select("*")
      .eq("id", batchId)
      .single();

    if (batchErr || !batch) {
      return NextResponse.json(
        { message: "Expense batch not found" },
        { status: 404 },
      );
    }

    // 2. Fetch original expense batch items
    const { data: items, error: itemsErr } = await supabase
      .from("expense_batch_items")
      .select("*")
      .eq("expense_batch_id", batchId);

    if (itemsErr || !items) {
      return NextResponse.json(
        { message: "Failed to verify expense batch items" },
        { status: 500 },
      );
    }

    // 3. Build lookup maps for item totals
    const itemTotalsMap = new Map<string, number>();
    for (const item of items) {
      itemTotalsMap.set(item.id, Number(item.amount));
    }

    // 4. Calculate actual sums from daily ledger input payload
    const inputTotalsMap = new Map<string, number>();
    for (const row of ledgerRows) {
      const amt = Number(row.amount);
      if (isNaN(amt) || amt < 0) {
        return NextResponse.json(
          {
            message: `Invalid amount ${row.amount} for item '${row.expense_name}'`,
          },
          { status: 400 },
        );
      }
      inputTotalsMap.set(
        row.expense_item_id,
        (inputTotalsMap.get(row.expense_item_id) || 0) + amt,
      );
    }

    // 5. Verify the sum matches original amounts exactly (tolerance of 0.01 for rounding)
    for (const item of items) {
      const originalVal = Math.round(Number(item.amount) * 100);
      const inputVal = Math.round((inputTotalsMap.get(item.id) || 0) * 100);
      if (originalVal !== inputVal) {
        return NextResponse.json(
          {
            message: `Validation failed: Sum of daily split-ups for '${item.expense_name}' is ₹${(inputVal / 100).toFixed(2)}, but original amount is ₹${(originalVal / 100).toFixed(2)}.`,
          },
          { status: 400 },
        );
      }
    }

    // 6. Invoke RPC transaction to save split-up with audit data
    const { data: success, error: rpcError } = await supabase.rpc(
      "save_expense_split_up_transactional",
      {
        p_batch_id: batchId,
        p_ledger_rows: ledgerRows.map((row) => ({
          expense_item_id: row.expense_item_id,
          expense_date: row.expense_date,
          expense_category: row.expense_category,
          expense_name: row.expense_name,
          amount: Number(row.amount),
        })),
        p_distribution_method: distributionMethod,
        p_generated_by: user.id,
        p_generated_at: new Date().toISOString(),
      },
    );

    if (rpcError || !success) {
      return NextResponse.json(
        {
          message: `Database error: ${rpcError?.message || "Failed to commit expense split-up"}`,
        },
        { status: 500 },
      );
    }

    return NextResponse.json({
      success: true,
      message: "Expense split-ups committed to daily ledger successfully",
    });
  } catch (error: any) {
    console.error("Error saving expense split-ups:", error);
    return NextResponse.json(
      { message: error?.message || "An unexpected error occurred" },
      { status: 500 },
    );
  }
}
