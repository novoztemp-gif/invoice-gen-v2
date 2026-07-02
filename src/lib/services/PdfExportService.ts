import PDFDocument from "pdfkit";
import { numberToWords } from "@/lib/numberToWords";

export async function generatePurchasePDFBuffer(
  inv: any,
  issuing: any,
  receiving: any,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A5",
      layout: "landscape",
      margin: 20,
    });

    const chunks: any[] = [];

    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", (err) => reject(err));

    // Outer double border outline around the A5 voucher (A5 landscape size is 595.28 x 419.53 points)
    doc
      .rect(20, 20, 555.28, 379.53)
      .lineWidth(1.5)
      .strokeColor("black")
      .stroke();
    doc
      .rect(23, 23, 549.28, 373.53)
      .lineWidth(0.5)
      .strokeColor("black")
      .stroke();

    // Title: PURCHASE INVOICE (centered)
    doc.font("Helvetica-Bold").fontSize(15).text("PURCHASE INVOICE", 0, 42, {
      align: "center",
      underline: true,
    });

    // No. and Date
    doc
      .fontSize(10)
      .font("Helvetica-Bold")
      .text("No. ", 40, 80, { lineBreak: false });
    const noWidth = doc.widthOfString("No. ");
    doc
      .font("Helvetica")
      .text(inv.invoice_number, 40 + noWidth, 80, { underline: true });

    const rawDate = inv.invoice_date ? new Date(inv.invoice_date) : new Date();
    const day = String(rawDate.getDate()).padStart(2, "0");
    const month = String(rawDate.getMonth() + 1).padStart(2, "0");
    const year = rawDate.getFullYear();
    const formattedDate = `${day}/${month}/${year}`;

    doc.font("Helvetica-Bold").text("Date. ", 400, 80, { lineBreak: false });
    const dateWidth = doc.widthOfString("Date. ");
    doc
      .font("Helvetica")
      .text(formattedDate, 400 + dateWidth, 80, { underline: true });

    // Rs Amount Box
    doc.font("Helvetica-Bold").text("Rs", 40, 112);
    doc.rect(70, 107, 120, 22).lineWidth(1).strokeColor("black").stroke();
    doc
      .font("Helvetica-Bold")
      .fontSize(11)
      .text(Number(inv.total_amount).toFixed(2), 76, 113);

    // Pay to
    doc
      .font("Helvetica-Bold")
      .fontSize(9)
      .fillColor("#334155")
      .text("PAY TO", 40, 142);
    doc.rect(40, 152, 515, 24).strokeColor("black").stroke();
    doc
      .font("Helvetica-Bold")
      .fontSize(10)
      .fillColor("black")
      .text(receiving?.company_name || "", 48, 159);

    // Rs. in Words
    doc
      .font("Helvetica-Bold")
      .fontSize(9)
      .fillColor("#334155")
      .text("RS. IN WORDS", 40, 187);
    doc.rect(40, 197, 515, 24).stroke();
    doc
      .font("Helvetica-Bold")
      .fontSize(9)
      .fillColor("black")
      .text(
        `Rupees ${numberToWords(Math.round(inv.total_amount))} Only`,
        48,
        204,
      );

    // being
    doc.font("Helvetica-Bold").fontSize(10).text("being", 40, 235);
    const productsList =
      inv.products?.map((p: any) => p.product_name).join(", ") ||
      "raw materials";
    doc.font("Helvetica-Oblique").text(`Purchase of ${productsList}`, 80, 235);
    doc
      .moveTo(80, 245)
      .lineTo(555, 245)
      .dash(2, { space: 2 })
      .stroke()
      .undash();

    // and debit
    doc.font("Helvetica-Bold").text("and debit", 40, 260);
    doc
      .moveTo(100, 270)
      .lineTo(555, 270)
      .dash(2, { space: 2 })
      .stroke()
      .undash();

    // Authorised by
    doc
      .font("Helvetica-Bold")
      .fontSize(9)
      .fillColor("#334155")
      .text("AUTHORISED BY", 40, 290);
    doc.rect(40, 302, 120, 32).strokeColor("black").stroke();

    // Recd above sum
    doc
      .fontSize(10)
      .fillColor("black")
      .text("Recd. above sum of Rs. ", 200, 312, { lineBreak: false });
    const recdWidth = doc.widthOfString("Recd. above sum of Rs. ");
    doc
      .font("Helvetica-Bold")
      .text(Number(inv.total_amount).toFixed(2), 200 + recdWidth, 312, {
        underline: true,
      });

    // Paid by Cash or Cheque Bank Details box
    doc.rect(40, 345, 360, 42).stroke();
    doc
      .font("Helvetica-Bold")
      .fontSize(8)
      .text("cash", 50, 351, { underline: true });
    doc.font("Helvetica").fontSize(7).text("or", 55, 361);
    doc
      .font("Helvetica-Bold")
      .fontSize(8)
      .text("cheque", 45, 371, { underline: true });

    doc.moveTo(100, 345).lineTo(100, 387).lineWidth(0.5).stroke();

    doc.font("Helvetica-Bold").fontSize(8).text("Drawn on Bank:", 110, 351);
    doc.font("Helvetica").text(issuing?.bank_name || "—", 185, 351);
    doc.font("Helvetica-Bold").text("A/c No.", 110, 362);
    doc.font("Helvetica").text(issuing?.account_number || "—", 185, 362);
    doc.font("Helvetica-Bold").text("IFSC:", 110, 373);
    doc.font("Helvetica").text(issuing?.ifsc_code || "—", 185, 373);

    // Receiver's Signature box
    doc.rect(415, 345, 140, 42).stroke();
    doc
      .font("Helvetica-Bold")
      .fontSize(8)
      .text("Receiver's Signature", 415, 376, {
        width: 140,
        align: "center",
      });

    doc.end();
  });
}
