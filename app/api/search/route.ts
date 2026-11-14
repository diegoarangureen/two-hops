import { NextResponse } from "next/server";
import { searchAttendees, suggestions } from "@/lib/engine";

export const dynamic = "force-dynamic";

/** Name search over the full attendee list. Local: it never calls Cala. */
export function GET(request: Request) {
  const q = new URL(request.url).searchParams.get("q")?.slice(0, 80) ?? "";
  return NextResponse.json(q.trim() ? { hits: searchAttendees(q) } : { hits: [], suggestions: suggestions() });
}
