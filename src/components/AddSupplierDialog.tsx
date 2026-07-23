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
import { Plus } from "lucide-react";

export function AddSupplierDialog() {
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
    const company_name = (formData.get("company_name") as string)?.trim();
    const address = (formData.get("address") as string)?.trim();
    const state = (formData.get("state") as string)?.trim();
    const state_code = (formData.get("state_code") as string)?.trim() || null;
    const gstin = (formData.get("gstin") as string)?.trim() || null;
    const pan = (formData.get("pan") as string)?.trim() || null;

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

    const data = {
      company_name,
      address,
      state,
      state_code,
      gstin: gstin ? gstin.toUpperCase() : null,
      pan: pan ? pan.toUpperCase() : null,
    };

    const { error: insertError } = await supabase
      .from("suppliers")
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
          <Plus className="w-4 h-4 mr-2" />
          Add Supplier
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add Supplier</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2 col-span-2">
              <Label htmlFor="company_name">Company / Supplier Name *</Label>
              <Input id="company_name" name="company_name" required />
            </div>

            <div className="space-y-2 md:col-span-2">
              <Label htmlFor="address">Address *</Label>
              <Input id="address" name="address" required />
            </div>

            <div className="space-y-2">
              <Label htmlFor="gstin">GSTIN (Optional)</Label>
              <Input
                id="gstin"
                name="gstin"
                placeholder="e.g. 33AAAAA0000A1Z5"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="pan">PAN (Optional)</Label>
              <Input id="pan" name="pan" placeholder="e.g. AAAAA0000A" />
            </div>

            <div className="space-y-2">
              <Label htmlFor="state">State *</Label>
              <Input id="state" name="state" required />
            </div>

            <div className="space-y-2">
              <Label htmlFor="state_code">State Code</Label>
              <Input id="state_code" name="state_code" />
            </div>
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded text-sm">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={loading}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={loading}>
              {loading ? "Adding..." : "Add Supplier"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
