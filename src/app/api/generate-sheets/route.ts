import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { fetchAllInvoicesForBatch } from "@/lib/supabase/fetchAll";

// Function to convert number to words in Indian format
function numberToWords(num: number): string {
  // Handle decimal numbers
  const [rupees, paise] = num.toString().split(".");

  let rupeesPart = "";
  let paisePart = "";

  // Convert rupees part
  const rupeesNum = parseInt(rupees);
  if (rupeesNum > 0) {
    rupeesPart = convertNumberToWords(rupeesNum) + " rupees";
  } else if (parseInt(paise) > 0) {
    rupeesPart = "zero rupees";
  }

  // Convert paise part
  if (paise && parseInt(paise) > 0) {
    const paiseNum = parseInt(paise.padEnd(2, "0").substring(0, 2)); // Take only first 2 digits
    if (paiseNum > 0) {
      paisePart = " and " + convertNumberToWords(paiseNum) + " paise";
    }
  }

  if (rupeesPart || paisePart) {
    return (rupeesPart + paisePart).trim() + " only";
  }

  return "zero rupees only";
}

function convertNumberToWords(num: number): string {
  if (num === 0) return "";

  const ones = [
    "",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
    "eleven",
    "twelve",
    "thirteen",
    "fourteen",
    "fifteen",
    "sixteen",
    "seventeen",
    "eighteen",
    "nineteen",
  ];

  const tens = [
    "",
    "",
    "twenty",
    "thirty",
    "forty",
    "fifty",
    "sixty",
    "seventy",
    "eighty",
    "ninety",
  ];

  function convertHundreds(n: number): string {
    let str = "";
    if (n >= 100) {
      str += ones[Math.floor(n / 100)] + " hundred ";
      n %= 100;
    }
    if (n >= 20) {
      str += tens[Math.floor(n / 10)] + " ";
      n %= 10;
    }
    if (n > 0) {
      str += ones[n] + " ";
    }
    return str.trim();
  }

  let result = "";
  let crore = Math.floor(num / 10000000);
  let lakh = Math.floor((num % 10000000) / 100000);
  let thousand = Math.floor((num % 100000) / 1000);
  let remaining = num % 1000;

  if (crore > 0) {
    result += convertHundreds(crore) + " crore ";
  }
  if (lakh > 0) {
    result += convertHundreds(lakh) + " lakh ";
  }
  if (thousand > 0) {
    result += convertHundreds(thousand) + " thousand ";
  }
  if (remaining > 0) {
    result += convertHundreds(remaining);
  }

  return result.trim();
}

// Function to format date as dd/mm/yyyy
function formatDate(dateString: string): string {
  const date = new Date(dateString);
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = date.getFullYear();
  return `${day}/${month}/${year}`;
}

export async function POST(request: NextRequest) {
  try {
    const { batchId, masterSheetLink } = await request.json();

    if (!batchId) {
      return NextResponse.json(
        { message: "Batch ID is required" },
        { status: 400 },
      );
    }

    if (!masterSheetLink) {
      return NextResponse.json(
        { message: "Master sheet link is required" },
        { status: 400 },
      );
    }

    const supabase = await createClient();

    const { data: batch, error: batchError } = await supabase
      .from("invoice_batch")
      .select("*")
      .eq("id", batchId)
      .single();

    if (batchError || !batch) {
      console.error("Batch fetch error:", batchError);
      return NextResponse.json({ message: "Batch not found" }, { status: 404 });
    }

    let invoices: any[] = [];
    try {
      invoices = await fetchAllInvoicesForBatch(supabase, batchId);
    } catch (invoicesError: any) {
      console.error("Error fetching invoices:", invoicesError);
      return NextResponse.json(
        { message: "Failed to fetch invoices" },
        { status: 500 },
      );
    }

    if (!invoices || invoices.length === 0) {
      return NextResponse.json(
        { message: "No invoices found for this batch" },
        { status: 404 },
      );
    }

    const { data: issuingCompany } = await supabase
      .from("issuing_companies")
      .select("*")
      .eq("id", batch.issuing_company_id)
      .single();

    const { data: receivingCompaniesList } = await supabase
      .from("receiving_companies")
      .select("*");

    const receivingCompaniesMap = new Map();
    if (receivingCompaniesList) {
      for (const comp of receivingCompaniesList) {
        receivingCompaniesMap.set(comp.id, comp);
      }
    }

    const invoicePayloads = invoices.map((invoice) => {
      const rCompId =
        invoice.products?.[0]?.customer_id || batch.receiving_company_id;
      const receivingCompany = rCompId
        ? receivingCompaniesMap.get(rCompId)
        : null;

      const payload = {
        // Invoice identification
        invoiceNumber: invoice.invoice_number,
        invoiceDate: formatDate(invoice.invoice_date),
        invoiceType: batch.batch_type,
        financialYear: batch.financial_year,
        // Issuing company details
        issuingCompany: issuingCompany
          ? {
              id: issuingCompany.id,
              name: issuingCompany.company_name,
              address: issuingCompany.address,
              phone: issuingCompany.phone,
              bankBranch: issuingCompany.branch,
              bankAccountName: issuingCompany.bank_account_name,
              gstin: issuingCompany.gstin,
              pan: issuingCompany.pan,
              bankName: issuingCompany.bank_name,
              accountNumber: issuingCompany.account_number,
              ifscCode: issuingCompany.ifsc_code,
            }
          : null,

        // Receiving company details
        receivingCompany: receivingCompany
          ? {
              id: receivingCompany.id,
              name: receivingCompany.company_name,
              address: receivingCompany.address,
              state: receivingCompany.state,
              stateCode: receivingCompany.state_code,
              pan: receivingCompany.pan,
              gstin: receivingCompany.gstin,
            }
          : null,

        // Transport details
        transportDetails: {
          mode: batch.transport_mode,
          vehicleNumber: batch.vehicle_number,
          dateOfSupply: formatDate(invoice.invoice_date),
        },

        // Products with line items
        products: invoice.products.map((product: any, index: number) => ({
          srNo: index + 1,
          productId: product.product_id,
          productName: product.product_name,
          hsnCode: product.hsn_code,
          unitOfMeasure: product.unit_of_measure,
          quantity: product.quantity,
          rate: product.rate,
          amount: product.amount,
        })),

        // Invoice totals
        totals: {
          totalAmountBeforeTax: invoice.total_amount,
          cgst: 0, // TODO: Calculate if needed
          sgst: 0, // TODO: Calculate if needed
          postage: 0, // TODO: Calculate if needed
          otherCharges: 0, // TODO: Calculate if needed
          roundOff: 0, // TODO: Calculate if needed
          forwarding: 0, // TODO: Calculate if needed
          totalAmountAfterTax: invoice.total_amount,
          grandTotal: invoice.total_amount,
          totalAmountInWords: numberToWords(invoice.total_amount),
        },

        // Metadata
        metadata: {
          batchId: batch.id,
          invoiceId: invoice.id,
        },
      };

      return payload;
    });

    // Use the provided master sheet link
    const sheetLink = masterSheetLink;

    if (!sheetLink) {
      return NextResponse.json(
        { message: "Google Sheet ID not configured" },
        { status: 500 },
      );
    }

    // Update batch with sheet_link
    const { error: updateError } = await supabase
      .from("invoice_batch")
      .update({ sheet_link: sheetLink })
      .eq("id", batchId);

    if (updateError) {
      console.error("Error updating batch with sheet link:", updateError);
      return NextResponse.json(
        { message: "Failed to update batch with sheet link" },
        { status: 500 },
      );
    }

    console.log("Batch updated with sheet link:", sheetLink);

    // Insert jobs for each invoice
    const jobsToInsert = invoices.map((invoice, index) => ({
      invoice_id: invoice.id,
      status: "pending",
      payload: invoicePayloads[index],
      metadata: {
        master_link: sheetLink,
      },
    }));

    const { data: insertedJobs, error: jobsError } = await supabase
      .from("jobs")
      .insert(jobsToInsert)
      .select();

    if (jobsError) {
      console.error("Error inserting jobs:", jobsError);
      return NextResponse.json(
        { message: "Failed to create jobs" },
        { status: 500 },
      );
    }

    console.log(
      `Created ${insertedJobs?.length || 0} jobs for sheet generation`,
    );

    return NextResponse.json({
      message: `Created ${insertedJobs?.length || 0} jobs for sheet generation`,
      batchId,
      jobCount: insertedJobs?.length || 0,
      success: true,
    });
  } catch (error) {
    console.error("Error generating Sheet:", error);
    return NextResponse.json(
      { message: "An error occurred while generating Sheet" },
      { status: 500 },
    );
  }
}
