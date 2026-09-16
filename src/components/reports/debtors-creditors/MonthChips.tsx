"use client";

import { Button } from "@/components/ui/button";
import { MonthlySplitUpMonth } from "@/lib/services/monthly-splitup/types";

interface MonthChipsProps {
  months: MonthlySplitUpMonth[];
  selected: number[];
  onChange: (selected: number[]) => void;
}

export function MonthChips({ months, selected, onChange }: MonthChipsProps) {
  const toggle = (monthIndex: number) => {
    if (selected.includes(monthIndex)) {
      onChange(selected.filter((m) => m !== monthIndex));
    } else {
      onChange([...selected, monthIndex].sort((a, b) => a - b));
    }
  };

  return (
    <div className="flex flex-wrap gap-2">
      {months.map((m) => {
        const isSelected = selected.includes(m.monthIndex);
        return (
          <Button
            key={m.monthIndex}
            type="button"
            size="sm"
            variant={isSelected ? "default" : "outline"}
            className="rounded-full"
            onClick={() => toggle(m.monthIndex)}
          >
            {m.label}
          </Button>
        );
      })}
    </div>
  );
}
