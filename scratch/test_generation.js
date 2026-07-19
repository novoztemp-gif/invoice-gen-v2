const crypto = require("crypto");

// 1. Define Mock Batch Details
const mockBatch = {
  id: "mock-batch-uuid",
  batch_type: "PURCHASE",
  minimum_invoice_amount: 15000,
  maximum_invoice_amount: 45000,
  total_amount: 500000, // Target Purchase Amount
  selected_customers: ["supplier-1", "supplier-2", "supplier-3"],
  major_customers: [],
  products: [
    {
      product_id: "prod-rice",
      product_name: "Rice",
      hsn_code: "1006",
      unit_of_measure: "KG",
      perDayQtyMin: "200",
      perDayQtyMax: "500",
      perDayRateMin: "40",
      perDayRateMax: "60",
      occurrencePercentage: 80, // Rice appears 80% of the time
    },
    {
      product_id: "prod-sugar",
      product_name: "Sugar",
      hsn_code: "1701",
      unit_of_measure: "KG",
      perDayQtyMin: "100",
      perDayQtyMax: "300",
      perDayRateMin: "35",
      perDayRateMax: "50",
      occurrencePercentage: null, // Default probability (50%)
    },
    {
      product_id: "prod-oil",
      product_name: "Oil",
      hsn_code: "1507",
      unit_of_measure: "LITRE",
      perDayQtyMin: "50",
      perDayQtyMax: "150",
      perDayRateMin: "110",
      perDayRateMax: "140",
      occurrencePercentage: 25, // Oil appears 25% of the time
    },
  ],
};

// 2. Exact Port of the generatePurchaseInvoiceSplitupsInternal algorithm
function generatePurchaseInvoiceSplitups(batch, numberOfDays) {
  const thresholdMin = batch.minimum_invoice_amount;
  const thresholdMax = batch.maximum_invoice_amount;
  const totalAmount = batch.total_amount;

  let invoiceCounter = 1;
  const invoices = [];

  // Gather Customers/Suppliers
  let selectedCustomers = batch.selected_customers || [];
  const majorCustomers = batch.major_customers || [];

  const targets = [];

  // Handle Regular Customers/Suppliers
  const majorTotal = majorCustomers.reduce((s, m) => s + (m.amount || 0), 0);
  const remainingBatchAmount =
    Math.round((totalAmount - majorTotal) * 100) / 100;

  if (remainingBatchAmount > 0.01 && selectedCustomers.length > 0) {
    const avgThreshold = (thresholdMin + thresholdMax) / 2;
    let N_rem = Math.round(remainingBatchAmount / avgThreshold);
    const N_min = Math.ceil(remainingBatchAmount / thresholdMax);
    const N_max = Math.floor(remainingBatchAmount / thresholdMin);
    N_rem = Math.max(N_min, Math.min(N_max, N_rem));
    if (N_rem < 1) N_rem = 1;

    console.log(`\n--- Budget Solver Configuration ---`);
    console.log(`Target Amount: ₹${remainingBatchAmount}`);
    console.log(`Invoice Limits: Min: ₹${thresholdMin}, Max: ₹${thresholdMax}`);
    console.log(
      `Calculated Invoice Count N: ${N_rem} (Feasible limits: [${N_min}, ${N_max}])`,
    );

    const budgets = [];
    let remAmt = remainingBatchAmount;
    for (let i = 0; i < N_rem; i++) {
      budgets.push(thresholdMin);
      remAmt -= thresholdMin;
    }

    const maxAddPerInvoice = thresholdMax - thresholdMin;
    for (let i = 0; i < N_rem - 1; i++) {
      const minAdd = Math.max(0, remAmt - (N_rem - 1 - i) * maxAddPerInvoice);
      const maxAdd = Math.min(remAmt, maxAddPerInvoice);
      const add = minAdd + Math.random() * (maxAdd - minAdd);
      const roundedAdd = Math.round(add * 100) / 100;
      budgets[i] = Math.round((budgets[i] + roundedAdd) * 100) / 100;
      remAmt = Math.round((remAmt - roundedAdd) * 100) / 100;
    }
    budgets[N_rem - 1] = Math.round((budgets[N_rem - 1] + remAmt) * 100) / 100;

    for (const amt of budgets) {
      const randomCustomerIndex = Math.floor(
        Math.random() * selectedCustomers.length,
      );
      targets.push({
        amount: amt,
        customerId: selectedCustomers[randomCustomerIndex],
      });
    }
  }

  // Generate Invoices
  for (let i = 0; i < targets.length; i++) {
    const tgt = targets[i];
    const invoiceAmount = tgt.amount;

    const dayOffset = Math.floor(Math.random() * numberOfDays);
    const currentDate = new Date("2026-04-01");
    currentDate.setDate(currentDate.getDate() + dayOffset);
    const invoiceDate = currentDate.toISOString().split("T")[0];

    let subset = [];
    let attempt = 0;
    while (attempt < 100) {
      attempt++;
      const candidate = [];
      for (const prod of batch.products) {
        const prob =
          prod.occurrencePercentage !== undefined &&
          prod.occurrencePercentage !== null
            ? Number(prod.occurrencePercentage)
            : 50;
        if (Math.random() * 100 <= prob) {
          candidate.push(prod);
        }
      }
      if (candidate.length === 0) {
        candidate.push(
          batch.products[Math.floor(Math.random() * batch.products.length)],
        );
      }

      const minSum = candidate.reduce(
        (sum, p) =>
          sum + parseFloat(p.perDayQtyMin) * parseFloat(p.perDayRateMin),
        0,
      );
      const maxSum = candidate.reduce(
        (sum, p) =>
          sum + parseFloat(p.perDayQtyMax) * parseFloat(p.perDayRateMax),
        0,
      );

      if (minSum <= invoiceAmount && invoiceAmount <= maxSum) {
        subset = candidate;
        break;
      }
    }

    if (subset.length === 0) {
      const sorted = [...batch.products].sort((a, b) => {
        const minA = parseFloat(a.perDayQtyMin) * parseFloat(a.perDayRateMin);
        const minB = parseFloat(b.perDayQtyMin) * parseFloat(b.perDayRateMin);
        return minA - minB;
      });
      const candidate = [];
      let currentMin = 0;
      for (const p of sorted) {
        const pMin = parseFloat(p.perDayQtyMin) * parseFloat(p.perDayRateMin);
        if (currentMin + pMin <= invoiceAmount || candidate.length === 0) {
          candidate.push(p);
          currentMin += pMin;
        } else {
          break;
        }
      }
      subset = candidate;
    }

    const minSum = subset.reduce(
      (sum, p) =>
        sum + parseFloat(p.perDayQtyMin) * parseFloat(p.perDayRateMin),
      0,
    );
    const maxSum = subset.reduce(
      (sum, p) =>
        sum + parseFloat(p.perDayQtyMax) * parseFloat(p.perDayRateMax),
      0,
    );
    const f =
      maxSum > minSum
        ? Math.max(0, Math.min(1, (invoiceAmount - minSum) / (maxSum - minSum)))
        : 0;
    const invoiceProducts = [];

    for (const p of subset) {
      const minQ = parseFloat(p.perDayQtyMin);
      const maxQ = parseFloat(p.perDayQtyMax);
      const minR = parseFloat(p.perDayRateMin);
      const maxR = parseFloat(p.perDayRateMax);

      const pMinVal = minQ * minR;
      const pMaxVal = maxQ * maxR;
      const targetVal = pMinVal + f * (pMaxVal - pMinVal);

      const randomRate = minR + Math.random() * (maxR - minR);
      const rate = Math.round(randomRate * 100) / 100;

      let qty = Math.round((targetVal / rate) * 100) / 100;
      qty = Math.max(minQ, Math.min(maxQ, qty));
      qty = Math.round(qty * 100) / 100;

      invoiceProducts.push({
        product_id: p.product_id,
        product_name: p.product_name,
        quantity: qty,
        rate,
        amount: Math.round(qty * rate * 100) / 100,
      });
    }

    // Align drift naturally across products in random order
    let drift =
      Math.round(
        (invoiceAmount -
          invoiceProducts.reduce((sum, p) => sum + p.amount, 0)) *
          100,
      ) / 100;
    if (Math.abs(drift) > 0.01 && invoiceProducts.length > 0) {
      const indices = Array.from(
        { length: invoiceProducts.length },
        (_, idx) => idx,
      );
      for (let k = indices.length - 1; k > 0; k--) {
        const j = Math.floor(Math.random() * (k + 1));
        [indices[k], indices[j]] = [indices[j], indices[k]];
      }

      for (const idx of indices) {
        if (Math.abs(drift) <= 0.01) break;

        const p = invoiceProducts[idx];
        const config = subset.find((pd) => pd.product_id === p.product_id);
        const minRate = parseFloat(config.perDayRateMin);
        const maxRate = parseFloat(config.perDayRateMax);
        const qty = p.quantity;
        if (qty <= 0) continue;

        if (drift > 0) {
          const maxPossibleAmt = Math.round(qty * maxRate * 100) / 100;
          const room = Math.max(
            0,
            Math.round((maxPossibleAmt - p.amount) * 100) / 100,
          );
          if (room > 0.01) {
            const toAdd = Math.round(Math.min(drift, room) * 100) / 100;
            p.amount = Math.round((p.amount + toAdd) * 100) / 100;
            p.rate = Math.round((p.amount / qty) * 100) / 100;
            drift = Math.round((drift - toAdd) * 100) / 100;
          }
        } else {
          const minPossibleAmt = Math.round(qty * minRate * 100) / 100;
          const room = Math.max(
            0,
            Math.round((p.amount - minPossibleAmt) * 100) / 100,
          );
          if (room > 0.01) {
            const toSub =
              Math.round(Math.min(Math.abs(drift), room) * 100) / 100;
            p.amount = Math.round((p.amount - toSub) * 100) / 100;
            p.rate = Math.round((p.amount / qty) * 100) / 100;
            drift = Math.round((drift + toSub) * 100) / 100;
          }
        }
      }

      if (Math.abs(drift) > 0.01) {
        for (const idx of indices) {
          const p = invoiceProducts[idx];
          const config = subset.find((pd) => pd.product_id === p.product_id);
          const minR = parseFloat(config.perDayRateMin);
          const maxR = parseFloat(config.perDayRateMax);

          const targetAmt = Math.round((p.amount + drift) * 100) / 100;
          const targetRate = Math.round((targetAmt / p.quantity) * 100) / 100;

          if (targetRate >= minR && targetRate <= maxR) {
            p.amount = targetAmt;
            p.rate = targetRate;
            drift = 0;
            break;
          }
        }
      }
    }

    const finalExactTotal = invoiceProducts.reduce(
      (sum, p) => sum + p.amount,
      0,
    );
    const invoiceNumber = `PI-2026-04-${String(invoiceCounter).padStart(4, "0")}`;

    invoices.push({
      invoice_number: invoiceNumber,
      invoice_date: invoiceDate,
      products: invoiceProducts,
      total_amount: finalExactTotal,
      customer_id: tgt.customerId,
    });

    invoiceCounter++;
  }

  return invoices;
}

// 3. Execute Verification
const generated = generatePurchaseInvoiceSplitups(mockBatch, 30);

// 4. Summarize Results and Print verification report
console.log(`\n--- Verification Report ---`);
console.log(`Total Invoices Generated: ${generated.length}`);

let calculatedTotalSum = 0;
let boundsFailure = false;
const productSelectionCounts = {};

for (const inv of generated) {
  calculatedTotalSum += inv.total_amount;
  if (
    inv.total_amount < mockBatch.minimum_invoice_amount ||
    inv.total_amount > mockBatch.maximum_invoice_amount
  ) {
    boundsFailure = true;
    console.error(
      `ERROR: Invoice ${inv.invoice_number} amount ₹${inv.total_amount} is out of bounds [${mockBatch.minimum_invoice_amount}, ${mockBatch.maximum_invoice_amount}]!`,
    );
  }
  for (const p of inv.products) {
    productSelectionCounts[p.product_name] =
      (productSelectionCounts[p.product_name] || 0) + 1;
  }
}

console.log(`Target Amount: ₹${mockBatch.total_amount}`);
console.log(`Generated Sum: ₹${calculatedTotalSum}`);
console.log(
  `Invoice Bounds Failure: ${boundsFailure ? "❌ FAILED" : "✅ PASSED"}`,
);
console.log(
  `Total Sum Matching: ${Math.abs(calculatedTotalSum - mockBatch.total_amount) < 0.01 ? "✅ MATCHED EXACTLY" : "❌ MISMATCHED"}`,
);

console.log(
  `\nProduct Selection Occurrences (out of ${generated.length} invoices):`,
);
for (const [prodName, count] of Object.entries(productSelectionCounts)) {
  const pct = Math.round((count / generated.length) * 100);
  console.log(`- ${prodName}: ${count} times (${pct}%)`);
}

console.log(`\nSample Invoices details (first 3):`);
for (let i = 0; i < Math.min(3, generated.length); i++) {
  const inv = generated[i];
  console.log(
    `\nInvoice: ${inv.invoice_number} | Date: ${inv.invoice_date} | Total Amount: ₹${inv.total_amount}`,
  );
  for (const p of inv.products) {
    console.log(
      `  * ${p.product_name} - Qty: ${p.quantity} | Rate: ₹${p.rate} | Amount: ₹${p.amount}`,
    );
  }
}
