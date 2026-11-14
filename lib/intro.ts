// Server only. The intro draft for one chosen path.
// Facts are re-read from the graph here, on the server, from ids: the client cannot hand in a "fact", and the
// language model never supplies one. Without a model the draft is a template filled with those facts; with
// one, the model may only reword that template, and its output is checked before it is accepted.

import Anthropic from "@anthropic-ai/sdk";
import { introContext } from "./engine";
import { bestRank, type Rank } from "./rank";
import type { SourceView } from "./types";

export interface IntroFact {
  key: string;
  text: string;
  sources: SourceView[];
  rank: Rank;
  /** Shown to the reader but kept out of the message, with the reason. */
  heldBack?: string;
}

export interface IntroDraft {
  to: string | null;
  subject: string;
  body: string;
  facts: IntroFact[];
  mode: "template" | "reworded";
  note?: string;
}

export interface IntroRequest {
  me: string;
  investor: string;
  peer: string;
  round: string | null;
  person: string | null;
  sender?: string;
  reword?: boolean;
}

const MODEL = "claude-haiku-5-5"; // the cheap model: it only rewords a short message
const SENDER_PLACEHOLDER = "[your name]";

const holder = globalThis as unknown as { __twoHopsIntroCalls?: number };

export function rewordBudgetLeft(): number {
  return Math.max(0, Number(process.env.INTRO_LLM_BUDGET ?? 40) - (holder.__twoHopsIntroCalls ?? 0));
}

function fact(key: string, text: string, sources: SourceView[], heldBack?: string): IntroFact {
  return { key, text, sources, rank: bestRank(sources.map((s) => s.rank)), ...(heldBack ? { heldBack } : {}) };
}

function monthYear(date: string): string {
  const [y, m] = date.split("-").map(Number);
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return m >= 1 && m <= 12 ? `${months[m - 1]} ${y}` : String(y);
}

function unique(sources: SourceView[]): SourceView[] {
  const seen = new Set<string>();
  return sources.filter((s) => {
    const k = `${s.name}|${s.url}|${s.date}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function templateIntro(req: IntroRequest): IntroDraft | null {
  const ctx = introContext(req.me, req.investor, req.peer, req.round, req.person);
  if (!ctx) return null;
  const { meName, peer, path, investor, person, shared } = ctx;
  const sender = (req.sender ?? "").replace(/[\r\n<>]/g, " ").trim().slice(0, 60) || SENDER_PLACEHOLDER;
  const peerName = peer.node.name;
  const facts: IntroFact[] = [];

  facts.push(
    fact(
      "attendance",
      `${meName} and ${peerName} are both linked to Slush 2026 in Cala as attendees.`,
      unique([...ctx.attendanceSources, ...peer.attendance.sources]),
    ),
  );

  // the funding link: only what the path itself states
  let funding: string;
  const linkSources = unique(path.links.flatMap((l) => l.sources));
  if (path.round) {
    const r = path.round;
    const role = String(path.links[1]?.props.role ?? "INVESTOR");
    const verb = path.isLead ? "led" : role === "LENDER" ? "was a lender in" : "took part in";
    const generic = /^(funding|equity) round$/i.test(r.label);
    const named = !r.labelInferred && !generic;
    const roundPhrase = named ? `${r.label}${/round|grant|financing|debt/i.test(r.label) ? "" : " round"}` : "funding round";
    const datedByRound = r.date && r.dateBasis !== "earliest source";
    const details = [r.amount, datedByRound ? monthYear(r.date!) : null].filter(Boolean).join(", ");
    funding = `${investor.name} ${verb} ${peerName}'s ${roundPhrase}${details ? ` (${details})` : ""}`;
    const roundSources = unique([...linkSources, ...r.node.facts.filter((f) => ["transaction_value", "event_date", "announcement_date", "round_label"].includes(f.key)).flatMap((f) => f.sources)]);
    facts.push(fact("funding", `${funding}.`, roundSources));
    if (r.labelInferred) {
      facts.push(fact("label", `Cala labels this round "${r.label}".`, [], "Cala inferred the label from the order of the rounds; no source states it, so the message says “funding round”."));
    }
    if (r.date && !datedByRound) {
      facts.push(fact("date", `The earliest source on this link is dated ${r.date}.`, [], "That is when a source was published or read, not the round date, so the message gives no date."));
    }
  } else {
    funding = `${investor.name} is one of ${peerName}'s investors`;
    facts.push(fact("funding", `${investor.name} is recorded as an investor in ${peerName} (INVESTED_IN).`, linkSources));
  }

  let greeting = `Hi ${peerName} team,`;
  if (person) {
    const roles = [...new Set(person.roles.map((r) => (r.relation === "WORKS_AT" ? (r.role ?? "works at") : (r.role ?? r.relation))))];
    facts.push(fact("person", `${person.name} is recorded at ${peerName} as: ${roles.join(", ")}.`, unique(person.roles.flatMap((r) => r.link.sources))));
    greeting = `Hi ${person.name.split(/\s+/)[0]},`;
  }

  let common = "";
  if (shared.industry && shared.country) {
    common = `, and like ${peerName} we are a ${shared.industry.label.toLowerCase()} company based in ${shared.country.label}`;
  } else if (shared.industry) {
    common = `, and like ${peerName} we work in ${shared.industry.label.toLowerCase()}`;
  } else if (shared.country) {
    common = `, and like ${peerName} we are based in ${shared.country.label}`;
  }
  if (shared.industry) facts.push(fact("industry", `Cala files both companies under ${shared.industry.label}.`, shared.industry.sources));
  if (shared.country) facts.push(fact("country", `Both companies have their headquarters in ${shared.country.label}.`, shared.country.sources));

  const subject = `Slush this week: a question about ${investor.name}`;
  const body = [
    greeting,
    "",
    `I'm ${sender}, founder of ${meName}. We are both at Slush this week${common}.`,
    "",
    `I saw that ${funding}. We are raising at the moment and they are on my list because of that.`,
    "",
    "Could I borrow ten minutes at Slush to hear how it has been to work with them? If it seems like a fit afterwards, an intro would mean a lot.",
    "",
    "Thanks,",
    sender,
  ].join("\n");

  return { to: person?.name ?? null, subject, body, facts, mode: "template" };
}

const SYSTEM = `You help a startup founder write a short, warm message to another founder they will meet at the Slush conference this week. You are given a list of verified facts and a plain draft built from them. Rewrite the draft so it reads like a person wrote it: natural, specific and friendly, under 120 words.

The facts come from a sourced knowledge graph and the message is shown to the user next to those facts, so accuracy matters more than polish. Use only what the facts say. Do not add names, numbers, dates, amounts, descriptions of either company, compliments about the recipient's company, or claims about the sender that are not in the facts. Leave out any fact marked "held back". Keep bracketed placeholders such as ${SENDER_PLACEHOLDER} exactly as written, and keep the ask the same: ten minutes at Slush, and an intro only if it feels right afterwards.

Reply with the message only: a first line starting with "Subject: ", then a blank line, then the body. No commentary before or after.`;

/**
 * The reworded text may not bring in anything new: no link, no number that is not in the template or the facts,
 * and no capitalised word in the middle of a sentence (a name) that is not there either. Sentence openers are
 * ordinary words and are left alone. The names that must survive (the investor) have to still be present.
 */
function staysOnFacts(text: string, allowed: string, mustKeep: string[]): boolean {
  if (/https?:\/\//i.test(text)) return false;
  for (const n of text.match(/\d[\d.,]*/g) ?? []) {
    if (!allowed.includes(n.replace(/[.,]$/, ""))) return false;
  }
  let opener = true;
  for (const line of text.split(/\n/)) {
    opener = true;
    for (const raw of line.split(/\s+/).filter(Boolean)) {
      const word = raw.replace(/^[^\p{L}\d\[]+|[^\p{L}\d\]]+$/gu, "");
      const isName = /^\p{Lu}/u.test(word) && word !== "I" && !/^I['’]/.test(word);
      if (isName && !opener && !allowed.includes(word.replace(/['’]s$/, ""))) return false;
      opener = /[.!?:]$/.test(raw);
    }
  }
  return mustKeep.every((name) => text.includes(name));
}

export async function buildIntro(req: IntroRequest): Promise<IntroDraft | null> {
  const draft = templateIntro(req);
  if (!draft || !req.reword) return draft;
  if (rewordBudgetLeft() <= 0) return { ...draft, note: "The rewording budget on this server is used up, so this is the template draft." };

  let client: Anthropic;
  try {
    client = new Anthropic(); // credentials from the environment (ANTHROPIC_API_KEY)
  } catch {
    return { ...draft, note: "No language model is configured on this server, so this is the template draft." };
  }
  holder.__twoHopsIntroCalls = (holder.__twoHopsIntroCalls ?? 0) + 1;

  const factLines = draft.facts.map((f) => `- ${f.text}${f.heldBack ? ` (held back: ${f.heldBack})` : ""}`).join("\n");
  const original = `Subject: ${draft.subject}\n\n${draft.body}`;
  try {
    const response = await client.messages.create(
      {
        model: MODEL,
        max_tokens: 1024, // a deliberately short message, and a cost cap
        thinking: { type: "disabled" },
        output_config: { effort: "low" },
        system: SYSTEM,
        messages: [{ role: "user", content: `<facts>\n${factLines}\n</facts>\n\n<draft>\n${original}\n</draft>` }],
      },
      { timeout: 20_000, maxRetries: 1 },
    );
    if (response.stop_reason !== "end_turn") {
      return { ...draft, note: `The model stopped early (${response.stop_reason}), so this is the template draft.` };
    }
    let text = "";
    for (const block of response.content) if (block.type === "text") text += block.text;
    text = text.trim();
    const m = /^Subject:\s*(.+)\r?\n\s*\r?\n([\s\S]+)$/.exec(text);
    const investorName = draft.subject.replace(/^.*a question about /, "");
    if (!m || text.length > 1500 || !staysOnFacts(text, `${original}\n${factLines}`, [investorName])) {
      return { ...draft, note: "The reworded version added or dropped something the facts do not support, so it was discarded. This is the template draft." };
    }
    return {
      ...draft,
      subject: m[1].trim(),
      body: m[2].trim(),
      mode: "reworded",
      note: `Reworded by ${MODEL}. It was given only these facts, and the result was checked: no number and no name in it is missing from them.`,
    };
  } catch (error) {
    let why = "The language model could not be reached";
    if (error instanceof Anthropic.AuthenticationError) why = "No valid language-model key is configured on this server";
    else if (error instanceof Anthropic.RateLimitError) why = "The language model is rate limited right now";
    else if (error instanceof Anthropic.APIError) why = `The language model answered with an error (${error.status ?? "no status"})`;
    else if (error instanceof Error && /api[_ ]?key|auth|credential/i.test(error.message)) why = "No language-model key is configured on this server";
    return { ...draft, note: `${why}, so this is the template draft.` };
  }
}
