"use client";

import React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";
import {
  LayoutDashboard,
  TrendingUp,
  CreditCard,
  Package,
  FileText,
  Layers,
  PlusCircle,
  Building2,
  Users,
  Sliders,
  LogOut,
  FileBarChart,
  ShoppingBag,
  Boxes,
  FolderArchive,
  Truck,
  Tag,
} from "lucide-react";

interface SidebarItem {
  name: string;
  href: string;
  icon: React.ElementType;
}

interface SidebarSection {
  title: string;
  items: SidebarItem[];
}

const sidebarSections: SidebarSection[] = [
  {
    title: "DASHBOARD",
    items: [
      { name: "Main Dashboard", href: "/", icon: LayoutDashboard },
      {
        name: "Profit & Loss",
        href: "/dashboard/profit-loss",
        icon: TrendingUp,
      },
      {
        name: "Expenditure Dashboard",
        href: "/dashboard/expense",
        icon: CreditCard,
      },
      {
        name: "Inventory Management",
        href: "/dashboard/inventory",
        icon: Package,
      },
    ],
  },
  {
    title: "INVOICES & EXPENDITURE",
    items: [
      {
        name: "Purchase Invoice",
        href: "/generate-purchase-invoice",
        icon: PlusCircle,
      },
      {
        name: "Purchase Invoice Batches",
        href: "/purchase-invoice-batches",
        icon: Layers,
      },
      { name: "Sales Invoice", href: "/generate-invoice", icon: FileText },
      { name: "Sales Invoice Batches", href: "/invoice-batches", icon: Layers },
      {
        name: "Expenditure Entry",
        href: "/generate-expense-batch",
        icon: CreditCard,
      },
      { name: "Expenditure Batches", href: "/expense-batches", icon: Layers },
    ],
  },
  {
    title: "REPORTS & DOCUMENTS",
    items: [
      {
        name: "Purchase Reports",
        href: "/reports/purchase",
        icon: ShoppingBag,
      },
      { name: "Sales Reports", href: "/reports/sales", icon: FileText },
      { name: "Inventory Reports", href: "/reports/inventory", icon: Package },
      {
        name: "Expenditure Reports",
        href: "/reports/expenditure",
        icon: CreditCard,
      },
      {
        name: "Profit & Loss Reports",
        href: "/reports/profit-loss",
        icon: TrendingUp,
      },
      { name: "Customer Reports", href: "/reports/customer", icon: Users },
    ],
  },
  {
    title: "MASTERS",
    items: [
      {
        name: "Issuing Companies",
        href: "/companies/issuing",
        icon: Building2,
      },
      {
        name: "Suppliers",
        href: "/companies/suppliers",
        icon: Truck,
      },
      {
        name: "Receiving Customers",
        href: "/companies/receiving",
        icon: Users,
      },
      { name: "Products", href: "/products", icon: Package },
      { name: "Product Rules", href: "/product-rules", icon: Sliders },
    ],
  },
];

export default function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const supabase = createClient();

  const handleLogout = async () => {
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  };

  return (
    <aside className="w-60 bg-slate-900 text-slate-300 flex flex-col h-screen fixed left-0 top-0 border-r border-slate-800 z-30 select-none">
      {/* Clean Branding Header - No Icon */}
      <div className="py-4 px-4 border-b border-slate-800">
        <h1 className="text-base font-bold text-white tracking-tight">
          Invoice Generator
        </h1>
      </div>

      {/* Navigation Sections */}
      <nav className="flex-1 px-2 py-3 overflow-y-auto space-y-4 text-xs">
        {sidebarSections.map((section, idx) => (
          <div key={idx} className="space-y-0.5">
            {/* Subtle Grey Uppercase Section Header */}
            <div className="px-2.5 pb-1 text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
              {section.title}
            </div>

            <ul className="space-y-0.5">
              {section.items.map((item) => {
                const isActive = pathname === item.href;
                const Icon = item.icon;

                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className={`flex items-center gap-2.5 px-2.5 py-1.5 rounded-md transition-colors text-xs ${
                        isActive
                          ? "bg-slate-800 text-white font-medium shadow-2xs"
                          : "text-slate-400 hover:bg-slate-800/60 hover:text-slate-200"
                      }`}
                    >
                      <Icon className="w-4 h-4 stroke-[1.5] shrink-0" />
                      <span className="truncate">{item.name}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      {/* Footer / Logout */}
      <div className="p-3 border-t border-slate-800 space-y-2">
        <Button
          onClick={handleLogout}
          variant="ghost"
          size="sm"
          className="w-full text-slate-400 hover:text-red-400 hover:bg-slate-800/80 justify-start h-8 text-xs font-medium px-2.5"
        >
          <LogOut className="w-4 h-4 mr-2 stroke-[1.5]" />
          Logout
        </Button>
        <p className="text-[10px] text-slate-600 px-2.5">
          © Novoz Infinity ERP
        </p>
      </div>
    </aside>
  );
}
