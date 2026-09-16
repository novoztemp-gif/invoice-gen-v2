"use client";

import { Check, Pencil, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { redistributeExcludingLocked } from "@/lib/services/debtors-creditors/LockedRedistribution";
import {
  DebtorCreditorPerson,
  PersonAmountEntry,
  SplitMode,
} from "@/lib/services/debtors-creditors/types";

interface PersonAmountEditorProps {
  mode: SplitMode;
  people: DebtorCreditorPerson[];
  totalAmount: number;
  entries: PersonAmountEntry[];
  onChange: (entries: PersonAmountEntry[]) => void;
  disabled?: boolean;
}

function formatAmount(n: number) {
  return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function PersonAmountEditor({
  mode,
  people,
  totalAmount,
  entries,
  onChange,
  disabled,
}: PersonAmountEditorProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftValue, setDraftValue] = useState("");

  const entryFor = (personId: string) =>
    entries.find((e) => e.personId === personId) ?? { personId, locked: false, amount: 0 };

  const startEdit = (personId: string) => {
    setEditingId(personId);
    setDraftValue(String(entryFor(personId).amount || ""));
  };

  const confirmEdit = (personId: string) => {
    const typed = Number(draftValue);
    if (!Number.isFinite(typed) || typed < 0) {
      setEditingId(null);
      return;
    }
    const items = entries.map((e) => ({
      id: e.personId,
      locked: e.personId === personId ? true : e.locked,
      value: e.personId === personId ? typed : e.amount,
    }));
    const result = redistributeExcludingLocked(items, totalAmount);
    onChange(
      entries.map((e) => {
        const v = result.values.find((x) => x.id === e.personId)!.value;
        return {
          ...e,
          locked: e.personId === personId ? true : e.locked,
          amount: v,
        };
      }),
    );
    setEditingId(null);
  };

  const unlock = (personId: string) => {
    const items = entries.map((e) => ({
      id: e.personId,
      locked: e.personId === personId ? false : e.locked,
      value: e.amount,
    }));
    const result = redistributeExcludingLocked(items, totalAmount);
    onChange(
      entries.map((e) => {
        const v = result.values.find((x) => x.id === e.personId)!.value;
        return {
          ...e,
          locked: e.personId === personId ? false : e.locked,
          amount: v,
        };
      }),
    );
  };

  const handleActualChange = (personId: string, raw: string) => {
    const typed = Number(raw);
    onChange(
      entries.map((e) =>
        e.personId === personId
          ? { ...e, amount: Number.isFinite(typed) ? typed : 0 }
          : e,
      ),
    );
  };

  const actualSum = entries.reduce((s, e) => s + (e.amount || 0), 0);
  const actualMatches = Math.abs(actualSum - totalAmount) < 0.005;

  return (
    <div className="space-y-2">
      <div className="divide-y divide-slate-100 border border-slate-200 rounded-lg overflow-hidden">
        {people.map((person) => {
          const entry = entryFor(person.id);
          const isEditing = editingId === person.id;

          return (
            <div
              key={person.id}
              className="flex items-center justify-between gap-3 px-3 py-2 bg-white"
            >
              <div className="min-w-0">
                <div className="text-sm font-medium text-slate-900 truncate">
                  {person.companyName}
                </div>
                <div className="text-xs text-slate-400">{person.category}</div>
              </div>

              {mode === "random" ? (
                isEditing ? (
                  <div className="flex items-center gap-1.5">
                    <Input
                      type="number"
                      min={0}
                      autoFocus
                      value={draftValue}
                      onChange={(e) => setDraftValue(e.target.value)}
                      className="h-8 w-28"
                    />
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8"
                      onClick={() => confirmEdit(person.id)}
                    >
                      <Check className="h-4 w-4 text-green-600" />
                    </Button>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8"
                      onClick={() => setEditingId(null)}
                    >
                      <X className="h-4 w-4 text-slate-400" />
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium tabular-nums">
                      ₹{formatAmount(entry.amount)}
                    </span>
                    {entry.locked && (
                      <span className="text-[10px] uppercase tracking-wide text-slate-400">
                        locked
                      </span>
                    )}
                    {!disabled && (
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        onClick={() =>
                          entry.locked ? unlock(person.id) : startEdit(person.id)
                        }
                        title={entry.locked ? "Unlock (back to auto)" : "Edit"}
                      >
                        <Pencil className="h-3.5 w-3.5 text-slate-500" />
                      </Button>
                    )}
                  </div>
                )
              ) : (
                <Input
                  type="number"
                  min={0}
                  disabled={disabled}
                  value={entry.amount || ""}
                  onChange={(e) => handleActualChange(person.id, e.target.value)}
                  className="h-8 w-32"
                  placeholder="0.00"
                />
              )}
            </div>
          );
        })}
      </div>

      {mode === "actual" && (
        <div className="flex items-center justify-between text-sm px-1">
          <span className="text-slate-500">Running total</span>
          <span
            className={cn(
              "font-semibold tabular-nums",
              actualMatches ? "text-green-600" : "text-red-600",
            )}
          >
            ₹{formatAmount(actualSum)} / ₹{formatAmount(totalAmount)}
          </span>
        </div>
      )}
    </div>
  );
}
