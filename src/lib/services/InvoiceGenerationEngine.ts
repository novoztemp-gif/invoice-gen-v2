import { InvoiceEngine } from "./InvoiceEngine";

export class InvoiceGenerationEngine {
  static validateBatchParams = InvoiceEngine.validateBatchParams;
  static generateAndSaveInvoices = InvoiceEngine.generateAndSaveInvoices;
}
