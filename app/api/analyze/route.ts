import { NextResponse } from "next/server";
import { fetchProfile, liveBudgetLeft } from "@/lib/cala";
import { analyze, isAttendee } from "@/lib/engine";
import { getGraph } from "@/lib/graph";
import type { LiveCall } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Walk the graph from one attendee. Reads its profile from Cala first if it is not cached: the one live call. */
export async function POST(request: Request) {
  let id = "";
  try {
    id = String((await request.json())?.id ?? "");
  } catch {
    // fall through to the 400 below
  }
  if (!/^[0-9a-f-]{36}$/.test(id) || !isAttendee(id)) {
    return NextResponse.json({ error: "Pick a company from the Slush 2026 attendee list." }, { status: 400 });
  }
  const g = getGraph();
  let live: LiveCall = { called: false, budgetLeft: liveBudgetLeft() };
  if (!g.node(id)?.loaded) {
    live = (await fetchProfile(id, g.attendees.get(id)![2])).live;
  }
  return NextResponse.json(analyze(id, live));
}
