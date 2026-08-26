import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ALAM Business Center — Lease Outreach",
  description: "Approval-controlled leasing outreach for ALAM Business Center.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
