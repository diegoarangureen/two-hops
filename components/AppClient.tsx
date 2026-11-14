"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isStrict, type Rank } from "@/lib/rank";
import { PEER_FLOOR, rankInvestors, RECENCY_HORIZON_YEARS, WEIGHTS, type Ranked } from "@/lib/score";
import type { Analysis, Coverage, LinkView, PathView, PeerView, SearchHit, SetOps } from "@/lib/types";
import IntroKit from "./IntroKit";
import Overview, { CoverageLine } from "./Overview";
import PathGraph, { type Selection } from "./PathGraph";
import Provenance, { type Picked } from "./Provenance";
import { RankBadge } from "./Rank";

interface OverviewData {
  coverage: Coverage;
  setOps: SetOps;
  suggestions: SearchHit[];
  liveBudgetLeft: number;
}

const fmt = (x: number) => x.toFixed(2).replace(/\.?0+$/, "");

export default function AppClient() {
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [loading, setLoading] = useState<{ name: string; live: boolean } | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [strict, setStrict] = useState(false);
  const [investorId, setInvestorId] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [kitPathId, setKitPathId] = useState<string | null>(null);
  const [showAllPeers, setShowAllPeers] = useState(false);
  const searchSeq = useRef(0);
  const detailRef = useRef<HTMLDivElement>(null);

  const loadOverview = useCallback(() => {
    fetch("/api/overview")
      .then((r) => r.json())
      .then(setOverview)
      .catch(() => undefined);
  }, []);

  const choose = useCallback(
    async (id: string, name: string, loaded: boolean) => {
      setError(null);
      setHits(null);
      setQ("");
      setLoading({ name, live: !loaded });
      setAnalysis(null);
      setInvestorId(null);
      setSelection(null);
      setKitPathId(null);
      setShowAllPeers(false);
      try {
        const res = await fetch("/api/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
        const j = await res.json();
        if (!res.ok) throw new Error(j.error ?? `The server answered ${res.status}`);
        setAnalysis(j as Analysis);
        window.history.replaceState(null, "", `/app?me=${id}`);
        if (!loaded) loadOverview(); // a live read adds one profile to the loaded set
      } catch (e) {
        setError(e instanceof Error ? e.message : "Something went wrong.");
      } finally {
        setLoading(null);
      }
    },
    [loadOverview],
  );

  useEffect(() => {
    loadOverview();
    const me = new URLSearchParams(window.location.search).get("me");
    if (me) void choose(me, "your company", true);
  }, [loadOverview, choose]);

  useEffect(() => {
    const term = q.trim();
    if (!term) {
      setHits(null);
      return;
    }
    const seq = ++searchSeq.current;
    const t = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(term)}`)
        .then((r) => r.json())
        .then((j) => {
          if (seq === searchSeq.current) setHits(j.hits ?? []);
        })
        .catch(() => undefined);
    }, 140);
    return () => clearTimeout(t);
  }, [q]);

  const ranked: Ranked[] = useMemo(
    () => (analysis ? rankInvestors(analysis.investors, analysis.peers, { strict, today: analysis.today }) : []),
    [analysis, strict],
  );
  const current = ranked.find((r) => r.investor.node.id === investorId) ?? ranked[0] ?? null;
  const currentRank = current ? ranked.indexOf(current) + 1 : 0;
  const topScore = ranked[0]?.factors.total ?? 1;
  const kitPath = current?.paths.find((p) => p.id === kitPathId) ?? current?.paths[0] ?? null;
  const strictCount = useMemo(
    () => (analysis ? analysis.investors.filter((i) => i.paths.some((p) => isStrict(p.trust))).length : 0),
    [analysis],
  );

  const picked: Picked = useMemo(() => {
    if (!analysis || !current || !selection) return null;
    const names = new Map<string, string>([
      [analysis.me.node.id, analysis.me.node.name],
      [analysis.event.id, analysis.event.name],
      [current.investor.node.id, current.investor.node.name],
    ]);
    for (const [id, p] of Object.entries(analysis.peers)) names.set(id, p.node.name);
    for (const p of current.paths) if (p.round) names.set(p.round.node.id, `${p.round.label} round`);
    if (selection.kind === "person") {
      const peer = analysis.peers[selection.peerId];
      const person = peer?.people.find((x) => x.id === selection.id);
      return person ? { kind: "person", person, company: peer.node.name } : null;
    }
    if (selection.kind === "link") {
      const links: LinkView[] = [analysis.me.attendance];
      for (const p of current.paths) {
        links.push(...p.links, analysis.peers[p.peerId].attendance);
        if (p.corroboration) links.push(p.corroboration);
      }
      const link = links.find((l) => l.id === selection.id);
      return link ? { kind: "link", link, fromName: names.get(link.from) ?? link.from, toName: names.get(link.to) ?? link.to } : null;
    }
    const id = selection.id;
    if (id === analysis.me.node.id) return { kind: "node", node: analysis.me.node, role: "you" };
    if (id === analysis.event.id) {
      return {
        kind: "node",
        node: analysis.event,
        role: "event",
        extra: (
          <p className="note">
            Attendance links come from slush.org through Cala, which gives them no source_rank. The same link is in every path,
            so path trust is computed over the funding links.
          </p>
        ),
      };
    }
    if (id === current.investor.node.id) return { kind: "node", node: current.investor.node, role: "investor" };
    const peer = analysis.peers[id];
    if (peer) return { kind: "node", node: peer.node, role: "peer at Slush", extra: <PeerExtra peer={peer} /> };
    const path = current.paths.find((p) => p.round?.node.id === id);
    if (path?.round) {
      const r = path.round;
      return {
        kind: "node",
        node: r.node,
        role: "funding round",
        extra: (
          <p className="note">
            {r.node.loaded
              ? `Date taken from the round's ${r.dateBasis}.`
              : r.date
                ? `This round's own record is not loaded. The date shown (${r.date}) is the earliest source on its links, not the round date.`
                : "This round's own record is not loaded: no amount or date."}
            {r.labelInferred ? " Cala inferred this label from the order of the company's rounds; it was not stated by a source." : ""}
            {r.alsoFiledAs ? " The same financing also exists in Cala as a filing event; it is counted once." : ""}
          </p>
        ),
      };
    }
    return null;
  }, [analysis, current, selection]);

  const selectInvestor = (id: string) => {
    setInvestorId(id);
    setSelection(null);
    setKitPathId(null);
    setShowAllPeers(false);
    if (window.innerWidth < 1000) detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="app">
      <header className="topbar">
        <Link href="/" className="brand">
          Two&nbsp;Hops
        </Link>
        <span className="tagline">the warm intro that is already at Slush</span>
        {overview && <CoverageLine c={analysis?.coverage ?? overview.coverage} />}
      </header>

      <section className="find">
        <h1>
          <span className="step">1</span> Find yourself among the Slush 2026 attendees
        </h1>
        <div className="searchbox">
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Type your company name…"
            aria-label="Search the Slush 2026 attendee list"
            autoComplete="off"
            spellCheck={false}
          />
          {hits && (
            <ul className="hits">
              {hits.length === 0 && <li className="none">No attendee with that name in Cala&apos;s Slush 2026 node.</li>}
              {hits.map((h) => (
                <li key={h.id}>
                  <button type="button" onClick={() => choose(h.id, h.name, h.loaded)}>
                    <span className="hname">{h.name}</span>
                    <span className="htype">{h.type}</span>
                    {h.hasFundingLink && <span className="chip chip-ok">has a sourced investor</span>}
                    <span className={`chip ${h.loaded ? "chip-cached" : "chip-live"}`}>{h.loaded ? "profile cached" : "1 live Cala call"}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <p className="muted small">
          The name search runs on the {overview?.coverage.attendeesListed.toLocaleString("en") ?? "2,989"} entities linked to the event
          and costs nothing. Opening a company that is not cached reads its profile from Cala once
          {overview ? ` (${overview.liveBudgetLeft} live call${overview.liveBudgetLeft === 1 ? "" : "s"} left on this server)` : ""}.
        </p>
        {!analysis && !loading && overview && overview.suggestions.length > 0 && (
          <p className="suggest">
            <span className="muted">Or start from a cached profile:</span>
            {overview.suggestions.map((s) => (
              <button key={s.id} type="button" className="linkish" onClick={() => choose(s.id, s.name, s.loaded)}>
                {s.name}
              </button>
            ))}
          </p>
        )}
      </section>

      {error && <p className="banner banner-warn">{error}</p>}

      {loading && (
        <section className="loading">
          <div className="spinner" aria-hidden />
          <p>{loading.live ? `Reading ${loading.name} from Cala: one live call…` : `Walking the graph from ${loading.name}…`}</p>
        </section>
      )}

      {analysis && (
        <>
          <section className="you">
            <div className="you-card">
              <p className="eyebrow">You</p>
              <h2>
                <button type="button" className="plain" onClick={() => setSelection({ kind: "node", id: analysis.me.node.id })}>
                  {analysis.me.node.name}
                </button>
              </h2>
              <p className="chips">
                {analysis.me.headline.industry && <span className="chip">{analysis.me.headline.industry}</span>}
                {analysis.me.headline.stage && <span className="chip">{analysis.me.headline.stage}</span>}
                {analysis.me.headline.hq && <span className="chip">{analysis.me.headline.hq}</span>}
                {analysis.me.headline.founded && <span className="chip">founded {analysis.me.headline.founded}</span>}
                {!analysis.me.node.loaded && <span className="chip chip-warn">profile not loaded</span>}
              </p>
            </div>
            <div className="you-notes">
              {analysis.live.called && !analysis.live.error && (
                <p className="banner banner-ok">
                  Profile read live from Cala in {analysis.live.seconds} s and cached. {analysis.live.budgetLeft} live call
                  {analysis.live.budgetLeft === 1 ? "" : "s"} left on this server.
                </p>
              )}
              {analysis.live.error && <p className="banner banner-warn">{analysis.live.error} Peers cannot be compared with you, but every path below is still real.</p>}
              {analysis.me.investorLike && (
                <p className="banner banner-warn">Cala records this attendee as an investor. Two Hops is built for founders who are raising.</p>
              )}
              <p className="summary">
                <b>{analysis.counts.peersWithPath}</b> other attendees have a sourced investor in the loaded graph. Behind them:{" "}
                <b>{analysis.counts.investorsTotal}</b> investors, each one two hops from you.
              </p>
            </div>
          </section>

          <section className="results">
            <aside className="investors">
              <div className="list-head">
                <h2>
                  <span className="step">2</span> Investors, ranked
                </h2>
                <label className="switch" title="Keep only paths where every funding link is backed by an official filing or a first-party source">
                  <input type="checkbox" checked={strict} onChange={(e) => { setStrict(e.target.checked); setSelection(null); }} />
                  <span>
                    Official &amp; first-party sources only <em>({strictCount})</em>
                  </span>
                </label>
              </div>
              {ranked.length === 0 && (
                <p className="muted pad">
                  {strict
                    ? "No path survives on filings and first-party sources alone. Switch the filter off to see the rest."
                    : "No funded peers in the loaded graph yet."}
                </p>
              )}
              <ol className="inv-list">
                {ranked.map((r, i) => {
                  const f = r.factors;
                  return (
                    <li key={r.investor.node.id}>
                      <button type="button" className={current === r ? "inv on" : "inv"} onClick={() => selectInvestor(r.investor.node.id)}>
                        <span className="pos">{i + 1}</span>
                        <span className="inv-main">
                          <span className="inv-name">{r.investor.node.name}</span>
                          <span className="inv-meta">
                            {f.peers} peer{f.peers === 1 ? "" : "s"} at Slush
                            {f.leads ? <b className="lead"> · led {f.leads}</b> : ""}
                            {f.latest ? ` · round in ${f.latest.slice(0, 4)}` : ""}
                            {f.fit > 0 ? ` · ${Math.round(f.fit * 100)}% fit` : ""}
                          </span>
                          <span className="bar" style={{ width: `${Math.max(8, (100 * f.total) / topScore)}%` }} aria-hidden>
                            <i className="b-peers" style={{ flexGrow: f.points.peers }} />
                            <i className="b-leads" style={{ flexGrow: f.points.leads }} />
                            <i className="b-fit" style={{ flexGrow: f.points.fit }} />
                            <i className="b-recency" style={{ flexGrow: f.points.recency }} />
                            <i className="b-trust" style={{ flexGrow: f.points.trust }} />
                          </span>
                        </span>
                        <RankBadge rank={f.bestTrust} small />
                      </button>
                    </li>
                  );
                })}
              </ol>
              {analysis.counts.investorsShown < analysis.counts.investorsTotal && (
                <p className="muted small pad">
                  Top {analysis.counts.investorsShown} of {analysis.counts.investorsTotal} investors shown.
                </p>
              )}
            </aside>

            <div className="detail" ref={detailRef}>
              {current && (
                <>
                  <div className="detail-head">
                    <p className="eyebrow">
                      #{currentRank} of {ranked.length} · {current.investor.node.type}
                    </p>
                    <h2>{current.investor.node.name}</h2>
                    <p className="muted small">{totalsLine(current)}</p>
                    {current.investor.coInvestors.length > 0 && (
                      <p className="coinv">
                        <span className="muted small">Funds the same attendees as</span>
                        {current.investor.coInvestors.map((c) => (
                          <button key={c.id} type="button" className="chip chip-btn" onClick={() => selectInvestor(c.id)} disabled={!ranked.some((r) => r.investor.node.id === c.id)}>
                            {c.name} <em>{c.shared}</em>
                          </button>
                        ))}
                      </p>
                    )}
                  </div>

                  <PathGraph
                    you={{
                      id: analysis.me.node.id,
                      name: analysis.me.node.name,
                      sub: analysis.me.headline.industry ?? (analysis.me.node.loaded ? undefined : "profile not loaded"),
                      rank: (analysis.me.node.facts.find((f) => f.key === "name")?.rank as Rank | undefined) ?? null,
                    }}
                    youAttendance={analysis.me.attendance}
                    event={analysis.event}
                    investor={current.investor.node}
                    paths={current.paths}
                    peers={analysis.peers}
                    selection={selection}
                    onSelect={setSelection}
                    maxPeers={showAllPeers ? 40 : 5}
                  />
                  {new Set(current.paths.map((p) => p.peerId)).size > 5 && (
                    <button type="button" className="linkish" onClick={() => setShowAllPeers((v) => !v)}>
                      {showAllPeers ? "Show the closest five only" : "Draw every funded peer"}
                    </button>
                  )}

                  <div className="two">
                    <Provenance picked={picked} />
                    <WhyRank r={current} rank={currentRank} peers={analysis.peers} />
                  </div>

                  <div className="panel">
                    <h3>
                      <span className="step">3</span> Every path to {current.investor.node.name}
                    </h3>
                    <table className="tbl paths">
                      <thead>
                        <tr>
                          <th>Peer at Slush</th>
                          <th>Like you</th>
                          <th>Round</th>
                          <th>Role</th>
                          <th>Path trust</th>
                          <th>Who to ask</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {current.paths.map((p) => (
                          <PathRow
                            key={p.id}
                            p={p}
                            peer={analysis.peers[p.peerId]}
                            active={kitPath?.id === p.id}
                            onKit={() => setKitPathId(p.id)}
                            onWeakest={() => setSelection({ kind: "link", id: p.weakestLinkId })}
                          />
                        ))}
                      </tbody>
                    </table>
                    <p className="muted small">
                      Path trust is the weakest of its funding links; each link counts as its best source. Click a trust badge to see
                      that weakest link.
                    </p>
                  </div>

                  {kitPath && (
                    <IntroKit
                      key={kitPath.id}
                      analysis={analysis}
                      ranked={ranked}
                      investor={current.investor}
                      path={kitPath}
                      peer={analysis.peers[kitPath.peerId]}
                    />
                  )}
                </>
              )}
            </div>
          </section>
        </>
      )}

      {overview && <Overview coverage={analysis?.coverage ?? overview.coverage} setOps={overview.setOps} />}

      <footer className="foot">
        Every company, round, investor and person on this page comes from Cala&apos;s knowledge graph with its source. Nothing is
        generated. <Link href="/">About Two Hops</Link>
      </footer>
    </div>
  );
}

function totalsLine(r: Ranked): string {
  const t = r.investor.totals;
  if (!r.investor.node.loaded) return "This investor's own profile is not loaded: it is known through the companies it funded.";
  const n = (x: number, rel: string) => `${x.toLocaleString("en")}${t.truncated.includes(rel) ? "+" : ""}`;
  return (
    `In Cala: ${n(t.investments, "INVESTED_IN")} portfolio links, ${n(t.roundsBacked, "PARTICIPATES_IN_FUNDING_ROUND")} rounds backed ` +
    `(${t.roundsLed} led), ${n(t.filingEvents, "PARTICIPATES_IN_CORPORATE_EVENT")} filing events. Shown side by side, never added: ` +
    "one financing can appear as both." +
    (t.truncated.length ? " A + means the list came back full at Cala's 1,000-item page: more exist than are loaded here." : "")
  );
}

function PeerExtra({ peer }: { peer: PeerView }) {
  const s = peer.similarity;
  return (
    <div className="sim">
      <p className="note">
        {peer.rounds.length} funding round{peer.rounds.length === 1 ? "" : "s"} on record
        {peer.filingEvents ? `, ${peer.filingEvents} filing event${peer.filingEvents === 1 ? "" : "s"}` : ""}
        {peer.filingEventsSameAsRound ? ` (${peer.filingEventsSameAsRound} is the same financing as a round and is counted once)` : ""}.
        {peer.formerPeople ? ` ${peer.formerPeople} past role-holder${peer.formerPeople === 1 ? "" : "s"} left out (valid_until in the past).` : ""}
      </p>
      {s.score === null ? (
        <p className="muted small">{s.note}</p>
      ) : (
        <table className="tbl mini">
          <thead>
            <tr>
              <th>How it compares with you</th>
              <th />
              <th className="num">{Math.round(s.score * 100)}%</th>
            </tr>
          </thead>
          <tbody>
            {s.factors.map((f) => (
              <tr key={f.key} className={f.score ? "" : "off"}>
                <td>{f.label}</td>
                <td className="muted">{f.detail}</td>
                <td className="num">{f.score ? `+${Math.round(f.weight * f.score * 100)}` : "0"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function WhyRank({ r, rank, peers }: { r: Ranked; rank: number; peers: Record<string, PeerView> }) {
  const f = r.factors;
  const rows: [string, string, string, number, string][] = [
    [
      "peers",
      "Attendees it funded",
      `${f.peers} (${fmt(f.peersWeighted)} weighted by likeness)`,
      f.points.peers,
      `${WEIGHTS.peers} × log₂(1 + ${fmt(f.peersWeighted)}); an attendee counts ${PEER_FLOOR} if nothing like you, up to 1 if just like you`,
    ],
    ["leads", "Rounds it led", `${f.leads}`, f.points.leads, `${WEIGHTS.leads} × log₂(1 + ${f.leads})`],
    [
      "fit",
      "Closest peer to you",
      f.fitPeer ? `${Math.round(f.fit * 100)}% · ${peers[f.fitPeer]?.node.name ?? ""}` : "no comparable peer loaded",
      f.points.fit,
      `${WEIGHTS.fit} × ${fmt(f.fit)}`,
    ],
    [
      "recency",
      "Most recent dated round",
      f.latest ?? (f.latestSource ? `none loaded (latest source: ${f.latestSource})` : "none loaded"),
      f.points.recency,
      `${WEIGHTS.recency} × ${fmt(f.recency)}, fades to 0 over ${RECENCY_HORIZON_YEARS} y`,
    ],
    ["trust", "Best-backed path", f.bestTrust, f.points.trust, `${WEIGHTS.trust} × ${fmt(f.points.trust / WEIGHTS.trust)}`],
  ];
  return (
    <div className="panel why">
      <h3>Why #{rank}</h3>
      <table className="tbl mini">
        <tbody>
          {rows.map(([key, label, found, pts, how]) => (
            <tr key={key}>
              <td>
                <i className={`sw b-${key}`} /> {label}
              </td>
              <td>{key === "trust" ? <RankBadge rank={found as Rank} small /> : found}</td>
              <td className="num" title={how}>
                {fmt(pts)}
              </td>
            </tr>
          ))}
          <tr className="total">
            <td>Score</td>
            <td className="muted small">sum of the five</td>
            <td className="num">{fmt(f.total)}</td>
          </tr>
        </tbody>
      </table>
      <p className="muted small">
        The order is arithmetic on the graph, not a model&apos;s opinion. Hover a number for its formula. Attendees are weighted
        by how much they resemble you and then put through a logarithm, so a large accelerator does not win on volume alone.
        A source date is not a round date and earns no recency.
      </p>
    </div>
  );
}

function PathRow({ p, peer, active, onKit, onWeakest }: { p: PathView; peer: PeerView; active: boolean; onKit: () => void; onWeakest: () => void }) {
  const asks = peer.people.filter((x) => x.primary);
  const s = peer.similarity.score;
  return (
    <tr className={active ? "on" : ""}>
      <td>
        <b>{peer.node.name}</b>
        <span className="sub">{peer.headline.industry ?? (peer.node.loaded ? "" : "profile not loaded")}</span>
      </td>
      <td>{s === null ? <span className="muted">n/a</span> : `${Math.round(s * 100)}%`}</td>
      <td>
        {p.round ? (
          <>
            {p.round.label}
            {p.round.labelInferred && <span className="flag">label inferred</span>}
            <span className="sub">
              {[p.round.amount, p.round.date ? (p.round.dateBasis === "earliest source" ? `source dated ${p.round.date}` : p.round.date) : null]
                .filter(Boolean)
                .join(" · ") || "round details not loaded"}
            </span>
          </>
        ) : (
          <>
            <span className="muted">INVESTED_IN</span>
            <span className="sub">{p.date ? `source dated ${p.date}` : "round not identified"}</span>
          </>
        )}
      </td>
      <td>{p.isLead ? <b className="lead">Lead</b> : p.kind === "round" ? String(p.links[1].props.role ?? "Investor").toLowerCase() : "investor"}</td>
      <td>
        <button type="button" className="plain" onClick={onWeakest} title="Show the weakest link of this path">
          <RankBadge rank={p.trust} small />
        </button>
      </td>
      <td>
        {asks.length ? asks.slice(0, 2).map((x) => x.name).join(", ") : <span className="muted">{peer.node.loaded ? "no founder or CEO in Cala" : "profile not loaded"}</span>}
        {asks.length > 2 && <span className="muted"> +{asks.length - 2}</span>}
      </td>
      <td>
        <button type="button" className="btn-sm" onClick={onKit}>
          Intro kit
        </button>
      </td>
    </tr>
  );
}
