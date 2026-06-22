import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

type Product = {
  id: string;
  product_name: string;
  hsn_code: string;
  unit_of_measure: string;
};

type SelectedProductItem = {
  product: Product;
  perDayQtyMin: string;
  perDayQtyMax: string;
  perDayRateMin: string;
  perDayRateMax: string;
};

type ValidationRequest = {
  products: SelectedProductItem[];
  invoiceDateFrom: string; 
  invoiceDateTo: string; 
  thresholdLimit: string;
  totalAmount: string;
};

export async function POST(request: NextRequest) {
  try {
    const body: ValidationRequest = await request.json();

    const {
      products,
      invoiceDateFrom,
      invoiceDateTo,
      thresholdLimit,
      totalAmount,
    } = body;

    const fromDate = new Date(invoiceDateFrom);
    const toDate = new Date(invoiceDateTo);

    const timeDiff = toDate.getTime() - fromDate.getTime();
    const numberOfDays = Math.ceil(timeDiff / (1000 * 3600 * 24)) + 1;

    if (numberOfDays <= 0) {
      return NextResponse.json({
        isValid: false,
        message: "Invalid date range. 'From Date' must be before or equal to 'To Date'.",
      });
    }

    const threshold = parseFloat(thresholdLimit);
    const total = parseFloat(totalAmount);

    // Validation 1: Check if we have at least one product
    if (products.length === 0) {
      return NextResponse.json({
        isValid: false,
        message: "No products selected. Please add at least one product.",
      });
    }

    // Calculate minimum and maximum possible amounts per day
    // Find the smallest single product minimum (for smallest invoice possible)
    let smallestProductMin = Number.POSITIVE_INFINITY;
    let maxAmountPerDay = 0;

    for (const product of products) {
      const qtyMin = parseFloat(product.perDayQtyMin);
      const qtyMax = parseFloat(product.perDayQtyMax);
      const rateMin = parseFloat(product.perDayRateMin);
      const rateMax = parseFloat(product.perDayRateMax);

      // Minimum amount for this single product (smallest possible invoice)
      const productMinAmount = qtyMin * rateMin;
      if (productMinAmount < smallestProductMin) {
        smallestProductMin = productMinAmount;
      }

      // Maximum amount for this product per day (using max qty and max rate)
      maxAmountPerDay += qtyMax * rateMax;
    }

    // Validation 2: Check if threshold can accommodate at least one product
    // (An invoice doesn't need all products, just needs to fit within threshold)
    if (smallestProductMin > threshold) {
      return NextResponse.json({
        isValid: false,
        message: `Threshold limit (₹${threshold.toFixed(2)}) is too small! Even the smallest product requires at least ₹${smallestProductMin.toFixed(2)} per day. Increase the threshold limit.`,
      });
    }

    // Validation 3: Calculate maximum total possible
    const maxTotalPossible = maxAmountPerDay * numberOfDays;

    // Check if total amount exceeds maximum possible
    if (total > maxTotalPossible) {
      return NextResponse.json({
        isValid: false,
        message: `Total amount (₹${total.toFixed(2)}) exceeds maximum possible! Maximum amount achievable for ${numberOfDays} day(s) is ₹${maxTotalPossible.toFixed(2)} (₹${maxAmountPerDay.toFixed(2)} per day maximum).`,
      });
    }

    // Validation 4: Check basic feasibility
    // Average amount per day
    const avgAmountPerDay = total / numberOfDays;
    
    // Check if average exceeds maximum possible per day
    if (avgAmountPerDay > maxAmountPerDay) {
      return NextResponse.json({
        isValid: false,
        message: `Average amount per day (₹${avgAmountPerDay.toFixed(2)}) exceeds maximum possible (₹${maxAmountPerDay.toFixed(2)}). Cannot generate invoices for all ${numberOfDays} day(s).`,
      });
    }

    // Estimate number of invoices needed per day (rough estimate)
    const estimatedInvoicesPerDay = Math.ceil(avgAmountPerDay / threshold);
    const totalInvoicesEstimated = estimatedInvoicesPerDay * numberOfDays;

    // All validations passed!
    return NextResponse.json({
      isValid: true,
      message: `✓ Validation successful! Estimated ${estimatedInvoicesPerDay}+ invoice(s) per day over ${numberOfDays} day(s).`,
      details: {
        numberOfDays,
        smallestProductMin: smallestProductMin.toFixed(2),
        maxAmountPerDay: maxAmountPerDay.toFixed(2),
        avgAmountPerDay: avgAmountPerDay.toFixed(2),
        estimatedInvoices: totalInvoicesEstimated,
        threshold: threshold.toFixed(2),
      },
    });
  } catch (error) {
    console.error("Validation error:", error);
    return NextResponse.json(
      {
        isValid: false,
        message: "An error occurred during validation. Please check your inputs.",
      },
      { status: 500 }
    );
  }
}
