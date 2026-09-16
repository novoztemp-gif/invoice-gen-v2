import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  DebtorCreditorSourceParseError,
  parseDebtorCreditorSourceWorkbook,
} from "@/lib/services/debtors-creditors/DebtorCreditorSourceParser";
import { resolveProductCategories } from "@/lib/services/debtors-creditors/ProductCategoryResolver";
import { DebtorCreditorSourceData } from "@/lib/services/debtors-creditors/types";

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

    const formData = await request.formData();
    const file = formData.get("file");
    if (!file || !(file instanceof File)) {
      return NextResponse.json({ message: "No file uploaded." }, { status: 400 });
    }

    const arrayBuffer = await file.arrayBuffer();

    let raw;
    try {
      raw = await parseDebtorCreditorSourceWorkbook(arrayBuffer);
    } catch (e: any) {
      const message =
        e instanceof DebtorCreditorSourceParseError
          ? e.message
          : "Could not read the uploaded Excel file. Please check its format.";
      return NextResponse.json({ message }, { status: 400 });
    }

    const products = await resolveProductCategories(supabase, raw.products);

    const result: DebtorCreditorSourceData = {
      financialYear: raw.financialYear,
      products,
      months: raw.months,
      purchaseMatrix: raw.purchaseMatrix,
      salesMatrix: raw.salesMatrix,
    };

    return NextResponse.json(result);
  } catch (error: any) {
    console.error("Debtors & Creditors parse-source error:", error);
    return NextResponse.json(
      { message: error?.message || "Failed to parse the uploaded file." },
      { status: 500 },
    );
  }
}
