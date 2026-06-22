"use client";

import { useState, useMemo } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Search, ArrowUpDown, ArrowUp, ArrowDown, Pencil } from "lucide-react";
import { EditReceivingCompanyDialog } from "./EditReceivingCompanyDialog";

type ReceivingCompany = {
  id: string;
  company_name: string;
  address: string;
  gstin: string;
  pan: string;
  state: string;
  state_code?: string;
  created_at: string;
  updated_at: string;
};

type SortField = keyof ReceivingCompany;
type SortOrder = "asc" | "desc" | null;

export function ReceivingCompaniesTable({
  companies,
}: {
  companies: ReceivingCompany[];
}) {
  const [searchQuery, setSearchQuery] = useState("");
  const [sortField, setSortField] = useState<SortField | null>(null);
  const [sortOrder, setSortOrder] = useState<SortOrder>(null);
  const [editingCompany, setEditingCompany] = useState<ReceivingCompany | null>(
    null,
  );

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

  const filteredAndSortedCompanies = useMemo(() => {
    let filtered = companies.filter((company) => {
      const query = searchQuery.toLowerCase();
      return (
        company.company_name.toLowerCase().includes(query) ||
        company.address.toLowerCase().includes(query) ||
        company.gstin.toLowerCase().includes(query) ||
        company.pan.toLowerCase().includes(query) ||
        company.state.toLowerCase().includes(query) ||
        company.state_code?.toLowerCase().includes(query)
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
  }, [companies, searchQuery, sortField, sortOrder]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2 top-2.5 h-4 w-4 text-slate-500" />
          <Input
            placeholder="Search companies..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-8"
          />
        </div>
        <p className="text-sm text-slate-600">
          Showing {filteredAndSortedCompanies.length} of {companies.length}{" "}
          companies
        </p>
      </div>

      {filteredAndSortedCompanies.length === 0 ? (
        <p className="text-slate-500 text-center py-8">
          {searchQuery
            ? "No companies match your search."
            : "No companies found. Add your first receiving company!"}
        </p>
      ) : (
        <div className="rounded-md border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-[180px]">
                  Company Name
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
              {filteredAndSortedCompanies.map((company) => (
                <TableRow key={company.id}>
                  <TableCell className="font-medium">
                    {company.company_name}
                  </TableCell>
                  <TableCell className="text-sm">
                    <div className="max-w-[300px] text-wrap">
                      {company.address}
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-sm whitespace-nowrap">
                    {company.gstin}
                  </TableCell>
                  <TableCell className="font-mono text-sm whitespace-nowrap">
                    {company.pan}
                  </TableCell>
                  <TableCell>
                    <span className="inline-flex items-center whitespace-nowrap">
                      {company.state}
                    </span>
                  </TableCell>
                  <TableCell className="font-mono text-sm whitespace-nowrap">
                    {company.state_code || "-"}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setEditingCompany(company)}
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

      {editingCompany && (
        <EditReceivingCompanyDialog
          company={editingCompany}
          open={!!editingCompany}
          onOpenChange={(open) => !open && setEditingCompany(null)}
        />
      )}
    </div>
  );
}
