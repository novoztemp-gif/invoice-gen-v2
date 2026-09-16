import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  MonthlySplitUpParseError,
  parseMonthlySplitUpWorkbook,
} from "@/lib/services/monthly-splitup/MonthlySplitUpParser";
import {
  DEFAULT_PURCHASE_MARGIN_PERCENT,
  computeMonthlySplitUp,
} from "@/lib/services/monthly-splitup/MonthlySplitUpEngine";

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
      return NextResponse.json(
        { message: "No file uploaded." },
        { status: 400 },
      );
    }

    const marginRaw = formData.get("marginPercent");
    const marginPercent =
      marginRaw !== null && !Number.isNaN(Number(marginRaw))
        ? Number(marginRaw)
        : DEFAULT_PURCHASE_MARGIN_PERCENT;

    const arrayBuffer = await file.arrayBuffer();

    let parsed;
    try {
      parsed = await parseMonthlySplitUpWorkbook(arrayBuffer);
    } catch (e: any) {
      const message =
        e instanceof MonthlySplitUpParseError
          ? e.message
          : "Could not read the uploaded Excel file. Please check its format.";
      return NextResponse.json({ message }, { status: 400 });
    }

    const result = computeMonthlySplitUp(parsed, marginPercent);
    return NextResponse.json(result);
  } catch (error: any) {
    console.error("Monthly Split-up generate error:", error);
    return NextResponse.json(
      { message: error?.message || "Failed to generate the monthly split-up." },
      { status: 500 },
    );
  }
}
