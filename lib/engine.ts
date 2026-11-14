// Server only. Walks the graph from one attendee: peers at the event, their rounds, who funded and who led,
// and the people to ask. Every value returned carries the sources Cala gave for it.

import { getGraph, SLUSH_2026, type GEdge, type GNode, type Graph } from "./graph";
import { bestRank, isStrict, toRank, weakestRank, type Rank } from "./rank";
import { scorePaths, sortPaths, type Factors, type PathLite } from "./score";
import type {
  Analysis,
  Coverage,
  Fact,
  Hop1Peer,
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

// What one analysis sends to the browser. Scores are computed over everything; only the detail is capped.
const MAX_INVESTORS = 40; // organisations; individuals (angels) are capped separately so they cannot crowd them out
const MAX_PEOPLE_INVESTORS = 15;
const MAX_PATHS_PER_INVESTOR = 8;
const HOP1_PEERS = 6;
const MAX_SOURCES_PER_ITEM = 4;

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
  /** Canonical English country name, or null when Cala does not say where the company is. */
  country: string | null;
  countrySources: number[];
  hq: string | null;
  stage: string | null;
  founded: string | null;
  tokens: Set<string>;
}

/** English country names as Intl spells them, plus the other spellings addresses use for a few of them. */
const COUNTRY_NAMES: Map<string, string> = (() => {
  const out = new Map<string, string>();
  const names = new Intl.DisplayNames(["en"], { type: "region" });
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const notCountries = new Set(["EU", "EZ", "UN", "QO", "XA", "XB", "ZZ"]);
  for (const a of letters) {
    for (const b of letters) {
      const code = a + b;
      if (notCountries.has(code)) continue;
      let name: string | undefined;
      try {
        name = names.of(code);
      } catch {
        name = undefined;
      }
      if (name && name !== code) out.set(name.toLowerCase(), name);
    }
  }
  const alias: Record<string, string> = {
    usa: "US", "u.s.a.": "US", "united states of america": "US", uk: "GB", "great britain": "GB", england: "GB",
    scotland: "GB", wales: "GB", "northern ireland": "GB", "the netherlands": "NL", holland: "NL", "czech republic": "CZ",
    turkey: "TR", turkiye: "TR", korea: "KR", "republic of korea": "KR", "russian federation": "RU", uae: "AE",
    "hong kong": "HK", macau: "MO", "ivory coast": "CI", "viet nam": "VN", "republic of ireland": "IE",
  };
  for (const [spelling, code] of Object.entries(alias)) {
    const name = names.of(code);
    if (name) out.set(spelling, name);
  }
  return out;
})();

/**
 * Where a company is, from what Cala states with a source. A structured headquarters link wins; then the last
 * part of the headquarters address, but only when it is a country name ("…, CA" could be California or Canada,
 * so two-letter endings are not read as countries); then where it is registered.
 */
function countryOf(g: Graph, n: GNode): { name: string; sources: number[] } | null {
  const fromLink = (rel: string) => {
    for (const e of g.outgoing(n.id, rel)) {
      const c = g.node(e.to);
      if (e.sources.length && c?.type === "Country") return { name: COUNTRY_NAMES.get(c.name.toLowerCase()) ?? c.name, sources: e.sources };
    }
    return null;
  };
  const fromAddress = (key: string) => {
    const p = n.props[key];
    if (!p?.sources.length || typeof p.value !== "string") return null;
    const name = COUNTRY_NAMES.get(p.value.split(",").pop()!.trim().toLowerCase());
    return name ? { name, sources: p.sources } : null;
  };
  return fromLink("HAS_HEADQUARTERS_IN") ?? fromAddress("headquarters_address") ?? fromLink("IS_REGISTERED_IN") ?? fromAddress("registered_address");
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
  const country = countryOf(g, n);
  return {
    industries,
    country: country?.name ?? null,
    countrySources: country?.sources ?? [],
    // "8048 Zürich, Switzerland" reads better without the postcode
    hq: hq ? hq.split(",").slice(-2).map((x) => x.trim().replace(/^\d{3,6}\s+/, "")).join(", ") : (country?.name ?? null),
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

  const sameCountry = !!me.country && me.country === peer.country;
  add(
    "country",
    "Same country",
    sameCountry ? 1 : 0,
    sameCountry ? me.country! : me.country && peer.country ? `${me.country} vs ${peer.country}` : "no country in Cala for one of the two",
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

const STAGE_LABEL = /^(pre[- ]?seed|seed(\s*\+|\s+plus|\s+extension)?|angel|pre[- ]?series\s+[a-z]|series\s+[a-z]\d?(\s+extension)?)$/i;

/**
 * The distinct stage labels one round record carries, when there are two or more (Seed and Series A, say):
 * then Cala folded several financings into it. A second name that is not a stage, such as "Strategic
 * Investment" next to "Equity round", is just another name for the same financing and does not count.
 */
function stageLabels(n: GNode): string[] {
  const seen = new Map<string, string>();
  for (const label of n.several_labels ?? []) {
    const t = label.trim();
    if (STAGE_LABEL.test(t)) seen.set(t.toLowerCase().replace(/[-\s]+/g, " "), t);
  }
  return seen.size > 1 ? [...seen.values()] : [];
}

/** The date of a round from its own record, and whether it can be read as "when this investor came in". */
function roundDate(g: Graph, n: GNode, links: GEdge[]): { date: string | null; basis: RoundView["dateBasis"]; approx: boolean } {
  const ev = str(prop(n, "event_date"));
  const an = str(prop(n, "announcement_date"));
  if (ev || an) {
    // a record that mixes several financings has a date, but not necessarily the date of this investor's cheque
    const mixed = Boolean(n.label_inferred) || stageLabels(n).length > 1;
    return { date: (ev ?? an)!.slice(0, 10), basis: ev ? "event_date" : "announcement_date", approx: mixed };
  }
  const fallback = earliestSource(g, links);
  return { date: fallback, basis: fallback ? "earliest source" : "none", approx: true };
}

function roundView(g: Graph, roundId: string, links: GEdge[], now: string, companyId?: string): RoundView {
  const n = g.node(roundId)!;
  const { date, basis } = roundDate(g, n, links);
  const filed = companyId
    ? g
        .outgoing(companyId, "PARTICIPATES_IN_CORPORATE_EVENT")
        .map((e) => g.node(e.to))
        .find((x) => x?.same_financing_as === n.id)
    : undefined;
  return {
    node: nodeView(g, roundId, now),
    label: n.name, // the name the relationship itself carries; a loaded round's own name property agrees with it
    date,
    dateText: showDate(date),
    dateBasis: basis,
    amount: money(prop(n, "transaction_value"), prop(n, "transaction_value_units")),
    labelInferred: Boolean(n.label_inferred),
    severalLabels: stageLabels(n),
    ...(filed ? { alsoFiledAs: filed.id } : {}),
  };
}

interface RawPath {
  investor: string;
  peer: string;
  round?: string;
  issuer?: GEdge;
  participant?: GEdge;
  /** IS_TRANCHE_OF, when the investor is recorded on a tranche of the round and not on the round itself. */
  tranche?: GEdge;
  via?: string;
  direct?: GEdge;
}

interface Lite extends PathLite {
  raw: RawPath;
}

interface Derived {
  graph: Graph;
  version: number;
  byPeer: Map<string, RawPath[]>;
  byInvestor: Map<string, Lite[]>;
  withRound: Set<string>;
  features: Map<string, Features | null>;
  example?: ReturnType<typeof examplePath>;
}

const derivedHolder = globalThis as unknown as { __twoHopsDerived?: Derived };

function isBacker(e: GEdge): boolean {
  return e.type === "PARTICIPATES_IN_FUNDING_ROUND" && (e.props.role === "INVESTOR" || e.props.role === "LENDER") && e.sources.length > 0;
}

function pathLinks(p: RawPath): GEdge[] {
  return p.round ? [p.issuer!, p.participant!, ...(p.tranche ? [p.tranche] : [])] : [p.direct!];
}

function lite(g: Graph, p: RawPath): Lite {
  const links = pathLinks(p);
  const trust = weakestRank(links.map((e) => edgeRank(g, e)));
  const when = p.round ? roundDate(g, g.node(p.round)!, links) : { date: earliestSource(g, links), approx: true };
  return {
    raw: p,
    peerId: p.peer,
    roundKey: p.round ?? `direct:${p.peer}`,
    trust,
    isLead: p.participant?.props.is_lead === true,
    date: when.date,
    dateApprox: when.approx,
  };
}

/** Every funded-by path into an attendee, independent of who is asking. Recomputed when the graph changes. */
function derive(g: Graph): Derived {
  const d = derivedHolder.__twoHopsDerived;
  if (d && d.graph === g && d.version === g.version) return d;
  const byPeer = new Map<string, RawPath[]>();
  const withRound = new Set<string>();
  for (const [attId] of g.attendees) {
    const pid = g.canonical(attId);
    const n = g.nodes.get(pid);
    if (!n || n.investor_like) continue;
    // one path per investor and round: a link on the round itself beats one on a tranche, a lead beats a non-lead
    const viaRound = new Map<string, RawPath>();
    const better = (a: RawPath) => (a.participant!.props.is_lead === true ? 2 : 0) + (a.tranche ? 0 : 1);
    for (const ie of g.outgoing(pid, "PARTICIPATES_IN_FUNDING_ROUND")) {
      if (ie.props.role !== "ISSUER" || !ie.sources.length || g.node(ie.to)?.type !== "FundingRound") continue;
      withRound.add(pid);
      const backers: { e: GEdge; tranche?: GEdge }[] = g.incoming(ie.to).filter(isBacker).map((e) => ({ e }));
      for (const t of g.incoming(ie.to, "IS_TRANCHE_OF")) {
        if (!t.sources.length) continue; // an unsourced tranche link cannot carry a path
        for (const e of g.incoming(t.from).filter(isBacker)) backers.push({ e, tranche: t });
      }
      for (const { e, tranche } of backers) {
        if (e.from === pid) continue;
        const cand: RawPath = {
          investor: e.from,
          peer: pid,
          round: ie.to,
          issuer: ie,
          participant: e,
          ...(tranche ? { tranche, via: g.node(tranche.from)?.name } : {}),
        };
        const key = `${ie.to}|${e.from}`;
        const prev = viaRound.get(key);
        if (!prev || better(cand) > better(prev)) viaRound.set(key, cand);
      }
    }
    const paths = [...viaRound.values()];
    const hasRound = new Set(paths.map((p) => p.investor));
    const direct = new Map<string, GEdge>();
    for (const de of g.incoming(pid, "INVESTED_IN")) {
      if (de.suspect_inverted || !de.sources.length || de.from === pid) continue;
      const prev = direct.get(de.from);
      if (!prev || RANK_ORDER[edgeRank(g, de)] > RANK_ORDER[edgeRank(g, prev)]) direct.set(de.from, de);
    }
    for (const [inv, de] of direct) {
      if (hasRound.has(inv)) {
        for (const p of paths) if (p.investor === inv) p.direct = de; // kept as corroboration of the round path
      } else {
        paths.push({ investor: inv, peer: pid, direct: de });
      }
    }
    if (paths.length) byPeer.set(pid, paths);
  }
  const byInvestor = new Map<string, Lite[]>();
  for (const paths of byPeer.values()) {
    for (const p of paths) {
      const list = byInvestor.get(p.investor);
      if (list) list.push(lite(g, p));
      else byInvestor.set(p.investor, [lite(g, p)]);
    }
  }
  const out: Derived = { graph: g, version: g.version, byPeer, byInvestor, withRound, features: new Map() };
  derivedHolder.__twoHopsDerived = out;
  return out;
}

function featuresOf(g: Graph, d: Derived, id: string): Features | null {
  if (!d.features.has(id)) d.features.set(id, features(g, g.node(id)));
  return d.features.get(id)!;
}

function pathView(g: Graph, l: Lite, now: string): PathView {
  const p = l.raw;
  const links: LinkView[] = [];
  let round: RoundView | undefined;
  let tranche: LinkView | undefined;
  if (p.round && p.issuer && p.participant) {
    links.push(linkView(g, p.issuer, now));
    links.push(linkView(g, p.participant, now, p.via ? `recorded on ${p.via} of this round` : undefined));
    if (p.tranche) tranche = linkView(g, p.tranche, now);
    round = roundView(g, p.round, [p.issuer, p.participant], now, p.peer);
  } else if (p.direct) {
    links.push(linkView(g, p.direct, now));
  }
  const counted = tranche ? [...links, tranche] : links;
  const weakest = counted.find((x) => x.rank === l.trust) ?? counted[0];
  return {
    id: `${p.investor}|${p.peer}|${p.round ?? "direct"}`,
    investorId: p.investor,
    peerId: p.peer,
    roundKey: l.roundKey,
    kind: round ? "round" : "direct",
    ...(round ? { round } : {}),
    links,
    ...(tranche ? { tranche } : {}),
    ...(round && p.direct ? { corroboration: linkView(g, p.direct, now) } : {}),
    trust: l.trust,
    weakestLinkId: weakest.id,
    isLead: l.isLead,
    date: l.date,
    dateApprox: l.dateApprox,
  };
}

function peerView(g: Graph, d: Derived, pid: string, me: Features | null, now: string): PeerView {
  const f = featuresOf(g, d, pid);
  const people = peopleOf(g, pid, now);
  const rounds = g
    .outgoing(pid, "PARTICIPATES_IN_FUNDING_ROUND")
    .filter((e) => e.props.role === "ISSUER" && e.sources.length > 0 && g.node(e.to)?.type === "FundingRound");
  const filings = g
    .outgoing(pid, "PARTICIPATES_IN_CORPORATE_EVENT")
    .filter((e) => e.sources.length > 0 && g.node(e.to)?.type === "PrivateCompanyFundingRound");
  return {
    node: nodeView(g, pid, now),
    attendance: attendanceLink(g, pid, now),
    similarity: similarity(me, f),
    people: people.current.slice(0, 5),
    formerPeople: people.former,
    roundCount: rounds.length,
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
      attendees: new Set(paths.map((p) => p.peerId)).size,
      led: new Set(paths.filter((p) => p.isLead).map((p) => p.roundKey)).size,
    }))
    .filter((x) => x.attendees > 1)
    .sort((a, b) => b.attendees - a.attendees || b.led - a.led || a.name.localeCompare(b.name))
    .slice(0, 40);

  const pairs = new Map<string, { a: string; b: string; companies: Set<string> }>();
  for (const [peer, paths] of d.byPeer) {
    const invs = [...new Set(paths.map((p) => p.investor))].sort().slice(0, 40); // a cap per company keeps this linear
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
    .sort((x, y) => y.companies.size - x.companies.size)
    .slice(0, 12)
    .map((p) => ({ a: p.a, b: p.b, aName: name(p.a), bName: name(p.b), shared: p.companies.size, companies: [...p.companies].map(name).slice(0, 5) }))
    .sort((x, y) => y.shared - x.shared || x.aName.localeCompare(y.aName));

  const t = g.meta.traps;
  const ranks: Record<string, number> = {};
  for (const s of g.sources) ranks[toRank(s.source_rank)] = (ranks[toRank(s.source_rank)] ?? 0) + 1;
  const bothWays = t.investment_recorded_both_ways ?? [];
  const mixedRounds = [...g.nodes.values()].filter((n) => n.type === "FundingRound" && stageLabels(n).length > 1);
  return {
    investorsInSeveral,
    coInvestorPairs,
    sourcesByRank: ranks,
    traps: {
      mergedDuplicates: (t.merged_duplicates ?? []).slice(0, 30).map((m) => ({ name: m.name, records: m.records })),
      pairsLeftApart: t.same_name_left_apart?.count ?? 0,
      inferredRoundLabels: (t.inferred_round_labels ?? []).length,
      roundsWithSeveralLabels: {
        count: mixedRounds.length,
        examples: mixedRounds.slice(0, 2).map((n) => ({ name: n.name, labels: stageLabels(n) })),
      },
      bothWays: bothWays.length,
      bothWaysUnclear: bothWays.filter((x) => x.direction_unclear).length,
      bothWaysExamples: bothWays.slice(0, 4).map((x) => ({ from: x.from, to: x.to })),
      financingTwice: (t.financing_recorded_twice ?? []).slice(0, 20).map((x) => ({ company: x.company, basis: x.basis })),
      sameNameKeptApart: t.notes.same_name_same_type_kept_apart ?? 0,
      listsCutShort: t.notes.relationship_lists_cut_at_page_limit ?? 0,
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

/** A few well-described startups to start from, picked from the ones that have a sourced investor. */
export function suggestions(limit = 8): SearchHit[] {
  const g = getGraph();
  const d = derive(g);
  const out: { id: string; name: string; score: number }[] = [];
  for (const pid of d.byPeer.keys()) {
    const n = g.node(pid);
    if (!n?.loaded || !g.attendees.has(pid)) continue;
    const f = featuresOf(g, d, pid);
    const led = d.byPeer.get(pid)!.some((p) => p.participant?.props.is_lead === true);
    const score = (f?.industries.length ? 2 : 0) + (f?.stage ? 2 : 0) + (f?.country ? 1 : 0) + (led ? 2 : 0) + Math.min(2, d.byPeer.get(pid)!.length / 4);
    out.push({ id: pid, name: n.name, score });
  }
  out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return out.slice(0, limit).map((x) => hit(g, d, x.id));
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
  const meFeatures = featuresOf(g, d, me);

  // how much each funded attendee resembles me: needed for every score, so computed once for all of them
  const likeness: Record<string, number | null> = {};
  for (const pid of d.byPeer.keys()) {
    if (pid !== me) likeness[pid] = similarity(meFeatures, featuresOf(g, d, pid)).score;
  }

  // every investor scored on all of its paths, and again on the filings-and-first-party ones
  const scored: { id: string; name: string; lites: Lite[]; all: Factors; strict: Factors | null }[] = [];
  const backers = new Map<string, Set<string>>();
  for (const [inv, list] of d.byInvestor) {
    if (inv === me) continue;
    const lites = list.filter((l) => l.peerId !== me);
    if (!lites.length) continue;
    const strictOnes = lites.filter((l) => isStrict(l.trust));
    scored.push({
      id: inv,
      name: g.node(inv)?.name ?? inv,
      lites,
      all: scorePaths(lites, likeness, now),
      strict: strictOnes.length ? scorePaths(strictOnes, likeness, now) : null,
    });
    for (const l of lites) {
      const s = backers.get(l.peerId);
      if (s) s.add(inv);
      else backers.set(l.peerId, new Set([inv]));
    }
  }
  const byAll = [...scored].sort((a, b) => b.all.total - a.all.total || a.name.localeCompare(b.name));
  const byStrict = scored.filter((s) => s.strict).sort((a, b) => b.strict!.total - a.strict!.total || a.name.localeCompare(b.name));
  const rankOf = new Map(byAll.map((s, i) => [s.id, i]));

  // first hop: the funded attendees closest to me, each with the best-ranked investor behind it
  const funded = [...backers.keys()];
  funded.sort(
    (a, b) =>
      (likeness[b] ?? -1) - (likeness[a] ?? -1) ||
      Number(Boolean(g.node(b)?.loaded)) - Number(Boolean(g.node(a)?.loaded)) ||
      backers.get(b)!.size - backers.get(a)!.size ||
      (g.node(a)?.name ?? "").localeCompare(g.node(b)?.name ?? ""),
  );
  const hopPeers = funded.slice(0, HOP1_PEERS);
  const forced = new Map<string, Set<string>>(); // investor -> peers whose path must be sent
  const hopBest = new Map<string, string>();
  for (const pid of hopPeers) {
    const best = [...backers.get(pid)!].sort((a, b) => rankOf.get(a)! - rankOf.get(b)!)[0];
    hopBest.set(pid, best);
    forced.set(best, (forced.get(best) ?? new Set()).add(pid));
  }

  const isPerson = (s: { id: string }) => g.node(s.id)?.type === "Person";
  const best = (list: typeof scored) => [
    ...list.filter((s) => !isPerson(s)).slice(0, MAX_INVESTORS),
    ...list.filter(isPerson).slice(0, MAX_PEOPLE_INVESTORS),
  ];
  const shownIds = new Set<string>([...best(byAll), ...best(byStrict)].map((s) => s.id));
  for (const id of forced.keys()) shownIds.add(id);

  const peers: Record<string, PeerView> = {};
  const needPeer = (pid: string) => (peers[pid] ??= peerView(g, d, pid, meFeatures, now));
  const investors: InvestorView[] = [];
  for (const s of byAll) {
    if (!shownIds.has(s.id)) continue;
    // the paths sent: the best of all, the best of the strict ones, and any a first-hop card points at
    const ordered = sortPaths(s.lites, likeness);
    const chosen = new Map<string, Lite>();
    const take = (l: Lite) => chosen.set(`${l.raw.peer}|${l.roundKey}`, l);
    ordered.slice(0, MAX_PATHS_PER_INVESTOR).forEach(take);
    ordered.filter((l) => isStrict(l.trust)).slice(0, MAX_PATHS_PER_INVESTOR).forEach(take);
    for (const pid of forced.get(s.id) ?? []) ordered.filter((l) => l.peerId === pid).slice(0, 1).forEach(take);
    const paths = sortPaths([...chosen.values()], likeness).map((l) => pathView(g, l, now));
    for (const p of paths) needPeer(p.peerId);
    for (const f of [s.all, s.strict]) if (f?.fitPeer) needPeer(f.fitPeer);

    const shared = new Map<string, number>();
    for (const pid of new Set(s.lites.map((l) => l.peerId))) {
      for (const other of backers.get(pid) ?? []) if (other !== s.id) shared.set(other, (shared.get(other) ?? 0) + 1);
    }
    investors.push({
      node: nodeView(g, s.id, now),
      paths,
      score: { all: s.all, strict: s.strict },
      counts: { paths: s.lites.length, strictPaths: s.lites.filter((l) => isStrict(l.trust)).length, peers: s.all.peers },
      totals: investorTotals(g, s.id),
      // who else funded the same attendees: most shared first, then the better-ranked for this founder
      coInvestors: [...shared.entries()]
        .map(([id, n]) => ({ id, name: g.node(id)?.name ?? id, shared: n }))
        .sort((a, b) => b.shared - a.shared || rankOf.get(a.id)! - rankOf.get(b.id)!)
        .slice(0, 6),
    });
  }

  const hop1: Hop1Peer[] = hopPeers.map((pid) => {
    const f = featuresOf(g, d, pid);
    const inv = hopBest.get(pid)!;
    const path = investors.find((i) => i.node.id === inv)?.paths.find((p) => p.peerId === pid);
    const h = headline(f);
    return {
      id: pid,
      name: g.node(pid)?.name ?? pid,
      loaded: Boolean(g.node(pid)?.loaded),
      likeness: likeness[pid] ?? null,
      ...(h.industry ? { industry: h.industry } : {}),
      ...(h.hq ? { hq: h.hq } : {}),
      investors: backers.get(pid)!.size,
      investorId: path ? inv : null,
      pathId: path?.id ?? null,
    };
  });

  return {
    me: {
      node: nodeView(g, me, now),
      attendance: attendanceLink(g, meId, now),
      headline: headline(meFeatures),
      investorLike: Boolean(meNode?.investor_like),
      people: meNode ? peopleOf(g, me, now).current.slice(0, 6) : [],
    },
    event: nodeView(g, SLUSH_2026, now),
    hop1: { top: hop1, comparable: funded.filter((p) => likeness[p] !== null && likeness[p] !== undefined).length, total: funded.length },
    peers,
    investors,
    counts: { peersWithPath: funded.length, investorsTotal: scored.length, investorsStrict: byStrict.length, investorsShown: investors.length },
    coverage: coverage(g),
    live,
    today: now,
  };
}

/** A real path for the landing page: a loaded round with a lead investor and a current founder or CEO to ask. */
export function examplePath(): { peer: PeerView; path: PathView; investor: NodeView; event: NodeView; attendance: LinkView } | null {
  const g = getGraph();
  const d = derive(g);
  if ("example" in d) return d.example ?? null;
  const now = todayISO();
  const candidates: { score: number; l: Lite }[] = [];
  for (const list of d.byInvestor.values()) {
    for (const l of list) {
      const p = l.raw;
      if (!p.round || p.tranche) continue;
      const round = g.node(p.round);
      const peer = g.node(p.peer);
      if (!round?.loaded || !peer?.loaded || round.label_inferred || stageLabels(round).length > 1) continue;
      const score =
        RANK_ORDER[l.trust] * 10 +
        (l.isLead ? 8 : 0) +
        (prop(round, "transaction_value") ? 2 : 0) +
        (l.date && !l.dateApprox ? (Number(l.date.slice(0, 4)) - 2000) / 10 : -2);
      candidates.push({ score, l });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.l.raw.peer.localeCompare(b.l.raw.peer));
  // the first one that also has a founder or CEO to ask, backed by a filing or a first-party source
  let pick = candidates[0]?.l;
  for (const c of candidates.slice(0, 200)) {
    const asks = peopleOf(g, c.l.raw.peer, now).current.filter((x) => x.primary);
    if (asks.some((x) => RANK_ORDER[x.rank] >= 3)) {
      pick = c.l;
      break;
    }
  }
  const example = pick
    ? {
        peer: peerView(g, d, pick.raw.peer, null, now),
        path: pathView(g, pick, now),
        investor: nodeView(g, pick.raw.investor, now),
        event: nodeView(g, SLUSH_2026, now),
        attendance: attendanceLink(g, pick.raw.peer, now),
      }
    : null;
  d.example = example;
  return example;
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

/** `personId` null means "write to the team". An id that is not a current role-holder of the peer is refused. */
export function introContext(meId: string, investorId: string, peerId: string, roundId: string | null, personId: string | null): IntroContext | null {
  const g = getGraph();
  if (!g.attendees.has(meId)) return null;
  const d = derive(g);
  const now = todayISO();
  const me = g.canonical(meId);
  const peer = g.canonical(peerId);
  const investor = g.canonical(investorId);
  if (peer === me || investor === me) return null;
  const l = d.byInvestor.get(investor)?.find((x) => x.peerId === peer && (x.raw.round ?? null) === (roundId ?? null));
  if (!l) return null;
  const meNode = g.node(me);
  const meF = featuresOf(g, d, me);
  const peerF = featuresOf(g, d, peer);
  const pv = peerView(g, d, peer, meF, now);
  const person = personId ? (peopleOf(g, peer, now).current.find((x) => x.id === personId) ?? undefined) : null;
  if (person === undefined) return null;

  const shared: IntroContext["shared"] = {};
  if (meF && peerF) {
    const mine = new Set(meF.industries.map((i) => i.code));
    const code = peerF.industries.map((i) => i.code).find((c) => mine.has(c));
    if (code) {
      const edges = [...g.outgoing(me, "OPERATES_IN_INDUSTRY"), ...g.outgoing(peer, "OPERATES_IN_INDUSTRY")].filter(
        (e) => e.sources.length > 0 && g.node(e.to)?.name === code,
      );
      shared.industry = { label: pretty(code), sources: sourceViews(g, [...new Set(edges.flatMap((e) => e.sources))], now) };
    }
    if (meF.country && peerF.country && meF.country === peerF.country) {
      shared.country = { label: meF.country, sources: sourceViews(g, [...new Set([...meF.countrySources, ...peerF.countrySources])], now) };
    }
  }
  return {
    meName: meNode?.name ?? g.attendees.get(meId)![1],
    peer: pv,
    path: pathView(g, l, now),
    investor: nodeView(g, investor, now),
    person,
    attendanceSources: [...attendanceLink(g, meId, now).sources],
    shared,
  };
}
