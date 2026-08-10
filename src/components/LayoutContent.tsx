"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";
import Sidebar from "./Sidebar";

interface LayoutContentProps {
  children: React.ReactNode;
}

export default function LayoutContent({ children }: LayoutContentProps) {
  const pathname = usePathname();
  const isLoginPage = pathname === "/login";

  // overflow-hidden on the shell div (below) only clips content that tries
  // to overflow THAT div's own box — it does nothing about an element that
  // escapes it entirely (e.g. anything fixed/absolute-positioned, or a
  // stray element appended straight to <body> by a third-party script or
  // library) inflating <html>'s own scrollHeight. Verified live: with only
  // the div-level fix, document.documentElement.scrollHeight measured
  // larger than document.body.scrollHeight (3271 vs 928) even though every
  // one of body's own children checked out at the correct height — proof
  // the escape was happening above the div, at the document level, which
  // only clipping <html> itself can categorically rule out regardless of
  // what specifically causes it. Scoped to non-login routes via a class
  // (not global CSS) so the login page — which has no shell div and relies
  // on ordinary body scroll — is unaffected.
  useEffect(() => {
    const root = document.documentElement;
    if (isLoginPage) {
      root.classList.remove("app-shell-active");
      return;
    }
    root.classList.add("app-shell-active");
    return () => {
      root.classList.remove("app-shell-active");
    };
  }, [isLoginPage]);

  if (isLoginPage) {
    return <>{children}</>;
  }

  return (
    // overflow-hidden here is the hard boundary: without it, content can
    // still visually overflow this h-screen box even though main has its
    // own overflow-auto, letting <body> itself grow taller than the
    // viewport and become independently scrollable — which is what let you
    // scroll the fixed sidebar's column straight past all real content into
    // blank space beneath it.
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      {/* min-h-0 overrides the flex item's default min-height:auto — without
          it, a flex child with overflow-auto doesn't actually clip/scroll
          internally once its content exceeds the h-screen parent; it just
          grows past the viewport instead. */}
      <main className="flex-1 ml-60 min-h-0 overflow-auto">
        <div className="p-8">{children}</div>
      </main>
    </div>
  );
}
