import { NextResponse } from "next/server";
import { buildIntro, rewordBudgetLeft, type IntroRequest } from "@/lib/intro";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f-]{36}$/;

/** Draft the intro message for one path. Takes ids only: the facts are re-read from the graph on the server. */
export async function POST(request: Request) {
  let b: Record<string, unknown> = {};
  try {
    b = (await request.json()) ?? {};
  } catch {
    // handled by the validation below
  }
  const id = (v: unknown) => (typeof v === "string" && UUID.test(v) ? v : null);
  const me = id(b.me);
  const investor = id(b.investor);
  const peer = id(b.peer);
  if (!me || !investor || !peer) return NextResponse.json({ error: "me, investor and peer must be Cala entity ids." }, { status: 400 });
  const req: IntroRequest = {
    me,
    investor,
    peer,
    round: id(b.round),
    person: id(b.person),
    sender: typeof b.sender === "string" ? b.sender : undefined,
    reword: b.reword === true,
  };
  const draft = await buildIntro(req);
  if (!draft) return NextResponse.json({ error: "That path is not in the graph." }, { status: 404 });
  return NextResponse.json({ ...draft, rewordBudgetLeft: rewordBudgetLeft() });
}
