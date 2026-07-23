"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createClient } from "@/lib/supabase/client";
import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function AddCategoryDialog() {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);

  const router = useRouter();
  const supabase = createClient();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError("Category Name is required");
      return;
    }

    setLoading(true);
    setError(null);

    const { error: insertError } = await supabase.from("categories").insert([
      {
        name: name.trim(),
        code: code.trim() || `CAT-${name.trim().substring(0, 4).toUpperCase()}`,
        description: description.trim() || null,
      },
    ]);

    setLoading(false);

    if (insertError) {
      setError(insertError.message);
      return;
    }

    setName("");
    setCode("");
    setDescription("");
    setOpen(false);
    router.refresh();
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          size="sm"
          className="gap-1 bg-slate-900 hover:bg-slate-800 text-xs"
        >
          <Plus className="h-4 w-4" /> Add Category
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[425px]">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Add New Category</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4 text-xs">
            {error && (
              <div className="bg-red-50 text-red-600 p-2.5 rounded border border-red-200">
                {error}
              </div>
            )}
            <div className="grid gap-1.5">
              <Label htmlFor="name">Category Name *</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Fish, Fruits, Dairy"
                required
                className="h-9 text-xs"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="code">Category Code</Label>
              <Input
                id="code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="e.g. CAT-FISH"
                className="h-9 text-xs"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="description">Description</Label>
              <textarea
                id="description"
                value={description}
                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                  setDescription(e.target.value)
                }
                placeholder="Optional description of product category"
                className="flex min-h-[70px] w-full rounded-md border border-slate-200 bg-transparent px-3 py-2 text-xs shadow-2xs placeholder:text-slate-400 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              size="sm"
              className="h-8 text-xs"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={loading}
              size="sm"
              className="h-8 text-xs bg-slate-900"
            >
              {loading ? "Saving..." : "Add Category"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
