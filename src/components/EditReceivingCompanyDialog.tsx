"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type ReceivingCompany = {
  id: string;
  company_name: string;
  address: string;
  gstin: string;
  pan: string;
  state: string;
  state_code?: string;
};

export function EditReceivingCompanyDialog({
  company,
  open,
  onOpenChange,
}: {
  company: ReceivingCompany;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState(company);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      const supabase = createClient();
      const { error } = await supabase
        .from("receiving_companies")
        .update({
          company_name: formData.company_name,
          address: formData.address,
          gstin: formData.gstin,
          pan: formData.pan,
          state: formData.state,
          state_code: formData.state_code,
          updated_at: new Date().toISOString(),
        })
        .eq("id", company.id);

      if (error) throw error;

      router.refresh();
      onOpenChange(false);
    } catch (error) {
      console.error("Error updating company:", error);
      alert("Failed to update company. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit Receiving Company</DialogTitle>
          <DialogDescription>
            Update the details of the company that receives invoices.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <Label htmlFor="company_name">Company Name *</Label>
              <Input
                id="company_name"
                value={formData.company_name}
                onChange={(e) =>
                  setFormData({ ...formData, company_name: e.target.value })
                }
                required
              />
            </div>

            <div className="col-span-2">
              <Label htmlFor="address">Address *</Label>
              <Input
                id="address"
                value={formData.address}
                onChange={(e) =>
                  setFormData({ ...formData, address: e.target.value })
                }
                required
              />
            </div>

            <div>
              <Label htmlFor="gstin">GSTIN *</Label>
              <Input
                id="gstin"
                value={formData.gstin}
                onChange={(e) =>
                  setFormData({ ...formData, gstin: e.target.value })
                }
                required
              />
            </div>

            <div>
              <Label htmlFor="pan">PAN *</Label>
              <Input
                id="pan"
                value={formData.pan}
                onChange={(e) =>
                  setFormData({ ...formData, pan: e.target.value })
                }
                required
              />
            </div>

            <div className="col-span-2">
              <Label htmlFor="state">State *</Label>
              <Input
                id="state"
                value={formData.state}
                onChange={(e) =>
                  setFormData({ ...formData, state: e.target.value })
                }
                required
              />
            </div>

            <div>
              <Label htmlFor="state_code">State Code</Label>
              <Input
                id="state_code"
                value={formData.state_code || ""}
                onChange={(e) =>
                  setFormData({ ...formData, state_code: e.target.value })
                }
              />
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={loading}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={loading}>
              {loading ? "Updating..." : "Update Company"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
