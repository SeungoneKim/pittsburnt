import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Pittsburnt — a crash test for cities",
  description:
    "Stress-test pedestrian heat exposure in Oakland, Pittsburgh, then measure which interventions reduce it most per dollar.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
