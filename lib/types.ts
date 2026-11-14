// Shapes shared by the server engine and the client. Everything the client shows comes in these.

import type { Rank } from "./rank";

/** One source as Cala returned it, with its rank normalised and its age worked out. */
export interface SourceView {
  name: string;
  url: string | null;
  date: string | null;
  precision: string | null;
  rank: Rank;
  ageDays: number | null;
}

/** A property of an entity with its provenance. */
export interface Fact {
  key: string;
  label: string;
  value: string;
  sources: SourceView[];
  rank: Rank;
}

/** One Cala relationship with its provenance. `from` and `to` are entity ids, direction as in Cala. */
export interface LinkView {
  id: string;
  type: string;
  from: string;
  to: string;
  props: Record<string, string | number | boolean>;
  sources: SourceView[];
  rank: Rank;
  /** More than one id when two Cala edges were merged because their endpoints are the same organisation. */
  calaIds: string[];
  note?: string;
}

export interface NodeView {
  id: string;
  type: string;
  name: string;
  loaded: boolean;
  attendee: boolean;
  facts: Fact[];
  /** Labels of values Cala holds without a source: named in the panel, never shown. */
  unsourced: string[];
  flags: string[];
  merged?: { id: string; type: string; name: string }[];
}

export interface PersonRole {
  relation: string;
  role?: string;
  since?: string;
  link: LinkView;
}

export interface PersonView {
  id: string;
  name: string;
  roles: PersonRole[];
  rank: Rank;
  /** Founder or CEO: the people to ask for the intro. */
  primary: boolean;
}

export interface SimilarityFactor {
  key: "industry" | "label" | "country" | "stage" | "description";
  label: string;
  weight: number;
  score: number;
  detail: string;
}

export interface Similarity {
  /** 0..1, or null when one of the two profiles is not loaded. */
  score: number | null;
  factors: SimilarityFactor[];
  note?: string;
}

export interface RoundView {
  node: NodeView;
  label: string;
  date: string | null;
  /** Where the date comes from: the round itself, or the earliest source on its links. */
  dateBasis: "event_date" | "announcement_date" | "earliest source" | "none";
  amount: string | null;
  labelInferred: boolean;
  /** Set when a filing event of the same company is the same financing as this round. */
  alsoFiledAs?: string;
}

export interface PeerView {
  node: NodeView;
  attendance: LinkView;
  similarity: Similarity;
  people: PersonView[];
  formerPeople: number;
  rounds: RoundView[];
  filingEvents: number;
  filingEventsSameAsRound: number;
  headline: { industry?: string; hq?: string; stage?: string; founded?: string };
}

export interface PathView {
  id: string;
  investorId: string;
  peerId: string;
  kind: "round" | "direct";
  round?: RoundView;
  /** Links in walking order from the peer to the investor. */
  links: LinkView[];
  /** INVESTED_IN between the same two parties, when the path itself runs through a round. */
  corroboration?: LinkView;
  trust: Rank;
  weakestLinkId: string;
  isLead: boolean;
  date: string | null;
  dateApprox: boolean;
}

export interface InvestorView {
  node: NodeView;
  paths: PathView[];
  /** What Cala holds for this investor overall; shown, never added together. */
  totals: {
    investments: number;
    roundsBacked: number;
    roundsLed: number;
    filingEvents: number;
    /** Relationship lists that came back full (1,000 items): Cala holds more than is loaded. */
    truncated: string[];
  };
  coInvestors: { id: string; name: string; shared: number }[];
}

export interface Coverage {
  attendeesListed: number;
  profilesLoaded: number;
  startupsLoaded: number;
  withRound: number;
  withNamedInvestor: number;
  investorsLinked: number;
  investorProfilesLoaded: number;
  roundsLoaded: number;
  builtAt: string;
  creditsLogged: number;
}

export interface SetOps {
  investorsInSeveral: { id: string; name: string; attendees: number; led: number }[];
  coInvestorPairs: { a: string; b: string; aName: string; bName: string; shared: number; companies: string[] }[];
  sourcesByRank: Record<string, number>;
  traps: {
    mergedDuplicates: { name: string; records: { id: string; type: string; name: string }[] }[];
    inferredRoundLabels: { id: string; name: string }[];
    bothWays: number;
    bothWaysExamples: { from: string; to: string }[];
    financingTwice: { company: string; basis: string }[];
    sameNameKeptApart: number;
  };
}

export interface LiveCall {
  called: boolean;
  seconds?: number;
  status?: number;
  error?: string;
  /** Live calls this server may still make. */
  budgetLeft: number;
}

export interface Analysis {
  me: {
    node: NodeView;
    attendance: LinkView;
    headline: PeerView["headline"];
    investorLike: boolean;
    people: PersonView[];
  };
  event: NodeView;
  peers: Record<string, PeerView>;
  investors: InvestorView[];
  counts: { peersWithPath: number; peersShown: number; investorsTotal: number; investorsShown: number };
  coverage: Coverage;
  live: LiveCall;
  today: string;
}

export interface SearchHit {
  id: string;
  name: string;
  type: string;
  loaded: boolean;
  hasFundingLink: boolean;
}
