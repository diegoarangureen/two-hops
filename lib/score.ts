// How investors are ordered. Shared by server and client so the order can be recomputed in the browser
// when the "official records and first-party sources only" switch changes. No Node APIs here.

import { isStrict, RANK_VALUE, type Rank } from "./rank";
import type { InvestorView, PathView, PeerView } from "./types";

export const WEIGHTS = { peers: 2, leads: 1.5, fit: 3, recency: 1, trust: 1 } as const;

/** What one funded attendee counts for: this much if it is nothing like you, up to 1 if it is your twin. */
export const PEER_FLOOR = 0.25;

/** Years after which a round stops adding anything to the recency factor. */
export const RECENCY_HORIZON_YEARS = 6;

const TRUST_VALUE: Record<Rank, number> = { FILING: 1, PRIMARY: 0.8, PRESS: 0.55, AGGREGATOR: 0.35, UNRANKED: 0.15 };

export interface Factors {
  /** Distinct Slush attendees this investor funded: each one is a way in. */
  peers: number;
  /** The same count with each attendee weighted by how much it resembles you (PEER_FLOOR..1). */
  peersWeighted: number;
  /** Rounds of those attendees that the investor led. */
  leads: number;
  /** Similarity of its closest funded attendee to you, 0..1. */
  fit: number;
  fitPeer?: string;
  /** Date of the most recent round whose own record is loaded. Source dates are not round dates and do not count. */
  latest: string | null;
  /** Latest source date on a link, shown when no round date is loaded. */
  latestSource: string | null;
  recency: number;
  /** Trust of its best-backed path. */
  bestTrust: Rank;
  points: { peers: number; leads: number; fit: number; recency: number; trust: number };
  total: number;
}

export interface Ranked {
  investor: InvestorView;
  paths: PathView[];
  factors: Factors;
}

function yearsBetween(a: string, b: string): number {
  return (Date.parse(b) - Date.parse(a)) / (365.25 * 86400000);
}

export function scorePaths(paths: PathView[], peers: Record<string, PeerView>, today: string): Factors {
  const peerIds = new Set(paths.map((p) => p.peerId));
  const led = new Set(paths.filter((p) => p.isLead).map((p) => p.round?.node.id ?? p.id));
  let fit = 0;
  let fitPeer: string | undefined;
  let peersWeighted = 0;
  for (const id of peerIds) {
    const s = peers[id]?.similarity.score ?? 0;
    peersWeighted += PEER_FLOOR + (1 - PEER_FLOOR) * s;
    if (s > fit) {
      fit = s;
      fitPeer = id;
    }
  }
  let latest: string | null = null;
  let latestSource: string | null = null;
  for (const p of paths) {
    if (!p.date) continue;
    if (p.dateApprox) {
      if (!latestSource || p.date > latestSource) latestSource = p.date;
    } else if (!latest || p.date > latest) {
      latest = p.date;
    }
  }
  const recency = latest ? Math.max(0, Math.min(1, 1 - yearsBetween(latest, today) / RECENCY_HORIZON_YEARS)) : 0;
  let bestTrust: Rank = "UNRANKED";
  for (const p of paths) if (RANK_VALUE[p.trust] > RANK_VALUE[bestTrust]) bestTrust = p.trust;
  const points = {
    peers: WEIGHTS.peers * Math.log2(1 + peersWeighted),
    leads: WEIGHTS.leads * Math.log2(1 + led.size),
    fit: WEIGHTS.fit * fit,
    recency: WEIGHTS.recency * recency,
    trust: WEIGHTS.trust * TRUST_VALUE[bestTrust],
  };
  const total = points.peers + points.leads + points.fit + points.recency + points.trust;
  return { peers: peerIds.size, peersWeighted, leads: led.size, fit, fitPeer, latest, latestSource, recency, bestTrust, points, total };
}

/** Path order inside one investor: closest peer first, then led rounds, then newest. */
export function sortPaths(paths: PathView[], peers: Record<string, PeerView>): PathView[] {
  return [...paths].sort((a, b) => {
    const sa = peers[a.peerId]?.similarity.score ?? -1;
    const sb = peers[b.peerId]?.similarity.score ?? -1;
    if (sb !== sa) return sb - sa;
    if (a.isLead !== b.isLead) return a.isLead ? -1 : 1;
    return (b.date ?? "").localeCompare(a.date ?? "");
  });
}

export function rankInvestors(
  investors: InvestorView[],
  peers: Record<string, PeerView>,
  opts: { strict: boolean; today: string },
): Ranked[] {
  const out: Ranked[] = [];
  for (const investor of investors) {
    const paths = opts.strict ? investor.paths.filter((p) => isStrict(p.trust)) : investor.paths;
    if (!paths.length) continue;
    out.push({ investor, paths: sortPaths(paths, peers), factors: scorePaths(paths, peers, opts.today) });
  }
  out.sort((a, b) => b.factors.total - a.factors.total || a.investor.node.name.localeCompare(b.investor.node.name));
  return out;
}
