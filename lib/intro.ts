// Server only. The intro draft for one chosen path.
// Facts are re-read from the graph here, on the server, from ids: the client cannot hand in a "fact", and the
// language model never supplies one. Without a model the draft is a template filled with those facts; with
// one, the model may only reword that template, and its output is checked before it is accepted.

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
  /** A current role-holder of the peer, or null to write to the team. */
  person: string | null;
  sender?: string;
  reword?: boolean;
}

// The cheap model: it only rewords a short message. GEMINI_MODEL overrides it without a code change.
const MODEL = process.env.GEMINI_MODEL?.trim() || "gemini-3.5-flash-lite";
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const SENDER_PLACEHOLDER = "[your name]";

const holder = globalThis as unknown as { __twoHopsIntroCalls?: number };

function budget(): number {
  const n = Number(process.env.INTRO_LLM_BUDGET ?? 40);
  return Number.isFinite(n) && n >= 0 ? n : 40;
}

export function rewordBudgetLeft(): number {
  return Math.max(0, budget() - (holder.__twoHopsIntroCalls ?? 0));
}

function fact(key: string, text: string, sources: SourceView[], heldBack?: string): IntroFact {
  return { key, text, sources, rank: bestRank(sources.map((s) => s.rank)), ...(heldBack ? { heldBack } : {}) };
}

/** "April 2023", or the year alone when the record only knows the year (Cala writes those as 1 January). */
function monthYear(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  if (m === 1 && d === 1) return String(y);
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

interface Built {
  draft: IntroDraft;
  /** Names that a rewording has to keep, and whether the path says the investor led. */
  keep: string[];
  isLead: boolean;
  sender: string;
}

function build(req: IntroRequest): Built | null {
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
  const linkSources = unique([...path.links, ...(path.tranche ? [path.tranche] : [])].flatMap((l) => l.sources));
  if (path.round) {
    const r = path.round;
    const role = String(path.links[1]?.props.role ?? "INVESTOR");
    const verb = path.isLead ? "led" : role === "LENDER" ? "was a lender in" : "took part in";
    const generic = /^(funding|equity) round$/i.test(r.label);
    const mixed = r.severalLabels.length > 1;
    const named = !r.labelInferred && !mixed && !generic;
    const roundPhrase = named ? `${r.label}${/round|grant|financing|debt/i.test(r.label) ? "" : " round"}` : "funding round";
    // amount and date are stated only when the record holds one financing and the date is the round's own
    const datedByRound = Boolean(r.date) && r.dateBasis !== "earliest source";
    const details = mixed ? "" : [r.amount, datedByRound ? monthYear(r.date!) : null].filter(Boolean).join(", ");
    funding = `${investor.name} ${verb} ${peerName}'s ${roundPhrase}${details ? ` (${details})` : ""}`;
    const detailSources = mixed ? [] : r.node.facts.filter((f) => ["transaction_value", "event_date", "announcement_date"].includes(f.key)).flatMap((f) => f.sources);
    facts.push(fact("funding", `${funding}.`, unique([...linkSources, ...detailSources])));
    if (mixed) {
      facts.push(
        fact(
          "mixed",
          `Cala's record of this round carries ${r.severalLabels.length} labels: ${r.severalLabels.join(", ")}.`,
          [],
          "Several financings are folded into this one record, so the amount and the date it holds may belong to different ones. The message names neither and calls it a “funding round”; the graph shows each with its own source.",
        ),
      );
    } else if (r.labelInferred) {
      facts.push(fact("label", `Cala labels this round "${r.label}".`, [], "Cala inferred the label from the order of the rounds; no source states it, so the message says “funding round”."));
    }
    if (!mixed && r.date && !datedByRound) {
      facts.push(fact("date", `The earliest source on this link is dated ${r.date}.`, [], "That is when a source was published or read, not the round date, so the message gives no date."));
    }
  } else {
    funding = `${investor.name} is one of ${peerName}'s investors`;
    facts.push(fact("funding", `${investor.name} is recorded as an investor in ${peerName} (INVESTED_IN).`, linkSources));
  }

  let greeting = `Hi ${peerName} team,`;
  const keep = [investor.name, peerName];
  if (person) {
    const roles = [...new Set(person.roles.map((r) => (r.relation === "WORKS_AT" ? (r.role ?? "works at") : (r.role ?? r.relation))))];
    facts.push(fact("person", `${person.name} is recorded at ${peerName} as: ${roles.join(", ")}.`, unique(person.roles.flatMap((r) => r.link.sources))));
    const first = person.name.split(/\s+/)[0];
    greeting = `Hi ${first},`;
    keep.push(first);
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
  if (shared.country) facts.push(fact("country", `Cala places both companies in ${shared.country.label}.`, shared.country.sources));

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

  keep.push(sender); // the name the user typed, or the placeholder when they typed none
  return { draft: { to: person?.name ?? null, subject, body, facts, mode: "template" }, keep, isLead: path.isLead, sender };
}

export function templateIntro(req: IntroRequest): IntroDraft | null {
  return build(req)?.draft ?? null;
}

function systemPrompt(sender: string): string {
  const signature =
    sender === SENDER_PLACEHOLDER
      ? `The sender has not given a name yet, so the draft has the placeholder ${SENDER_PLACEHOLDER} in its place: keep that placeholder exactly as written, both times.`
      : `The sender's name is ${sender}: keep it exactly as written, and do not replace it with a placeholder.`;
  return `You help a startup founder write a short, warm message to another founder they will meet at the Slush conference this week. You are given a list of verified facts and a plain draft built from them. Rewrite the draft so it reads like one founder writing to another: natural, specific and friendly, under 120 words. The draft is deliberately stiff, so do not hand it back nearly unchanged: vary how the sentences open and flow, and merge or reorder them where that reads better.

The facts come from a sourced knowledge graph and the message is shown to the user next to those facts, so accuracy matters more than polish. Use only what the facts say. Do not add names, numbers, dates, amounts, descriptions of either company, compliments about the recipient's company, or claims about the sender that are not in the facts. Keep the verb the draft uses for what the investor did (led, took part in, was a lender in, is one of the investors): they mean different things. Write company and investor names exactly as the draft does. ${signature} Keep the ask the same: ten minutes at Slush, and an intro only if it feels right afterwards.

Reply with the message only: a first line starting with "Subject: ", then a blank line, then the body. No commentary before or after.`;
}

function numbers(text: string): string[] {
  return (text.match(/\d+(?:[.,]\d+)*/g) ?? []).map((n) => n.replace(/,/g, ""));
}

/**
 * The reworded text may not bring in anything new. Checked against the plain draft and the facts that went
 * into it (facts held back are not part of that):
 *  - no link;
 *  - every number is one of theirs, as a whole number and not as part of a longer one;
 *  - every capitalised word in the middle of a sentence (a name, a month) is one of theirs;
 *  - the investor, the peer and the person addressed are still named;
 *  - "led" appears only if the path says the investor led.
 * It does not judge the rest of the wording: the user reads the draft next to the facts before sending it.
 */
export function staysOnFacts(text: string, allowed: string, keep: string[], isLead: boolean): boolean {
  if (/https?:\/\//i.test(text)) return false;
  const allowedNumbers = new Set(numbers(allowed));
  if (/\bten minutes\b/i.test(allowed)) allowedNumbers.add("10"); // the same ask written with a digit
  if (numbers(text).some((n) => !allowedNumbers.has(n))) return false;
  const allowedWords = new Set((allowed.match(/[\p{L}\d]+/gu) ?? []).map((w) => w));
  for (const line of text.split(/\n/)) {
    let opener = true;
    for (const raw of line.split(/\s+/).filter(Boolean)) {
      for (const word of raw.match(/[\p{L}\d]+/gu) ?? []) {
        const isName = /^\p{Lu}/u.test(word) && word !== "I";
        if (isName && !opener && !allowedWords.has(word)) return false;
        opener = false;
      }
      if (/[.!?:]["')\]]?$/.test(raw)) opener = true;
    }
  }
  if (!isLead && /\b(led|leads?|leading|spearhead\w*|headed)\b/i.test(text)) return false;
  return keep.every((name) => text.includes(name));
}

interface GeminiResponse {
  candidates?: { finishReason?: string; content?: { parts?: { text?: string }[] } }[];
  promptFeedback?: { blockReason?: string };
  error?: { code?: number; status?: string; message?: string };
}

/** One call to Gemini's generateContent. Returns the text, or why there is none. The key travels in a header. */
async function gemini(key: string, system: string, user: string): Promise<{ text: string } | { why: string }> {
  let res: Response;
  try {
    res = await fetch(`${GEMINI_URL}/${encodeURIComponent(MODEL)}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { maxOutputTokens: 1024 }, // a deliberately short message, and a cost cap
      }),
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
    });
  } catch {
    return { why: "The language model could not be reached" };
  }
  let j: GeminiResponse | null = null;
  try {
    j = (await res.json()) as GeminiResponse;
  } catch {
    j = null;
  }
  if (!res.ok) {
    if (res.status === 429) return { why: "The language model is rate limited right now" };
    if (res.status === 401 || res.status === 403) return { why: "The language-model key on this server was not accepted" };
    // say what the provider said, cut short
    const said = String(j?.error?.message ?? "").replace(/\s+/g, " ").trim().slice(0, 140);
    return { why: `The language model turned the request down (${res.status}${said ? `: ${said}` : ""})` };
  }
  const c = j?.candidates?.[0];
  if (!c) return { why: `The language model returned nothing${j?.promptFeedback?.blockReason ? ` (${j.promptFeedback.blockReason})` : ""}` };
  if (c.finishReason && c.finishReason !== "STOP") return { why: `The model stopped early (${c.finishReason})` };
  const text = (c.content?.parts ?? []).map((part) => part.text ?? "").join("").trim();
  return text ? { text } : { why: "The language model returned an empty message" };
}

export async function buildIntro(req: IntroRequest): Promise<IntroDraft | null> {
  const built = build(req);
  if (!built || !req.reword) return built?.draft ?? null;
  const { draft, keep, isLead, sender } = built;
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) return { ...draft, note: "No language model is configured on this server (GEMINI_API_KEY), so this is the template draft." };
  if (rewordBudgetLeft() <= 0) return { ...draft, note: "The rewording budget on this server is used up, so this is the template draft." };
  holder.__twoHopsIntroCalls = (holder.__twoHopsIntroCalls ?? 0) + 1;

  // the model sees only the facts that may be used; what is held back stays on the page, not in the prompt
  const factLines = draft.facts.filter((f) => !f.heldBack).map((f) => `- ${f.text}`).join("\n");
  const original = `Subject: ${draft.subject}\n\n${draft.body}`;
  const out = await gemini(key, systemPrompt(sender), `<facts>\n${factLines}\n</facts>\n\n<draft>\n${original}\n</draft>`);
  if ("why" in out) return { ...draft, note: `${out.why}, so this is the template draft.` };

  const text = out.text.replace(/^```[a-z]*\s*\n|\n```\s*$/g, "").trim(); // in case the reply comes fenced
  const m = /^Subject:\s*(.+)\r?\n\s*\r?\n([\s\S]+)$/.exec(text);
  const lostName = sender !== SENDER_PLACEHOLDER && text.includes(SENDER_PLACEHOLDER);
  if (!m || lostName || text.length > 1500 || !staysOnFacts(text, `${original}\n${factLines}`, keep, isLead)) {
    return { ...draft, note: "The reworded version added or dropped something the facts do not support, so it was discarded. This is the template draft." };
  }
  return {
    ...draft,
    subject: m[1].trim(),
    body: m[2].trim(),
    mode: "reworded",
    note: `Reworded by ${MODEL}. It was given only the facts in use, and the result was checked: no link, number or name that is not in them. Read it against the facts before sending.`,
  };
}
