import { InvoiceEngine } from "./InvoiceEngine";

export class InvoiceBatchService {
  static createBatch = InvoiceEngine.createBatch;
  static updateBatchStatus = InvoiceEngine.updateBatchStatus;
}
