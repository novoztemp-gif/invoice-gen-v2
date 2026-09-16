import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { buildMonthlySplitUpWorkbook } from "@/lib/services/monthly-splitup/MonthlySplitUpWorkbookService";
import { MonthlySplitUpResult } from "@/lib/services/monthly-splitup/types";

function isValidPayload(payload: any): payload is MonthlySplitUpResult {
  return (
    payload &&
    typeof payload.financialYear === "string" &&
    Array.isArray(payload.products) &&
    Array.isArray(payload.months) &&
    Array.isArray(payload.purchaseMatrix) &&
    Array.isArray(payload.salesMatrix)
  );
}

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
    }

    const payload = await request.json();
    if (!isValidPayload(payload)) {
      return NextResponse.json(
        { message: "Invalid split-up data." },
        { status: 400 },
      );
    }

    const buffer = await buildMonthlySplitUpWorkbook(payload);

    return new NextResponse(buffer as any, {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="Monthly_SplitUp_${payload.financialYear}.xlsx"`,
      },
    });
  } catch (error: any) {
    console.error("Monthly Split-up download error:", error);
    return NextResponse.json(
      { message: error?.message || "Failed to build the split-up workbook." },
      { status: 500 },
    );
  }
}
