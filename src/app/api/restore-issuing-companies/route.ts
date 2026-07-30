import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET() {
  try {
    const supabase = await createClient();

    const issuingCompaniesToRestore = [
      {
        company_name: "ABC Industries Pvt Ltd",
        abbreviation: "ABC",
        address: "123 Industrial Area, Phase 2, Mumbai, Maharashtra - 400001",
        gstin: "27AABCT1234A1Z5",
        phone: "+91-9876543210",
        bank_account_name: "ABC Industries Pvt Ltd",
        bank_name: "State Bank of India",
        account_number: "12345678901234",
        ifsc_code: "SBIN0001234",
        pan: "AABCT1234A",
      },
      {
        company_name: "TechCorp Solutions",
        abbreviation: "TECH",
        address: "45 Tech Park, Whitefield, Bangalore, Karnataka - 560066",
        gstin: "29AATCT5678B1Z3",
        phone: "+91-9988776655",
        bank_account_name: "TechCorp Solutions",
        bank_name: "HDFC Bank",
        account_number: "98765432109876",
        ifsc_code: "HDFC0001234",
        pan: "AATCT5678B",
      },
      {
        company_name: "A1 Marketing",
        abbreviation: "A1",
        address: "88 Commercial Street, Chennai, Tamil Nadu - 600001",
        gstin: "33A1MKT9999A1Z1",
        phone: "+91-9444012345",
        bank_account_name: "A1 Marketing",
        bank_name: "ICICI Bank",
        account_number: "55556666777788",
        ifsc_code: "ICIC0005555",
        pan: "A1MKT9999A",
      },
    ];

    const { data, error } = await supabase
      .from("issuing_companies")
      .insert(issuingCompaniesToRestore)
      .select();

    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, count: data?.length, data });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
