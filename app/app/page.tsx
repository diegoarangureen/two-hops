import type { Metadata } from "next";
import AppClient from "@/components/AppClient";

export const metadata: Metadata = {
  title: "Two Hops · find your path to an investor at Slush 2026",
};

export default function AppPage() {
  return <AppClient />;
}
