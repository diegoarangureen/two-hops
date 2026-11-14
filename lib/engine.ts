// Server only. Walks the graph from one attendee: peers at the event, their rounds, who funded and who led,
// and the people to ask. Every value returned carries the sources Cala gave for it.

import { getGraph, SLUSH_2026, type GEdge, type GNode, type Graph } from "./graph";
import { bestRank, toRank, weakestRank, type Rank } from "./rank";
import { rankInvestors } from "./score";
import type {
  Analysis,
  Coverage,
  Fact,
  InvestorView,
  LinkView,
  LiveCall,
  NodeView,
  PathView,
  PeerView,
  PersonRole,
  PersonView,
  RoundView,
  SearchHit,
  SetOps,
  Similarity,
  SimilarityFactor,
  SourceView,
} from "./types";

const MAX_INVESTORS = 150;
const MAX_PATHS_PER_INVESTOR = 30;
const MAX_SOURCES_PER_ITEM = 8;

// ---------------------------------------------------------------------------------------------------------
// provenance

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function ageDays(date: string | null, now: string): number | null {
  if (!date) return null;
  const t = Date.parse(date.slice(0, 10));
  return Number.isNaN(t) ? null : Math.max(0, Math.round((Date.parse(now) - t) / 86400000));
}

function safeUrl(u: string | null): string | null {
  return u && /^https?:\/\//i.test(u) ? u : null;
}

function host(u: string | null): string | null {
  try {
    return u ? new URL(u).hostname.replace(/^www\./, "") : null;
  } catch {
    return null;
  }
}

const RANK_ORDER: Record<Rank, number> = { FILING: 4, PRIMARY: 3, PRESS: 2, AGGREGATOR: 1, UNRANKED: 0 };

function sourceViews(g: Graph, ixs: number[], now: string): SourceView[] {
  const out = ixs.map((i) => {
    const s = g.sources[i];
    return {
      name: s.name || host(s.document) || "unnamed source",
      url: safeUrl(s.document),
      date: s.date,
      precision: s.date_precision,
      rank: toRank(s.source_rank),
      ageDays: ageDays(s.date, now),
    };
  });
  out.sort((a, b) => RANK_ORDER[b.rank] - RANK_ORDER[a.rank] || (b.date ?? "").localeCompare(a.date ?? ""));
  return out.slice(0, MAX_SOURCES_PER_ITEM);
}

function edgeRank(g: Graph, e: GEdge): Rank {
  return bestRank(e.sources.map((i) => toRank(g.sources[i].source_rank)));
}

function cleanProps(props: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(props)) {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
  }
  return out;
}

function linkView(g: Graph, e: GEdge, now: string, note?: string): LinkView {
  const sources = sourceViews(g, e.sources, now);
  const notes = [note, e.reciprocal ? "Cala also records this investment the other way round" : undefined].filter(Boolean);
  return {
    id: e.id,
    type: e.type,
    from: e.from,
    to: e.to,
    props: cleanProps(e.props),
    sources,
    rank: edgeRank(g, e),
    calaIds: e.cala_ids ?? [e.id],
    ...(notes.length ? { note: notes.join(". ") } : {}),
  };
}

function attendanceLink(g: Graph, id: string, now: string): LinkView {
  const row = g.attendees.get(id);
  const ixs = row?.[5] ?? g.meta.event.attendance_sources;
  const sources = sourceViews(g, ixs, now);
  return {
    id: row?.[4] ?? `PARTICIPATES_IN_EVENT:${id}`,
    type: "PARTICIPATES_IN_EVENT",
    from: id,
    to: SLUSH_2026,
    props: row?.[3] ? { role: row[3] } : {},
    sources,
    rank: bestRank(sources.map((s) => s.rank)),
    calaIds: row?.[4] ? [row[4]] : [],
  };
}

// ---------------------------------------------------------------------------------------------------------
// values

/** A property value, but only if Cala gave a source for it: unsourced values are neither shown nor used. */
function prop(n: GNode | undefined, key: string): unknown {
  const p = n?.props[key];
  return p && p.sources.length ? p.value : undefined;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function money(value: unknown, units: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const u = str(units) ?? "";
  const abs = Math.abs(value);
  const txt =
    abs >= 1e9 ? `${trim(value / 1e9)}B` : abs >= 1e6 ? `${trim(value / 1e6)}M` : abs >= 1e3 ? `${trim(value / 1e3)}K` : `${value}`;
  return `${u} ${txt}`.trim();
}

function trim(x: number): string {
  return x.toFixed(x >= 100 ? 0 : x >= 10 ? 1 : 2).replace(/\.?0+$/, "");
}

function pretty(code: string): string {
  return code
    .toLowerCase()
    .split("_")
    .map((w) => (w === "and" ? "&" : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ")
    .replace(/^Pre /, "Pre-");
}

function showDate(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  return /^\d{4}-01-01$/.test(s) ? s.slice(0, 4) : s.slice(0, 10);
}

const FACT_ORDER: [string, string][] = [
  ["name", "Name"],
  ["legal_name", "Legal name"],
  ["aliases", "Also known as"],
  ["description", "Description"],
  ["website", "Website"],
  ["founding_date", "Founded"],
  ["headquarters_address", "Headquarters"],
  ["registered_address", "Registered address"],
  ["funding_stage", "Stage"],
  ["total_funding", "Total funding"],
  ["operational_status", "Status"],
  ["company_ownership_status", "Ownership"],
  ["round_label", "Round label"],
  ["instrument", "Instrument"],
  ["transaction_value", "Amount"],
  ["event_date", "Round date"],
  ["announcement_date", "Announced"],
  ["annotations", "Cala's notes on this round"],
];

function factValue(n: GNode, key: string): string | null {
  const v = prop(n, key);
  if (v === undefined || v === null) return null;
  if (key === "total_funding") return money(v, prop(n, "total_funding_units"));
  if (key === "transaction_value") return money(v, prop(n, "transaction_value_units"));
  if (key === "founding_date" || key === "event_date" || key === "announcement_date") return showDate(v);
  if (key === "funding_stage" || key === "round_label" || key === "instrument" || key === "operational_status") {
    return typeof v === "string" ? pretty(v) : null;
  }
  if (Array.isArray(v)) return v.map((x) => String(x)).join(" · ") || null;
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

function facts(g: Graph, n: GNode, now: string): Fact[] {
  const out: Fact[] = [];
  for (const [key, label] of FACT_ORDER) {
    const value = factValue(n, key); // undefined when the value has no source
    if (!value) continue;
    const sources = sourceViews(g, n.props[key].sources, now);
    out.push({ key, label, value, sources, rank: bestRank(sources.map((s) => s.rank)) });
  }
  return out;
}

/** Labels of the values Cala holds for this entity without any source. They are named, not shown. */
function unsourced(n: GNode): string[] {
  return FACT_ORDER.filter(([key]) => n.props[key] && !n.props[key].sources.length).map(([, label]) => label);
}

function nodeView(g: Graph, id: string, now: string): NodeView {
  const n = g.node(id);
  const row = g.attendees.get(id);
  if (!n) {
    return {
      id,
      type: row?.[2] ?? "Entity",
      name: row?.[1] ?? id,
      loaded: false,
      attendee: Boolean(row),
      facts: [],
      unsourced: [],
      flags: ["profile not loaded"],
    };
  }
  const flags: string[] = [];
  if (!n.loaded) flags.push("profile not loaded");
  if (n.label_inferred) flags.push("round label inferred by Cala");
  if (n.merged) flags.push(`merged from ${n.merged.length} Cala records`);
  return {
    id: n.id,
    type: n.type,
    name: n.name,
    loaded: n.loaded,
    attendee: Boolean(n.attendee),
    facts: facts(g, n, now),
    unsourced: unsourced(n),
    flags,
    ...(n.merged ? { merged: n.merged } : {}),
  };
}

// ---------------------------------------------------------------------------------------------------------
// company features and similarity

interface Features {
  industries: { code: string; label: string | null }[];
  country: string | null;
  hq: string | null;
  stage: string | null;
  founded: string | null;
  tokens: Set<string>;
}

const STOP = new Set(
  (
    "about above after again against also among and are based been before being between both business company companies " +
    "could does each every first for from founded founder founders have having headquartered help helps here high into its " +
    "just like make makes more most much need needs new next not now only other our out over own platform product products " +
    "provide provides providing service services solution solutions some such than that the their them then there these they " +
    "this those through time under until use used uses using very was way were what when where which while who will with " +
    "within without world you your global leading across around offers offering enable enables enabling built build builds " +
    "learn every team teams customer customers user users people technology technologies tech startup startups industry " +
    "industries data software digital free better best real management value high capacity experience existing"
  ).split(" "),
);

function tokens(text: string | null): Set<string> {
  const out = new Set<string>();
  for (const w of (text ?? "").toLowerCase().split(/[^a-z0-9äöåéèüßñç]+/)) {
    if (w.length < 4 || STOP.has(w) || /^\d+$/.test(w)) continue;
    const stem = w.replace(/(ies|es|s)$/, (m) => (m === "ies" ? "y" : ""));
    if (stem.length >= 4 && !STOP.has(stem)) out.add(stem);
  }
  return out;
}

function features(g: Graph, n: GNode | undefined): Features | null {
  if (!n || !n.loaded) return null;
  const industries = g
    .outgoing(n.id, "OPERATES_IN_INDUSTRY")
    .filter((e) => e.sources.length > 0)
    .map((e) => ({ code: g.node(e.to)?.name ?? "", label: str(e.props.original_label) }))
    .filter((i) => i.code);
  const hq = str(prop(n, "headquarters_address"));
  let country: string | null = null;
  if (hq) country = hq.split(",").pop()!.trim() || null;
  if (!country) {
    for (const rel of ["HAS_HEADQUARTERS_IN", "IS_REGISTERED_IN"]) {
      const c = g.outgoing(n.id, rel).filter((e) => e.sources.length > 0).map((e) => g.node(e.to)).find((x) => x?.type === "Country");
      if (c) {
        country = c.name;
        break;
      }
    }
  }
  return {
    industries,
    country,
    hq: hq ? hq.split(",").slice(-2).join(",").trim() : country,
    stage: str(prop(n, "funding_stage")),
    founded: showDate(prop(n, "founding_date"))?.slice(0, 4) ?? null,
    tokens: tokens(str(prop(n, "description"))),
  };
}

function headline(f: Features | null): PeerView["headline"] {
  if (!f) return {};
  const i = f.industries[0];
  return {
    ...(i ? { industry: i.label ? `${pretty(i.code)} · ${i.label}` : pretty(i.code) } : {}),
    ...(f.hq ? { hq: f.hq } : {}),
    ...(f.stage ? { stage: pretty(f.stage) } : {}),
    ...(f.founded ? { founded: f.founded } : {}),
  };
}

const STAGES = ["PRE_SEED", "SEED", "PRE_SERIES_A", "SERIES_A", "SERIES_B", "SERIES_C", "SERIES_D", "SERIES_E", "SERIES_F"];
export const SIMILARITY_WEIGHTS = { industry: 0.4, label: 0.1, country: 0.2, stage: 0.15, description: 0.15 } as const;

function similarity(me: Features | null, peer: Features | null): Similarity {
  if (!me) return { score: null, factors: [], note: "Your profile is not loaded, so peers cannot be compared with you." };
  if (!peer) return { score: null, factors: [], note: "This company's profile is not loaded yet: only its funding link is known." };
  const factors: SimilarityFactor[] = [];
  const add = (key: SimilarityFactor["key"], label: string, score: number, detail: string) =>
    factors.push({ key, label, weight: SIMILARITY_WEIGHTS[key], score, detail });

  const myCodes = new Set(me.industries.map((i) => i.code));
  const sharedCodes = peer.industries.filter((i) => myCodes.has(i.code)).map((i) => pretty(i.code));
  add(
    "industry",
    "Same industry",
    sharedCodes.length ? 1 : 0,
    sharedCodes.length
      ? sharedCodes.join(", ")
      : !me.industries.length || !peer.industries.length
        ? "no industry in Cala for one of the two"
        : `${pretty(me.industries[0].code)} vs ${pretty(peer.industries[0].code)}`,
  );

  const myLabels = new Set(me.industries.map((i) => i.label?.toLowerCase()).filter(Boolean));
  const sharedLabels = peer.industries.map((i) => i.label).filter((l): l is string => !!l && myLabels.has(l.toLowerCase()));
  add("label", "Same sector tag", sharedLabels.length ? 1 : 0, sharedLabels.length ? sharedLabels.join(", ") : "no shared tag");

  const sameCountry = !!me.country && !!peer.country && me.country.toLowerCase() === peer.country.toLowerCase();
  add(
    "country",
    "Same country",
    sameCountry ? 1 : 0,
    sameCountry ? me.country! : me.country && peer.country ? `${me.country} vs ${peer.country}` : "no headquarters in Cala for one of the two",
  );

  const a = me.stage ? STAGES.indexOf(me.stage) : -1;
  const b = peer.stage ? STAGES.indexOf(peer.stage) : -1;
  const stageScore = a < 0 || b < 0 ? 0 : a === b ? 1 : Math.abs(a - b) === 1 ? 0.5 : 0;
  add(
    "stage",
    "Stage",
    stageScore,
    !me.stage || !peer.stage
      ? "no stage in Cala for one of the two"
      : a === b
        ? `both ${pretty(me.stage)}`
        : `${pretty(me.stage)} vs ${pretty(peer.stage)}`,
  );

  const shared = [...peer.tokens].filter((t) => me.tokens.has(t));
  add("description", "Shared terms", Math.min(1, shared.length / 4), shared.length ? shared.slice(0, 6).join(", ") : "none");

  const score = factors.reduce((s, f) => s + f.weight * f.score, 0);
  return { score: Math.round(score * 100) / 100, factors };
}

// ---------------------------------------------------------------------------------------------------------
// people

const PERSON_RELS = ["FOUNDED", "IS_CEO_OF", "IS_CTO_OF", "WORKS_AT", "IS_BOARD_MEMBER_OF"];
const ROLE_LABEL: Record<string, string> = {
  FOUNDED: "Founder",
  IS_CEO_OF: "CEO",
  IS_CTO_OF: "CTO",
  WORKS_AT: "Works at",
  IS_BOARD_MEMBER_OF: "Board member",
};

function isCurrent(e: GEdge, now: string): boolean {
  const until = str(e.props.valid_until);
  return !until || until.slice(0, 10) >= now;
}

function peopleOf(g: Graph, companyId: string, now: string): { current: PersonView[]; former: number } {
  const byPerson = new Map<string, GEdge[]>();
  for (const e of g.incoming(companyId)) {
    if (!PERSON_RELS.includes(e.type) || !e.sources.length) continue;
    if (g.node(e.from)?.type !== "Person") continue;
    byPerson.set(e.from, [...(byPerson.get(e.from) ?? []), e]);
  }
  const current: PersonView[] = [];
  let former = 0;
  for (const [pid, edges] of byPerson) {
    const live = edges.filter((e) => isCurrent(e, now));
    if (!live.length) {
      former++; // every role this person held has a valid_until in the past
      continue;
    }
    const roles: PersonRole[] = live
      .sort((a, b) => PERSON_RELS.indexOf(a.type) - PERSON_RELS.indexOf(b.type))
      .map((e) => ({
        relation: e.type,
        role: str(e.props.role) ?? ROLE_LABEL[e.type],
        ...(str(e.props.valid_since) ? { since: str(e.props.valid_since)! } : {}),
        link: linkView(g, e, now),
      }));
    const primary = roles.some(
      (r) => r.relation === "FOUNDED" || r.relation === "IS_CEO_OF" || (r.relation === "WORKS_AT" && /founder|ceo|chief executive/i.test(r.role ?? "")),
    );
    current.push({ id: pid, name: g.node(pid)?.name ?? pid, roles, rank: bestRank(roles.map((r) => r.link.rank)), primary });
  }
  current.sort((a, b) => Number(b.primary) - Number(a.primary) || RANK_ORDER[b.rank] - RANK_ORDER[a.rank] || a.name.localeCompare(b.name));
  return { current, former };
}

// ---------------------------------------------------------------------------------------------------------
// rounds and paths

function earliestSource(g: Graph, edges: GEdge[]): string | null {
  let min: string | null = null;
  for (const e of edges) {
    for (const i of e.sources) {
      const d = g.sources[i].date;
      if (d && (!min || d < min)) min = d;
    }
  }
  return min ? min.slice(0, 10) : null;
}

function roundView(g: Graph, roundId: string, links: GEdge[], now: string, companyId?: string): RoundView {
  const n = g.node(roundId)!;
  const ev = str(prop(n, "event_date"));
  const an = str(prop(n, "announcement_date"));
  const fallback = ev || an ? null : earliestSource(g, links);
  const filed = companyId
    ? g
        .outgoing(companyId, "PARTICIPATES_IN_CORPORATE_EVENT")
        .map((e) => g.node(e.to))
        .find((x) => x?.same_financing_as === n.id)
    : undefined;
  return {
    node: nodeView(g, roundId, now),
    label: n.name, // the name the relationship itself carries; a loaded round's own name property agrees with it
    date: (ev ?? an ?? fallback)?.slice(0, 10) ?? null,
    dateBasis: ev ? "event_date" : an ? "announcement_date" : fallback ? "earliest source" : "none",
    amount: money(prop(n, "transaction_value"), prop(n, "transaction_value_units")),
    labelInferred: Boolean(n.label_inferred),
    ...(filed ? { alsoFiledAs: filed.id } : {}),
  };
}

interface RawPath {
  investor: string;
  peer: string;
  round?: string;
  issuer?: GEdge;
  participant?: GEdge;
  direct?: GEdge;
  via?: string;
}

interface Derived {
  version: number;
  byPeer: Map<string, RawPath[]>;
  byInvestor: Map<string, RawPath[]>;
  withRound: Set<string>;
}

const derivedHolder = globalThis as unknown as { __twoHopsDerived?: Derived };

function isBacker(e: GEdge): boolean {
  return e.type === "PARTICIPATES_IN_FUNDING_ROUND" && (e.props.role === "INVESTOR" || e.props.role === "LENDER") && e.sources.length > 0;
}

/** Every funded-by path into an attendee, independent of who is asking. */
function derive(g: Graph): Derived {
  const d = derivedHolder.__twoHopsDerived;
  if (d && d.version === g.version) return d;
  const byPeer = new Map<string, RawPath[]>();
  const withRound = new Set<string>();
  for (const [attId] of g.attendees) {
    const pid = g.canonical(attId);
    const n = g.nodes.get(pid);
    if (!n || n.investor_like) continue;
    const paths: RawPath[] = [];
    const viaRound = new Map<string, RawPath[]>();
    for (const ie of g.outgoing(pid, "PARTICIPATES_IN_FUNDING_ROUND")) {
      if (ie.props.role !== "ISSUER" || !ie.sources.length || g.node(ie.to)?.type !== "FundingRound") continue;
      withRound.add(pid);
      const backers: { e: GEdge; via?: string }[] = g.incoming(ie.to).filter(isBacker).map((e) => ({ e }));
      for (const t of g.incoming(ie.to, "IS_TRANCHE_OF")) {
        for (const e of g.incoming(t.from).filter(isBacker)) backers.push({ e, via: g.node(t.from)?.name });
      }
      for (const { e, via } of backers) {
        if (e.from === pid) continue;
        const p: RawPath = { investor: e.from, peer: pid, round: ie.to, issuer: ie, participant: e, ...(via ? { via } : {}) };
        paths.push(p);
        viaRound.set(e.from, [...(viaRound.get(e.from) ?? []), p]);
      }
    }
    for (const de of g.incoming(pid, "INVESTED_IN")) {
      if (de.suspect_inverted || !de.sources.length || de.from === pid) continue;
      const known = viaRound.get(de.from);
      if (known) for (const p of known) p.direct = de;
      else paths.push({ investor: de.from, peer: pid, direct: de });
    }
    if (paths.length) byPeer.set(pid, paths);
  }
  const byInvestor = new Map<string, RawPath[]>();
  for (const paths of byPeer.values()) {
    for (const p of paths) byInvestor.set(p.investor, [...(byInvestor.get(p.investor) ?? []), p]);
  }
  const out = { version: g.version, byPeer, byInvestor, withRound };
  derivedHolder.__twoHopsDerived = out;
  return out;
}

function pathView(g: Graph, p: RawPath, now: string): PathView {
  const links: LinkView[] = [];
  let round: RoundView | undefined;
  if (p.round && p.issuer && p.participant) {
    links.push(linkView(g, p.issuer, now));
    links.push(linkView(g, p.participant, now, p.via ? `recorded on ${p.via} of this round` : undefined));
    round = roundView(g, p.round, [p.issuer, p.participant], now, p.peer);
  } else if (p.direct) {
    links.push(linkView(g, p.direct, now));
  }
  const trust = weakestRank(links.map((l) => l.rank));
  const weakest = links.find((l) => l.rank === trust) ?? links[0];
  const date = round ? round.date : p.direct ? earliestSource(g, [p.direct]) : null;
  return {
    id: `${p.investor}|${p.peer}|${p.round ?? "direct"}`,
    investorId: p.investor,
    peerId: p.peer,
    kind: round ? "round" : "direct",
    ...(round ? { round } : {}),
    links,
    ...(round && p.direct ? { corroboration: linkView(g, p.direct, now) } : {}),
    trust,
    weakestLinkId: weakest.id,
    isLead: p.participant?.props.is_lead === true,
    date,
    dateApprox: round ? round.dateBasis === "earliest source" : true,
  };
}

function peerView(g: Graph, d: Derived, pid: string, me: Features | null, now: string): PeerView {
  const n = g.node(pid);
  const f = features(g, n);
  const people = peopleOf(g, pid, now);
  const rounds = g
    .outgoing(pid, "PARTICIPATES_IN_FUNDING_ROUND")
    .filter((e) => e.props.role === "ISSUER" && g.node(e.to)?.type === "FundingRound")
    .map((e) => roundView(g, e.to, [e], now, pid))
    .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  const filings = g.outgoing(pid, "PARTICIPATES_IN_CORPORATE_EVENT").filter((e) => g.node(e.to)?.type === "PrivateCompanyFundingRound");
  return {
    node: nodeView(g, pid, now),
    attendance: attendanceLink(g, pid, now),
    similarity: similarity(me, f),
    people: people.current.slice(0, 12),
    formerPeople: people.former,
    rounds,
    filingEvents: filings.length,
    filingEventsSameAsRound: filings.filter((e) => g.node(e.to)?.same_financing_as).length,
    headline: headline(f),
  };
}

function investorTotals(g: Graph, id: string): InvestorView["totals"] {
  const backed = g.outgoing(id).filter(isBacker);
  return {
    investments: g.node(id)?.investments ?? g.outgoing(id, "INVESTED_IN").length,
    roundsBacked: backed.length,
    roundsLed: backed.filter((e) => e.props.is_lead === true).length,
    filingEvents: g.outgoing(id, "PARTICIPATES_IN_CORPORATE_EVENT").filter((e) => g.node(e.to)?.type === "PrivateCompanyFundingRound").length,
    truncated: Object.keys(g.node(id)?.truncated ?? {}),
  };
}

// ---------------------------------------------------------------------------------------------------------
// whole-set numbers

export function coverage(g: Graph = getGraph()): Coverage {
  const d = derive(g);
  let profilesLoaded = 0;
  let startupsLoaded = 0;
  for (const [id] of g.attendees) {
    const n = g.node(id);
    if (!n?.loaded) continue;
    profilesLoaded++;
    if (!n.investor_like) startupsLoaded++;
  }
  let investorProfiles = 0;
  for (const id of d.byInvestor.keys()) if (g.node(id)?.loaded) investorProfiles++;
  let roundsLoaded = 0;
  for (const n of g.nodes.values()) if (n.type === "FundingRound" && n.loaded) roundsLoaded++;
  return {
    attendeesListed: g.attendees.size,
    profilesLoaded,
    startupsLoaded,
    withRound: d.withRound.size,
    withNamedInvestor: d.byPeer.size,
    investorsLinked: d.byInvestor.size,
    investorProfilesLoaded: investorProfiles,
    roundsLoaded,
    builtAt: g.meta.built_at,
    creditsLogged: g.meta.cala_calls.credits_logged,
  };
}

export function setOps(g: Graph = getGraph()): SetOps {
  const d = derive(g);
  const name = (id: string) => g.node(id)?.name ?? id;
  const investorsInSeveral = [...d.byInvestor.entries()]
    .map(([id, paths]) => ({
      id,
      name: name(id),
      attendees: new Set(paths.map((p) => p.peer)).size,
      led: new Set(paths.filter((p) => p.participant?.props.is_lead === true).map((p) => p.round)).size,
    }))
    .filter((x) => x.attendees > 1)
    .sort((a, b) => b.attendees - a.attendees || b.led - a.led || a.name.localeCompare(b.name))
    .slice(0, 40);

  const pairs = new Map<string, { a: string; b: string; companies: Set<string> }>();
  for (const [peer, paths] of d.byPeer) {
    const invs = [...new Set(paths.map((p) => p.investor))].sort();
    for (let i = 0; i < invs.length; i++) {
      for (let j = i + 1; j < invs.length; j++) {
        const key = `${invs[i]}|${invs[j]}`;
        const rec = pairs.get(key) ?? { a: invs[i], b: invs[j], companies: new Set<string>() };
        rec.companies.add(peer);
        pairs.set(key, rec);
      }
    }
  }
  const coInvestorPairs = [...pairs.values()]
    .map((p) => ({ a: p.a, b: p.b, aName: name(p.a), bName: name(p.b), shared: p.companies.size, companies: [...p.companies].map(name).slice(0, 5) }))
    .sort((x, y) => y.shared - x.shared || x.aName.localeCompare(y.aName))
    .slice(0, 12);

  const t = g.meta.traps;
  const ranks: Record<string, number> = {};
  for (const s of g.sources) ranks[toRank(s.source_rank)] = (ranks[toRank(s.source_rank)] ?? 0) + 1;
  return {
    investorsInSeveral,
    coInvestorPairs,
    sourcesByRank: ranks,
    traps: {
      mergedDuplicates: t.merged_duplicates.map((m) => ({ name: m.name, records: m.records })),
      inferredRoundLabels: t.inferred_round_labels.map((r) => ({ id: r.id, name: r.name })),
      bothWays: t.investment_recorded_both_ways.length,
      bothWaysExamples: t.investment_recorded_both_ways.slice(0, 4).map((x) => ({ from: x.from, to: x.to })),
      financingTwice: t.financing_recorded_twice.map((x) => ({ company: x.company, basis: x.basis })),
      sameNameKeptApart: t.notes.same_name_same_type_kept_apart ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------------------------------------
// search and the analysis itself

function fold(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function searchAttendees(q: string, limit = 12): SearchHit[] {
  const g = getGraph();
  const d = derive(g);
  const needle = fold(q);
  if (!needle) return [];
  const scored: { score: number; row: (typeof g.attendeeList)[number] }[] = [];
  for (const row of g.attendeeList) {
    const name = fold(row[1]);
    let score = -1;
    if (name === needle) score = 0;
    else if (name.startsWith(needle)) score = 1;
    else if (name.split(" ").some((w) => w.startsWith(needle))) score = 2;
    else if (name.includes(needle)) score = 3;
    if (score >= 0) scored.push({ score, row });
  }
  scored.sort((a, b) => a.score - b.score || a.row[1].length - b.row[1].length || a.row[1].localeCompare(b.row[1]));
  return scored.slice(0, limit).map(({ row }) => hit(g, d, row[0]));
}

function hit(g: Graph, d: Derived, id: string): SearchHit {
  const row = g.attendees.get(id)!;
  const cid = g.canonical(id);
  return { id, name: row[1], type: row[2], loaded: Boolean(g.node(id)?.loaded), hasFundingLink: d.byPeer.has(cid) };
}

/** Loaded startups to offer as a start without spending a live call. */
export function suggestions(limit = 8): SearchHit[] {
  const g = getGraph();
  const d = derive(g);
  const out: { n: GNode; score: number }[] = [];
  for (const [id] of g.attendees) {
    const n = g.node(id);
    if (!n?.loaded || n.investor_like) continue;
    const f = features(g, n);
    const score = (f?.industries.length ? 2 : 0) + (f?.stage ? 2 : 0) + (f?.country ? 1 : 0) + (d.byPeer.has(n.id) ? 1 : 0);
    out.push({ n, score });
  }
  out.sort((a, b) => b.score - a.score || a.n.name.localeCompare(b.n.name));
  return out.slice(0, limit).map(({ n }) => hit(g, d, n.id));
}

export function isAttendee(id: string): boolean {
  return getGraph().attendees.has(id);
}

export function analyze(meId: string, live: LiveCall): Analysis {
  const g = getGraph();
  const d = derive(g);
  const now = todayISO();
  const me = g.canonical(meId);
  const meNode = g.node(me);
  const meFeatures = features(g, meNode);

  const investors: InvestorView[] = [];
  for (const [inv, raw] of d.byInvestor) {
    if (inv === me) continue;
    const paths = raw.filter((p) => p.peer !== me).map((p) => pathView(g, p, now));
    if (!paths.length) continue;
    investors.push({ node: nodeView(g, inv, now), paths, totals: investorTotals(g, inv), coInvestors: [] });
  }

  // similarity is needed to rank, so build every referenced peer once
  const peers: Record<string, PeerView> = {};
  for (const inv of investors) {
    for (const p of inv.paths) peers[p.peerId] ??= peerView(g, d, p.peerId, meFeatures, now);
  }
  const peersWithPath = Object.keys(peers).length;

  const ranked = rankInvestors(investors, peers, { strict: false, today: now });
  const top = ranked.slice(0, MAX_INVESTORS).map((r) => ({ ...r.investor, paths: r.paths.slice(0, MAX_PATHS_PER_INVESTOR) }));

  // co-investors: who else funded the same attendees
  const invByPeer = new Map<string, Set<string>>();
  for (const inv of investors) for (const p of inv.paths) invByPeer.set(p.peerId, (invByPeer.get(p.peerId) ?? new Set()).add(inv.node.id));
  for (const inv of top) {
    const shared = new Map<string, number>();
    for (const pid of new Set(inv.paths.map((p) => p.peerId))) {
      for (const other of invByPeer.get(pid) ?? []) if (other !== inv.node.id) shared.set(other, (shared.get(other) ?? 0) + 1);
    }
    inv.coInvestors = [...shared.entries()]
      .map(([id, n]) => ({ id, name: g.node(id)?.name ?? id, shared: n }))
      .sort((a, b) => b.shared - a.shared || a.name.localeCompare(b.name))
      .slice(0, 6);
  }

  const shownPeers: Record<string, PeerView> = {};
  for (const inv of top) for (const p of inv.paths) shownPeers[p.peerId] = peers[p.peerId];

  return {
    me: {
      node: nodeView(g, me, now),
      attendance: attendanceLink(g, meId, now),
      headline: headline(meFeatures),
      investorLike: Boolean(meNode?.investor_like),
      people: meNode ? peopleOf(g, me, now).current.slice(0, 6) : [],
    },
    event: nodeView(g, SLUSH_2026, now),
    peers: shownPeers,
    investors: top,
    counts: { peersWithPath, peersShown: Object.keys(shownPeers).length, investorsTotal: investors.length, investorsShown: top.length },
    coverage: coverage(g),
    live,
    today: now,
  };
}

/** A real path for the landing page: a loaded round with a lead investor and a current founder or CEO to ask. */
export function examplePath(): { peer: PeerView; path: PathView; investor: NodeView; event: NodeView; attendance: LinkView } | null {
  const g = getGraph();
  const d = derive(g);
  const now = todayISO();
  let best: { score: number; raw: RawPath } | null = null;
  for (const paths of d.byPeer.values()) {
    for (const p of paths) {
      if (!p.round || !p.issuer || !p.participant) continue;
      const round = g.node(p.round);
      const peer = g.node(p.peer);
      if (!round?.loaded || !peer?.loaded) continue;
      const trust = weakestRank([edgeRank(g, p.issuer), edgeRank(g, p.participant)]);
      const people = peopleOf(g, p.peer, now).current.filter((x) => x.primary);
      const date = str(prop(round, "event_date")) ?? str(prop(round, "announcement_date")) ?? "";
      const score =
        RANK_ORDER[trust] * 10 +
        (p.participant.props.is_lead === true ? 8 : 0) +
        (people.length ? 6 : 0) +
        (people.some((x) => RANK_ORDER[x.rank] >= 3) ? 3 : 0) +
        (prop(round, "transaction_value") ? 2 : 0) +
        (round.label_inferred ? -6 : 0) +
        (date ? Number(date.slice(0, 4)) - 2000 : 0) / 10;
      if (!best || score > best.score) best = { score, raw: p };
    }
  }
  if (!best) return null;
  const path = pathView(g, best.raw, now);
  return {
    peer: peerView(g, d, best.raw.peer, null, now),
    path,
    investor: nodeView(g, best.raw.investor, now),
    event: nodeView(g, SLUSH_2026, now),
    attendance: attendanceLink(g, best.raw.peer, now),
  };
}

// ---------------------------------------------------------------------------------------------------------
// facts for the intro draft: one chosen path, re-read from the graph on the server

export interface IntroContext {
  meName: string;
  peer: PeerView;
  path: PathView;
  investor: NodeView;
  person: PersonView | null;
  attendanceSources: SourceView[];
  shared: { industry?: { label: string; sources: SourceView[] }; country?: { label: string; sources: SourceView[] } };
}

export function introContext(meId: string, investorId: string, peerId: string, roundId: string | null, personId: string | null): IntroContext | null {
  const g = getGraph();
  if (!g.attendees.has(meId)) return null;
  const d = derive(g);
  const now = todayISO();
  const me = g.canonical(meId);
  const peer = g.canonical(peerId);
  const investor = g.canonical(investorId);
  const raw = d.byPeer.get(peer)?.find((p) => p.investor === investor && (p.round ?? null) === (roundId ?? null));
  if (!raw || peer === me) return null;
  const meNode = g.node(me);
  const peerNode = g.node(peer);
  const meF = features(g, meNode);
  const peerF = features(g, peerNode);
  const pv = peerView(g, d, peer, meF, now);
  const person = pv.people.find((x) => x.id === personId) ?? pv.people.find((x) => x.primary) ?? null;

  const shared: IntroContext["shared"] = {};
  if (meF && peerF) {
    const mine = new Set(meF.industries.map((i) => i.code));
    const code = peerF.industries.map((i) => i.code).find((c) => mine.has(c));
    if (code) {
      const edges = [...g.outgoing(me, "OPERATES_IN_INDUSTRY"), ...g.outgoing(peer, "OPERATES_IN_INDUSTRY")].filter((e) => g.node(e.to)?.name === code);
      shared.industry = { label: pretty(code), sources: sourceViews(g, [...new Set(edges.flatMap((e) => e.sources))], now) };
    }
    if (meF.country && peerF.country && meF.country.toLowerCase() === peerF.country.toLowerCase()) {
      const ixs = [...(meNode?.props.headquarters_address?.sources ?? []), ...(peerNode?.props.headquarters_address?.sources ?? [])];
      shared.country = { label: meF.country, sources: sourceViews(g, [...new Set(ixs)], now) };
    }
  }
  return {
    meName: meNode?.name ?? g.attendees.get(meId)![1],
    peer: pv,
    path: pathView(g, raw, now),
    investor: nodeView(g, investor, now),
    person,
    attendanceSources: [...attendanceLink(g, meId, now).sources],
    shared,
  };
}
