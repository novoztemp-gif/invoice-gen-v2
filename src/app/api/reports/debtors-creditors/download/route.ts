import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { createClient } from "@/lib/supabase/server";
import {
  buildCombinedDebtorCreditorExcel,
  buildCreditorExcel,
  buildDebtorExcel,
} from "@/lib/services/debtors-creditors/DebtorCreditorWorkbookService";
import {
  DebtorCreditorPerson,
  DebtorCreditorRoleResult,
} from "@/lib/services/debtors-creditors/types";

type DownloadKind = "debtor" | "creditor" | "combined";

interface DownloadRequestBody {
  kind: DownloadKind;
  debtor?: DebtorCreditorRoleResult;
  creditor?: DebtorCreditorRoleResult;
  people: DebtorCreditorPerson[];
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

    const body = (await request.json()) as DownloadRequestBody;
    if (!body?.kind || !Array.isArray(body?.people)) {
      return NextResponse.json({ message: "Invalid request body." }, { status: 400 });
    }

    let buffer: ExcelJS.Buffer;
    let filenamePart: string;

    if (body.kind === "debtor") {
      if (!body.debtor) {
        return NextResponse.json({ message: "Missing debtor data." }, { status: 400 });
      }
      buffer = await buildDebtorExcel(body.debtor, body.people);
      filenamePart = `Debtors_FY_${body.debtor.source.financialYear}`;
    } else if (body.kind === "creditor") {
      if (!body.creditor) {
        return NextResponse.json({ message: "Missing creditor data." }, { status: 400 });
      }
      buffer = await buildCreditorExcel(body.creditor, body.people);
      filenamePart = `Creditors_FY_${body.creditor.source.financialYear}`;
    } else {
      if (!body.debtor || !body.creditor) {
        return NextResponse.json(
          { message: "Missing debtor and/or creditor data." },
          { status: 400 },
        );
      }
      buffer = await buildCombinedDebtorCreditorExcel(
        body.debtor,
        body.creditor,
        body.people,
      );
      filenamePart = `Debtors_and_Creditors_${body.debtor.source.financialYear}_${body.creditor.source.financialYear}`;
    }

    return new NextResponse(buffer as any, {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filenamePart}.xlsx"`,
      },
    });
  } catch (error: any) {
    console.error("Debtors & Creditors download error:", error);
    return NextResponse.json(
      { message: error?.message || "Failed to build the workbook." },
      { status: 500 },
    );
  }
}
