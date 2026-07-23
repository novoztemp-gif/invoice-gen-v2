"use client";

import { ArrowDown, ArrowUp, ArrowUpDown, Pencil, Search } from "lucide-react";
import { useMemo, useState } from "react";
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
import { EditSupplierDialog } from "./EditSupplierDialog";
import { cn } from "@/lib/utils";

type Supplier = {
  id: string;
  company_name: string;
  address: string;
  gstin?: string | null;
  pan?: string | null;
  state: string;
  state_code?: string;
  created_at: string;
  updated_at: string;
};

type SortField = keyof Supplier;
type SortOrder = "asc" | "desc" | null;

export function SuppliersTable({ suppliers }: { suppliers: Supplier[] }) {
  const [searchQuery, setSearchQuery] = useState("");
  const [sortField, setSortField] = useState<SortField | null>(null);
  const [sortOrder, setSortOrder] = useState<SortOrder>(null);
  const [editingSupplier, setEditingSupplier] = useState<Supplier | null>(null);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      if (sortOrder === "asc") {
        setSortOrder("desc");
      } else if (sortOrder === "desc") {
        setSortField(null);
        setSortOrder(null);
      } else {
        setSortOrder("asc");
      }
    } else {
      setSortField(field);
      setSortOrder("asc");
    }
  };

  const getSortIcon = (field: SortField) => {
    if (sortField !== field) {
      return <ArrowUpDown className="h-4 w-4" />;
    }
    if (sortOrder === "asc") {
      return <ArrowUp className="h-4 w-4" />;
    }
    return <ArrowDown className="h-4 w-4" />;
  };

  const filteredAndSortedSuppliers = useMemo(() => {
    let filtered = suppliers.filter((supplier) => {
      const query = searchQuery.toLowerCase();
      return (
        supplier.company_name?.toLowerCase().includes(query) ||
        supplier.address?.toLowerCase().includes(query) ||
        supplier.gstin?.toLowerCase().includes(query) ||
        supplier.pan?.toLowerCase().includes(query) ||
        supplier.state?.toLowerCase().includes(query) ||
        supplier.state_code?.toLowerCase().includes(query)
      );
    });

    if (sortField && sortOrder) {
      filtered = [...filtered].sort((a, b) => {
        const aValue = a[sortField] || "";
        const bValue = b[sortField] || "";

        if (aValue < bValue) return sortOrder === "asc" ? -1 : 1;
        if (aValue > bValue) return sortOrder === "asc" ? 1 : -1;
        return 0;
      });
    }

    return filtered;
  }, [suppliers, searchQuery, sortField, sortOrder]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2 top-2.5 h-4 w-4 text-slate-500" />
          <Input
            placeholder="Search suppliers..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-8"
          />
        </div>
        <p className="text-sm text-slate-600">
          Showing {filteredAndSortedSuppliers.length} of {suppliers.length}{" "}
          suppliers
        </p>
      </div>

      {filteredAndSortedSuppliers.length === 0 ? (
        <p className="text-slate-500 text-center py-8">
          {searchQuery
            ? "No suppliers match your search."
            : "No suppliers found. Add your first supplier!"}
        </p>
      ) : (
        <div className="rounded-md border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-[180px]">
                  Supplier Name
                  <Button
                    variant="ghost"
                    onClick={() => handleSort("company_name")}
                    className="p-0 h-auto font-semibold hover:bg-transparent"
                  >
                    {getSortIcon("company_name")}
                  </Button>
                </TableHead>
                <TableHead className="min-w-[300px]">Address</TableHead>
                <TableHead className="min-w-[140px]">
                  GSTIN
                  <Button
                    variant="ghost"
                    onClick={() => handleSort("gstin")}
                    className="h-auto p-0 font-semibold hover:bg-transparent"
                  >
                    {getSortIcon("gstin")}
                  </Button>
                </TableHead>
                <TableHead className="min-w-[120px]">
                  PAN
                  <Button
                    variant="ghost"
                    onClick={() => handleSort("pan")}
                    className="h-auto p-0 font-semibold hover:bg-transparent"
                  >
                    {getSortIcon("pan")}
                  </Button>
                </TableHead>
                <TableHead className="min-w-[120px]">
                  State
                  <Button
                    variant="ghost"
                    onClick={() => handleSort("state")}
                    className="h-auto p-0 font-semibold hover:bg-transparent"
                  >
                    {getSortIcon("state")}
                  </Button>
                </TableHead>
                <TableHead className="min-w-[100px]">State Code</TableHead>
                <TableHead className="min-w-[80px]">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredAndSortedSuppliers.map((supplier) => (
                <TableRow key={supplier.id}>
                  <TableCell className="font-medium">
                    {supplier.company_name}
                  </TableCell>
                  <TableCell className="text-sm">
                    <div className="max-w-[300px] text-wrap">
                      {supplier.address}
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-sm whitespace-nowrap">
                    {supplier.gstin || "-"}
                  </TableCell>
                  <TableCell className="font-mono text-sm whitespace-nowrap">
                    {supplier.pan || "-"}
                  </TableCell>
                  <TableCell>
                    <span className="inline-flex items-center whitespace-nowrap">
                      {supplier.state}
                    </span>
                  </TableCell>
                  <TableCell className="font-mono text-sm whitespace-nowrap">
                    {supplier.state_code || "-"}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setEditingSupplier(supplier)}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {editingSupplier && (
        <EditSupplierDialog
          supplier={editingSupplier}
          open={!!editingSupplier}
          onOpenChange={(open) => !open && setEditingSupplier(null)}
        />
      )}
    </div>
  );
}
