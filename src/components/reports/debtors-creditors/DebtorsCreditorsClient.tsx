"use client";

import { Download, X } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { GeneratingModal } from "@/components/GeneratingModal";
import { redistributeProportionally } from "@/lib/services/WorkbookSyncEngine";
import { redistributeExcludingLocked } from "@/lib/services/debtors-creditors/LockedRedistribution";
import {
  DebtorCreditorPerson,
  DebtorCreditorRoleResult,
  DebtorCreditorSourceData,
  PartnerCategory,
  PersonAmountEntry,
  SplitMode,
} from "@/lib/services/debtors-creditors/types";
import { summarizeKnockoff } from "@/lib/services/debtors-creditors/StockAllocationEngine";
import { triggerDownload } from "@/lib/utils";
import { SourceUploadPanel } from "./SourceUploadPanel";
import { UploadedDataAnnualTable } from "./UploadedDataAnnualTable";
import { MonthChips } from "./MonthChips";
import { PeoplePicker } from "./PeoplePicker";
import { PersonAmountEditor } from "./PersonAmountEditor";
import { StockAllocationResultsTable } from "./StockAllocationResultsTable";
import { KnockoffSummaryTable } from "./KnockoffSummaryTable";
import { ShortfallErrorPanel } from "./ShortfallErrorPanel";

function categoriesResolved(source: DebtorCreditorSourceData | null): boolean {
  return !!source && source.products.every((p) => p.category !== null);
}

export function DebtorsCreditorsClient({
  people,
}: {
  people: DebtorCreditorPerson[];
}) {
  const [generatingLabel, setGeneratingLabel] = useState<string | null>(null);

  // ---- Debtor state ----
  const [debtorSource, setDebtorSource] = useState<DebtorCreditorSourceData | null>(null);
  const [debtorMonths, setDebtorMonths] = useState<number[]>([]);
  const [debtorTotalAmount, setDebtorTotalAmount] = useState("");
  const [debtorMode, setDebtorMode] = useState<SplitMode>("random");
  const [debtorPersonIds, setDebtorPersonIds] = useState<string[]>([]);
  const [debtorAmounts, setDebtorAmounts] = useState<PersonAmountEntry[]>([]);
  const [debtorResult, setDebtorResult] = useState<DebtorCreditorRoleResult | null>(null);
  const [debtorShortfalls, setDebtorShortfalls] = useState<
    DebtorCreditorRoleResult["allocation"]["shortfalls"]
  >([]);
  const [debtorError, setDebtorError] = useState<string | null>(null);

  // ---- Creditor state ----
  const [creditorSource, setCreditorSource] = useState<DebtorCreditorSourceData | null>(null);
  const [creditorMonths, setCreditorMonths] = useState<number[]>([]);
  const [creditorTotalAmount, setCreditorTotalAmount] = useState("");
  const [creditorAmounts, setCreditorAmounts] = useState<PersonAmountEntry[]>([]);
  const [creditorResult, setCreditorResult] = useState<DebtorCreditorRoleResult | null>(null);
  const [creditorShortfalls, setCreditorShortfalls] = useState<
    DebtorCreditorRoleResult["allocation"]["shortfalls"]
  >([]);
  const [creditorError, setCreditorError] = useState<string | null>(null);

  const [downloadingKind, setDownloadingKind] = useState<string | null>(null);

  const debtorPeople = debtorPersonIds
    .map((id) => people.find((p) => p.id === id))
    .filter((p): p is DebtorCreditorPerson => !!p);

  // ---- Debtor handlers ----
  const handleDebtorCategoryChange = (productIndex: number, category: PartnerCategory) => {
    if (!debtorSource) return;
    setDebtorSource({
      ...debtorSource,
      products: debtorSource.products.map((p, idx) =>
        idx === productIndex ? { ...p, category, categorySource: "manual" } : p,
      ),
    });
  };

  const recomputeDebtorAmounts = (total: number, personIds: string[]) => {
    if (personIds.length === 0) {
      setDebtorAmounts([]);
      return;
    }
    if (debtorMode === "actual") {
      setDebtorAmounts(personIds.map((id) => ({ personId: id, locked: false, amount: 0 })));
      return;
    }
    const items = personIds.map((id) => ({ id, locked: false, value: 0 }));
    const result = redistributeExcludingLocked(items, total);
    setDebtorAmounts(
      personIds.map((id, i) => ({
        personId: id,
        locked: false,
        amount: result.values[i].value,
      })),
    );
  };

  const handleDebtorTotalChange = (value: string) => {
    setDebtorTotalAmount(value);
    const total = Number(value) || 0;
    recomputeDebtorAmounts(total, debtorPersonIds);
  };

  const handleDebtorModeChange = (mode: SplitMode) => {
    setDebtorMode(mode);
    const total = Number(debtorTotalAmount) || 0;
    if (mode === "actual") {
      setDebtorAmounts(
        debtorPersonIds.map((id) => ({ personId: id, locked: false, amount: 0 })),
      );
    } else {
      const items = debtorPersonIds.map((id) => ({ id, locked: false, value: 0 }));
      const result = redistributeExcludingLocked(items, total);
      setDebtorAmounts(
        debtorPersonIds.map((id, i) => ({
          personId: id,
          locked: false,
          amount: result.values[i].value,
        })),
      );
    }
  };

  const handleDebtorPeopleChange = (newIds: string[]) => {
    setDebtorPersonIds(newIds);
    const total = Number(debtorTotalAmount) || 0;

    if (debtorMode === "actual") {
      setDebtorAmounts(
        newIds.map((id) => {
          const existing = debtorAmounts.find((e) => e.personId === id);
          return existing ?? { personId: id, locked: false, amount: 0 };
        }),
      );
      return;
    }

    const items = newIds.map((id) => {
      const existing = debtorAmounts.find((e) => e.personId === id);
      return existing
        ? { id, locked: existing.locked, value: existing.amount }
        : { id, locked: false, value: 0 };
    });
    const result = redistributeExcludingLocked(items, total);
    setDebtorAmounts(
      newIds.map((id, i) => {
        const existing = debtorAmounts.find((e) => e.personId === id);
        return {
          personId: id,
          locked: existing?.locked ?? false,
          amount: result.values[i].value,
        };
      }),
    );
  };

  const debtorActualSum = debtorAmounts.reduce((s, e) => s + (e.amount || 0), 0);
  const debtorTotalNum = Number(debtorTotalAmount) || 0;
  const debtorFormValid =
    !!debtorSource &&
    categoriesResolved(debtorSource) &&
    debtorTotalNum > 0 &&
    debtorMonths.length > 0 &&
    debtorPersonIds.length > 0 &&
    (debtorMode === "random" || Math.abs(debtorActualSum - debtorTotalNum) < 0.01);

  const handleDebtorGenerate = async () => {
    if (!debtorSource || !debtorFormValid) return;
    setDebtorError(null);
    setDebtorShortfalls([]);
    setGeneratingLabel("Allocating debtor stock");
    try {
      const response = await fetch("/api/reports/debtors-creditors/allocate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          role: "debtor",
          source: debtorSource,
          people: debtorPeople,
          selectedMonthIndices: debtorMonths,
          personAmounts: debtorAmounts,
        }),
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json?.message || "Failed to generate.");

      if (!json.ok) {
        setDebtorShortfalls(json.shortfalls);
        return;
      }

      setDebtorResult({
        source: debtorSource,
        selectedMonthIndices: debtorMonths,
        totalAmount: debtorTotalNum,
        personAmounts: debtorAmounts,
        allocation: json,
      });
    } catch (err: any) {
      setDebtorError(err?.message || "Something went wrong.");
    } finally {
      setGeneratingLabel(null);
    }
  };

  // ---- Creditor handlers ----
  const handleCreditorCategoryChange = (productIndex: number, category: PartnerCategory) => {
    if (!creditorSource) return;
    setCreditorSource({
      ...creditorSource,
      products: creditorSource.products.map((p, idx) =>
        idx === productIndex ? { ...p, category, categorySource: "manual" } : p,
      ),
    });
  };

  const handleCreditorTotalChange = (value: string) => {
    setCreditorTotalAmount(value);
    const total = Number(value) || 0;
    if (!debtorResult || debtorPersonIds.length === 0) {
      setCreditorAmounts([]);
      return;
    }
    // Pre-edit starting point: each person's final debtor amount, scaled
    // proportionally to the new creditor total — no independent noise —
    // so equal totals produce identical per-person amounts, matching the
    // client's own explicit example.
    const weights = debtorPersonIds.map(
      (id) => debtorResult.personAmounts.find((e) => e.personId === id)?.amount ?? 0,
    );
    const scaled = redistributeProportionally(weights, total, 1);
    setCreditorAmounts(
      debtorPersonIds.map((id, i) => ({ personId: id, locked: false, amount: scaled[i] })),
    );
  };

  const creditorTotalNum = Number(creditorTotalAmount) || 0;
  const creditorFormValid =
    !!creditorSource &&
    categoriesResolved(creditorSource) &&
    creditorTotalNum > 0 &&
    creditorMonths.length > 0 &&
    debtorPersonIds.length > 0;

  const handleCreditorGenerate = async () => {
    if (!creditorSource || !creditorFormValid || !debtorResult) return;
    setCreditorError(null);
    setCreditorShortfalls([]);
    setGeneratingLabel("Allocating creditor stock");
    try {
      const excludedHsnByPerson: Record<string, string[]> = {};
      for (const id of debtorPersonIds) {
        excludedHsnByPerson[id] = debtorResult.allocation.lines
          .filter((l) => l.personId === id)
          .map((l) => l.hsnCode.trim());
      }

      const response = await fetch("/api/reports/debtors-creditors/allocate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          role: "creditor",
          source: creditorSource,
          people: debtorPeople,
          selectedMonthIndices: creditorMonths,
          personAmounts: creditorAmounts,
          excludedHsnByPerson,
        }),
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json?.message || "Failed to generate.");

      if (!json.ok) {
        setCreditorShortfalls(json.shortfalls);
        return;
      }

      setCreditorResult({
        source: creditorSource,
        selectedMonthIndices: creditorMonths,
        totalAmount: creditorTotalNum,
        personAmounts: creditorAmounts,
        allocation: json,
      });
    } catch (err: any) {
      setCreditorError(err?.message || "Something went wrong.");
    } finally {
      setGeneratingLabel(null);
    }
  };

  const handleDownload = async (kind: "debtor" | "creditor" | "combined") => {
    if (!debtorResult) return;
    if (kind === "creditor" && !creditorResult) return;
    if (kind === "combined" && !creditorResult) return;

    setDownloadingKind(kind);
    try {
      const filenames = {
        debtor: `Debtors_FY_${debtorResult.source.financialYear}.xlsx`,
        creditor: `Creditors_FY_${creditorResult?.source.financialYear}.xlsx`,
        combined: `Debtors_and_Creditors.xlsx`,
      };
      await triggerDownload(
        "/api/reports/debtors-creditors/download",
        filenames[kind],
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind,
            debtor: debtorResult,
            creditor: creditorResult ?? undefined,
            people: debtorPeople,
          }),
        },
      );
    } finally {
      setDownloadingKind(null);
    }
  };

  const handleResetAll = () => {
    setDebtorSource(null);
    setDebtorMonths([]);
    setDebtorTotalAmount("");
    setDebtorMode("random");
    setDebtorPersonIds([]);
    setDebtorAmounts([]);
    setDebtorResult(null);
    setDebtorShortfalls([]);
    setDebtorError(null);
    setCreditorSource(null);
    setCreditorMonths([]);
    setCreditorTotalAmount("");
    setCreditorAmounts([]);
    setCreditorResult(null);
    setCreditorShortfalls([]);
    setCreditorError(null);
  };

  const knockoffSummary =
    debtorResult && creditorResult
      ? summarizeKnockoff(debtorPeople, debtorResult.allocation.lines, creditorResult.allocation.lines)
      : [];

  return (
    <div className="p-6 max-w-[1400px] mx-auto space-y-8">
      <GeneratingModal open={!!generatingLabel} label={generatingLabel ?? "Working"} />

      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-slate-900">Debtors &amp; Creditors</h1>
        {(debtorSource || creditorSource) && (
          <Button variant="ghost" size="icon" onClick={handleResetAll} title="Start over">
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>

      {(debtorResult || creditorResult) && (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={!debtorResult || downloadingKind === "debtor"}
            onClick={() => handleDownload("debtor")}
          >
            <Download className="h-4 w-4" />
            Debtor Excel
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={!creditorResult || downloadingKind === "creditor"}
            onClick={() => handleDownload("creditor")}
          >
            <Download className="h-4 w-4" />
            Creditor Excel
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={!creditorResult || downloadingKind === "combined"}
            onClick={() => handleDownload("combined")}
          >
            <Download className="h-4 w-4" />
            Debtor &amp; Creditor Excel
          </Button>
        </div>
      )}

      {/* Debtor upload */}
      {!debtorSource && (
        <SourceUploadPanel
          title="Debtors — Upload Monthly Split-up"
          description="Upload the Excel downloaded from Monthly Split-up for the financial year debtors are based on (sales-driven)."
          inputId="debtor-file"
          onGenerating={setGeneratingLabel}
          onGenerated={() => setGeneratingLabel(null)}
          onUploaded={setDebtorSource}
        />
      )}

      {debtorSource && (
        <div className="space-y-6">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <h2 className="text-sm font-semibold text-slate-700">
                Uploaded Data — FY {debtorSource.financialYear}
              </h2>
              <Badge variant="secondary">Debtors</Badge>
            </div>
            <UploadedDataAnnualTable
              products={debtorSource.products}
              onCategoryChange={handleDebtorCategoryChange}
            />
          </div>

          {categoriesResolved(debtorSource) && (
            <div className="border border-slate-200 rounded-xl p-6 space-y-5 bg-white">
              <h2 className="text-base font-semibold text-slate-900">Debtor Details</h2>

              <div className="space-y-2 max-w-xs">
                <Label>Total Debt Amount</Label>
                <Input
                  type="number"
                  min={0}
                  value={debtorTotalAmount}
                  onChange={(e) => handleDebtorTotalChange(e.target.value)}
                />
              </div>

              <div className="space-y-2">
                <Label>Months (FY {debtorSource.financialYear})</Label>
                <MonthChips
                  months={debtorSource.months}
                  selected={debtorMonths}
                  onChange={setDebtorMonths}
                />
              </div>

              <div className="space-y-2">
                <Label>Split-up Type</Label>
                <div className="inline-flex rounded-lg border border-slate-200 p-0.5 bg-slate-50">
                  <Button
                    type="button"
                    size="sm"
                    variant={debtorMode === "random" ? "default" : "ghost"}
                    className="rounded-md"
                    onClick={() => handleDebtorModeChange("random")}
                  >
                    Random Split-up
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={debtorMode === "actual" ? "default" : "ghost"}
                    className="rounded-md"
                    onClick={() => handleDebtorModeChange("actual")}
                  >
                    Actual Data Split-up
                  </Button>
                </div>
              </div>

              <div className="space-y-2">
                <Label>Select Suppliers</Label>
                <PeoplePicker
                  people={people}
                  selectedIds={debtorPersonIds}
                  onChange={handleDebtorPeopleChange}
                />
              </div>

              {debtorPersonIds.length > 0 && (
                <div className="space-y-2">
                  <Label>Amount Split</Label>
                  <PersonAmountEditor
                    mode={debtorMode}
                    people={debtorPeople}
                    totalAmount={debtorTotalNum}
                    entries={debtorAmounts}
                    onChange={setDebtorAmounts}
                  />
                </div>
              )}

              {debtorError && (
                <div className="p-3.5 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
                  {debtorError}
                </div>
              )}
              <ShortfallErrorPanel shortfalls={debtorShortfalls} />

              <Button disabled={!debtorFormValid} onClick={handleDebtorGenerate}>
                Generate
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Debtor results */}
      {debtorResult && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-slate-700">
            Debtor Allocation — FY {debtorResult.source.financialYear}
          </h2>
          <StockAllocationResultsTable
            people={debtorPeople}
            lines={debtorResult.allocation.lines}
          />
        </div>
      )}

      {/* Creditor upload */}
      {debtorResult && !creditorSource && (
        <SourceUploadPanel
          title="Creditors — Upload Monthly Split-up"
          description="Upload the Excel downloaded from Monthly Split-up for a different (later) financial year — creditors are based on purchase data."
          inputId="creditor-file"
          onGenerating={setGeneratingLabel}
          onGenerated={() => setGeneratingLabel(null)}
          onUploaded={setCreditorSource}
        />
      )}

      {creditorSource && (
        <div className="space-y-6">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <h2 className="text-sm font-semibold text-slate-700">
                Uploaded Data — FY {creditorSource.financialYear}
              </h2>
              <Badge variant="secondary">Creditors</Badge>
            </div>
            <UploadedDataAnnualTable
              products={creditorSource.products}
              onCategoryChange={handleCreditorCategoryChange}
            />
          </div>

          {categoriesResolved(creditorSource) && (
            <div className="border border-slate-200 rounded-xl p-6 space-y-5 bg-white">
              <h2 className="text-base font-semibold text-slate-900">Creditor Details</h2>

              <div className="space-y-2 max-w-xs">
                <Label>Total Creditor Amount</Label>
                <Input
                  type="number"
                  min={0}
                  value={creditorTotalAmount}
                  onChange={(e) => handleCreditorTotalChange(e.target.value)}
                />
              </div>

              <div className="space-y-2">
                <Label>Months (FY {creditorSource.financialYear})</Label>
                <MonthChips
                  months={creditorSource.months}
                  selected={creditorMonths}
                  onChange={setCreditorMonths}
                />
              </div>

              <div className="space-y-2">
                <Label>Suppliers (same as Debtors)</Label>
                <div className="flex flex-wrap gap-1.5">
                  {debtorPeople.map((p) => (
                    <Badge key={p.id} variant="secondary">
                      {p.companyName} <span className="text-slate-400 ml-1">({p.category})</span>
                    </Badge>
                  ))}
                </div>
              </div>

              {creditorAmounts.length > 0 && (
                <div className="space-y-2">
                  <Label>Amount Split (Random)</Label>
                  <PersonAmountEditor
                    mode="random"
                    people={debtorPeople}
                    totalAmount={creditorTotalNum}
                    entries={creditorAmounts}
                    onChange={setCreditorAmounts}
                  />
                </div>
              )}

              {creditorError && (
                <div className="p-3.5 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
                  {creditorError}
                </div>
              )}
              <ShortfallErrorPanel shortfalls={creditorShortfalls} />

              <Button disabled={!creditorFormValid} onClick={handleCreditorGenerate}>
                Generate
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Creditor results + combined knockoff */}
      {creditorResult && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-slate-700">
            Creditor Allocation — FY {creditorResult.source.financialYear}
          </h2>
          <StockAllocationResultsTable
            people={debtorPeople}
            lines={creditorResult.allocation.lines}
          />
        </div>
      )}

      {debtorResult && creditorResult && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-slate-700">Knockoff Summary</h2>
          <KnockoffSummaryTable
            summary={knockoffSummary}
            debtorFinancialYear={debtorResult.source.financialYear}
            creditorFinancialYear={creditorResult.source.financialYear}
          />
        </div>
      )}
    </div>
  );
}
