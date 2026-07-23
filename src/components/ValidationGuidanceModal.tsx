"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AlertTriangle, Lightbulb, Users, Sliders } from "lucide-react";

export interface ValidationGuidanceData {
  title: string;
  reason: string;
  partyTerm: string; // "Suppliers" or "Receiving Customers"
  singlePartyTerm: string; // "Supplier" or "Receiving Customer"
  numberOfDays: number;
  totalAmount: number;
  minAmount: number;
  maxAmount: number;
  avgAmount: number;
  estimatedRequiredInvoices: number;
  availableCustomers: number;
  maxCapacity: number;
  deficitCustomers: number;
  requiredCustomersCount: number;
  suggestedMin: number;
  suggestedMax: number;
}

interface ValidationGuidanceModalProps {
  data: ValidationGuidanceData | null;
  onClose: () => void;
  onApplySuggestedLimits?: (suggestedMin: number, suggestedMax: number) => void;
}

export function ValidationGuidanceModal({
  data,
  onClose,
  onApplySuggestedLimits,
}: ValidationGuidanceModalProps) {
  if (!data) return null;

  return (
    <Dialog open={Boolean(data)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto bg-white text-slate-900 border border-slate-200">
        <DialogHeader className="pb-2 border-b border-slate-100">
          <DialogTitle className="flex items-center gap-2 text-base font-bold text-amber-600">
            <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0" />
            {data.title}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 pt-2 text-xs">
          {/* Reason Block */}
          <div className="bg-amber-50 border border-amber-200 p-3 rounded-lg text-slate-800 space-y-1">
            <p className="font-semibold text-amber-900">
              Daily Billing Limit Exceeded
            </p>
            <p className="text-slate-700 leading-relaxed">{data.reason}</p>
          </div>

          {/* Configuration Breakdown */}
          <div className="bg-slate-50 border border-slate-200 p-3.5 rounded-lg space-y-2">
            <p className="font-bold text-slate-800 uppercase tracking-wider text-[11px]">
              Generation Capacity vs Required Invoices
            </p>
            <div className="grid grid-cols-2 gap-2 pt-1 text-slate-600">
              <div>
                <span className="text-slate-500">Date Range Duration:</span>{" "}
                <span className="font-semibold text-slate-900">
                  {data.numberOfDays} Days
                </span>
              </div>
              <div>
                <span className="text-slate-500">Configured Min / Max:</span>{" "}
                <span className="font-semibold text-slate-900">
                  ₹{data.minAmount.toLocaleString()} - ₹
                  {data.maxAmount.toLocaleString()}
                </span>
              </div>
              <div>
                <span className="text-slate-500">
                  Available {data.partyTerm}:
                </span>{" "}
                <span className="font-semibold text-slate-900">
                  {data.availableCustomers}
                </span>
              </div>
              <div>
                <span className="text-slate-500">Max Invoices Capacity:</span>{" "}
                <span className="font-semibold text-slate-900">
                  {data.maxCapacity.toLocaleString()} invoices (
                  {data.availableCustomers} × {data.numberOfDays} days)
                </span>
              </div>
              <div className="col-span-2 pt-1 border-t border-slate-200">
                <span className="text-slate-500">
                  Estimated Required Invoices:
                </span>{" "}
                <span className="font-bold text-red-600">
                  ~{data.estimatedRequiredInvoices.toLocaleString()} invoices
                </span>
              </div>
            </div>
          </div>

          {/* Actionable Recommendations Header */}
          <div className="space-y-3 pt-1">
            <div className="flex items-center gap-1.5 font-bold text-slate-900 text-xs uppercase tracking-wider">
              <Lightbulb className="w-4 h-4 text-amber-500" />
              Actionable Recommendations
            </div>

            {/* Recommendation 1: Add Customers/Suppliers */}
            <div className="p-3 bg-blue-50/60 border border-blue-200 rounded-lg space-y-1">
              <div className="flex items-center gap-1.5 font-semibold text-blue-900">
                <Users className="w-4 h-4 text-blue-600" />
                Option 1: Add More {data.partyTerm}
              </div>
              <p className="text-slate-600 leading-relaxed">
                Add approximately{" "}
                <span className="font-bold text-blue-700">
                  {data.deficitCustomers} more {data.partyTerm}
                </span>{" "}
                (Total required: {data.requiredCustomersCount}) to meet the
                required invoice count over {data.numberOfDays} days.
              </p>
            </div>

            {/* Recommendation 2: Adjust Min/Max Invoice Limits */}
            <div className="p-3 bg-emerald-50/60 border border-emerald-200 rounded-lg space-y-2">
              <div className="flex items-center gap-1.5 font-semibold text-emerald-900">
                <Sliders className="w-4 h-4 text-emerald-600" />
                Option 2: Increase Invoice Amount Limits
              </div>
              <p className="text-slate-600 leading-relaxed">
                Suggested invoice limits based on configured Total Amount and
                current {data.partyTerm} count:
              </p>
              <div className="flex items-center gap-4 bg-white p-2.5 rounded border border-emerald-100 font-medium">
                <div>
                  Suggested Min:{" "}
                  <span className="font-bold text-emerald-700">
                    ₹{data.suggestedMin.toLocaleString()}
                  </span>
                </div>
                <div>
                  Suggested Max:{" "}
                  <span className="font-bold text-emerald-700">
                    ₹{data.suggestedMax.toLocaleString()}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <DialogFooter className="pt-3 border-t border-slate-100 flex justify-between items-center">
          <p className="text-[11px] text-slate-500">
            Form inputs & selections have been preserved.
          </p>
          <div className="flex gap-2">
            {onApplySuggestedLimits && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  onApplySuggestedLimits(data.suggestedMin, data.suggestedMax);
                  onClose();
                }}
                className="h-8 text-xs text-emerald-700 border-emerald-300 hover:bg-emerald-50"
              >
                Apply Suggested Limits
              </Button>
            )}
            <Button
              size="sm"
              onClick={onClose}
              className="h-8 text-xs bg-slate-900"
            >
              Close & Adjust Form
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
