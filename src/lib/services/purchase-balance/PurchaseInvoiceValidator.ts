import { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllInvoicesForBatch } from "@/lib/supabase/fetchAll";
import {
  computeLineAmount,
  isValidWholeNumber,
} from "@/lib/utils/quantity-rate-utils";
import {
  BALANCE_LIMITS,
  MONEY_TOLERANCE,
  normaliseCategory,
  ProductConstraint,
  PurchaseBalanceContext,
  PurchaseInvoice,
  PurchaseInvoiceUpdate,
  PurchaseLine,
  roundMoney,
} from "./types";

export class PurchaseInvoiceValidator {
  constructor(private readonly supabase: SupabaseClient) {}

  async loadContext(batchId: string): Promise<PurchaseBalanceContext> {
    const { data: batch, error: batchError } = await this.supabase
      .from("invoice_batch")
      .select("id, batch_type, batch_status, total_amount, supplier_id")
      .eq("id", batchId)
      .single();
    if (batchError || !batch) throw new Error("Purchase batch not found.");
    if (batch.batch_type !== "PURCHASE") {
      throw new Error(
        "Atomic auto balance is available only for purchase batches.",
      );
    }
    if (batch.batch_status === "FINALIZED") {
      throw new Error("Batch is finalized and read-only.");
    }
    if (!batch.supplier_id) {
      throw new Error(
        "Purchase batch must have one supplier before invoices can be edited.",
      );
    }

    const { data: supplier, error: supplierError } = await this.supabase
      .from("suppliers")
      .select("category")
      .eq("id", batch.supplier_id)
      .single();
    if (supplierError || !supplier?.category) {
      throw new Error("Selected supplier does not have a valid category.");
    }

    const invoices = (await fetchAllInvoicesForBatch(
      this.supabase,
      batchId,
    )) as PurchaseInvoice[];
    if (invoices.length === 0)
      throw new Error("Purchase batch has no invoices.");

    const productIds = new Set<string>();
    for (const invoice of invoices) {
      for (const line of invoice.products || [])
        productIds.add(line.product_id);
    }
    const [
      { data: rules, error: ruleError },
      { data: products, error: productError },
    ] = await Promise.all([
      this.supabase
        .from("product_rules")
        .select("product_id, quantity_min, quantity_max, rate_min, rate_max")
        .in("product_id", [...productIds]),
      this.supabase
        .from("products")
        .select("id, category, unit_of_measure")
        .in("id", [...productIds]),
    ]);
    if (ruleError)
      throw new Error(`Unable to load product rules: ${ruleError.message}`);
    if (productError)
      throw new Error(`Unable to load products: ${productError.message}`);

    const productMap = new Map(
      (products || []).map((product) => [product.id, product]),
    );
    const constraints = new Map<string, ProductConstraint>();
    for (const rule of rules || []) {
      const product = productMap.get(rule.product_id);
      if (!product) continue;
      constraints.set(rule.product_id, {
        productId: rule.product_id,
        category: normaliseCategory(product.category),
        unitOfMeasure: String(product.unit_of_measure || ""),
        quantityMin: Number(rule.quantity_min),
        quantityMax: Number(rule.quantity_max),
        rateMin: Number(rule.rate_min),
        rateMax: Number(rule.rate_max),
      });
    }
    if (constraints.size !== productIds.size) {
      throw new Error(
        "Every invoice product must have a product rule and product master.",
      );
    }

    return {
      batchId,
      batchTotal: Number(batch.total_amount),
      supplierCategory: normaliseCategory(supplier.category),
      invoices: invoices.map((invoice) => this.cloneInvoice(invoice)),
      constraints,
    };
  }

  normaliseEditedInvoice(
    original: PurchaseInvoice,
    update: PurchaseInvoiceUpdate,
    constraints: Map<string, ProductConstraint>,
  ): PurchaseInvoice {
    if (update.products.length !== original.products.length) {
      throw new Error("Product count is immutable during automatic balancing.");
    }
    const originalById = new Map(
      original.products.map((line) => [line.product_id, line]),
    );
    const seen = new Set<string>();
    const products = update.products.map((input) => {
      if (seen.has(input.product_id))
        throw new Error("Duplicate product lines are not permitted.");
      seen.add(input.product_id);
      const originalLine = originalById.get(input.product_id);
      const constraint = constraints.get(input.product_id);
      if (!originalLine || !constraint) {
        throw new Error("Product set is immutable during automatic balancing.");
      }
      const quantity = Number(input.quantity);
      const rate = Number(input.rate);
      return {
        ...originalLine,
        category: constraint.category,
        unit_of_measure: constraint.unitOfMeasure,
        quantity,
        rate,
        amount: computeLineAmount(quantity, rate),
      };
    });
    return {
      ...original,
      transport_mode: update.transport_mode ?? original.transport_mode,
      vehicle_number: update.vehicle_number ?? original.vehicle_number,
      date_of_supply: update.date_of_supply ?? original.date_of_supply,
      products,
      total_amount: roundMoney(
        products.reduce((sum, line) => sum + line.amount, 0),
      ),
    };
  }

  validateInvoice(
    invoice: PurchaseInvoice,
    context: Pick<PurchaseBalanceContext, "constraints" | "supplierCategory">,
  ) {
    if (!invoice.products.length)
      throw new Error("Invoice must contain at least one product.");
    if (invoice.products.length > BALANCE_LIMITS.maxInvoiceLines) {
      throw new Error(
        `Purchase invoices may contain at most ${BALANCE_LIMITS.maxInvoiceLines} products.`,
      );
    }
    const categories = new Set<string>();
    for (const line of invoice.products) {
      const constraint = context.constraints.get(line.product_id);
      if (!constraint)
        throw new Error(
          `Missing product rule for ${line.product_name || line.product_id}.`,
        );
      if (!this.isCommercialQuantity(Number(line.quantity), constraint)) {
        throw new Error(
          `Commercial quantity is invalid for ${line.product_name || line.product_id}.`,
        );
      }
      if (
        !isValidWholeNumber(Number(line.rate)) ||
        Number(line.rate) < constraint.rateMin ||
        Number(line.rate) > constraint.rateMax
      ) {
        throw new Error(
          `Rate is outside the allowed range for ${line.product_name || line.product_id}.`,
        );
      }
      if (
        Number(line.amount) <= 0 ||
        Math.abs(
          Number(line.amount) -
            computeLineAmount(Number(line.quantity), Number(line.rate)),
        ) > MONEY_TOLERANCE
      ) {
        throw new Error(
          `Line amount must equal quantity × rate for ${line.product_name || line.product_id}.`,
        );
      }
      categories.add(constraint.category);
    }
    if (categories.size !== 1)
      throw new Error("A purchase invoice must contain one category only.");
    if ([...categories][0] !== context.supplierCategory) {
      throw new Error(
        "Supplier category is incompatible with the invoice category.",
      );
    }
    const total = roundMoney(
      invoice.products.reduce((sum, line) => sum + Number(line.amount), 0),
    );
    if (total <= 0 || total !== roundMoney(Number(invoice.total_amount))) {
      throw new Error(
        "Invoice total must equal the sum of positive line amounts.",
      );
    }
  }

  validateBatch(invoices: PurchaseInvoice[], expectedTotal: number) {
    const total = roundMoney(
      invoices.reduce((sum, invoice) => sum + Number(invoice.total_amount), 0),
    );
    if (total !== roundMoney(expectedTotal)) {
      throw new Error(
        `Batch total mismatch: expected ₹${roundMoney(expectedTotal).toFixed(2)}, calculated ₹${total.toFixed(2)}.`,
      );
    }
  }

  isCommercialQuantity(quantity: number, constraint: ProductConstraint) {
    if (
      !Number.isFinite(quantity) ||
      quantity <= 0 ||
      quantity < constraint.quantityMin ||
      quantity > constraint.quantityMax
    )
      return false;
    const uom = constraint.unitOfMeasure.trim().toUpperCase();
    if (["KG", "KGS", "KILOGRAM", "KILOGRAMS"].includes(uom)) {
      if (constraint.quantityMax < 10)
        return (
          Math.abs(quantity * 4 - Math.round(quantity * 4)) < MONEY_TOLERANCE
        );
      return this.weightQuantities(constraint).includes(quantity);
    }
    if (["MT", "TON", "TONNE", "TONNES"].includes(uom)) {
      return (
        Math.abs(quantity * 4 - Math.round(quantity * 4)) < MONEY_TOLERANCE
      );
    }
    return Number.isInteger(quantity);
  }

  commercialQuantities(constraint: ProductConstraint, current: number) {
    const uom = constraint.unitOfMeasure.trim().toUpperCase();
    let values: number[];
    if (["KG", "KGS", "KILOGRAM", "KILOGRAMS"].includes(uom)) {
      values = this.weightQuantities(constraint);
    } else if (["MT", "TON", "TONNE", "TONNES"].includes(uom)) {
      const minQuarter = Math.ceil(constraint.quantityMin * 4) / 4;
      const maxQuarter = Math.floor(constraint.quantityMax * 4) / 4;
      values = [];
      for (let value = minQuarter; value <= maxQuarter; value += 0.25)
        values.push(roundMoney(value));
    } else {
      const min = Math.ceil(constraint.quantityMin);
      const max = Math.floor(constraint.quantityMax);
      values = [];
      for (let value = min; value <= max; value++) values.push(value);
    }
    return [
      ...new Set([
        current,
        constraint.quantityMin,
        constraint.quantityMax,
        ...values,
      ]),
    ]
      .filter((value) => this.isCommercialQuantity(value, constraint))
      .sort((a, b) => Math.abs(a - current) - Math.abs(b - current) || a - b)
      .slice(0, BALANCE_LIMITS.maxQuantityCandidates);
  }

  private weightQuantities(constraint: ProductConstraint) {
    const bases = [
      10, 12, 15, 18, 20, 25, 30, 35, 40, 45, 50, 60, 75, 80, 100, 125, 150,
      200, 250, 300, 400, 500, 750, 1000,
    ];
    if (constraint.quantityMax < 10) {
      const values: number[] = [];
      for (
        let value = Math.ceil(constraint.quantityMin * 4) / 4;
        value <= constraint.quantityMax;
        value += 0.25
      )
        values.push(roundMoney(value));
      return values;
    }
    return bases
      .flatMap((base) => [base, base + 0.25, base + 0.5, base + 0.75])
      .filter(
        (value) =>
          value >= constraint.quantityMin && value <= constraint.quantityMax,
      );
  }

  private cloneInvoice(invoice: PurchaseInvoice): PurchaseInvoice {
    return {
      ...invoice,
      products: invoice.products.map((line) => ({ ...line })),
    };
  }
}
