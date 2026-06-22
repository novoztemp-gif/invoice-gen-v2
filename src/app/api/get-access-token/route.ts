import crypto from "crypto";
import { NextResponse } from "next/server";

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

export async function GET() {
  try {
    const accessToken = await getAccessToken();

    return NextResponse.json({ access_token: accessToken });
  } catch (error) {
    console.error("Error getting access token:", error);
    return NextResponse.json(
      { message: "Failed to get access token" },
      { status: 500 },
    );
  }
}
