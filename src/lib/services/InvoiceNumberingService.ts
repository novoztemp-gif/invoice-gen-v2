import { SupabaseClient } from "@supabase/supabase-js";

export type InvoiceType = "P" | "S";

export interface InvoiceSequencePreview {
  companyName: string;
  abbreviation: string;
  financialYear: string;
  invoiceType: InvoiceType;
  invoiceTypeLabel: string;
  currentSequenceNumber: number;
  nextSequenceNumber: number;
  currentInvoiceNumber: string;
  nextInvoiceNumber: string;
}

export class InvoiceNumberingService {
  /**
   * Normalizes a Financial Year string to canonical format `YYYY-YY` (e.g. `2026-27`).
   * Rejects invalid or arbitrary text.
   */
  public static normalizeFinancialYear(financialYear: string): string {
    if (!financialYear) return "2026-27";
    let clean = financialYear.trim();

    // Strip leading "FY" or "FY "
    if (/^FY\s*/i.test(clean)) {
      clean = clean.replace(/^FY\s*/i, "");
    }

    // Match 2026-27 or 2026-2027
    const match = clean.match(/^((?:20|21)\d{2})[-/_\s]+(\d{2}|\d{4})$/);
    if (match) {
      const startYr = parseInt(match[1], 10);
      let endYrStr = match[2];
      if (endYrStr.length === 4) {
        endYrStr = endYrStr.slice(-2);
      }
      return `${startYr}-${endYrStr}`;
    }

    // Match single year e.g. 2026
    if (/^(20|21)\d{2}$/.test(clean)) {
      const startYr = parseInt(clean, 10);
      const endYrStr = String(startYr + 1).slice(-2);
      return `${startYr}-${endYrStr}`;
    }

    // Default fallback
    return "2026-27";
  }

  /**
   * Normalizes a company abbreviation to uppercase alphanumeric (1-10 characters).
   * Throws Error if abbreviation contains special characters or spaces.
   */
  public static normalizeAbbreviation(abbreviation: string): string {
    const clean = (abbreviation || "").trim().toUpperCase();
    if (!clean) {
      throw new Error("Company Abbreviation is required.");
    }
    if (!/^[A-Z0-9]{1,10}$/.test(clean)) {
      throw new Error(
        "Company Abbreviation must be 1 to 10 characters long and contain only uppercase letters and numbers (e.g. A1, AT, NOVOZ). Spaces and special characters are not permitted.",
      );
    }
    return clean;
  }

  /**
   * Formats an invoice number according to standard:
   * <Abbreviation>-<CanonicalFY>-<P|S>-<7-Digit-Padded-Number>
   * Example: A1-2026-27-P-0000001
   */
  public static formatInvoiceNumber(
    abbreviation: string,
    financialYear: string,
    invoiceType: InvoiceType,
    sequenceNumber: number,
  ): string {
    const cleanAbbr = this.normalizeAbbreviation(abbreviation);
    const cleanFy = this.normalizeFinancialYear(financialYear);
    const paddedSeq = String(sequenceNumber).padStart(7, "0");
    return `${cleanAbbr}-${cleanFy}-${invoiceType}-${paddedSeq}`;
  }

  /**
   * Fetches current sequence state & next sequence preview with rich accounting information.
   * The next sequence number is always auto-detected from the highest existing
   * invoice number for this company + financial year + type — there is no
   * manual override. A new financial year (or a deleted batch/sequence)
   * naturally starts back at 1 since the detection is scoped to that exact
   * prefix.
   */
  public static async fetchSequencePreview(
    supabase: SupabaseClient,
    issuingCompanyId: string,
    financialYear: string,
    invoiceType: InvoiceType,
  ): Promise<InvoiceSequencePreview | null> {
    if (!issuingCompanyId) return null;

    const canonicalFy = this.normalizeFinancialYear(financialYear);

    // 1. Get company details
    const { data: company } = await supabase
      .from("issuing_companies")
      .select("company_name, abbreviation")
      .eq("id", issuingCompanyId)
      .single();

    if (!company) return null;

    const companyName = company.company_name;
    const abbreviation =
      company.abbreviation ||
      companyName
        .substring(0, 4)
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "");

    const prefix = `${abbreviation}-${canonicalFy}-${invoiceType}`;
    let currentSeq = 0;
    let page = 0;
    const pageSize = 1000;
    let hasMore = true;
    while (hasMore) {
      const { data: pageInvoices } = await supabase
        .from("invoice")
        .select("invoice_number")
        .like("invoice_number", `${prefix}-%`)
        .range(page * pageSize, (page + 1) * pageSize - 1);

      if (pageInvoices && pageInvoices.length > 0) {
        for (const row of pageInvoices) {
          const parts = (row.invoice_number || "").split("-");
          const seqNum = parseInt(parts[parts.length - 1], 10);
          if (!isNaN(seqNum) && seqNum > currentSeq) {
            currentSeq = seqNum;
          }
        }
        if (pageInvoices.length < pageSize) {
          hasMore = false;
        } else {
          page++;
        }
      } else {
        hasMore = false;
      }
    }

    const nextSeq = currentSeq + 1;

    const currentInvoiceNumber =
      currentSeq > 0
        ? this.formatInvoiceNumber(
            abbreviation,
            canonicalFy,
            invoiceType,
            currentSeq,
          )
        : "None yet";

    const nextInvoiceNumber = this.formatInvoiceNumber(
      abbreviation,
      canonicalFy,
      invoiceType,
      nextSeq,
    );

    return {
      companyName,
      abbreviation,
      financialYear: canonicalFy,
      invoiceType,
      invoiceTypeLabel: invoiceType === "P" ? "Purchase" : "Sales",
      currentSequenceNumber: currentSeq,
      nextSequenceNumber: nextSeq,
      currentInvoiceNumber,
      nextInvoiceNumber,
    };
  }

  /**
   * Commits invoice batch and increments sequence inside ONE single atomic database transaction via RPC.
   * If any error occurs, PostgreSQL automatically rolls back the invoices and the sequence.
   */
  public static async commitInvoiceBatchWithSequences(
    supabase: SupabaseClient,
    batchId: string,
    issuingCompanyId: string,
    financialYear: string,
    invoiceType: InvoiceType,
    invoicesPayload: any[],
  ): Promise<Array<{ invoice_number: string; sequence_number: number }>> {
    const canonicalFy = this.normalizeFinancialYear(financialYear);

    const { data, error } = await supabase.rpc(
      "commit_invoice_batch_with_sequences",
      {
        p_batch_id: batchId,
        p_issuing_company_id: issuingCompanyId,
        p_financial_year: canonicalFy,
        p_invoice_type: invoiceType,
        p_invoices: invoicesPayload,
      },
    );

    if (error) {
      throw new Error(`Atomic batch commit failed: ${error.message}`);
    }

    return (data || []).map((d: any) => ({
      invoice_number: d.invoice_number,
      sequence_number: Number(d.sequence_number),
    }));
  }

  /**
   * Generates next `count` sequential invoice numbers for fallback paths.
   */
  public static async generateSequentialInvoiceNumbers(
    supabase: SupabaseClient,
    issuingCompanyId: string,
    financialYear: string,
    invoiceType: InvoiceType,
    count: number,
    previousEndingSequence?: number | string,
  ): Promise<Array<{ invoice_number: string; sequence_number: number }>> {
    const canonicalFy = this.normalizeFinancialYear(financialYear);

    const { data: company } = await supabase
      .from("issuing_companies")
      .select("abbreviation, company_name")
      .eq("id", issuingCompanyId)
      .single();

    const abbr =
      company?.abbreviation ||
      company?.company_name
        .substring(0, 4)
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "") ||
      "IC";

    const parsedPrev =
      previousEndingSequence !== undefined &&
      previousEndingSequence !== null &&
      previousEndingSequence !== ""
        ? Number(previousEndingSequence)
        : 0;

    const startSeq = (!isNaN(parsedPrev) ? parsedPrev : 0) + 1;

    const result = [];
    for (let i = 0; i < count; i++) {
      const seqNum = startSeq + i;
      result.push({
        invoice_number: this.formatInvoiceNumber(
          abbr,
          canonicalFy,
          invoiceType,
          seqNum,
        ),
        sequence_number: seqNum,
      });
    }

    return result;
  }
}
