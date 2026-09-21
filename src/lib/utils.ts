import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export async function triggerDownload(
  url: string,
  fallbackFilename: string,
  init?: RequestInit,
) {
  try {
    const response = await fetch(url, init);
    if (!response.ok) {
      // Hotfix — this used to throw a generic "Download failed" and get
      // swallowed below with only a console.error, so a click on any
      // Download button (ZIP, Summary, Monthly Split-up, Debtors &
      // Creditors — every one of them goes through this same function)
      // that hit a real backend error (batch not finalized yet, no
      // invoices found, a thrown exception building the workbook) looked
      // identical to nothing happening at all: no error, no file, no
      // clue why. Every one of these routes already returns a real
      // `{ message: "..." }` JSON body on failure — read and surface it
      // instead of discarding it.
      let serverMessage = "";
      try {
        const body = await response.json();
        serverMessage = body?.message || "";
      } catch {
        // Response body wasn't JSON (or was already consumed) — fall
        // through to the generic message below.
      }
      throw new Error(
        serverMessage || `Download failed (HTTP ${response.status}).`,
      );
    }

    const contentDisposition = response.headers.get("content-disposition");
    let filename = fallbackFilename;
    if (contentDisposition) {
      const filenameMatch = contentDisposition.match(/filename="?([^"]+)"?/);
      if (filenameMatch) {
        filename = filenameMatch[1];
      }
    }

    const blob = await response.blob();
    const blobUrl = window.URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = blobUrl;
    link.setAttribute("download", filename);
    document.body.appendChild(link);
    link.click();
    link.parentNode?.removeChild(link);
    window.URL.revokeObjectURL(blobUrl);
  } catch (error: any) {
    console.error("Download trigger failed:", error);
    alert(
      error?.message ||
        "Download failed — an unexpected error occurred. Please try again.",
    );
  }
}
