import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const invoiceNumbers = (searchParams.get("invoiceNumbers") || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
    }

    const { data, error } = await supabase
      .from("invoice")
      .select("id, invoice_number, invoice_date, products, total_amount")
      .in("invoice_number", invoiceNumbers);

    if (error) {
      return NextResponse.json({ message: error.message }, { status: 500 });
    }

    const withDupeCheck = (data || []).map((inv: any) => {
      const counts = new Map<string, number>();
      for (const p of inv.products || []) {
        counts.set(p.product_id, (counts.get(p.product_id) || 0) + 1);
      }
      const duplicates = Array.from(counts.entries()).filter(
        ([, c]) => c > 1,
      );
      return { ...inv, duplicateProductIds: duplicates };
    });

    return NextResponse.json({ invoices: withDupeCheck });
  } catch (error: any) {
    return NextResponse.json(
      { message: error.message || "Failed" },
      { status: 500 },
    );
  }
}
