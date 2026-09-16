import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  TemplateKind,
  buildMonthlySplitUpTemplate,
} from "@/lib/services/monthly-splitup/MonthlySplitUpTemplateService";

const FILENAMES: Record<TemplateKind, string> = {
  "with-purchase": "Monthly_SplitUp_Template_With_Purchase.xlsx",
  "no-purchase": "Monthly_SplitUp_Template_No_Purchase.xlsx",
};

export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const type = searchParams.get("type");
    if (type !== "with-purchase" && type !== "no-purchase") {
      return NextResponse.json(
        { message: "Invalid template type. Use with-purchase or no-purchase." },
        { status: 400 },
      );
    }

    const buffer = await buildMonthlySplitUpTemplate(type);

    return new NextResponse(buffer as any, {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${FILENAMES[type]}"`,
      },
    });
  } catch (error: any) {
    console.error("Monthly Split-up template error:", error);
    return NextResponse.json(
      { message: error?.message || "Failed to build the template." },
      { status: 500 },
    );
  }
}
