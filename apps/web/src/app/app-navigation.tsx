"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

const pages = [
  { href: "/", title: "Calendar", mark: "▦" },
  { href: "/settings/goals", title: "Goals", mark: "◎" },
  { href: "/settings/availability", title: "Availability", mark: "◷" },
  { href: "/settings/profile", title: "Profile", mark: "○" },
];

export default function AppNavigation({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  return <div className="app-shell">
    <a href="#app-content" className="skip-link">Skip to content</a>
    <aside className="app-sidebar">
      <div className="flex items-center justify-between gap-3 px-5 py-5">
        <Link href="/" className="font-semibold tracking-tight">Training planner</Link>
        <button type="button" className="calendar-nav md:hidden" aria-expanded={open} aria-controls="main-navigation" onClick={() => setOpen(value => !value)}>Menu</button>
      </div>
      <nav id="main-navigation" aria-label="Main navigation" className={`${open ? "block" : "hidden"} space-y-1 px-3 pb-4 md:block`}>
        {pages.map(page => <Link key={page.href} href={page.href} onClick={() => setOpen(false)}
          aria-current={pathname === page.href ? "page" : undefined}
          className={`flex items-center gap-3 rounded-lg px-3 py-3 text-sm ${pathname === page.href ? "bg-blue-50 font-semibold text-blue-700" : "text-slate-600 hover:bg-slate-50"}`}>
          <span aria-hidden="true" className="w-5 text-lg">{page.mark}</span>{page.title}
        </Link>)}
      </nav>
    </aside>
    <div id="app-content" className="min-w-0" tabIndex={-1}>{children}</div>
  </div>;
}
