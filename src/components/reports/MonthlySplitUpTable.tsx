"use client";

import { Fragment } from "react";
import {
  MonthlySplitUpMonth,
  MonthlySplitUpProduct,
  SplitUpMatrix,
} from "@/lib/services/monthly-splitup/types";

interface MonthlySplitUpTableProps {
  products: MonthlySplitUpProduct[];
  months: MonthlySplitUpMonth[];
  matrix: SplitUpMatrix;
}

function formatQty(n: number) {
  return n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

function formatAmount(n: number) {
  // Amounts are always whole rupees — force ".00" to show rather than
  // being dropped, so it reads as a normal currency value, not a plain
  // integer.
  return n.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

const IDENTITY_COL_WIDTH = 260;
const UQC_COL_WIDTH = 64;
const NUM_COL_WIDTH = 96;

/** Sticky header row + sticky first column (HSN/Description), with an
 * explicit opaque background on every sticky cell — a plain table lets
 * scrolled-under content show through a transparent sticky cell, and the
 * corner cell (both sticky) needs the highest z-index of all.
 *
 * The identity column is the one place `whitespace-nowrap` must NOT apply —
 * a real product description can run to 100+ characters, and forcing that
 * onto one unbroken line (while sticky-pinned) blows the column out to
 * enormous width and pushes every other column off-screen. It gets a fixed
 * width + wrapping instead; every other cell stays nowrap since its content
 * is always short (a number or a short label). */
export function MonthlySplitUpTable({
  products,
  months,
  matrix,
}: MonthlySplitUpTableProps) {
  const totalsByMonth = months.map((m) =>
    matrix.reduce(
      (acc, row) => {
        const cell = row[m.monthIndex];
        return { qty: acc.qty + cell.qty, amount: acc.amount + cell.amount };
      },
      { qty: 0, amount: 0 },
    ),
  );
  const grandTotal = totalsByMonth.reduce(
    (acc, t) => ({ qty: acc.qty + t.qty, amount: acc.amount + t.amount }),
    { qty: 0, amount: 0 },
  );

  const thBase =
    "px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-600 border-b border-slate-200 whitespace-nowrap bg-slate-50 box-border";
  const tdBase =
    "px-3 py-1.5 text-sm border-b border-slate-100 whitespace-nowrap box-border";
  const identityWidthStyle = { width: IDENTITY_COL_WIDTH, minWidth: IDENTITY_COL_WIDTH };
  const uqcWidthStyle = { width: UQC_COL_WIDTH, minWidth: UQC_COL_WIDTH };
  const numWidthStyle = { width: NUM_COL_WIDTH, minWidth: NUM_COL_WIDTH };

  return (
    <div className="overflow-auto border border-slate-200 rounded-lg max-h-[70vh]">
      <table className="border-collapse text-slate-800 w-max">
        <thead>
          <tr className="h-9">
            <th
              style={identityWidthStyle}
              className={`${thBase} sticky left-0 top-0 z-30 text-left`}
            >
              HSN Code / Description
            </th>
            <th style={uqcWidthStyle} className={`${thBase} sticky top-0 z-20 text-left`}>
              UQC
            </th>
            {months.map((m) => (
              <th
                key={m.label}
                colSpan={2}
                style={{ width: NUM_COL_WIDTH * 2 }}
                className={`${thBase} sticky top-0 z-20 text-center`}
              >
                {m.label}
              </th>
            ))}
            <th
              colSpan={2}
              style={{ width: NUM_COL_WIDTH * 2 }}
              className={`${thBase} sticky top-0 z-20 text-center`}
            >
              Total
            </th>
          </tr>
          <tr className="h-9">
            <th
              style={identityWidthStyle}
              className={`${thBase} sticky left-0 top-9 z-30 text-left`}
            >
              &nbsp;
            </th>
            <th style={uqcWidthStyle} className={`${thBase} sticky top-9 z-20 text-left`}>
              &nbsp;
            </th>
            {months.map((m) => (
              <Fragment key={m.label}>
                <th
                  style={numWidthStyle}
                  className={`${thBase} sticky top-9 z-20 text-right`}
                >
                  Qty
                </th>
                <th
                  style={numWidthStyle}
                  className={`${thBase} sticky top-9 z-20 text-right`}
                >
                  Amount (₹)
                </th>
              </Fragment>
            ))}
            <th style={numWidthStyle} className={`${thBase} sticky top-9 z-20 text-right`}>
              Qty
            </th>
            <th style={numWidthStyle} className={`${thBase} sticky top-9 z-20 text-right`}>
              Amount (₹)
            </th>
          </tr>
        </thead>
        <tbody>
          {products.map((p, pIdx) => {
            const isOdd = pIdx % 2 === 1;
            const rowBg = isOdd ? "bg-slate-50" : "bg-white";
            let totalQty = 0;
            let totalAmount = 0;
            return (
              <tr key={p.hsnCode + pIdx} className={rowBg}>
                <td
                  style={identityWidthStyle}
                  className={`px-3 py-1.5 text-sm border-b border-slate-100 box-border whitespace-normal sticky left-0 z-10 ${rowBg} font-medium text-slate-900 align-top`}
                >
                  <div className="leading-snug">{p.description}</div>
                  <div className="text-xs text-slate-400 font-normal mt-0.5">
                    {p.hsnCode}
                  </div>
                </td>
                <td style={uqcWidthStyle} className={`${tdBase} text-slate-500`}>
                  {p.uqc}
                </td>
                {matrix[pIdx].map((cell, mIdx) => {
                  totalQty += cell.qty;
                  totalAmount += cell.amount;
                  return (
                    <Fragment key={mIdx}>
                      <td style={numWidthStyle} className={`${tdBase} text-right`}>
                        {formatQty(cell.qty)}
                      </td>
                      <td style={numWidthStyle} className={`${tdBase} text-right`}>
                        {formatAmount(cell.amount)}
                      </td>
                    </Fragment>
                  );
                })}
                <td style={numWidthStyle} className={`${tdBase} text-right font-medium`}>
                  {formatQty(totalQty)}
                </td>
                <td style={numWidthStyle} className={`${tdBase} text-right font-medium`}>
                  {formatAmount(totalAmount)}
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="bg-slate-800 text-white font-semibold">
            <td
              style={identityWidthStyle}
              className={`${tdBase} sticky left-0 z-10 bg-slate-800 border-b-0`}
            >
              TOTAL
            </td>
            <td style={uqcWidthStyle} className={`${tdBase} bg-slate-800 border-b-0`} />
            {months.map((m, mIdx) => (
              <Fragment key={m.label}>
                <td
                  style={numWidthStyle}
                  className={`${tdBase} bg-slate-800 border-b-0 text-right`}
                >
                  {formatQty(totalsByMonth[mIdx].qty)}
                </td>
                <td
                  style={numWidthStyle}
                  className={`${tdBase} bg-slate-800 border-b-0 text-right`}
                >
                  {formatAmount(totalsByMonth[mIdx].amount)}
                </td>
              </Fragment>
            ))}
            <td style={numWidthStyle} className={`${tdBase} bg-slate-800 border-b-0 text-right`}>
              {formatQty(grandTotal.qty)}
            </td>
            <td style={numWidthStyle} className={`${tdBase} bg-slate-800 border-b-0 text-right`}>
              {formatAmount(grandTotal.amount)}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
