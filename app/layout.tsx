import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Two Hops · the warm intro that is already at Slush",
  description:
    "For founders raising at Slush 2026: walk Cala's knowledge graph from your own startup to the investors who funded companies like yours, and to the founders in the room who can introduce you. Every step sourced.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
