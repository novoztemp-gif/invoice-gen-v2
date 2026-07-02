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
import { EditProductDialog } from "./EditProductDialog";

type Product = {
  id: string;
  product_name: string;
  hsn_code: string;
  unit_of_measure: string;
  created_at: string;
  updated_at: string;
};

type SortField = keyof Product;
type SortOrder = "asc" | "desc" | null;

export function ProductsTable({ products }: { products: Product[] }) {
  const [searchQuery, setSearchQuery] = useState("");
  const [sortField, setSortField] = useState<SortField | null>(null);
  const [sortOrder, setSortOrder] = useState<SortOrder>(null);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);

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
      return <ArrowUpDown className="ml-2 h-4 w-4 inline" />;
    }
    if (sortOrder === "asc") {
      return <ArrowUp className="ml-2 h-4 w-4 inline" />;
    }
    return <ArrowDown className="ml-2 h-4 w-4 inline" />;
  };

  const filteredAndSortedProducts = useMemo(() => {
    let filtered = products.filter((product) => {
      const query = searchQuery.toLowerCase();
      return (
        product.product_name.toLowerCase().includes(query) ||
        product.hsn_code.toLowerCase().includes(query) ||
        product.unit_of_measure.toLowerCase().includes(query)
      );
    });

    if (sortField && sortOrder) {
      filtered = [...filtered].sort((a, b) => {
        const aValue = a[sortField];
        const bValue = b[sortField];

        if (aValue < bValue) return sortOrder === "asc" ? -1 : 1;
        if (aValue > bValue) return sortOrder === "asc" ? 1 : -1;
        return 0;
      });
    }

    return filtered;
  }, [products, searchQuery, sortField, sortOrder]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2 top-2.5 h-4 w-4 text-slate-500" />
          <Input
            placeholder="Search products..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-8"
          />
        </div>
        <p className="text-sm text-slate-600">
          Showing {filteredAndSortedProducts.length} of {products.length}{" "}
          products
        </p>
      </div>

      {filteredAndSortedProducts.length === 0 ? (
        <p className="text-slate-500 text-center py-8">
          {searchQuery
            ? "No products match your search."
            : "No products found. Add your first product!"}
        </p>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>
                  Product Name
                  <Button
                    variant="ghost"
                    onClick={() => handleSort("product_name")}
                    className="h-auto p-0 font-semibold hover:bg-transparent"
                  >
                    {getSortIcon("product_name")}
                  </Button>
                </TableHead>
                <TableHead>
                  HSN Code
                  <Button
                    variant="ghost"
                    onClick={() => handleSort("hsn_code")}
                    className="h-auto p-0 font-semibold hover:bg-transparent"
                  >
                    {getSortIcon("hsn_code")}
                  </Button>
                </TableHead>
                <TableHead>
                  Unit of Measure
                  <Button
                    variant="ghost"
                    onClick={() => handleSort("unit_of_measure")}
                    className="h-auto p-0 font-semibold hover:bg-transparent"
                  >
                    {getSortIcon("unit_of_measure")}
                  </Button>
                </TableHead>
                <TableHead>
                  Created At
                  <Button
                    variant="ghost"
                    onClick={() => handleSort("created_at")}
                    className="h-auto p-0 font-semibold hover:bg-transparent"
                  >
                    {getSortIcon("created_at")}
                  </Button>
                </TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredAndSortedProducts.map((product) => (
                <TableRow key={product.id}>
                  <TableCell className="font-medium">
                    {product.product_name}
                  </TableCell>
                  <TableCell>
                    <code className="relative font-mono text-sm font-semibold">
                      {product.hsn_code}
                    </code>
                  </TableCell>
                  <TableCell>
                    <span className="font-mono text-sm">
                      {product.unit_of_measure}
                    </span>
                  </TableCell>
                  <TableCell className="text-sm">
                    {new Date(product.created_at).toLocaleDateString("en-IN", {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                    })}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setEditingProduct(product)}
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

      {editingProduct && (
        <EditProductDialog
          product={editingProduct}
          open={!!editingProduct}
          onOpenChange={(open) => !open && setEditingProduct(null)}
        />
      )}
    </div>
  );
}
