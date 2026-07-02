"use client";

import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createClient } from "@/lib/supabase/client";

export function EditProductRuleDialog({
  productWithRule,
  open,
  onOpenChange,
}: any) {
  const router = useRouter();
  const supabase = createClient();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [formData, setFormData] = useState({
    quantity_min: "",
    quantity_max: "",
    rate_min: "",
    rate_max: "",
  });

  useEffect(() => {
    if (productWithRule?.rule) {
      setFormData({
        quantity_min: productWithRule.rule.quantity_min?.toString() || "",
        quantity_max: productWithRule.rule.quantity_max?.toString() || "",
        rate_min: productWithRule.rule.rate_min?.toString() || "",
        rate_max: productWithRule.rule.rate_max?.toString() || "",
      });
    } else {
      setFormData({
        quantity_min: "",
        quantity_max: "",
        rate_min: "",
        rate_max: "",
      });
    }
  }, [productWithRule]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const qtyMin = parseFloat(formData.quantity_min);
    const qtyMax = parseFloat(formData.quantity_max);
    const rateMin = parseFloat(formData.rate_min);
    const rateMax = parseFloat(formData.rate_max);

    if (isNaN(qtyMin) || qtyMin < 0) {
      setError("Minimum Quantity must be zero or greater.");
      return;
    }
    if (isNaN(qtyMax) || qtyMax < qtyMin) {
      setError(
        "Maximum Quantity must be greater than or equal to Minimum Quantity.",
      );
      return;
    }
    if (isNaN(rateMin) || rateMin < 0) {
      setError("Minimum Rate must be zero or greater.");
      return;
    }
    if (isNaN(rateMax) || rateMax < rateMin) {
      setError("Maximum Rate must be greater than or equal to Minimum Rate.");
      return;
    }

    setLoading(true);

    try {
      const payload = {
        product_id: productWithRule.id,
        quantity_min: qtyMin,
        quantity_max: qtyMax,
        rate_min: rateMin,
        rate_max: rateMax,
        updated_at: new Date().toISOString(),
      };

      if (productWithRule.rule?.id) {
        // Update
        const { error: updateError } = await supabase
          .from("product_rules")
          .update(payload)
          .eq("id", productWithRule.rule.id);

        if (updateError) throw updateError;
      } else {
        // Insert
        const { error: insertError } = await supabase
          .from("product_rules")
          .insert(payload);

        if (insertError) throw insertError;
      }

      onOpenChange(false);
      router.refresh();
    } catch (err: any) {
      console.error("Error saving rule:", err);
      setError(err.message || "Failed to save product rules.");
    } finally {
      setLoading(false);
    }
  };

  if (!productWithRule) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Configure Product Rules</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 py-4">
          <div className="space-y-4 mb-6 p-4 bg-slate-50 rounded-lg border border-slate-200">
            <div>
              <Label className="text-xs text-slate-500">Product Name</Label>
              <p className="font-semibold text-slate-900">
                {productWithRule.product_name}
              </p>
            </div>
            <div>
              <Label className="text-xs text-slate-500">HSN Code</Label>
              <p className="font-mono text-sm text-slate-900">
                {productWithRule.hsn_code}
              </p>
            </div>
          </div>

          {error && (
            <div className="p-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded-md">
              {error}
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Minimum Quantity</Label>
              <Input
                type="number"
                min="0"
                step="0.01"
                required
                value={formData.quantity_min}
                onChange={(e) =>
                  setFormData({ ...formData, quantity_min: e.target.value })
                }
              />
            </div>
            <div className="space-y-2">
              <Label>Maximum Quantity</Label>
              <Input
                type="number"
                min="0"
                step="0.01"
                required
                value={formData.quantity_max}
                onChange={(e) =>
                  setFormData({ ...formData, quantity_max: e.target.value })
                }
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Minimum Rate</Label>
              <Input
                type="number"
                min="0"
                step="0.01"
                required
                value={formData.rate_min}
                onChange={(e) =>
                  setFormData({ ...formData, rate_min: e.target.value })
                }
              />
            </div>
            <div className="space-y-2">
              <Label>Maximum Rate</Label>
              <Input
                type="number"
                min="0"
                step="0.01"
                required
                value={formData.rate_max}
                onChange={(e) =>
                  setFormData({ ...formData, rate_max: e.target.value })
                }
              />
            </div>
          </div>

          <DialogFooter className="mt-6">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={loading}>
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save Rules
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
