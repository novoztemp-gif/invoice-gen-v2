"use client";

import { ArrowDown, ArrowUp, ArrowUpDown, Pencil, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
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
import { EditProductRuleDialog } from "./EditProductRuleDialog";

export function ProductRulesTable({
  productsWithRules,
}: {
  productsWithRules: any[];
}) {
  const [searchQuery, setSearchQuery] = useState("");
  const [sortField, setSortField] = useState<string | null>(null);
  const [sortOrder, setSortOrder] = useState<"asc" | "desc" | null>(null);
  const [editingRule, setEditingRule] = useState<any | null>(null);

  const handleSort = (field: string) => {
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

  const getSortIcon = (field: string) => {
    if (sortField !== field) {
      return <ArrowUpDown className="ml-2 h-4 w-4 inline" />;
    }
    if (sortOrder === "asc") {
      return <ArrowUp className="ml-2 h-4 w-4 inline" />;
    }
    return <ArrowDown className="ml-2 h-4 w-4 inline" />;
  };

  const filteredAndSorted = useMemo(() => {
    let filtered = productsWithRules.filter((item) => {
      const query = searchQuery.toLowerCase();
      return (
        item.product_name.toLowerCase().includes(query) ||
        item.hsn_code.toLowerCase().includes(query)
      );
    });

    if (sortField && sortOrder) {
      filtered = [...filtered].sort((a, b) => {
        let aValue = a[sortField];
        let bValue = b[sortField];

        // Handle rule fields
        if (sortField.startsWith("rule_")) {
          const actualField = sortField.replace("rule_", "");
          aValue = a.rule ? a.rule[actualField] : null;
          bValue = b.rule ? b.rule[actualField] : null;
        }

        // Handle status sort
        if (sortField === "status") {
          aValue = a.rule ? 1 : 0;
          bValue = b.rule ? 1 : 0;
        }

        if (aValue === null && bValue !== null)
          return sortOrder === "asc" ? -1 : 1;
        if (aValue !== null && bValue === null)
          return sortOrder === "asc" ? 1 : -1;
        if (aValue === null && bValue === null) return 0;

        if (aValue < bValue) return sortOrder === "asc" ? -1 : 1;
        if (aValue > bValue) return sortOrder === "asc" ? 1 : -1;
        return 0;
      });
    }

    return filtered;
  }, [productsWithRules, searchQuery, sortField, sortOrder]);

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
          Showing {filteredAndSorted.length} products
        </p>
      </div>

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
              <TableHead>HSN Code</TableHead>
              <TableHead>Unit</TableHead>
              <TableHead className="text-right">Qty Min/Max</TableHead>
              <TableHead className="text-right">Rate Min/Max</TableHead>
              <TableHead>
                Status
                <Button
                  variant="ghost"
                  onClick={() => handleSort("status")}
                  className="h-auto p-0 font-semibold hover:bg-transparent"
                >
                  {getSortIcon("status")}
                </Button>
              </TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredAndSorted.map((item) => (
              <TableRow key={item.id}>
                <TableCell className="font-medium">
                  {item.product_name}
                </TableCell>
                <TableCell>
                  <code className="font-mono text-sm">{item.hsn_code}</code>
                </TableCell>
                <TableCell>{item.unit_of_measure}</TableCell>
                <TableCell className="text-right">
                  {item.rule ? (
                    <span className="text-sm text-slate-600">
                      {item.rule.quantity_min} - {item.rule.quantity_max}
                    </span>
                  ) : (
                    <span className="text-sm text-slate-400">-</span>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  {item.rule ? (
                    <span className="text-sm text-slate-600">
                      ₹{item.rule.rate_min} - ₹{item.rule.rate_max}
                    </span>
                  ) : (
                    <span className="text-sm text-slate-400">-</span>
                  )}
                </TableCell>
                <TableCell>
                  {item.rule ? (
                    <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100 font-normal">
                      Configured
                    </Badge>
                  ) : (
                    <Badge
                      variant="secondary"
                      className="text-slate-500 font-normal"
                    >
                      Not Configured
                    </Badge>
                  )}
                </TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="flex items-center gap-2"
                    onClick={() => setEditingRule(item)}
                  >
                    <Pencil className="h-4 w-4" /> Edit
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {filteredAndSorted.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={7}
                  className="text-center py-8 text-slate-500"
                >
                  No products found.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {editingRule && (
        <EditProductRuleDialog
          productWithRule={editingRule}
          open={!!editingRule}
          onOpenChange={(open: boolean) => !open && setEditingRule(null)}
        />
      )}
    </div>
  );
}
