"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createClient } from "@/lib/supabase/client";

export function AddIssuingCompanyDialog() {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const supabase = createClient();

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const formData = new FormData(e.currentTarget);
    const data = {
      company_name: formData.get("company_name") as string,
      address: formData.get("address") as string,
      gstin: formData.get("gstin") as string,
      phone: formData.get("phone") as string,
      pan: formData.get("pan") as string,
      branch: formData.get("branch") as string,
      bank_account_name: formData.get("bank_account_name") as string,
      bank_name: formData.get("bank_name") as string,
      account_number: formData.get("account_number") as string,
      ifsc_code: formData.get("ifsc_code") as string,
    };

    const { error: insertError } = await supabase
      .from("issuing_companies")
      .insert(data);

    if (insertError) {
      setError(insertError.message);
      setLoading(false);
      return;
    }

    setOpen(false);
    setLoading(false);
    router.refresh();
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <svg
            className="w-4 h-4 mr-2"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 4v16m8-8H4"
            />
          </svg>
          Add Company
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add Issuing Company</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="company_name">Company Name *</Label>
              <Input id="company_name" name="company_name" required />
            </div>

            <div className="space-y-2">
              <Label htmlFor="phone">Phone *</Label>
              <Input id="phone" name="phone" type="tel" required />
            </div>

            <div className="space-y-2 md:col-span-2">
              <Label htmlFor="address">Address *</Label>
              <Input id="address" name="address" required />
            </div>

            <div className="space-y-2">
              <Label htmlFor="gstin">GSTIN *</Label>
              <Input id="gstin" name="gstin" required />
            </div>

            <div className="space-y-2">
              <Label htmlFor="pan">PAN *</Label>
              <Input id="pan" name="pan" required />
            </div>

            <div className="space-y-2">
              <Label htmlFor="branch">Branch</Label>
              <Input id="branch" name="branch" />
            </div>

            <div className="space-y-2">
              <Label htmlFor="bank_account_name">Bank Account Name *</Label>
              <Input id="bank_account_name" name="bank_account_name" required />
            </div>

            <div className="space-y-2">
              <Label htmlFor="bank_name">Bank Name *</Label>
              <Input id="bank_name" name="bank_name" required />
            </div>

            <div className="space-y-2">
              <Label htmlFor="account_number">Account Number *</Label>
              <Input id="account_number" name="account_number" required />
            </div>

            <div className="space-y-2">
              <Label htmlFor="ifsc_code">IFSC Code *</Label>
              <Input id="ifsc_code" name="ifsc_code" required />
            </div>
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={loading}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={loading}>
              {loading ? "Adding..." : "Add Company"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
