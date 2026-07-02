import { InvoiceEngine } from "./InvoiceEngine";

export class InvoiceEditorService {
  static saveInvoice = InvoiceEngine.saveInvoiceAndRebalance;
}
