import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

// Inter, self-hosted by next/font; globals.css reads it through --font-inter.
const inter = Inter({ subsets: ["latin"], display: "swap", variable: "--font-inter" });

export const metadata: Metadata = {
  title: "Two Hops · the warm intro that is already at Slush",
  description:
    "For founders raising at Slush 2026: walk Cala's knowledge graph from your own startup to the investors who funded companies like yours, and to the founders in the room who can introduce you. Every step sourced.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body>{children}</body>
    </html>
  );
}
