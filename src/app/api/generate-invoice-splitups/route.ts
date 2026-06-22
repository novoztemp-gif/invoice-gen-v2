import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

type ProductConfig = {
  product_id: string;
  product_name: string;
  hsn_code: string;
  unit_of_measure: string;
  perDayQtyMin: string;
  perDayQtyMax: string;
  perDayRateMin: string;
  perDayRateMax: string;
};

type InvoiceBatch = {
  id: string;
  invoice_date_from: string;
  invoice_date_to: string;
  threshold_limit: number;
  total_amount: number;
  products: ProductConfig[];
};

export async function POST(request: NextRequest) {
  try {
    const { batchId } = await request.json();

    if (!batchId) {
      return NextResponse.json(
        { message: "Batch ID is required" },
        { status: 400 },
      );
    }

    const supabase = await createClient();

    // Fetch batch details
    const { data: batch, error: batchError } = await supabase
      .from("invoice_batch")
      .select("*")
      .eq("id", batchId)
      .single();

    if (batchError || !batch) {
      console.error("Batch fetch error:", batchError);
      return NextResponse.json({ message: "Batch not found" }, { status: 404 });
    }

    const typedBatch = batch as unknown as InvoiceBatch;

    if (!typedBatch.products || typedBatch.products.length === 0) {
      console.error("No products in batch:", batch);
      return NextResponse.json(
        {
          message:
            "No products found in batch. The products field may not have been saved. Please create a new batch after running the migration.",
        },
        { status: 400 },
      );
    }

    // Calculate number of days
    const fromDate = new Date(typedBatch.invoice_date_from);
    const toDate = new Date(typedBatch.invoice_date_to);
    const timeDiff = toDate.getTime() - fromDate.getTime();
    const numberOfDays = Math.ceil(timeDiff / (1000 * 3600 * 24)) + 1;

    // Get ALL invoice numbers to find the highest counter
    const { data: allInvoices } = await supabase
      .from("invoice")
      .select("invoice_number")
      .order("invoice_number", { ascending: false });

    let startingCounter = 1;

    if (allInvoices && allInvoices.length > 0) {
      // Extract all counters and find the maximum
      const counters = allInvoices
        .map((inv) => {
          const match = inv.invoice_number.match(/-(\d+)$/);
          return match ? parseInt(match[1], 10) : 0;
        })
        .filter((num) => !isNaN(num));

      if (counters.length > 0) {
        startingCounter = Math.max(...counters) + 1;
      }
    }

    console.log("Starting invoice counter at:", startingCounter);

    const invoices = generateInvoiceSplitups(
      typedBatch,
      numberOfDays,
      fromDate,
      startingCounter,
    );

    // Insert invoices (in chunks for safety)
    for (let i = 0; i < invoices.length; i += 100) {
      const chunk = invoices.slice(i, i + 100);
      const { error: insertError } = await supabase
        .from("invoice")
        .insert(chunk);
      if (insertError) {
        console.error("Error inserting invoices:", insertError);
        return NextResponse.json(
          { message: "Failed to save invoices" },
          { status: 500 },
        );
      }
    }

    // Update batch status
    const { error: updateError } = await supabase
      .from("invoice_batch")
      .update({ status: "generated" })
      .eq("id", batchId);

    if (updateError) {
      console.error("Error updating batch status:", updateError);
    }

    return NextResponse.json({
      message: `Successfully generated ${invoices.length} invoice(s)!`,
      count: invoices.length,
    });
  } catch (error) {
    console.error("Error generating invoice splitups:", error);
    return NextResponse.json(
      { message: "An error occurred while generating invoices" },
      { status: 500 },
    );
  }
}

function generateInvoiceSplitups(
  batch: InvoiceBatch,
  numberOfDays: number,
  startDate: Date,
  startingCounter: number = 1,
) {
  const invoices = [];
  const threshold = batch.threshold_limit;
  const totalAmount = batch.total_amount;
  const avgAmountPerDay = totalAmount / numberOfDays;
  let invoiceCounter = startingCounter;

  for (let day = 0; day < numberOfDays; day++) {
    const currentDate = new Date(startDate);
    currentDate.setDate(startDate.getDate() + day);
    const invoiceDate = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, "0")}-${String(currentDate.getDate()).padStart(2, "0")}`;

    let dayAmount = avgAmountPerDay;
    if (day === numberOfDays - 1) {
      const sumSoFar = avgAmountPerDay * (numberOfDays - 1);
      dayAmount = totalAmount - sumSoFar;
    }

    let remainingAmount = dayAmount;

    while (remainingAmount > 0.01) {
      const randomThresholdFactor = 0.7 + Math.random() * 0.25;
      const maxInvoiceAmount = threshold * randomThresholdFactor;

      const invoiceAmount = Math.min(remainingAmount, maxInvoiceAmount);
      const products = distributeAmountToProducts(
        batch.products,
        invoiceAmount,
      );

      const exactTotal =
        Math.round(products.reduce((sum, p) => sum + p.amount, 0) * 100) / 100;

      const invoiceNumber = `INV-${currentDate.getFullYear()}-${String(
        currentDate.getMonth() + 1,
      ).padStart(2, "0")}-${String(currentDate.getDate()).padStart(
        2,
        "0",
      )}-${String(invoiceCounter).padStart(4, "0")}`;

      invoices.push({
        invoice_batch_id: batch.id,
        invoice_number: invoiceNumber,
        invoice_date: invoiceDate,
        products,
        total_amount: exactTotal,
        status: "generated",
      });

      remainingAmount = Math.max(0, remainingAmount - exactTotal);
      invoiceCounter++;
    }
  }

  return invoices;
}

function distributeAmountToProducts(
  productConfigs: ProductConfig[],
  targetAmount: number,
) {
  const products: Array<{
    product_id: string;
    product_name: string;
    hsn_code: string;
    unit_of_measure: string;
    quantity: number;
    rate: number;
    amount: number;
  }> = [];

  if (!productConfigs || productConfigs.length === 0) {
    console.error("No product configs provided");
    return products;
  }

  const productData = productConfigs.map((config) => {
    const minQty = parseFloat(config.perDayQtyMin);
    const minRate = parseFloat(config.perDayRateMin);
    const maxQty = parseFloat(config.perDayQtyMax);
    const maxRate = parseFloat(config.perDayRateMax);

    return {
      config,
      minAmount: minQty * minRate,
      maxAmount: maxQty * maxRate,
      minQty,
      minRate,
      maxQty,
      maxRate,
    };
  });

  productData.sort((a, b) => a.minAmount - b.minAmount);

  const selectedProducts: typeof productData = [];
  let totalMin = 0;
  let totalMax = 0;

  for (const product of productData) {
    const potentialMin = totalMin + product.minAmount;
    const potentialMax = totalMax + product.maxAmount;
    if (
      totalMax < targetAmount ||
      (potentialMin <= targetAmount && potentialMax >= targetAmount)
    ) {
      selectedProducts.push(product);
      totalMin += product.minAmount;
      totalMax += product.maxAmount;
      if (totalMin <= targetAmount && totalMax >= targetAmount * 1.2) break;
    }
  }

  if (selectedProducts.length === 0 || totalMax < targetAmount) {
    selectedProducts.length = 0;
    selectedProducts.push(...productData);
    totalMin = productData.reduce((sum, p) => sum + p.minAmount, 0);
    totalMax = productData.reduce((sum, p) => sum + p.maxAmount, 0);
  }

  let totalAllocated = 0;

  selectedProducts.forEach((item, index) => {
    const isLast = index === selectedProducts.length - 1;
    let productTargetAmount: number;

    if (isLast) {
      productTargetAmount = targetAmount - totalAllocated;
    } else {
      const productRange = item.maxAmount - item.minAmount;
      const totalRange = totalMax - totalMin;
      if (totalRange > 0) {
        const proportion = productRange / totalRange;
        const randomAdjustment = 0.8 + Math.random() * 0.4;
        productTargetAmount =
          (item.minAmount + (targetAmount - totalMin) * proportion) *
          randomAdjustment;
      } else {
        productTargetAmount = targetAmount / selectedProducts.length;
      }
    }

    productTargetAmount = Math.max(
      item.minAmount,
      Math.min(item.maxAmount, productTargetAmount),
    );

    const qtyRange = item.maxQty - item.minQty;
    const qtyRandomFactor = Math.random();
    const randomQty = item.minQty + qtyRange * qtyRandomFactor;
    const quantity = Math.round(randomQty);

    const rateRange = item.maxRate - item.minRate;
    const rateRandomFactor = Math.random();
    let rate = item.minRate + rateRange * rateRandomFactor;

    let finalAmount = quantity * rate;

    if (!isLast) {
      if (finalAmount < item.minAmount || finalAmount > item.maxAmount) {
        const targetRate = productTargetAmount / quantity;
        rate = Math.max(item.minRate, Math.min(item.maxRate, targetRate));
        finalAmount = quantity * rate;
      }
    } else {
      rate = productTargetAmount / quantity;
      rate = Math.max(item.minRate, Math.min(item.maxRate, rate));
      finalAmount = quantity * rate;
    }

    products.push({
      product_id: item.config.product_id,
      product_name: item.config.product_name,
      hsn_code: item.config.hsn_code,
      unit_of_measure: item.config.unit_of_measure,
      quantity,
      rate: Math.round(rate * 100) / 100,
      amount: Math.round(finalAmount * 100) / 100,
    });

    totalAllocated += finalAmount;
  });

  const totalAfter = products.reduce((s, p) => s + p.amount, 0);
  const diff = Math.round((targetAmount - totalAfter) * 100) / 100;
  if (Math.abs(diff) > 0.01 && products.length > 0) {
    const last = products[products.length - 1];
    last.amount = Math.round((last.amount + diff) * 100) / 100;
    last.rate = Math.round((last.amount / last.quantity) * 100) / 100;
  }

  return products;
}
