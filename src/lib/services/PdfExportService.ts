import PDFDocument from "pdfkit";
import { numberToWords } from "@/lib/numberToWords";

function buildBeingText(inv: any): string {
  const productsList =
    inv.products
      ?.map((p: any) => {
        const hsn = p.hsn_code ? String(p.hsn_code).trim() : "";
        const namePart = hsn ? `${p.product_name} - ${hsn}` : p.product_name;
        const qty = Number(p.quantity || 0);
        const qtyStr = qty % 1 === 0 ? String(qty) : qty.toFixed(2);
        const unit = p.unit_of_measure
          ? String(p.unit_of_measure).toUpperCase()
          : "KG";
        const rate = Number(p.rate || 0);
        const amount = Number(p.amount || 0).toLocaleString("en-IN", {
          maximumFractionDigits: 2,
        });
        return `${namePart} - ${qtyStr}${unit} @ ${rate}/${unit} & ₹${amount}`;
      })
      .join(", ") || "raw materials";
  return `Purchase of ${productsList}`;
}

export async function generatePurchasePDFBuffer(
  inv: any,
  issuing: any,
  receiving: any,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const BEING_TEXT_X = 80;
    const BEING_TEXT_WIDTH = 555 - BEING_TEXT_X;
    const BEING_FONT_SIZE = 7;
    // Same fixed A5 voucher size as before — the being section gets a
    // reserved budget of ~4 lines (calibrated against real pdfkit
    // measurements: 4 lines of realistic product detail at 7pt is
    // ~32.4pt tall) instead of growing the page or shrinking the font
    // further. A being line that's genuinely longer than 4 lines'
    // worth truncates with an ellipsis rather than overlapping the
    // sections below — the user's call: this is enough room, fewer
    // products per invoice (or the existing per-invoice product-count
    // cap) is expected to keep it within that.
    const MAX_BEING_TEXT_HEIGHT = 33;
    const beingFullText = buildBeingText(inv);

    const doc = new PDFDocument({
      size: "A5",
      layout: "landscape",
      margin: 20,
    });

    doc.font("Helvetica-Oblique").fontSize(BEING_FONT_SIZE);
    const beingTextHeight = Math.min(
      doc.heightOfString(beingFullText, { width: BEING_TEXT_WIDTH }),
      MAX_BEING_TEXT_HEIGHT,
    );
    const beingDashedLineY = 235 + beingTextHeight + 4;
    // Everything below "being" keeps its original relative spacing (235 +
    // 10 was the original single-line assumption this layout was tuned
    // for), anchored to wherever beingDashedLineY actually landed — with
    // two downstream gaps also trimmed (see GAP_1/GAP_2 reclaim below) so
    // the full ~4-line budget still fits inside the voucher's own border.
    const layoutShift = beingDashedLineY - 245;

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

    // Title: CASH VOUCHER (centered)
    doc.font("Helvetica-Bold").fontSize(15).text("CASH VOUCHER", 0, 42, {
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

    // being — one clause per product (name - HSN - qty UNIT @ rate/UNIT &
    // ₹amount), not just a bare product list, so the voucher shows exactly
    // what was bought and for how much per item.
    const BEING_TEXT_Y = 235;
    doc.font("Helvetica-Bold").fontSize(10).text("being", 40, BEING_TEXT_Y);
    doc.font("Helvetica-Oblique").fontSize(BEING_FONT_SIZE);
    doc.text(beingFullText, BEING_TEXT_X, BEING_TEXT_Y, {
      width: BEING_TEXT_WIDTH,
      height: MAX_BEING_TEXT_HEIGHT,
      ellipsis: true,
    });

    doc
      .moveTo(80, beingDashedLineY)
      .lineTo(555, beingDashedLineY)
      .dash(2, { space: 2 })
      .stroke()
      .undash();

    // and debit
    doc.font("Helvetica-Bold").fontSize(10).text("and debit", 40, 260 + layoutShift);
    doc
      .moveTo(100, 270 + layoutShift)
      .lineTo(555, 270 + layoutShift)
      .dash(2, { space: 2 })
      .stroke()
      .undash();

    // "and debit" dashed line -> AUTHORISED BY was a spacious 20pt gap of
    // pure whitespace; Authorised-By box -> Paid-by/Signature boxes was
    // another 11pt — both reclaimed down to keep the full ~4-line being
    // budget inside the voucher's own border without the page growing.
    const GAP_1_RECLAIM = 15;
    const GAP_2_RECLAIM = 5;
    const shiftAfterAuthBy = layoutShift - GAP_1_RECLAIM;
    const shiftAfterPaidBy = shiftAfterAuthBy - GAP_2_RECLAIM;

    // Authorised by
    doc
      .font("Helvetica-Bold")
      .fontSize(9)
      .fillColor("#334155")
      .text("AUTHORISED BY", 40, 290 + shiftAfterAuthBy);
    doc
      .rect(40, 302 + shiftAfterAuthBy, 120, 32)
      .strokeColor("black")
      .stroke();

    // Recd above sum
    doc
      .fontSize(10)
      .fillColor("black")
      .text("Recd. above sum of Rs. ", 200, 312 + shiftAfterAuthBy, {
        lineBreak: false,
      });
    const recdWidth = doc.widthOfString("Recd. above sum of Rs. ");
    doc
      .font("Helvetica-Bold")
      .text(
        Number(inv.total_amount).toFixed(2),
        200 + recdWidth,
        312 + shiftAfterAuthBy,
        { underline: true },
      );

    // Paid by Cash or Cheque Bank Details box
    doc.rect(40, 345 + shiftAfterPaidBy, 360, 42).stroke();
    doc
      .font("Helvetica-Bold")
      .fontSize(8)
      .text("cash", 50, 351 + shiftAfterPaidBy, { underline: true });
    doc.font("Helvetica").fontSize(7).text("or", 55, 361 + shiftAfterPaidBy);
    doc
      .font("Helvetica-Bold")
      .fontSize(8)
      .text("cheque", 45, 371 + shiftAfterPaidBy, { underline: true });

    doc
      .moveTo(100, 345 + shiftAfterPaidBy)
      .lineTo(100, 387 + shiftAfterPaidBy)
      .lineWidth(0.5)
      .stroke();

    doc
      .font("Helvetica-Bold")
      .fontSize(8)
      .text("Drawn on Bank:", 110, 351 + shiftAfterPaidBy);
    doc
      .font("Helvetica")
      .text(issuing?.bank_name || "—", 185, 351 + shiftAfterPaidBy);
    doc.font("Helvetica-Bold").text("A/c No.", 110, 362 + shiftAfterPaidBy);
    doc
      .font("Helvetica")
      .text(issuing?.account_number || "—", 185, 362 + shiftAfterPaidBy);
    doc.font("Helvetica-Bold").text("IFSC:", 110, 373 + shiftAfterPaidBy);
    doc
      .font("Helvetica")
      .text(issuing?.ifsc_code || "—", 185, 373 + shiftAfterPaidBy);

    // Receiver's Signature box
    doc.rect(415, 345 + shiftAfterPaidBy, 140, 42).stroke();
    doc
      .font("Helvetica-Bold")
      .fontSize(8)
      .text("Receiver's Signature", 415, 376 + shiftAfterPaidBy, {
        width: 140,
        align: "center",
      });

    doc.end();
  });
}
