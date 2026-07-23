"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createClient } from "@/lib/supabase/client";

type Supplier = {
  id: string;
  company_name: string;
  address: string;
  gstin?: string | null;
  pan?: string | null;
  state: string;
  state_code?: string;
  category?: string;
};

export function EditSupplierDialog({
  supplier,
  open,
  onOpenChange,
}: {
  supplier: Supplier;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formData, setFormData] = useState(supplier);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const gstin = formData.gstin?.trim() || null;
    const pan = formData.pan?.trim() || null;

    // Validate optional GSTIN format if provided
    if (
      gstin &&
      !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/i.test(gstin)
    ) {
      setError("Invalid GSTIN format. Standard format: 33AAAAA0000A1Z5");
      setLoading(false);
      return;
    }

    // Validate optional PAN format if provided
    if (pan && !/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/i.test(pan)) {
      setError("Invalid PAN format. Standard format: ABCDE1234F");
      setLoading(false);
      return;
    }

    try {
      const supabase = createClient();
      const { error: updateError } = await supabase
        .from("suppliers")
        .update({
          company_name: formData.company_name,
          address: formData.address,
          gstin: gstin ? gstin.toUpperCase() : null,
          pan: pan ? pan.toUpperCase() : null,
          state: formData.state,
          state_code: formData.state_code,
          category: formData.category || "Meat",
          updated_at: new Date().toISOString(),
        })
        .eq("id", supplier.id);

      if (updateError) throw updateError;

      router.refresh();
      onOpenChange(false);
    } catch (err: any) {
      console.error("Error updating supplier:", err);
      setError(err.message || "Failed to update supplier. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit Supplier</DialogTitle>
          <DialogDescription>
            Update the details of the raw material vendor / supplier.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <Label htmlFor="edit_company_name">
                Company / Supplier Name *
              </Label>
              <Input
                id="edit_company_name"
                value={formData.company_name}
                onChange={(e) =>
                  setFormData({ ...formData, company_name: e.target.value })
                }
                required
              />
            </div>

            <div className="col-span-2">
              <Label htmlFor="edit_address">Address *</Label>
              <Input
                id="edit_address"
                value={formData.address}
                onChange={(e) =>
                  setFormData({ ...formData, address: e.target.value })
                }
                required
              />
            </div>

            <div>
              <Label htmlFor="edit_gstin">GSTIN (Optional)</Label>
              <Input
                id="edit_gstin"
                value={formData.gstin || ""}
                onChange={(e) =>
                  setFormData({ ...formData, gstin: e.target.value })
                }
              />
            </div>

            <div>
              <Label htmlFor="edit_pan">PAN (Optional)</Label>
              <Input
                id="edit_pan"
                value={formData.pan || ""}
                onChange={(e) =>
                  setFormData({ ...formData, pan: e.target.value })
                }
              />
            </div>

            <div className="col-span-2">
              <Label htmlFor="edit_state">State *</Label>
              <Input
                id="edit_state"
                value={formData.state}
                onChange={(e) =>
                  setFormData({ ...formData, state: e.target.value })
                }
                required
              />
            </div>

            <div>
              <Label htmlFor="edit_state_code">State Code</Label>
              <Input
                id="edit_state_code"
                value={formData.state_code || ""}
                onChange={(e) =>
                  setFormData({ ...formData, state_code: e.target.value })
                }
              />
            </div>

            <div className="col-span-2">
              <Label htmlFor="edit_category">Supplier Category *</Label>
              <select
                id="edit_category"
                value={formData.category || "Meat"}
                onChange={(e) =>
                  setFormData({ ...formData, category: e.target.value })
                }
                required
                className="w-full h-9 rounded-md border border-slate-200 bg-white px-3 py-1 text-xs shadow-2xs focus:outline-hidden focus:ring-1 focus:ring-slate-950"
              >
                <option value="Meat">Meat</option>
                <option value="Fruits">Fruits</option>
              </select>
            </div>
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded text-sm">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={loading}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={loading}>
              {loading ? "Updating..." : "Update Supplier"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
