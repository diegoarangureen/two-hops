import { NextResponse } from "next/server";
import { liveBudgetLeft } from "@/lib/cala";
import { coverage, setOps, suggestions } from "@/lib/engine";

export const dynamic = "force-dynamic";

/** Whole-set numbers: what is loaded, who funds several attendees, who co-invests, and the data traps found. */
export function GET() {
  return NextResponse.json({ coverage: coverage(), setOps: setOps(), suggestions: suggestions(), liveBudgetLeft: liveBudgetLeft() });
}
