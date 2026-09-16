import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { allocateStock } from "@/lib/services/debtors-creditors/StockAllocationEngine";
import {
  DebtorCreditorPerson,
  DebtorCreditorSourceData,
  PersonAmountEntry,
} from "@/lib/services/debtors-creditors/types";

interface AllocateRequestBody {
  role: "debtor" | "creditor";
  source: DebtorCreditorSourceData;
  people: DebtorCreditorPerson[];
  selectedMonthIndices: number[];
  personAmounts: PersonAmountEntry[];
  excludedHsnByPerson?: Record<string, string[]>;
}

function isValidBody(body: any): body is AllocateRequestBody {
  return (
    body &&
    (body.role === "debtor" || body.role === "creditor") &&
    body.source &&
    Array.isArray(body.source.products) &&
    Array.isArray(body.source.months) &&
    Array.isArray(body.people) &&
    Array.isArray(body.selectedMonthIndices) &&
    Array.isArray(body.personAmounts)
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

    const body = await request.json();
    if (!isValidBody(body)) {
      return NextResponse.json({ message: "Invalid request body." }, { status: 400 });
    }

    const excludedHsnByPerson = body.excludedHsnByPerson
      ? Object.fromEntries(
          Object.entries(body.excludedHsnByPerson).map(([personId, hsns]) => [
            personId,
            new Set(hsns as string[]),
          ]),
        )
      : undefined;

    const result = allocateStock({
      role: body.role,
      source: body.source,
      people: body.people,
      selectedMonthIndices: body.selectedMonthIndices,
      personAmounts: body.personAmounts,
      excludedHsnByPerson,
    });

    // ok:false is a legitimate business outcome (genuinely insufficient
    // stock to honor the configured amounts) — not a server fault, so this
    // still returns 200 and lets the UI branch on `.ok`.
    return NextResponse.json(result);
  } catch (error: any) {
    console.error("Debtors & Creditors allocate error:", error);
    return NextResponse.json(
      { message: error?.message || "Failed to allocate stock." },
      { status: 500 },
    );
  }
}
