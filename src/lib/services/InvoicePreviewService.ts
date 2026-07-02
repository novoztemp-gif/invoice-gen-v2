export class InvoicePreviewService {
  static getPreviewData(invoice: any, receivingCompany: any) {
    // Shared template normalization logic for Sales and Purchase invoices
    return {
      invoice,
      receivingCompany,
    };
  }
}
