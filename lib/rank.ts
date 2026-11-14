// Source ranks as Cala gives them, plus UNRANKED for sources that come without one.
// Shared by server and client: no Node APIs here.

export const RANKS = ["FILING", "PRIMARY", "PRESS", "AGGREGATOR", "UNRANKED"] as const;
export type Rank = (typeof RANKS)[number];

export const RANK_VALUE: Record<Rank, number> = { FILING: 4, PRIMARY: 3, PRESS: 2, AGGREGATOR: 1, UNRANKED: 0 };

export const RANK_LABEL: Record<Rank, string> = {
  FILING: "Official filing",
  PRIMARY: "First-party",
  PRESS: "Press",
  AGGREGATOR: "Aggregator",
  UNRANKED: "No rank in Cala",
};

export const RANK_HELP: Record<Rank, string> = {
  FILING: "Business registries, regulators and official filings",
  PRIMARY: "The company itself, or its investors, lenders or grant bodies",
  PRESS: "Independent publications",
  AGGREGATOR: "Funding databases, data providers and archives",
  UNRANKED: "Cala returned this source without a source_rank",
};

/** Ranks that pass the "official records and first-party sources only" switch. */
export const STRICT_RANKS: Rank[] = ["FILING", "PRIMARY"];

export function toRank(s: string | null | undefined): Rank {
  return s && s in RANK_VALUE ? (s as Rank) : "UNRANKED";
}

/** A fact is as good as its best source. */
export function bestRank(ranks: Rank[]): Rank {
  let best: Rank = "UNRANKED";
  for (const r of ranks) if (RANK_VALUE[r] > RANK_VALUE[best]) best = r;
  return best;
}

/** A path is as good as its weakest link. */
export function weakestRank(ranks: Rank[]): Rank {
  if (!ranks.length) return "UNRANKED";
  let worst: Rank = "FILING";
  for (const r of ranks) if (RANK_VALUE[r] < RANK_VALUE[worst]) worst = r;
  return worst;
}

export function isStrict(r: Rank): boolean {
  return STRICT_RANKS.includes(r);
}
