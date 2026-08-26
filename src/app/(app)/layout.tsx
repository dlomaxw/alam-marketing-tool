import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { getSendSwitch } from "@/lib/settings";
import { signOut } from "@/app/actions/auth";
import { Badge } from "@/components/ui";

const NAV: { href: string; label: string; permission?: string }[] = [
  { href: "/dashboard", label: "Dashboard", permission: "dashboard:read" },
  { href: "/sources", label: "Sources", permission: "source:upload" },
  { href: "/prospects", label: "Prospects", permission: "prospect:read" },
  { href: "/campaigns", label: "Campaigns", permission: "campaign:read" },
  { href: "/review", label: "Review", permission: "draft:read" },
  { href: "/send-queue", label: "Send queue", permission: "draft:read" },
  { href: "/activity", label: "Activity", permission: "dashboard:read" },
  { href: "/settings", label: "Settings", permission: "settings:manage" },
  { href: "/audit", label: "Audit", permission: "audit:read" },
];

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const send = await getSendSwitch();
  const items = NAV.filter((n) => !n.permission || user.permissions.includes(n.permission));

  return (
    <div className="min-h-screen">
      <header className="border-b border-[var(--color-line)] bg-white">
        <div className="mx-auto flex max-w-7xl items-center gap-6 px-6 py-3">
          <Link href="/dashboard" className="flex items-baseline gap-2">
            <span className="text-sm font-bold tracking-tight text-[var(--color-ink)]">ALAM</span>
            <span className="text-sm text-[var(--color-muted)]">Business Center</span>
          </Link>

          <nav className="flex flex-1 flex-wrap items-center gap-1">
            {items.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                className="rounded px-2.5 py-1.5 text-sm text-[var(--color-ink-2)] transition hover:bg-[var(--color-canvas)]"
              >
                {n.label}
              </Link>
            ))}
          </nav>

          <div className="flex items-center gap-3">
            {send.enabled
              ? <Badge tone="ok">Sending on</Badge>
              : <Badge tone="danger">Send off</Badge>}
            {!user.mfaSatisfied && <Badge tone="warn">MFA not verified</Badge>}
            <div className="text-right">
              <div className="text-xs font-medium text-[var(--color-ink)]">{user.name}</div>
              <div className="text-xs text-[var(--color-muted)]">{user.roleName}</div>
            </div>
            <form action={signOut}>
              <button className="text-xs text-[var(--color-muted)] underline underline-offset-2 hover:text-[var(--color-ink)]">
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-6">{children}</main>
    </div>
  );
}
