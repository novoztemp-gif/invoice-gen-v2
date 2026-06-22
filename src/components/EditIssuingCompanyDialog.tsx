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

type IssuingCompany = {
  id: string;
  company_name: string;
  address: string;
  gstin: string;
  pan: string;
  phone: string;
  branch?: string;
  bank_account_name: string;
  bank_name: string;
  account_number: string;
  ifsc_code: string;
};

export function EditIssuingCompanyDialog({
  company,
  open,
  onOpenChange,
}: {
  company: IssuingCompany;
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
        .from("issuing_companies")
        .update({
          company_name: formData.company_name,
          address: formData.address,
          gstin: formData.gstin,
          pan: formData.pan,
          phone: formData.phone,
          branch: formData.branch,
          bank_account_name: formData.bank_account_name,
          bank_name: formData.bank_name,
          account_number: formData.account_number,
          ifsc_code: formData.ifsc_code,
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
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit Issuing Company</DialogTitle>
          <DialogDescription>
            Update the details of the company that issues invoices.
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

            <div>
              <Label htmlFor="phone">Phone *</Label>
              <Input
                id="phone"
                value={formData.phone}
                onChange={(e) =>
                  setFormData({ ...formData, phone: e.target.value })
                }
                required
              />
            </div>

            <div>
              <Label htmlFor="branch">Branch</Label>
              <Input
                id="branch"
                value={formData.branch || ""}
                onChange={(e) =>
                  setFormData({ ...formData, branch: e.target.value })
                }
              />
            </div>

            <div>
              <Label htmlFor="bank_account_name">Bank Account Name *</Label>
              <Input
                id="bank_account_name"
                value={formData.bank_account_name}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    bank_account_name: e.target.value,
                  })
                }
                required
              />
            </div>

            <div>
              <Label htmlFor="bank_name">Bank Name *</Label>
              <Input
                id="bank_name"
                value={formData.bank_name}
                onChange={(e) =>
                  setFormData({ ...formData, bank_name: e.target.value })
                }
                required
              />
            </div>

            <div>
              <Label htmlFor="account_number">Account Number *</Label>
              <Input
                id="account_number"
                value={formData.account_number}
                onChange={(e) =>
                  setFormData({ ...formData, account_number: e.target.value })
                }
                required
              />
            </div>

            <div>
              <Label htmlFor="ifsc_code">IFSC Code *</Label>
              <Input
                id="ifsc_code"
                value={formData.ifsc_code}
                onChange={(e) =>
                  setFormData({ ...formData, ifsc_code: e.target.value })
                }
                required
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
