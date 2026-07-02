export class ExcelExportService {
  static getDownloadUrl(invoiceId: string) {
    return `/api/download-invoice?invoiceId=${invoiceId}`;
  }
}
