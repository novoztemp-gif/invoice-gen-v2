"use client";

import React from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Filter, RotateCcw } from "lucide-react";

export interface GlobalFilterState {
  financialYear: string;
  startDate: string;
  endDate: string;
  purchaseBatchId: string;
  salesBatchId: string;
  productId: string;
  customerId: string;
}

interface GlobalFilterHeaderProps {
  filterOptions: {
    financialYears: string[];
    purchaseBatches: any[];
    salesBatches: any[];
    products: any[];
    customers: any[];
  };
  filter: GlobalFilterState;
  onFilterChange: (newFilter: GlobalFilterState) => void;
  onReset: () => void;
}

export function GlobalFilterHeader({
  filterOptions,
  filter,
  onFilterChange,
  onReset,
}: GlobalFilterHeaderProps) {
  const handleChange = (key: keyof GlobalFilterState, value: string) => {
    onFilterChange({
      ...filter,
      [key]: value,
    });
  };

  const isFiltered =
    filter.financialYear !== "All" ||
    filter.startDate !== "" ||
    filter.endDate !== "" ||
    filter.purchaseBatchId !== "All" ||
    filter.salesBatchId !== "All" ||
    filter.productId !== "All" ||
    filter.customerId !== "All";

  return (
    <Card className="border border-slate-200 shadow-2xs bg-white rounded-md mb-5">
      <CardContent className="p-3.5 space-y-3">
        <div className="flex items-center justify-between pb-2 border-b border-slate-100">
          <div className="flex items-center gap-2 text-slate-700 font-semibold text-xs uppercase tracking-wider">
            <Filter className="w-3.5 h-3.5 text-slate-500 stroke-[1.5]" />
            <span>Filter Criteria</span>
          </div>

          {isFiltered && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onReset}
              className="h-7 text-xs text-slate-500 hover:text-slate-900 gap-1 px-2"
            >
              <RotateCcw className="w-3 h-3 stroke-[1.5]" />
              Reset Filters
            </Button>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2.5">
          {/* Financial Year */}
          <div>
            <Label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1 block">
              Financial Year
            </Label>
            <Select
              value={filter.financialYear}
              onValueChange={(val) => handleChange("financialYear", val)}
            >
              <SelectTrigger className="h-8 text-xs bg-slate-50/50 border-slate-200 rounded-md">
                <SelectValue placeholder="All Years" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="All">All Financial Years</SelectItem>
                {filterOptions.financialYears.map((fy) => (
                  <SelectItem key={fy} value={fy}>
                    {fy}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Start Date */}
          <div>
            <Label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1 block">
              Start Date
            </Label>
            <Input
              type="date"
              value={filter.startDate}
              onChange={(e) => handleChange("startDate", e.target.value)}
              className="h-8 text-xs bg-slate-50/50 border-slate-200 rounded-md"
            />
          </div>

          {/* End Date */}
          <div>
            <Label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1 block">
              End Date
            </Label>
            <Input
              type="date"
              value={filter.endDate}
              onChange={(e) => handleChange("endDate", e.target.value)}
              className="h-8 text-xs bg-slate-50/50 border-slate-200 rounded-md"
            />
          </div>

          {/* Purchase Batch */}
          <div>
            <Label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1 block">
              Purchase Batch
            </Label>
            <Select
              value={filter.purchaseBatchId}
              onValueChange={(val) => handleChange("purchaseBatchId", val)}
            >
              <SelectTrigger className="h-8 text-xs bg-slate-50/50 border-slate-200 rounded-md">
                <SelectValue placeholder="All Batches" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="All">All Purchase Batches</SelectItem>
                {filterOptions.purchaseBatches.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    Batch ({b.id.slice(0, 8)})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Product Filter */}
          <div>
            <Label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1 block">
              Product
            </Label>
            <Select
              value={filter.productId}
              onValueChange={(val) => handleChange("productId", val)}
            >
              <SelectTrigger className="h-8 text-xs bg-slate-50/50 border-slate-200 rounded-md">
                <SelectValue placeholder="All Products" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="All">All Products</SelectItem>
                {filterOptions.products.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.product_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Customer Filter */}
          <div>
            <Label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1 block">
              Customer
            </Label>
            <Select
              value={filter.customerId}
              onValueChange={(val) => handleChange("customerId", val)}
            >
              <SelectTrigger className="h-8 text-xs bg-slate-50/50 border-slate-200 rounded-md">
                <SelectValue placeholder="All Customers" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="All">All Customers</SelectItem>
                {filterOptions.customers.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.company_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
