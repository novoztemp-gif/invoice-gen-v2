import crypto from "crypto";
import { NextResponse } from "next/server";

// Alternative method to check edit access by attempting a small write operation
async function checkEditAccessByAttemptingWrite(
  spreadsheetId: string,
  accessToken: string,
) {
  try {
    // Try to add a temporary sheet to test write access
    const addSheetResponse = await fetch(
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
                  title: "TestSheet_PermissionCheck",
                },
              },
            },
          ],
        }),
      },
    );

    if (!addSheetResponse.ok) {
      console.log("Failed to add test sheet, no edit access");
      return NextResponse.json({
        hasAccess: false,
        message:
          "The service account needs edit access to generate sheets. Please share the spreadsheet with edit permissions.",
      });
    }

    const addSheetData = await addSheetResponse.json();
    const testSheetId =
      addSheetData.replies?.[0]?.addSheet?.properties?.sheetId;

    // If we successfully added a sheet, we have edit access
    // Now clean up by deleting the test sheet
    if (testSheetId) {
      await fetch(
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
                deleteSheet: {
                  sheetId: testSheetId,
                },
              },
            ],
          }),
        },
      );
    }

    console.log(
      "Successfully tested edit access by adding/removing test sheet",
    );
    return NextResponse.json({
      hasAccess: true,
      accessToken,
    });
  } catch (error) {
    console.error("Error in alternative permission check:", error);
    return NextResponse.json({
      hasAccess: false,
      message:
        "Failed to verify edit permissions. Please ensure the service account has edit access to the spreadsheet.",
    });
  }
}

// Generate OAuth2 access token from service account
async function getAccessToken() {
  try {
    console.log("=== Starting getAccessToken ===");
    console.log(
      "Service Account Email:",
      process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    );
    console.log("Private Key Length:", process.env.GOOGLE_PRIVATE_KEY?.length);

    if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL) {
      throw new Error("GOOGLE_SERVICE_ACCOUNT_EMAIL is not set");
    }

    if (!process.env.GOOGLE_PRIVATE_KEY) {
      throw new Error("GOOGLE_PRIVATE_KEY is not set");
    }

    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + 3600; // 1 hour

    const header = {
      alg: "RS256",
      typ: "JWT",
    };

    const payload = {
      iss: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
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
    const pemContent = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n")
      .replace("-----BEGIN PRIVATE KEY-----", "")
      .replace("-----END PRIVATE KEY-----", "")
      .replace(/\n/g, "");

    console.log("PEM content length after cleaning:", pemContent.length);

    const privateKey = crypto.createPrivateKey({
      key: Buffer.from(
        `-----BEGIN PRIVATE KEY-----\n${pemContent}\n-----END PRIVATE KEY-----`,
        "utf8",
      ),
      format: "pem",
      type: "pkcs8",
    });

    const signature = crypto.sign(
      "RSA-SHA256",
      Buffer.from(message),
      privateKey,
    );

    console.log("JWT signature created");

    const encodedSignature = signature
      .toString("base64")
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");

    const token = `${message}.${encodedSignature}`;

    console.log("JWT Token created, exchanging for access token...");
    console.log(
      "Service Account Email:",
      process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    );
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

export async function POST(request: Request) {
  try {
    const { spreadsheetId } = await request.json();

    if (!spreadsheetId) {
      return NextResponse.json(
        { message: "Spreadsheet ID is required" },
        { status: 400 },
      );
    }

    const accessToken = await getAccessToken();

    // First check if we can read the spreadsheet
    const readResponse = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=properties.title,sheets.properties`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );

    if (!readResponse.ok) {
      if (readResponse.status === 403) {
        return NextResponse.json({
          hasAccess: false,
          message:
            "The service account does not have permission to access this spreadsheet. Please share the spreadsheet with edit permissions.",
        });
      } else if (readResponse.status === 404) {
        return NextResponse.json({
          hasAccess: false,
          message: "Spreadsheet not found. Please check the URL.",
        });
      } else {
        return NextResponse.json({
          hasAccess: false,
          message: "Failed to validate spreadsheet access. Please try again.",
        });
      }
    }

    // Now check if we have edit permissions by trying to get permissions from Drive API
    const permissionsResponse = await fetch(
      `https://www.googleapis.com/drive/v3/files/${spreadsheetId}/permissions?fields=permissions(role,emailAddress,type)`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );

    if (!permissionsResponse.ok) {
      console.log("Permissions API failed, trying alternative check...");
      // If we can't get permissions, try a different approach - attempt to create a test sheet
      return await checkEditAccessByAttemptingWrite(spreadsheetId, accessToken);
    }

    const permissionsData = await permissionsResponse.json();
    console.log("Permissions data:", JSON.stringify(permissionsData, null, 2));

    // Check if service account has writer or owner role, OR if anyone has writer access (public edit)
    const hasEditAccess = permissionsData.permissions?.some((perm: any) => {
      // Check if service account has explicit permissions
      if (
        perm.emailAddress === process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL &&
        (perm.role === "writer" || perm.role === "owner")
      ) {
        console.log("Service account has explicit permissions:", perm.role);
        return true;
      }
      // Check if anyone has writer access (public edit permission)
      if (perm.type === "anyone" && perm.role === "writer") {
        console.log("Public edit access found");
        return true;
      }
      return false;
    });

    console.log("Has edit access:", hasEditAccess);

    if (!hasEditAccess) {
      // Try alternative check - attempt to create a test sheet
      console.log("No explicit permissions found, trying alternative check...");
      return await checkEditAccessByAttemptingWrite(spreadsheetId, accessToken);
    }

    if (!hasEditAccess) {
      return NextResponse.json({
        hasAccess: false,
        message:
          "The service account needs edit access to generate sheets. Please share the spreadsheet with edit permissions.",
      });
    }

    return NextResponse.json({
      hasAccess: true,
      accessToken,
    });
  } catch (error) {
    console.error("Error checking permissions:", error);
    return NextResponse.json(
      { message: "Failed to check permissions" },
      { status: 500 },
    );
  }
}
