"use client";

import { Check, ChevronsUpDown, X } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { DebtorCreditorPerson } from "@/lib/services/debtors-creditors/types";

interface PeoplePickerProps {
  people: DebtorCreditorPerson[];
  selectedIds: string[];
  onChange: (selectedIds: string[]) => void;
  disabled?: boolean;
}

export function PeoplePicker({
  people,
  selectedIds,
  onChange,
  disabled,
}: PeoplePickerProps) {
  const [open, setOpen] = useState(false);
  const selectedPeople = selectedIds
    .map((id) => people.find((p) => p.id === id))
    .filter((p): p is DebtorCreditorPerson => !!p);

  const toggle = (id: string) => {
    if (selectedIds.includes(id)) {
      onChange(selectedIds.filter((s) => s !== id));
    } else {
      onChange([...selectedIds, id]);
    }
  };

  return (
    <div className="space-y-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            disabled={disabled}
            className="w-full justify-between h-10"
          >
            Search &amp; select suppliers...
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-full p-0" align="start">
          <Command>
            <CommandInput placeholder="Search by name or category..." />
            <CommandList>
              <CommandEmpty>No supplier found.</CommandEmpty>
              <CommandGroup>
                {people.map((person) => {
                  const isSelected = selectedIds.includes(person.id);
                  return (
                    <CommandItem
                      key={person.id}
                      value={`${person.companyName} ${person.category}`}
                      onSelect={() => toggle(person.id)}
                    >
                      <Check
                        className={cn(
                          "mr-2 h-4 w-4",
                          isSelected ? "opacity-100" : "opacity-0",
                        )}
                      />
                      <span className="flex-1">{person.companyName}</span>
                      <Badge variant="outline" className="ml-2">
                        {person.category}
                      </Badge>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {selectedPeople.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selectedPeople.map((person) => (
            <Badge key={person.id} variant="secondary" className="gap-1 pr-1">
              {person.companyName}
              <span className="text-slate-400">({person.category})</span>
              {!disabled && (
                <button
                  type="button"
                  className="ml-1 rounded-full hover:bg-slate-300/60"
                  onClick={() => toggle(person.id)}
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
