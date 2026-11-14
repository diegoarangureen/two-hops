"use client";

// For one chosen path: a draft message to the founder of the peer company that cites only facts of the path,
// and an exportable list of who to look for at Slush.

import { useEffect, useMemo, useRef, useState } from "react";
import type { Rank } from "@/lib/rank";
import type { Ranked } from "@/lib/score";
import type { Analysis, InvestorView, PathView, PeerView, SourceView } from "@/lib/types";
import { RankBadge, SourceList } from "./Rank";

interface Fact {
  key: string;
  text: string;
  sources: SourceView[];
  rank: Rank;
  heldBack?: string;
}

interface Draft {
  to: string | null;
  subject: string;
  body: string;
  facts: Fact[];
  mode: "template" | "reworded";
  note?: string;
  rewordBudgetLeft: number;
}

interface Row {
  investor: string;
  peer: string;
  person: string;
  role: string;
  round: string;
  lead: string;
  trust: string;
  like: string;
  source: string;
  sourceDate: string;
  sourceRank: string;
}

function exportRows(ranked: Ranked[], peers: Record<string, PeerView>): Row[] {
  const rows: Row[] = [];
  for (const r of ranked) {
    const seen = new Set<string>();
    for (const p of r.paths) {
      if (seen.has(p.peerId)) continue;
      seen.add(p.peerId);
      const peer = peers[p.peerId];
      const base = {
        investor: r.investor.node.name,
        peer: peer.node.name,
        round: p.round ? p.round.label : "INVESTED_IN",
        lead: p.isLead ? "lead" : "",
        trust: p.trust,
        like: peer.similarity.score === null ? "" : `${Math.round(peer.similarity.score * 100)}%`,
      };
      const asks = peer.people.filter((x) => x.primary);
      if (!asks.length) {
        rows.push({ ...base, person: "", role: peer.node.loaded ? "no founder or CEO in Cala" : "profile not loaded", source: "", sourceDate: "", sourceRank: "" });
        continue;
      }
      for (const a of asks) {
        const s = a.roles.flatMap((x) => x.link.sources)[0];
        rows.push({
          ...base,
          person: a.name,
          role: [...new Set(a.roles.map((x) => x.relation))].join(" + "),
          source: s?.url ?? s?.name ?? "",
          sourceDate: s?.date ?? "",
          sourceRank: a.rank,
        });
      }
    }
  }
  return rows;
}

const COLUMNS: [keyof Row, string][] = [
  ["person", "Person to find"],
  ["role", "Role in Cala"],
  ["peer", "Company at Slush"],
  ["investor", "Can introduce you to"],
  ["round", "Round"],
  ["lead", "Lead"],
  ["trust", "Path trust"],
  ["like", "Like you"],
  ["sourceRank", "Role source rank"],
  ["sourceDate", "Role source date"],
  ["source", "Role source"],
];

function csvCell(v: string): string {
  const safe = /^[=+\-@]/.test(v) ? `'${v}` : v; // keep spreadsheets from reading a cell as a formula
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function toCsv(rows: Row[]): string {
  return [COLUMNS.map(([, h]) => h).join(","), ...rows.map((r) => COLUMNS.map(([k]) => csvCell(r[k])).join(","))].join("\r\n");
}

function toMarkdown(rows: Row[], me: string): string {
  const cols = COLUMNS.slice(0, 8);
  const cell = (v: string) => v.replace(/\|/g, "\\|") || "–";
  return [
    `**Who to find at Slush 2026 · ${me}** (from Cala's knowledge graph via Two Hops)`,
    "",
    `| ${cols.map(([, h]) => h).join(" | ")} |`,
    `| ${cols.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${cols.map(([k]) => cell(r[k])).join(" | ")} |`),
  ].join("\n");
}

export default function IntroKit({ analysis, ranked, investor, path, peer }: { analysis: Analysis; ranked: Ranked[]; investor: InvestorView; path: PathView; peer: PeerView }) {
  const asks = useMemo(() => [...peer.people].sort((a, b) => Number(b.primary) - Number(a.primary)), [peer]);
  const [personId, setPersonId] = useState<string>(asks[0]?.id ?? "");
  const [sender, setSender] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState<"" | "draft" | "reword">("");
  const [failed, setFailed] = useState<string | null>(null);
  const [copied, setCopied] = useState("");
  const [scope, setScope] = useState<"one" | "top">("one");
  const seq = useRef(0);

  useEffect(() => {
    try {
      setSender(window.localStorage.getItem("twohops.sender") ?? "");
    } catch {
      // storage unavailable: the name just is not remembered
    }
  }, []);

  const request = async (reword: boolean, name: string) => {
    const mine = ++seq.current;
    setBusy(reword ? "reword" : "draft");
    setFailed(null);
    try {
      const res = await fetch("/api/intro", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          me: analysis.me.attendance.from,
          investor: investor.node.id,
          peer: path.peerId,
          round: path.round?.node.id ?? null,
          person: personId || null,
          sender: name,
          reword,
        }),
      });
      const j = await res.json();
      if (mine !== seq.current) return;
      if (!res.ok) throw new Error(j.error ?? `The server answered ${res.status}`);
      setDraft(j as Draft);
      setBody((j as Draft).body);
    } catch (e) {
      if (mine === seq.current) setFailed(e instanceof Error ? e.message : "The draft could not be built.");
    } finally {
      if (mine === seq.current) setBusy("");
    }
  };

  // the template draft is cheap and local to the server: rebuild it whenever the recipient or the name changes
  useEffect(() => {
    const t = setTimeout(() => void request(false, sender), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personId, sender, path.id]);

  const rows = useMemo(
    () => exportRows(scope === "one" ? ranked.filter((r) => r.investor.node.id === investor.node.id) : ranked.slice(0, 10), analysis.peers),
    [scope, ranked, investor, analysis.peers],
  );

  const copy = async (what: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(""), 1600);
    } catch {
      setCopied("");
    }
  };

  const download = () => {
    const url = URL.createObjectURL(new Blob(["﻿" + toCsv(rows)], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `two-hops-${analysis.me.node.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-slush-2026.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="panel kit">
      <h3>
        <span className="step">4</span> Intro kit · {peer.node.name} → {investor.node.name}
      </h3>
      <div className="kit-grid">
        <div className="kit-draft">
          <div className="kit-controls">
            <label>
              Ask
              <select value={personId} onChange={(e) => setPersonId(e.target.value)}>
                {asks.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {[...new Set(p.roles.map((r) => (r.relation === "WORKS_AT" ? (r.role ?? "works at") : r.relation)))].join(", ")}
                  </option>
                ))}
                <option value="">{asks.length ? "The team (no name)" : "The team: Cala has no person for this company"}</option>
              </select>
            </label>
            <label>
              Your name
              <input
                value={sender}
                maxLength={60}
                placeholder="[your name]"
                onChange={(e) => {
                  setSender(e.target.value);
                  try {
                    window.localStorage.setItem("twohops.sender", e.target.value);
                  } catch {
                    // not remembered, nothing else to do
                  }
                }}
              />
            </label>
          </div>
          {failed && <p className="banner banner-warn">{failed}</p>}
          {draft && (
            <>
              <p className="subject">
                <span className="muted">Subject</span> {draft.subject}
              </p>
              <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={13} spellCheck aria-label="Intro message draft" />
              <div className="kit-actions">
                <button type="button" className="btn" onClick={() => copy("draft", `Subject: ${draft.subject}\n\n${body}`)}>
                  {copied === "draft" ? "Copied" : "Copy message"}
                </button>
                <button type="button" className="btn btn-ghost" disabled={busy !== "" || draft.rewordBudgetLeft <= 0} onClick={() => request(true, sender)} title="A language model rewords the draft. It gets only the facts on the right and may not add any.">
                  {busy === "reword" ? "Rewording…" : "Reword it"}
                </button>
                {draft.mode === "reworded" && (
                  <button type="button" className="linkish" onClick={() => request(false, sender)}>
                    Back to the plain draft
                  </button>
                )}
              </div>
              <p className="muted small">
                {draft.note ?? "Built from a template: every statement in it is one of the facts on the right. Edit freely; your edits stay in your browser."}
              </p>
            </>
          )}
          {!draft && !failed && <p className="muted">Building the draft…</p>}
        </div>

        <div className="kit-facts">
          <h4>The only facts this message may use</h4>
          {draft ? (
            <ul>
              {draft.facts.map((f) => (
                <li key={f.key} className={f.heldBack ? "held" : ""}>
                  <p>
                    {f.text} {f.sources.length > 0 && <RankBadge rank={f.rank} small />}
                  </p>
                  {f.heldBack ? <p className="note">Held back: {f.heldBack}</p> : <SourceList sources={f.sources.slice(0, 3)} />}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">Read from the graph on the server for this path.</p>
          )}
        </div>
      </div>

      <div className="kit-export">
        <div className="export-head">
          <h4>Who to look for at Slush</h4>
          <div className="seg" role="group" aria-label="Which investors to include">
            <button type="button" className={scope === "one" ? "on" : ""} onClick={() => setScope("one")}>
              {investor.node.name}
            </button>
            <button type="button" className={scope === "top" ? "on" : ""} onClick={() => setScope("top")}>
              Your top 10 investors
            </button>
          </div>
          <button type="button" className="btn btn-ghost" onClick={download}>
            Download CSV
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => copy("md", toMarkdown(rows, analysis.me.node.name))}>
            {copied === "md" ? "Copied" : "Copy as Markdown"}
          </button>
        </div>
        <div className="scroll">
          <table className="tbl">
            <thead>
              <tr>
                {COLUMNS.slice(0, 8).map(([k, h]) => (
                  <th key={k}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 12).map((r, i) => (
                <tr key={i}>
                  {COLUMNS.slice(0, 8).map(([k]) => (
                    <td key={k} className={k === "person" ? "strong" : ""}>
                      {k === "trust" ? <RankBadge rank={r.trust as Rank} small /> : r[k] || <span className="muted">–</span>}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted small">
          {rows.length} row{rows.length === 1 ? "" : "s"}
          {rows.length > 12 ? ", first 12 shown" : ""}. The file also carries the source, its date and its rank for each person&apos;s role.
        </p>
      </div>
    </div>
  );
}
