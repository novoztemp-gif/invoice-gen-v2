# Phase 1: Purchase Invoice Editing and Atomic Auto Balance

## Scope

This is the approved Phase 1 contract. It applies only to editable purchase
invoices before purchase-batch finalisation. It does not post inventory, alter
sales, update the daily stock ledger, change reporting, or change exports.

## Immutable fields

Automatic balancing must never change an invoice's supplier, category, product
set, product count, product identity, HSN, UOM, invoice date, invoice number,
party allocation, or transport details. It may change only existing product
quantities, existing product rates, derived line amounts, and invoice totals.

## Deterministic ordering

Invoice tie-break order is exactly:

1. `invoice_date` ascending;
2. `invoice_number` ascending;
3. `id` ascending.

Line tie-break order is exactly:

1. `product_name` ascending;
2. `product_id` ascending.

Candidate ties use the same order. No random value, database return order, or
wall-clock value participates in planning.

## Commercial quantity policy

The product's configured min/max values always apply. A quantity must also be
positive and valid for its UOM.

| UOM family | Recognised values | Valid commercial quantities |
| --- | --- | --- |
| Weight | `KG`, `KGS`, `KILOGRAM`, `KILOGRAMS` | Wholesale base steps `10, 12, 15, 18, 20, 25, 30, 35, 40, 45, 50, 60, 75, 80, 100, 125, 150, 200, 250, 300, 400, 500, 750, 1000`, plus `.25`, `.50`, and `.75` variants when inside product rules. If the product maximum is below 10, quarter increments inside its explicit rule range are permitted. |
| Tonnage | `MT`, `TON`, `TONNE`, `TONNES` | Whole commercial base steps above, divided by 1000 where applicable, plus quarter-ton increments only when explicitly allowed by product min/max. |
| Count/package | `BAG`, `BAGS`, `PIECE`, `PIECES`, `PCS`, `BOX`, `BOXES`, `CARTON`, `CARTONS`, `PACK`, `PACKS`, `UNIT`, `UNITS` | Positive whole integers only. Candidate values are the current quantity, the configured bounds, and nearby whole-number values. |
| Unknown UOM | Any other value | Positive whole integers only. Auto-balance does not create fractional quantities for an unknown UOM. |

The Phase 1 engine never creates a line below 10 KG for a normal weight
product. A sub-10 quantity is allowed only when that product rule explicitly
sets `quantity_max < 10`.

## Fixed adjustment cost weights

All costs are integer points and are frozen for Phase 1.

| Cost component | Weight |
| --- | ---: |
| Changed invoice | 100 |
| Changed product line | 20 |
| One commercial quantity step away from current quantity | 10 |
| One whole-rupee rate away from current rate | 2 |
| Candidate at quantity minimum or maximum | 25 |
| Candidate at rate minimum or maximum | 25 |

The planner compares lower total cost first. This means a one-rupee rate repair
is cheaper than moving one wholesale quantity step, while a material rate
distortion becomes more expensive than the nearest commercial quantity move.

## Candidate limits and performance constants

These constants are frozen for Phase 1.

| Constant | Value |
| --- | ---: |
| Maximum invoice lines accepted by balance engine | 8 |
| Maximum quantity candidates per line | 12 |
| Maximum rate candidates per quantity | 5 |
| Maximum valid line candidates retained | 24 |
| Maximum invoice candidates retained | 16 |
| Maximum dynamic-programming states | 20,000 |
| Residual-repair invoices | 3 |
| Maximum residual-repair combinations | 4,096 |
| Planner time budget | 2 seconds |

If a limit or time budget is reached, the request is rejected without saving
anything with a `search capacity exceeded` error. That error is deliberately
different from `no valid rebalance exists`.

## Quantity-first candidate strategy

For every existing line, the generator:

1. creates valid commercial quantity candidates;
2. calculates whole-number rate candidates for each quantity;
3. derives amount as `round(quantity × rate)`;
4. rejects candidates outside product rules;
5. scores valid candidates using the fixed cost table.

Products are never added, removed, substituted, or moved between invoices.

## Solver and residual repair

The solver uses a deterministic dynamic-programming map:

`amount delta -> lowest-cost plan`.

For every invoice it combines retained invoice candidates, retaining the
lowest-cost plan for each exact amount delta. The final three eligible invoices
are then exhaustively checked within the frozen residual-repair bound to close
the remaining exact rupee difference.

Results have three distinct outcomes:

- **solution found**: all validations pass and the batch total is exact;
- **no valid solution**: the complete approved candidate universe was searched
  within the limits and no exact plan exists;
- **search capacity exceeded**: the bounded search stopped; no claim is made
  about mathematical feasibility, and no data is saved.

## Module boundaries

| Module | Responsibility |
| --- | --- |
| `PurchaseInvoiceValidator` | Load/validate purchase batch, immutable fields, product rules, category and supplier compatibility. |
| `BalanceCandidateGenerator` | Generate and score quantity-first line and invoice candidates. |
| `DeterministicBalanceSolver` | Combine invoice candidates into a lowest-cost exact batch plan. |
| `ResidualRepair` | Exhaustively repair the final exact rupee residual within its frozen bound. |
| `PurchaseBalanceFinalValidator` | Revalidate all invoices, product preservation, and exact batch total. |
| `PurchaseBalancePersistence` | Acquire/release application lock and invoke the one atomic database RPC. |
| `AutoBalanceEngine` | Thin orchestration facade; it contains no independent balancing logic. |

## Atomicity

The complete balance plan is validated before persistence. The database RPC
locks the batch row, writes the edited invoice and balance updates, verifies
the exact batch total, then commits. Any database error rolls back every write.
