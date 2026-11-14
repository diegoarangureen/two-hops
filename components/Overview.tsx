"use client";

// Numbers over everything loaded, not a top-ten: coverage, investors behind several attendees, co-investors,
// and the data traps found while building the graph.

import { RANKS } from "@/lib/rank";
import type { Coverage, SetOps } from "@/lib/types";
import { RankBadge } from "./Rank";

function pct(a: number, b: number): string {
  return b ? `${((100 * a) / b).toFixed(a / b < 0.1 ? 1 : 0)}%` : "0%";
}

export function CoverageLine({ c }: { c: Coverage }) {
  return (
    <span className="coverage-pill" title="How much of the Slush 2026 node is loaded in this build">
      <b>{c.profilesLoaded.toLocaleString("en")}</b> of {c.attendeesListed.toLocaleString("en")} attendee profiles loaded ·{" "}
      <b>{c.withNamedInvestor}</b> attendees with a sourced investor
    </span>
  );
}

export default function Overview({ coverage: c, setOps: s }: { coverage: Coverage; setOps: SetOps }) {
  const totalSources = Object.values(s.sourcesByRank).reduce((a, b) => a + b, 0);
  return (
    <section className="overview">
      <h2>Across everything loaded</h2>
      <p className="lede">
        These are counts over the whole loaded set, computed on the graph. Nothing here is a sample of search results.
      </p>

      <div className="stat-row">
        <div className="stat">
          <b>{c.attendeesListed.toLocaleString("en")}</b>
          <span>entities linked to the Slush 2026 node in Cala</span>
        </div>
        <div className="stat">
          <b>{c.profilesLoaded}</b>
          <span>attendee profiles loaded ({pct(c.profilesLoaded, c.attendeesListed)} of the node)</span>
        </div>
        <div className="stat">
          <b>{c.withRound}</b>
          <span>loaded startups with a funding round on record</span>
        </div>
        <div className="stat">
          <b>{c.withNamedInvestor}</b>
          <span>attendees with at least one sourced investor</span>
        </div>
        <div className="stat">
          <b>{c.investorsLinked}</b>
          <span>investors linked to those attendees ({c.investorProfilesLoaded} with their full portfolio loaded)</span>
        </div>
      </div>
      <p className="muted small">
        Coverage is partial on purpose: the free Cala plan allows 100 calls a month, and this build used {c.creditsLogged} of
        them. Attendees found through an investor&apos;s portfolio are matched by Cala id, never by name. Graph built{" "}
        {c.builtAt.slice(0, 16).replace("T", " ")} UTC.
      </p>

      <div className="cols">
        <div className="panel">
          <h3>Investors behind more than one attendee</h3>
          {s.investorsInSeveral.length === 0 ? (
            <p className="muted">None in the loaded set yet.</p>
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>Investor</th>
                  <th className="num">Attendees funded</th>
                  <th className="num">Rounds led</th>
                </tr>
              </thead>
              <tbody>
                {s.investorsInSeveral.slice(0, 12).map((x) => (
                  <tr key={x.id}>
                    <td>{x.name}</td>
                    <td className="num">{x.attendees}</td>
                    <td className="num">{x.led || "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="panel">
          <h3>Who co-invests</h3>
          {s.coInvestorPairs.length === 0 ? (
            <p className="muted">No attendee in the loaded set has two investors yet.</p>
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>Pair</th>
                  <th className="num">Shared attendees</th>
                  <th>In</th>
                </tr>
              </thead>
              <tbody>
                {s.coInvestorPairs.slice(0, 8).map((x) => (
                  <tr key={x.a + x.b}>
                    <td>
                      {x.aName} <span className="muted">+</span> {x.bName}
                    </td>
                    <td className="num">{x.shared}</td>
                    <td className="muted">{x.companies.join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="panel">
          <h3>Data traps, in the open</h3>
          <ul className="traps">
            <li>
              <b>{s.traps.mergedDuplicates.length}</b> organisations held twice in Cala, once as Company and once as
              Organization, merged into one
              {s.traps.mergedDuplicates.length > 0 && (
                <span className="muted"> (e.g. {s.traps.mergedDuplicates.slice(0, 3).map((m) => m.name).join(", ")})</span>
              )}
              . {s.traps.sameNameKeptApart} same-name records of the same type are kept apart: they may be different
              companies.
            </li>
            <li>
              <b>{s.traps.bothWays}</b> investments recorded in both directions
              {s.traps.bothWaysExamples.length > 0 && (
                <span className="muted">
                  {" "}
                  (e.g. {s.traps.bothWaysExamples[0].from} “invested in” {s.traps.bothWaysExamples[0].to})
                </span>
              )}
              . The direction pointing at the bigger investor is not used for paths.
            </li>
            <li>
              <b>{s.traps.inferredRoundLabels.length}</b> loaded round{s.traps.inferredRoundLabels.length === 1 ? "" : "s"} whose
              label Cala inferred rather than read. They are tagged “label inferred” and the intro draft does not name them.
            </li>
            <li>
              <b>{s.traps.financingTwice.length}</b> financings found both as a FundingRound and as a filing event of the same
              company. Rounds and filing events are never added together.
            </li>
          </ul>
          <h4>Sources behind this graph</h4>
          <div className="rankbar" aria-hidden>
            {RANKS.map((r) =>
              s.sourcesByRank[r] ? <i key={r} className={`rk-${r}`} style={{ flexGrow: s.sourcesByRank[r] }} title={`${r}: ${s.sourcesByRank[r]}`} /> : null,
            )}
          </div>
          <p className="rank-counts">
            {RANKS.map((r) =>
              s.sourcesByRank[r] ? (
                <span key={r}>
                  <RankBadge rank={r} small /> {s.sourcesByRank[r].toLocaleString("en")} ({pct(s.sourcesByRank[r], totalSources)})
                </span>
              ) : null,
            )}
          </p>
        </div>
      </div>
    </section>
  );
}
