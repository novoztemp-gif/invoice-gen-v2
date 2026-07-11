import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { financialYear, expenseDateFrom, expenseDateTo, items, remarks } =
      body;

    // Validation
    if (!financialYear || !expenseDateFrom || !expenseDateTo) {
      return NextResponse.json(
        { message: "Financial year and date range parameters are required" },
        { status: 400 },
      );
    }

    if (!items || !Array.isArray(items) || items.length === 0) {
      return NextResponse.json(
        { message: "At least one expense item is required" },
        { status: 400 },
      );
    }

    // Validate each row
    for (const item of items) {
      if (!item.expense_name || !item.expense_name.trim()) {
        return NextResponse.json(
          { message: "All expense items must have a valid name" },
          { status: 400 },
        );
      }
      const amt = Number(item.amount);
      if (isNaN(amt) || amt <= 0) {
        return NextResponse.json(
          {
            message: `Expense amount for '${item.expense_name}' must be greater than zero`,
          },
          { status: 400 },
        );
      }
    }

    const totalAmount = items.reduce(
      (sum, item) => sum + Number(item.amount),
      0,
    );

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
    }

    // Generate batch name from starting date
    const [year, month, day] = expenseDateFrom.split("-").map(Number);
    const dateObj = new Date(year, month - 1, day);
    const monthName = dateObj.toLocaleString("en-US", { month: "long" });
    const batchName = `FY ${financialYear} - ${monthName} Expenses`;

    // Call the database transactional RPC
    const batchPayload = {
      batch_name: batchName,
      financial_year: financialYear,
      expense_date_from: expenseDateFrom,
      expense_date_to: expenseDateTo,
      total_amount: totalAmount,
      status: "pending",
      remarks: remarks || null,
      created_by: user.id,
    };

    const itemsPayload = items.map((it, idx) => ({
      expense_name: it.expense_name.trim(),
      expense_category: it.expense_category || "General",
      amount: Number(it.amount),
      display_order: idx,
    }));

    const { data: newBatchId, error: rpcError } = await supabase.rpc(
      "create_expense_batch_transactional",
      {
        batch_payload: batchPayload,
        items_payload: itemsPayload,
      },
    );

    if (rpcError || !newBatchId) {
      return NextResponse.json(
        {
          message: `Database error: ${rpcError?.message || "Failed to create expense batch"}`,
        },
        { status: 500 },
      );
    }

    return NextResponse.json({
      success: true,
      batchId: newBatchId,
      message: "Expense Batch created atomically!",
    });
  } catch (error: any) {
    console.error("Error creating expense batch:", error);
    return NextResponse.json(
      { message: error?.message || "An unexpected server error occurred" },
      { status: 500 },
    );
  }
}
