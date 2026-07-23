"use client";

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
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

export type CategoryItem = {
  id: string;
  name: string;
  code?: string | null;
  description?: string | null;
  created_at?: string;
};

interface EditCategoryDialogProps {
  category: CategoryItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function EditCategoryDialog({
  category,
  open,
  onOpenChange,
}: EditCategoryDialogProps) {
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);

  const router = useRouter();
  const supabase = createClient();

  useEffect(() => {
    if (category) {
      setName(category.name || "");
      setCode(category.code || "");
      setDescription(category.description || "");
      setError(null);
    }
  }, [category]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!category) return;
    if (!name.trim()) {
      setError("Category Name is required");
      return;
    }

    setLoading(true);
    setError(null);

    const { error: updateError } = await supabase
      .from("categories")
      .update({
        name: name.trim(),
        code: code.trim() || null,
        description: description.trim() || null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", category.id);

    setLoading(false);

    if (updateError) {
      setError(updateError.message);
      return;
    }

    onOpenChange(false);
    router.refresh();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Edit Category</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4 text-xs">
            {error && (
              <div className="bg-red-50 text-red-600 p-2.5 rounded border border-red-200">
                {error}
              </div>
            )}
            <div className="grid gap-1.5">
              <Label htmlFor="edit-name">Category Name *</Label>
              <Input
                id="edit-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                className="h-9 text-xs"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="edit-code">Category Code</Label>
              <Input
                id="edit-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                className="h-9 text-xs"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="edit-description">Description</Label>
              <textarea
                id="edit-description"
                value={description}
                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                  setDescription(e.target.value)
                }
                className="flex min-h-[70px] w-full rounded-md border border-slate-200 bg-transparent px-3 py-2 text-xs shadow-2xs placeholder:text-slate-400 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
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
              {loading ? "Saving..." : "Save Changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
