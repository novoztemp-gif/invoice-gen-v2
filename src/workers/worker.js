// Cloudflare Worker for processing invoice sheet generation jobs
import { createClient } from "@supabase/supabase-js";

// Generate OAuth2 access token from service account
async function getAccessToken(env) {
  try {
    console.log("=== Starting getAccessToken ===");
    console.log("Service Account Email:", env.GOOGLE_SERVICE_ACCOUNT_EMAIL);
    console.log("Private Key Length:", env.GOOGLE_PRIVATE_KEY?.length);

    if (!env.GOOGLE_SERVICE_ACCOUNT_EMAIL) {
      throw new Error("GOOGLE_SERVICE_ACCOUNT_EMAIL is not set");
    }

    if (!env.GOOGLE_PRIVATE_KEY) {
      throw new Error("GOOGLE_PRIVATE_KEY is not set");
    }

    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + 3600; // 1 hour

    const header = {
      alg: "RS256",
      typ: "JWT",
    };

    const payload = {
      iss: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      scope:
        "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive",
      aud: "https://oauth2.googleapis.com/token",
      exp: expiresAt,
      iat: now,
    };

    const encodedHeader = btoa(JSON.stringify(header))
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    const encodedPayload = btoa(JSON.stringify(payload))
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    const message = `${encodedHeader}.${encodedPayload}`;

    console.log("JWT payload:", JSON.stringify(payload));
    console.log("Converting PEM to DER format...");

    // Convert PEM to DER format
    const pemContent = env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n")
      .replace("-----BEGIN PRIVATE KEY-----", "")
      .replace("-----END PRIVATE KEY-----", "")
      .replace(/\n/g, "");

    console.log("PEM content length after cleaning:", pemContent.length);

    const binaryString = atob(pemContent);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    console.log("Converted to DER, bytes length:", bytes.length);

    // Import crypto for signing
    const privateKey = await crypto.subtle.importKey(
      "pkcs8",
      bytes.buffer,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );

    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      privateKey,
      new TextEncoder().encode(message),
    );

    console.log("JWT signature created");

    const encodedSignature = btoa(
      String.fromCharCode(...new Uint8Array(signature)),
    )
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");

    const token = `${message}.${encodedSignature}`;

    console.log("JWT Token created, exchanging for access token...");
    console.log("Service Account Email:", env.GOOGLE_SERVICE_ACCOUNT_EMAIL);
    console.log("Token first 50 chars:", token.substring(0, 50));

    // Exchange JWT for access token
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${token}`,
    });

    if (!tokenResponse.ok) {
      const error = await tokenResponse.text();
      console.error(
        "Failed to get access token. Status:",
        tokenResponse.status,
      );
      console.error("Error response:", error);
      throw new Error(`Failed to authenticate with Google API: ${error}`);
    }

    const tokenData = await tokenResponse.json();
    console.log("Access token obtained successfully");
    return tokenData.access_token;
  } catch (error) {
    console.error("Error in getAccessToken:", error);
    throw error;
  }
}

async function createSheetTab(accessToken, sheetTitle, spreadsheetId) {
  console.log("Creating sheet tab:", sheetTitle);

  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        requests: [
          {
            addSheet: {
              properties: {
                title: sheetTitle,
              },
            },
          },
        ],
      }),
    },
  );

  if (!response.ok) {
    const error = await response.text();

    // Check if it's a "sheet already exists" error
    if (error.includes("already exists")) {
      console.log("Sheet tab already exists, skipping creation:", sheetTitle);
      return sheetTitle;
    }

    console.error("Failed to create sheet tab:", error);
    throw new Error(`Failed to create sheet tab "${sheetTitle}": ${error}`);
  }

  console.log("Sheet tab created successfully:", sheetTitle);
  return sheetTitle;
}

async function getSheetIdByTitle(accessToken, spreadsheetId, title) {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );

  if (!res.ok) {
    const e = await res.text();
    throw new Error("Failed to fetch sheet metadata: " + e);
  }

  const data = await res.json();

  const sheet = data.sheets.find((s) => s.properties.title === title);

  if (!sheet) {
    throw new Error(`Sheet with title "${title}" not found`);
  }

  return sheet.properties.sheetId;
}

export async function populateInvoiceToSheet(
  accessToken,
  invoice,
  sheetTitle,
  spreadsheetId,
) {
  const SPREADSHEET_ID = spreadsheetId;
  const safeTitle = sheetTitle.replace(/'/g, "''");
  const blank = "";
  const issuing = invoice.issuingCompany;
  const receiving = invoice.receivingCompany;
  const transport = invoice.transportDetails || {};
  const products = invoice.products || [];
  const totals = invoice.totals || {};

  // ================= BUILD ROWS (Matching Excel Sample) =================
  const rows = [];

  // Row 0: Company Name (Centered, Bold, Large, Blue)
  rows.push([issuing?.name || "", blank, blank, blank, blank, blank]);

  // Row 1: Full Address Line (merged across all columns)
  rows.push([issuing?.address || "", blank, blank, blank, blank, blank]);

  // Row 2: INVOICE Title (centered, bold)
  rows.push(["INVOICE", blank, blank, blank, blank, blank]);

  // Row 3: Delivery Details | Seller Details Header (grey background)
  rows.push(["Delivery Details", blank, blank, "Seller Details", blank, blank]);

  // Row 4: Transportation Mode | GSTIN
  rows.push([
    "Transportation Mode",
    transport.mode || "In hand Delivery",
    blank,
    `GSTIN : ${issuing?.gstin || ""}`,
    blank,
    blank,
  ]);

  // Row 5: Vehicle Number | (empty right)
  rows.push([
    "Vehicle Number",
    transport.vehicleNumber || "NA",
    blank,
    blank,
    blank,
    blank,
  ]);

  // Row 6: Date of Supply | Phone
  rows.push([
    "Date of Supply (on or Before)",
    transport.dateOfSupply || invoice.invoiceDate || "",
    blank,
    `Phone : ${issuing?.phone || ""}`,
    blank,
    blank,
  ]);

  // Row 7: Details of Receiver / Billed to : | Original for Recipient (grey background)
  rows.push([
    "Details of Receiver / Billed to :",
    blank,
    blank,
    "Original for Recipient",
    blank,
    blank,
  ]);

  // Row 8: Name | Invoice No
  rows.push([
    "Name",
    `: ${receiving?.name || ""}`,
    blank,
    "Invoice No",
    `: ${invoice.invoiceNumber || ""}`,
    blank,
  ]);

  // Row 9: Address | Date
  rows.push([
    "Address",
    `: ${receiving?.address || ""}`,
    blank,
    "Date",
    `: ${invoice.invoiceDate || ""}`,
    blank,
  ]);

  // Row 10: GSTIN
  rows.push([
    "GSTIN",
    `: ${receiving?.gstin || "Unregistered"}`,
    blank,
    blank,
    blank,
    blank,
  ]);

  // Row 11: PAN
  rows.push(["PAN", `: ${receiving?.pan || ""}`, blank, blank, blank, blank]);

  // Row 12: State with Code
  rows.push([
    "State",
    `: ${receiving?.state || ""} State Code : ${receiving?.stateCode || ""}`,
    blank,
    blank,
    blank,
    blank,
  ]);

  // Row 13: Product Table Header (grey background)
  const tableStartRow = rows.length;
  rows.push([
    "Sl.\nNo.",
    "Name of the Product / Service",
    "HSN/ ACS",
    "Qty in KG",
    "Rate Per KG\nRs.",
    "Total\nAmount",
  ]);

  // Product Rows - dynamic count with minimum of 13 rows
  const minProductRows = 13;
  const productRowCount = Math.max(products.length, minProductRows);

  products.forEach((p, i) => {
    rows.push([
      i + 1,
      p.productName || p.name || "",
      p.hsnCode || p.hsn || "",
      p.quantity || p.qty || 0,
      Number(p.rate || p.price || 0).toFixed(2),
      Number(p.amount || p.total || 0).toFixed(2),
    ]);
  });

  // Fill empty rows if products are less than minimum
  for (let i = products.length; i < productRowCount; i++) {
    rows.push([blank, blank, blank, blank, blank, blank]);
  }

  // Total Row inside table (grey background on right)
  const totalRowIndex = rows.length;
  rows.push([
    blank,
    blank,
    blank,
    blank,
    "Total",
    Number(totals.totalAmountBeforeTax || totals.grandTotal || 0).toFixed(2),
  ]);

  // ================= FOOTER SECTION =================
  // Row: Goods Despatched | Total Amount Before Tax
  const footerStartRow = rows.length;
  rows.push([
    "Goods Despatched",
    blank,
    blank,
    "Total Amount Before Tax",
    "Rs.",
    Number(totals.totalAmountBeforeTax || 0).toFixed(2),
  ]);

  // Row: Rupees in words | Add : CGST*
  rows.push([
    `Rupees in words: ${totals.totalAmountInWords || ""}`,
    blank,
    blank,
    "Add : CGST*",
    "Rs.",
    Number(totals.cgst || 0).toFixed(2),
  ]);

  // Row: (empty left) | Add : SGST*
  rows.push([
    blank,
    blank,
    blank,
    "Add : SGST*",
    "Rs.",
    Number(totals.sgst || 0).toFixed(2),
  ]);

  // Row: Company's Bank Details : | Total Amount After GST
  rows.push([
    "Company's Bank Details :",
    blank,
    blank,
    "Total Amount After GST",
    "Rs.",
    Number(totals.totalAmountAfterTax || totals.grandTotal || 0).toFixed(2),
  ]);

  // Row: Name of Account | Forwarding
  rows.push([
    "Name of Account",
    `: ${issuing?.name || ""}`,
    blank,
    "Forwarding",
    "Rs.",
    Number(totals.forwarding || 0).toFixed(2),
  ]);

  // Row: Name of Bank | Postage
  rows.push([
    "Name of Bank",
    `: ${issuing?.bankName || ""}`,
    blank,
    "Postage",
    "Rs.",
    Number(totals.postage || 0).toFixed(2),
  ]);

  // Row: Branch Name | Other charges if any
  rows.push([
    "Branch Name",
    `: ${issuing?.bankBranch || ""}`,
    blank,
    "Other charges if any",
    "Rs.",
    Number(totals.otherCharges || 0).toFixed(2),
  ]);

  // Row: Account No. | Ps.Rounded Off
  rows.push([
    "Account No.",
    `: ${issuing?.accountNumber || ""}`,
    blank,
    "Ps.Rounded Off",
    "Rs.",
    Number(totals.roundOff || 0).toFixed(2),
  ]);

  // Row: IFSC Code | Net Total (large bold)
  const netTotalRowIndex = rows.length;
  rows.push([
    "IFSC Code",
    `: ${issuing?.ifscCode || ""}`,
    blank,
    "Net Total",
    blank,
    Number(totals.grandTotal || 0).toFixed(2),
  ]);

  // Row: PAN
  rows.push(["PAN", `: ${issuing?.pan || ""}`, blank, blank, blank, blank]);

  // ================= TERMS & SIGNATURE SECTION =================
  const termsStartRow = rows.length;
  // Row: Certified text | For Company
  rows.push([
    "Certified that the particulars given above are true and correct",
    blank,
    blank,
    `For ${issuing?.name || ""}`,
    blank,
    blank,
  ]);

  // Row: Terms & Conditions header
  rows.push(["Terms & Conditions :", blank, blank, blank, blank, blank]);

  // Row: Terms content | Authorised Signatory
  rows.push([
    "1. Interest @ 24% p.a. Will be charged for\n   Over due bills ( more than 30 days ).\n2. All disputers are subject to Chennai Jurisdiction",
    blank,
    blank,
    "Authorised Signatory",
    blank,
    blank,
  ]);

  // ================= WRITE DATA =================
  const writeRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/'${safeTitle}'!A1?valueInputOption=USER_ENTERED`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ values: rows }),
    },
  );
  if (!writeRes.ok) throw new Error("Write failed: " + (await writeRes.text()));

  const sheetId = await getSheetIdByTitle(
    accessToken,
    SPREADSHEET_ID,
    sheetTitle,
  );

  // ================= COLORS (Matching Excel Sample) =================
  const greyBg = { red: 0.85, green: 0.85, blue: 0.85 }; // #D9D9D9
  const darkBlue = { red: 0, green: 0.122, blue: 0.373 }; // #001F5F
  const black = { red: 0, green: 0, blue: 0 };

  // ================= FORMATTING REQUESTS =================
  const requests = [
    // Column Widths (matching sample proportions)
    {
      updateDimensionProperties: {
        range: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 1 },
        properties: { pixelSize: 220 },
        fields: "pixelSize",
      },
    },
    {
      updateDimensionProperties: {
        range: { sheetId, dimension: "COLUMNS", startIndex: 1, endIndex: 2 },
        properties: { pixelSize: 220 },
        fields: "pixelSize",
      },
    },
    {
      updateDimensionProperties: {
        range: { sheetId, dimension: "COLUMNS", startIndex: 2, endIndex: 3 },
        properties: { pixelSize: 230 },
        fields: "pixelSize",
      },
    },
    {
      updateDimensionProperties: {
        range: { sheetId, dimension: "COLUMNS", startIndex: 3, endIndex: 4 },
        properties: { pixelSize: 155 },
        fields: "pixelSize",
      },
    },
    {
      updateDimensionProperties: {
        range: { sheetId, dimension: "COLUMNS", startIndex: 4, endIndex: 5 },
        properties: { pixelSize: 75 },
        fields: "pixelSize",
      },
    },
    {
      updateDimensionProperties: {
        range: { sheetId, dimension: "COLUMNS", startIndex: 5, endIndex: 6 },
        properties: { pixelSize: 85 },
        fields: "pixelSize",
      },
    },

    // ================= MERGE CELLS =================
    // Row 0: Company Name (merge A-F)
    {
      mergeCells: {
        range: {
          sheetId,
          startRowIndex: 0,
          endRowIndex: 1,
          startColumnIndex: 0,
          endColumnIndex: 6,
        },
        mergeType: "MERGE_ALL",
      },
    },
    // Row 1: Address (merge A-F)
    {
      mergeCells: {
        range: {
          sheetId,
          startRowIndex: 1,
          endRowIndex: 2,
          startColumnIndex: 0,
          endColumnIndex: 6,
        },
        mergeType: "MERGE_ALL",
      },
    },
    // Row 2: INVOICE (merge A-F)
    {
      mergeCells: {
        range: {
          sheetId,
          startRowIndex: 2,
          endRowIndex: 3,
          startColumnIndex: 0,
          endColumnIndex: 6,
        },
        mergeType: "MERGE_ALL",
      },
    },
    // Row 3: Delivery Details (merge A-C) | Seller Details (merge D-F)
    {
      mergeCells: {
        range: {
          sheetId,
          startRowIndex: 3,
          endRowIndex: 4,
          startColumnIndex: 0,
          endColumnIndex: 3,
        },
        mergeType: "MERGE_ALL",
      },
    },
    {
      mergeCells: {
        range: {
          sheetId,
          startRowIndex: 3,
          endRowIndex: 4,
          startColumnIndex: 3,
          endColumnIndex: 6,
        },
        mergeType: "MERGE_ALL",
      },
    },
    // Rows 4-6: Merge columns B-C and E-F for delivery/seller details
    {
      mergeCells: {
        range: {
          sheetId,
          startRowIndex: 4,
          endRowIndex: 5,
          startColumnIndex: 1,
          endColumnIndex: 3,
        },
        mergeType: "MERGE_ALL",
      },
    },
    {
      mergeCells: {
        range: {
          sheetId,
          startRowIndex: 4,
          endRowIndex: 5,
          startColumnIndex: 3,
          endColumnIndex: 6,
        },
        mergeType: "MERGE_ALL",
      },
    },
    {
      mergeCells: {
        range: {
          sheetId,
          startRowIndex: 5,
          endRowIndex: 6,
          startColumnIndex: 1,
          endColumnIndex: 3,
        },
        mergeType: "MERGE_ALL",
      },
    },
    {
      mergeCells: {
        range: {
          sheetId,
          startRowIndex: 6,
          endRowIndex: 7,
          startColumnIndex: 1,
          endColumnIndex: 3,
        },
        mergeType: "MERGE_ALL",
      },
    },
    {
      mergeCells: {
        range: {
          sheetId,
          startRowIndex: 6,
          endRowIndex: 7,
          startColumnIndex: 3,
          endColumnIndex: 6,
        },
        mergeType: "MERGE_ALL",
      },
    },
    // Row 7: Receiver Header (merge A-C) | Original for Recipient (merge D-F)
    {
      mergeCells: {
        range: {
          sheetId,
          startRowIndex: 7,
          endRowIndex: 8,
          startColumnIndex: 0,
          endColumnIndex: 3,
        },
        mergeType: "MERGE_ALL",
      },
    },
    {
      mergeCells: {
        range: {
          sheetId,
          startRowIndex: 7,
          endRowIndex: 8,
          startColumnIndex: 3,
          endColumnIndex: 6,
        },
        mergeType: "MERGE_ALL",
      },
    },
    // Rows 8-12: Receiver details merges
    {
      mergeCells: {
        range: {
          sheetId,
          startRowIndex: 8,
          endRowIndex: 9,
          startColumnIndex: 1,
          endColumnIndex: 3,
        },
        mergeType: "MERGE_ALL",
      },
    },
    {
      mergeCells: {
        range: {
          sheetId,
          startRowIndex: 8,
          endRowIndex: 9,
          startColumnIndex: 4,
          endColumnIndex: 6,
        },
        mergeType: "MERGE_ALL",
      },
    },
    {
      mergeCells: {
        range: {
          sheetId,
          startRowIndex: 9,
          endRowIndex: 10,
          startColumnIndex: 1,
          endColumnIndex: 3,
        },
        mergeType: "MERGE_ALL",
      },
    },
    {
      mergeCells: {
        range: {
          sheetId,
          startRowIndex: 9,
          endRowIndex: 10,
          startColumnIndex: 4,
          endColumnIndex: 6,
        },
        mergeType: "MERGE_ALL",
      },
    },
    {
      mergeCells: {
        range: {
          sheetId,
          startRowIndex: 10,
          endRowIndex: 11,
          startColumnIndex: 1,
          endColumnIndex: 6,
        },
        mergeType: "MERGE_ALL",
      },
    },
    {
      mergeCells: {
        range: {
          sheetId,
          startRowIndex: 11,
          endRowIndex: 12,
          startColumnIndex: 1,
          endColumnIndex: 6,
        },
        mergeType: "MERGE_ALL",
      },
    },
    {
      mergeCells: {
        range: {
          sheetId,
          startRowIndex: 12,
          endRowIndex: 13,
          startColumnIndex: 1,
          endColumnIndex: 6,
        },
        mergeType: "MERGE_ALL",
      },
    },

    // Footer section merges (Rows after product table)
    // Goods Despatched row - merge A-C
    {
      mergeCells: {
        range: {
          sheetId,
          startRowIndex: footerStartRow,
          endRowIndex: footerStartRow + 1,
          startColumnIndex: 0,
          endColumnIndex: 3,
        },
        mergeType: "MERGE_ALL",
      },
    },
    // Rupees in words - merge A-C
    {
      mergeCells: {
        range: {
          sheetId,
          startRowIndex: footerStartRow + 1,
          endRowIndex: footerStartRow + 2,
          startColumnIndex: 0,
          endColumnIndex: 3,
        },
        mergeType: "MERGE_ALL",
      },
    },
    // Company's Bank Details - merge A-C
    {
      mergeCells: {
        range: {
          sheetId,
          startRowIndex: footerStartRow + 3,
          endRowIndex: footerStartRow + 4,
          startColumnIndex: 0,
          endColumnIndex: 3,
        },
        mergeType: "MERGE_ALL",
      },
    },
    // Net Total row - merge D-E for "Net Total" label
    {
      mergeCells: {
        range: {
          sheetId,
          startRowIndex: netTotalRowIndex,
          endRowIndex: netTotalRowIndex + 1,
          startColumnIndex: 3,
          endColumnIndex: 5,
        },
        mergeType: "MERGE_ALL",
      },
    },

    // Terms section merges
    {
      mergeCells: {
        range: {
          sheetId,
          startRowIndex: termsStartRow,
          endRowIndex: termsStartRow + 1,
          startColumnIndex: 0,
          endColumnIndex: 3,
        },
        mergeType: "MERGE_ALL",
      },
    },
    {
      mergeCells: {
        range: {
          sheetId,
          startRowIndex: termsStartRow,
          endRowIndex: termsStartRow + 1,
          startColumnIndex: 3,
          endColumnIndex: 6,
        },
        mergeType: "MERGE_ALL",
      },
    },
    {
      mergeCells: {
        range: {
          sheetId,
          startRowIndex: termsStartRow + 1,
          endRowIndex: termsStartRow + 2,
          startColumnIndex: 0,
          endColumnIndex: 6,
        },
        mergeType: "MERGE_ALL",
      },
    },
    {
      mergeCells: {
        range: {
          sheetId,
          startRowIndex: termsStartRow + 2,
          endRowIndex: termsStartRow + 3,
          startColumnIndex: 0,
          endColumnIndex: 3,
        },
        mergeType: "MERGE_ALL",
      },
    },
    {
      mergeCells: {
        range: {
          sheetId,
          startRowIndex: termsStartRow + 2,
          endRowIndex: termsStartRow + 3,
          startColumnIndex: 3,
          endColumnIndex: 6,
        },
        mergeType: "MERGE_ALL",
      },
    },

    // ================= CELL FORMATTING =================
    // Row 0: Company Name - Blue, Bold, Large, Center
    {
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: 0,
          endRowIndex: 1,
          startColumnIndex: 0,
          endColumnIndex: 6,
        },
        cell: {
          userEnteredFormat: {
            textFormat: {
              bold: true,
              fontSize: 20,
              foregroundColor: darkBlue,
            },
            horizontalAlignment: "CENTER",
            verticalAlignment: "MIDDLE",
          },
        },
        fields: "userEnteredFormat",
      },
    },
    // Row 1: Address - Center
    {
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: 1,
          endRowIndex: 2,
          startColumnIndex: 0,
          endColumnIndex: 6,
        },
        cell: {
          userEnteredFormat: {
            textFormat: { bold: true, fontSize: 10 },
            horizontalAlignment: "CENTER",
            verticalAlignment: "MIDDLE",
          },
        },
        fields: "userEnteredFormat",
      },
    },
    // Row 2: INVOICE - Bold, Center
    {
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: 2,
          endRowIndex: 3,
          startColumnIndex: 0,
          endColumnIndex: 6,
        },
        cell: {
          userEnteredFormat: {
            textFormat: { bold: true, fontSize: 12 },
            horizontalAlignment: "CENTER",
            verticalAlignment: "MIDDLE",
          },
        },
        fields: "userEnteredFormat",
      },
    },
    // Row 3: Delivery Details / Seller Details - Grey Background, Bold
    {
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: 3,
          endRowIndex: 4,
          startColumnIndex: 0,
          endColumnIndex: 6,
        },
        cell: {
          userEnteredFormat: {
            backgroundColor: greyBg,
            textFormat: { bold: true },
            horizontalAlignment: "CENTER",
            verticalAlignment: "MIDDLE",
          },
        },
        fields: "userEnteredFormat",
      },
    },
    // Rows 4-6: Seller details formatting (GSTIN, Phone - Blue)
    {
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: 4,
          endRowIndex: 7,
          startColumnIndex: 3,
          endColumnIndex: 6,
        },
        cell: {
          userEnteredFormat: {
            textFormat: {
              bold: true,
              foregroundColor: darkBlue,
            },
          },
        },
        fields: "userEnteredFormat.textFormat",
      },
    },
    // Row 6: Date of Supply value - Left align
    {
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: 6,
          endRowIndex: 7,
          startColumnIndex: 1,
          endColumnIndex: 2,
        },
        cell: {
          userEnteredFormat: {
            horizontalAlignment: "LEFT",
          },
        },
        fields: "userEnteredFormat.horizontalAlignment",
      },
    },
    // Row 7: Receiver Header - Grey Background, Bold
    {
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: 7,
          endRowIndex: 8,
          startColumnIndex: 0,
          endColumnIndex: 6,
        },
        cell: {
          userEnteredFormat: {
            backgroundColor: greyBg,
            textFormat: { bold: true },
            horizontalAlignment: "CENTER",
            verticalAlignment: "MIDDLE",
          },
        },
        fields: "userEnteredFormat",
      },
    },
    // Receiver name and values - Bold
    {
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: 8,
          endRowIndex: 13,
          startColumnIndex: 1,
          endColumnIndex: 2,
        },
        cell: {
          userEnteredFormat: {
            textFormat: { bold: true },
          },
        },
        fields: "userEnteredFormat.textFormat",
      },
    },
    // Invoice No, Date values - Bold
    {
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: 8,
          endRowIndex: 10,
          startColumnIndex: 4,
          endColumnIndex: 6,
        },
        cell: {
          userEnteredFormat: {
            textFormat: { bold: true },
          },
        },
        fields: "userEnteredFormat.textFormat",
      },
    },

    // Table Header Row - Grey Background, Bold, Center
    {
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: tableStartRow,
          endRowIndex: tableStartRow + 1,
          startColumnIndex: 0,
          endColumnIndex: 6,
        },
        cell: {
          userEnteredFormat: {
            backgroundColor: greyBg,
            textFormat: { bold: true, fontSize: 9 },
            horizontalAlignment: "CENTER",
            verticalAlignment: "MIDDLE",
            wrapStrategy: "WRAP",
          },
        },
        fields: "userEnteredFormat",
      },
    },

    // Product data rows - center Sl.No., right-align numbers
    {
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: tableStartRow + 1,
          endRowIndex: totalRowIndex,
          startColumnIndex: 0,
          endColumnIndex: 1,
        },
        cell: {
          userEnteredFormat: {
            horizontalAlignment: "CENTER",
            verticalAlignment: "MIDDLE",
          },
        },
        fields: "userEnteredFormat",
      },
    },
    {
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: tableStartRow + 1,
          endRowIndex: totalRowIndex + 1,
          startColumnIndex: 2,
          endColumnIndex: 6,
        },
        cell: {
          userEnteredFormat: {
            horizontalAlignment: "RIGHT",
            verticalAlignment: "MIDDLE",
          },
        },
        fields: "userEnteredFormat",
      },
    },

    // Total Row - Grey Background, Bold
    {
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: totalRowIndex,
          endRowIndex: totalRowIndex + 1,
          startColumnIndex: 0,
          endColumnIndex: 6,
        },
        cell: {
          userEnteredFormat: {
            backgroundColor: greyBg,
            textFormat: { bold: true },
          },
        },
        fields: "userEnteredFormat",
      },
    },

    // Footer - Right align amounts
    {
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: footerStartRow,
          endRowIndex: netTotalRowIndex + 1,
          startColumnIndex: 5,
          endColumnIndex: 6,
        },
        cell: {
          userEnteredFormat: {
            horizontalAlignment: "RIGHT",
          },
        },
        fields: "userEnteredFormat.horizontalAlignment",
      },
    },

    // Net Total Row - Grey Background, Bold, Large
    {
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: netTotalRowIndex,
          endRowIndex: netTotalRowIndex + 1,
          startColumnIndex: 3,
          endColumnIndex: 6,
        },
        cell: {
          userEnteredFormat: {
            backgroundColor: greyBg,
            textFormat: { bold: true, fontSize: 14 },
          },
        },
        fields: "userEnteredFormat",
      },
    },

    // Bank details label - Blue
    {
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: footerStartRow + 3,
          endRowIndex: footerStartRow + 4,
          startColumnIndex: 0,
          endColumnIndex: 1,
        },
        cell: {
          userEnteredFormat: {
            textFormat: { bold: true },
          },
        },
        fields: "userEnteredFormat.textFormat",
      },
    },
    // Bank details values - Blue
    {
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: footerStartRow + 4,
          endRowIndex: netTotalRowIndex + 2,
          startColumnIndex: 1,
          endColumnIndex: 2,
        },
        cell: {
          userEnteredFormat: {
            textFormat: {
              bold: true,
              foregroundColor: darkBlue,
            },
          },
        },
        fields: "userEnteredFormat.textFormat",
      },
    },

    // Terms section - For Company name in Blue
    {
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: termsStartRow,
          endRowIndex: termsStartRow + 1,
          startColumnIndex: 3,
          endColumnIndex: 6,
        },
        cell: {
          userEnteredFormat: {
            textFormat: {
              bold: true,
              foregroundColor: darkBlue,
            },
          },
        },
        fields: "userEnteredFormat.textFormat",
      },
    },
    // Authorised Signatory - Blue
    {
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: termsStartRow + 2,
          endRowIndex: termsStartRow + 3,
          startColumnIndex: 3,
          endColumnIndex: 6,
        },
        cell: {
          userEnteredFormat: {
            textFormat: {
              bold: true,
              foregroundColor: darkBlue,
            },
            horizontalAlignment: "CENTER",
            verticalAlignment: "BOTTOM",
          },
        },
        fields: "userEnteredFormat",
      },
    },

    // ================= BORDERS =================
    // Outer border for entire invoice
    {
      updateBorders: {
        range: {
          sheetId,
          startRowIndex: 0,
          endRowIndex: rows.length,
          startColumnIndex: 0,
          endColumnIndex: 6,
        },
        top: { style: "SOLID", color: black },
        bottom: { style: "SOLID", color: black },
        left: { style: "SOLID", color: black },
        right: { style: "SOLID", color: black },
      },
    },

    // Header section borders (rows 0-2)
    {
      updateBorders: {
        range: {
          sheetId,
          startRowIndex: 0,
          endRowIndex: 3,
          startColumnIndex: 0,
          endColumnIndex: 6,
        },
        bottom: { style: "SOLID", color: black },
        innerHorizontal: { style: "SOLID", color: black },
      },
    },

    // Delivery/Seller section vertical divider
    {
      updateBorders: {
        range: {
          sheetId,
          startRowIndex: 3,
          endRowIndex: 8,
          startColumnIndex: 3,
          endColumnIndex: 4,
        },
        left: { style: "SOLID", color: black },
      },
    },

    // Receiver section borders
    {
      updateBorders: {
        range: {
          sheetId,
          startRowIndex: 3,
          endRowIndex: 13,
          startColumnIndex: 0,
          endColumnIndex: 6,
        },
        bottom: { style: "SOLID", color: black },
        innerHorizontal: { style: "SOLID", color: black },
      },
    },

    // Product table borders
    {
      updateBorders: {
        range: {
          sheetId,
          startRowIndex: tableStartRow,
          endRowIndex: totalRowIndex + 1,
          startColumnIndex: 0,
          endColumnIndex: 6,
        },
        top: { style: "SOLID", color: black },
        bottom: { style: "SOLID", color: black },
        left: { style: "SOLID", color: black },
        right: { style: "SOLID", color: black },
        innerHorizontal: { style: "SOLID", color: black },
        innerVertical: { style: "SOLID", color: black },
      },
    },

    // Footer section borders
    {
      updateBorders: {
        range: {
          sheetId,
          startRowIndex: footerStartRow,
          endRowIndex: netTotalRowIndex + 2,
          startColumnIndex: 0,
          endColumnIndex: 6,
        },
        innerHorizontal: { style: "SOLID", color: black },
        innerVertical: { style: "SOLID", color: black },
      },
    },
    {
      updateBorders: {
        range: {
          sheetId,
          startRowIndex: footerStartRow,
          endRowIndex: netTotalRowIndex + 2,
          startColumnIndex: 3,
          endColumnIndex: 4,
        },
        left: { style: "SOLID", color: black },
      },
    },

    // Terms section borders
    {
      updateBorders: {
        range: {
          sheetId,
          startRowIndex: termsStartRow,
          endRowIndex: rows.length,
          startColumnIndex: 0,
          endColumnIndex: 6,
        },
        top: { style: "SOLID", color: black },
        innerHorizontal: { style: "SOLID", color: black },
      },
    },
    {
      updateBorders: {
        range: {
          sheetId,
          startRowIndex: termsStartRow,
          endRowIndex: rows.length,
          startColumnIndex: 3,
          endColumnIndex: 4,
        },
        left: { style: "SOLID", color: black },
      },
    },

    // Row heights for better display
    {
      updateDimensionProperties: {
        range: { sheetId, dimension: "ROWS", startIndex: 0, endIndex: 1 },
        properties: { pixelSize: 35 },
        fields: "pixelSize",
      },
    },
    {
      updateDimensionProperties: {
        range: {
          sheetId,
          dimension: "ROWS",
          startIndex: tableStartRow,
          endIndex: tableStartRow + 1,
        },
        properties: { pixelSize: 35 },
        fields: "pixelSize",
      },
    },
    {
      updateDimensionProperties: {
        range: {
          sheetId,
          dimension: "ROWS",
          startIndex: termsStartRow + 2,
          endIndex: termsStartRow + 3,
        },
        properties: { pixelSize: 60 },
        fields: "pixelSize",
      },
    },
  ];

  const formatRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}:batchUpdate`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ requests }),
    },
  );
  if (!formatRes.ok)
    throw new Error("Format failed: " + (await formatRes.text()));

  console.log("Invoice generated matching Excel sample!");
}

async function processPendingJobs(env) {
  const supabase = createClient(
    env.SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
  );

  console.log("=== Processing pending jobs ===");

  let processedCount = 0;
  const maxJobsPerRun = 10; // Process up to 10 jobs per worker execution

  // Get Google API access token
  const accessToken = await getAccessToken(env);

  // Process jobs one at a time
  while (processedCount < maxJobsPerRun) {
    // Fetch only ONE pending job at a time
    const { data: jobs, error: jobsError } = await supabase
      .from("jobs")
      .select("*")
      .eq("status", "pending")
      .order("created_at", { ascending: true }) // Process oldest first
      .limit(1); // Only fetch 1 job

    if (jobsError) {
      console.error("Error fetching pending job:", jobsError);
      throw new Error("Failed to fetch pending job");
    }

    if (!jobs || jobs.length === 0) {
      console.log("No more pending jobs found");
      break; // No more jobs to process
    }

    const job = jobs[0];
    const invoicePayload = job.payload;
    const batchId = invoicePayload.metadata.batchId;
    const invoiceId = invoicePayload.metadata.invoiceId;
    const masterSheetLink = job.metadata?.master_link;

    console.log(
      `Processing job ${job.id} for invoice ${invoiceId} in batch ${batchId}`,
    );

    if (!masterSheetLink) {
      console.error("Master sheet link not found in job metadata");
      await supabase
        .from("jobs")
        .update({
          status: "failed",
          metadata: {
            ...job.metadata,
            error: "Master sheet link not found",
            failed_at: new Date().toISOString(),
          },
          updated_at: new Date().toISOString(),
        })
        .eq("id", job.id);
      processedCount++;
      continue;
    }

    // Extract spreadsheet ID from master sheet link
    // Format: https://docs.google.com/spreadsheets/d/{spreadsheetId}/edit
    const spreadsheetMatch = masterSheetLink.match(
      /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/,
    );
    if (!spreadsheetMatch) {
      console.error("Could not extract spreadsheet ID from master sheet link");
      await supabase
        .from("jobs")
        .update({
          status: "failed",
          metadata: {
            ...job.metadata,
            error: "Invalid master sheet link format",
            failed_at: new Date().toISOString(),
          },
          updated_at: new Date().toISOString(),
        })
        .eq("id", job.id);
      processedCount++;
      continue;
    }

    const spreadsheetId = spreadsheetMatch[1];

    try {
      // Update job status to processing
      const { error: updateError } = await supabase
        .from("jobs")
        .update({
          status: "processing",
          updated_at: new Date().toISOString(),
        })
        .eq("id", job.id);

      if (updateError) {
        console.error(`Failed to update job ${job.id} status:`, updateError);
        processedCount++;
        continue;
      }

      // Create sheet tab for this invoice
      const sheetTitle = `${invoicePayload.invoiceNumber}`;
      await createSheetTab(accessToken, sheetTitle, spreadsheetId);

      // Small delay between sheet operations
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Populate the sheet with invoice data
      await populateInvoiceToSheet(
        accessToken,
        invoicePayload,
        sheetTitle,
        spreadsheetId,
      );

      // Get sheet ID and generate the tab link
      const sheetId = await getSheetIdByTitle(
        accessToken,
        spreadsheetId,
        sheetTitle,
      );
      const invoiceTabLink = `${masterSheetLink}#gid=${sheetId}`;

      // Update invoice with the tab link and mark as completed
      const { error: invoiceError } = await supabase
        .from("invoice")
        .update({
          sheet_link: invoiceTabLink,
          status: "completed",
        })
        .eq("id", invoiceId);

      if (invoiceError) {
        console.error(`Failed to update invoice ${invoiceId}:`, invoiceError);
        throw new Error(`Failed to update invoice: ${invoiceError.message}`);
      }

      // Update job status to completed
      const { error: completeError } = await supabase
        .from("jobs")
        .update({
          status: "completed",
          updated_at: new Date().toISOString(),
        })
        .eq("id", job.id);

      if (completeError) {
        console.error(
          `Failed to mark job ${job.id} as completed:`,
          completeError,
        );
      } else {
        console.log(`Successfully completed job ${job.id}`);
      }

      // Check if all invoices in this batch are completed
      const { data: batchInvoices, error: fetchError } = await supabase
        .from("invoice")
        .select("id, status")
        .eq("invoice_batch_id", batchId);

      if (!fetchError && batchInvoices) {
        const allCompleted = batchInvoices.every(
          (inv) => inv.status === "completed",
        );

        if (allCompleted) {
          console.log(
            `All invoices in batch ${batchId} are completed, marking batch as completed`,
          );
          const { error: batchError } = await supabase
            .from("invoice_batch")
            .update({
              status: "completed",
            })
            .eq("id", batchId);

          if (batchError) {
            console.error(
              `Failed to mark batch ${batchId} as completed:`,
              batchError,
            );
          } else {
            console.log(`Batch ${batchId} marked as completed`);
          }
        }
      }
    } catch (error) {
      console.error(`Error processing job ${job.id}:`, error);

      // Update job status to failed
      const { error: failError } = await supabase
        .from("jobs")
        .update({
          status: "failed",
          metadata: {
            ...job.metadata,
            error: error.message,
            failed_at: new Date().toISOString(),
          },
          updated_at: new Date().toISOString(),
        })
        .eq("id", job.id);

      if (failError) {
        console.error(`Failed to mark job ${job.id} as failed:`, failError);
      }
    }

    processedCount++;

    // Add delay between jobs to respect rate limits
    if (processedCount < maxJobsPerRun) {
      console.log(
        `Waiting 3 seconds before next job... (${processedCount}/${maxJobsPerRun})`,
      );
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }

  console.log(`=== Finished processing ${processedCount} jobs ===`);
}

export default {
  async fetch(request, env) {
    try {
      console.log("=== Starting Cloudflare Worker (fetch) ===");

      console.log(
        "GOOGLE_SERVICE_ACCOUNT_EMAIL present:",
        !!env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      );
      console.log("GOOGLE_PRIVATE_KEY present:", !!env.GOOGLE_PRIVATE_KEY);
      console.log("SUPABASE_URL present:", !!env.SUPABASE_URL);
      console.log(
        "SUPABASE_SERVICE_ROLE_KEY present:",
        !!env.SUPABASE_SERVICE_ROLE_KEY,
      );

      if (!env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !env.GOOGLE_PRIVATE_KEY) {
        throw new Error("Google service account credentials are missing");
      }

      if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
        throw new Error("Supabase credentials are missing");
      }

      // Process pending jobs
      await processPendingJobs(env);

      console.log("=== Cloudflare Worker completed successfully ===");

      return new Response(
        JSON.stringify({
          success: true,
          message: "Jobs processed successfully",
        }),
        {
          headers: { "Content-Type": "application/json" },
        },
      );
    } catch (error) {
      console.error("=== Error in Cloudflare Worker ===");
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error("Error message:", errorMessage);
      console.error(
        "Error stack:",
        error instanceof Error ? error.stack : "N/A",
      );

      return new Response(
        JSON.stringify({
          success: false,
          error: errorMessage,
        }),
        {
          headers: { "Content-Type": "application/json" },
          status: 500,
        },
      );
    }
  },

  async scheduled(event, env, ctx) {
    try {
      console.log("=== Starting Cloudflare Worker (scheduled) ===");

      console.log(
        "GOOGLE_SERVICE_ACCOUNT_EMAIL present:",
        !!env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      );
      console.log("GOOGLE_PRIVATE_KEY present:", !!env.GOOGLE_PRIVATE_KEY);
      console.log("SUPABASE_URL present:", !!env.SUPABASE_URL);
      console.log(
        "SUPABASE_SERVICE_ROLE_KEY present:",
        !!env.SUPABASE_SERVICE_ROLE_KEY,
      );

      if (!env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !env.GOOGLE_PRIVATE_KEY) {
        throw new Error("Google service account credentials are missing");
      }

      if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
        throw new Error("Supabase credentials are missing");
      }

      // Process pending jobs
      await processPendingJobs(env);

      console.log("=== Scheduled task completed successfully ===");
    } catch (error) {
      console.error("=== Error in scheduled task ===");
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error("Error message:", errorMessage);
      console.error(
        "Error stack:",
        error instanceof Error ? error.stack : "N/A",
      );
    }
  },
};
