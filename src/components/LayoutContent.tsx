"use client";

import { usePathname } from "next/navigation";
import Sidebar from "./Sidebar";

interface LayoutContentProps {
  children: React.ReactNode;
}

export default function LayoutContent({ children }: LayoutContentProps) {
  const pathname = usePathname();
  const isLoginPage = pathname === "/login";

  if (isLoginPage) {
    return <>{children}</>;
  }

  return (
    <div className="flex h-screen">
      <Sidebar />
      <main className="flex-1 ml-64 overflow-auto">
        <div className="p-8">{children}</div>
      </main>
    </div>
  );
}
