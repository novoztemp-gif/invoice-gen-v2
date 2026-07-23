"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { createClient } from "@/lib/supabase/client";
import { Edit, Trash2, Search, Tag } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { CategoryItem, EditCategoryDialog } from "./EditCategoryDialog";

interface CategoriesTableProps {
  categories: CategoryItem[];
}

export function CategoriesTable({ categories }: CategoriesTableProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<CategoryItem | null>(
    null,
  );
  const [editOpen, setEditOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const router = useRouter();
  const supabase = createClient();

  const filteredCategories = categories.filter((cat) => {
    const query = searchTerm.toLowerCase();
    return (
      cat.name.toLowerCase().includes(query) ||
      (cat.code && cat.code.toLowerCase().includes(query)) ||
      (cat.description && cat.description.toLowerCase().includes(query))
    );
  });

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Are you sure you want to delete category "${name}"?`)) return;

    setDeletingId(id);
    const { error } = await supabase.from("categories").delete().eq("id", id);
    setDeletingId(null);

    if (error) {
      alert(`Failed to delete category: ${error.message}`);
      return;
    }

    router.refresh();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 max-w-sm">
        <div className="relative w-full">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
          <Input
            placeholder="Search categories by name or code..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-9 h-9 text-xs"
          />
        </div>
      </div>

      <div className="border rounded-md border-slate-200 overflow-hidden">
        <Table>
          <TableHeader className="bg-slate-50">
            <TableRow className="text-xs">
              <TableHead className="w-[60px]">S.No</TableHead>
              <TableHead>Category Name</TableHead>
              <TableHead>Code</TableHead>
              <TableHead>Description</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody className="text-xs">
            {filteredCategories.length > 0 ? (
              filteredCategories.map((cat, index) => (
                <TableRow key={cat.id} className="hover:bg-slate-50/50">
                  <TableCell className="font-medium text-slate-500">
                    {index + 1}
                  </TableCell>
                  <TableCell className="font-semibold text-slate-900 flex items-center gap-1.5 py-3">
                    <Tag className="w-3.5 h-3.5 text-slate-400" />
                    {cat.name}
                  </TableCell>
                  <TableCell className="font-mono text-slate-600">
                    {cat.code || "-"}
                  </TableCell>
                  <TableCell className="text-slate-500 max-w-xs truncate">
                    {cat.description || "-"}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setSelectedCategory(cat);
                          setEditOpen(true);
                        }}
                        className="h-7 w-7 p-0 text-slate-600 hover:text-slate-900"
                      >
                        <Edit className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={deletingId === cat.id}
                        onClick={() => handleDelete(cat.id, cat.name)}
                        className="h-7 w-7 p-0 text-red-500 hover:text-red-700 hover:bg-red-50"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="text-center py-8 text-slate-500"
                >
                  No categories found.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <EditCategoryDialog
        category={selectedCategory}
        open={editOpen}
        onOpenChange={setEditOpen}
      />
    </div>
  );
}
