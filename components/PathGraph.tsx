"use client";

// The path drawn as the graph it is: you -> Slush 2026 <- peer -> round <- investor, plus the people of the peer.
// Arrows point the way the relationship points in Cala. Colour is the best source rank behind each item.
// Each row carries its relationship names above it, so the full Cala name fits whatever the zoom.

import { bestRank, type Rank } from "@/lib/rank";
import type { LinkView, NodeView, PathView, PeerView, PersonView } from "@/lib/types";

export type Selection =
  | { kind: "node"; id: string }
  | { kind: "link"; id: string }
  | { kind: "person"; id: string; peerId: string }
  | null;

export interface YouNode {
  id: string;
  name: string;
  sub?: string;
  rank?: Rank | null;
  placeholder?: boolean;
}

interface Props {
  you: YouNode;
  youAttendance?: LinkView;
  event: NodeView;
  investor: NodeView;
  paths: PathView[];
  peers: Record<string, PeerView>;
  selection?: Selection;
  onSelect?: (s: Selection) => void;
  maxPeers?: number;
  maxPeople?: number;
}

const W = 1204;
const X = { you: 94, event: 333, peer: 581, round: 839, inv: 1099 };
const NW = { you: 168, event: 150, peer: 186, round: 170, inv: 190 };
const NH = 52;
const ROUND_H = 56;
const HEAD = 36; // room above every row for its relationship labels
const PERSON_H = 36;
const PERSON_GAP = 6;
const BLOCK_GAP = 14;

interface Row {
  peerId: string;
  peer: PeerView;
  rounds: PathView[];
  direct?: PathView;
  people: PersonView[];
  morePeople: number;
  peerY: number;
  roundY: number[];
  peopleTop: number;
}

function nodeRank(n: NodeView): Rank | null {
  const name = n.facts.find((f) => f.key === "name");
  if (name && name.sources.length) return name.rank;
  const all = n.facts.filter((f) => f.sources.length).map((f) => f.rank);
  return all.length ? bestRank(all) : null;
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
}

function propsText(l: LinkView): string {
  const out: string[] = [];
  for (const k of ["role", "is_lead", "valid_since", "event_date"]) {
    if (l.props[k] !== undefined) out.push(`${k}: ${String(l.props[k])}`);
  }
  return out.join(" · ");
}

function curve(x1: number, y1: number, x2: number, y2: number): string {
  const dx = (x2 - x1) / 2;
  return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
}

export default function PathGraph({
  you,
  youAttendance,
  event,
  investor,
  paths,
  peers,
  selection = null,
  onSelect,
  maxPeers = 6,
  maxPeople = 2,
}: Props) {
  // one block per peer, in the order the paths arrive (closest peer first)
  const order: string[] = [];
  for (const p of paths) if (!order.includes(p.peerId)) order.push(p.peerId);
  const shown = order.slice(0, maxPeers);

  const rows: Row[] = [];
  let top = 4;
  for (const peerId of shown) {
    const peer = peers[peerId];
    if (!peer) continue;
    const mine = paths.filter((p) => p.peerId === peerId);
    const rounds = mine.filter((p) => p.kind === "round").slice(0, 3);
    const direct = rounds.length ? undefined : mine.find((p) => p.kind === "direct");
    const primary = peer.people.filter((x) => x.primary);
    const people = (primary.length ? primary : peer.people).slice(0, maxPeople);
    const morePeople = peer.people.length - people.length;

    const peerY = top + HEAD + NH / 2;
    const roundY = rounds.map((_, i) => (rounds.length === 1 ? peerY : top + HEAD + ROUND_H / 2 + i * (ROUND_H + HEAD)));
    const roundsBottom = rounds.length ? roundY[roundY.length - 1] + ROUND_H / 2 + (rounds.some((p) => p.round?.labelInferred) ? 14 : 0) : peerY + NH / 2;
    // with several rounds the lower rows need the space under the peer for their labels: people go below them
    const peopleTop = (rounds.length > 1 ? Math.max(peerY + NH / 2, roundsBottom) : peerY + NH / 2) + 10;
    const peopleH = people.length ? people.length * (PERSON_H + PERSON_GAP) + (morePeople > 0 ? 12 : 0) : 0;
    const bottom = Math.max(roundsBottom, people.length ? peopleTop + peopleH : peerY + NH / 2);
    rows.push({ peerId, peer, rounds, direct, people, morePeople, peerY, roundY, peopleTop });
    top = bottom + BLOCK_GAP;
  }
  if (!rows.length) return null;
  const H = top - BLOCK_GAP + 12;

  const leftY = (rows[0].peerY + rows[rows.length - 1].peerY) / 2;
  const rightAnchors = rows.flatMap((r) => (r.rounds.length ? r.roundY : [r.peerY]));
  const invY = (rightAnchors[0] + rightAnchors[rightAnchors.length - 1]) / 2;

  const isSel = (s: Selection) =>
    !!selection && !!s && selection.kind === s.kind && selection.id === s.id && (s.kind !== "person" || (selection as { peerId: string }).peerId === s.peerId);
  const pick = (s: Selection) => (e: React.MouseEvent | React.KeyboardEvent) => {
    if ("key" in e && e.key !== "Enter" && e.key !== " ") return;
    e.stopPropagation();
    onSelect?.(s);
  };
  const interactive = (s: Selection) =>
    onSelect && s ? { role: "button", tabIndex: 0, onClick: pick(s), onKeyDown: pick(s), "data-sel": isSel(s) ? "1" : undefined } : {};

  /** One relationship: the line with its arrow, and its name and properties above the row it arrives on. */
  const edge = (
    key: string,
    l: LinkView,
    from: [number, number],
    to: [number, number],
    label: { x: number; anchor: "start" | "middle" | "end"; rowTop: number },
    lead = false,
  ) => {
    const props = propsText(l);
    const d = curve(from[0], from[1], to[0], to[1]);
    return (
      <g key={key} className={`edge rk-${l.rank}${lead ? " lead" : ""}`} {...interactive({ kind: "link", id: l.id })}>
        <title>{`${l.type} · best source: ${l.rank} · ${l.sources.length} source${l.sources.length === 1 ? "" : "s"}`}</title>
        <path className="hit" d={d} />
        <path className="line" d={d} markerEnd={`url(#arrow-${l.rank})`} />
        <text className="etype" x={label.x} y={label.rowTop - (props ? 17 : 7)} textAnchor={label.anchor}>
          {l.type}
        </text>
        {props && (
          <text className={`eprops${l.props.is_lead === true ? " is-lead" : ""}`} x={label.x} y={label.rowTop - 5} textAnchor={label.anchor}>
            {props}
          </text>
        )}
      </g>
    );
  };

  const box = (
    key: string,
    kind: string,
    cx: number,
    cy: number,
    w: number,
    h: number,
    type: string,
    name: string,
    sub: string | undefined,
    rank: Rank | null,
    sel: Selection,
    below?: string,
  ) => (
    <g key={key} className={`node node-${kind}`} transform={`translate(${cx - w / 2},${cy - h / 2})`} {...interactive(sel)}>
      <title>{name}</title>
      <rect width={w} height={h} rx={11} />
      <text className="ntype" x={12} y={15}>
        {type}
      </text>
      <text className="nname" x={12} y={sub ? 32 : 35}>
        {clip(name, Math.floor((w - 22) / 7.7))}
      </text>
      {sub && (
        <text className="nsub" x={12} y={h - 8}>
          {clip(sub, Math.floor((w - 22) / 5.7))}
        </text>
      )}
      <circle className={`dot ${rank ? `rk-${rank}` : "rk-none"}`} cx={w - 13} cy={12} r={4.5} />
      {below && (
        <text className="ntag" x={w / 2} y={h + 11} textAnchor="middle">
          {below}
        </text>
      )}
    </g>
  );

  const youR = X.you + NW.you / 2;
  const evL = X.event - NW.event / 2;
  const evR = X.event + NW.event / 2;
  const peerL = X.peer - NW.peer / 2;
  const peerR = X.peer + NW.peer / 2;
  const rndL = X.round - NW.round / 2;
  const rndR = X.round + NW.round / 2;
  const invL = X.inv - NW.inv / 2;
  const pillW = NW.peer - 14;

  return (
    <div className="graph-wrap">
      <svg className="graph" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Paths from ${you.name} to ${investor.name}`}>
        <defs>
          {(["FILING", "PRIMARY", "PRESS", "AGGREGATOR", "UNRANKED"] as Rank[]).map((r) => (
            <marker key={r} id={`arrow-${r}`} className={`arrow rk-${r}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" />
            </marker>
          ))}
        </defs>

        {/* relationships first, so nodes sit on top of the line ends */}
        {youAttendance ? (
          edge("you-ev", youAttendance, [youR, leftY], [evL, leftY], { x: (youR + evL) / 2, anchor: "middle", rowTop: leftY - NH / 2 })
        ) : (
          <g className="edge rk-UNRANKED placeholder">
            <path className="line" d={curve(youR, leftY, evL, leftY)} markerEnd="url(#arrow-UNRANKED)" />
            <text className="etype" x={(youR + evL) / 2} y={leftY - NH / 2 - 17} textAnchor="middle">
              PARTICIPATES_IN_EVENT
            </text>
            <text className="eprops" x={(youR + evL) / 2} y={leftY - NH / 2 - 5} textAnchor="middle">
              role: ATTENDEE
            </text>
          </g>
        )}
        {rows.map((r) =>
          edge(`att-${r.peerId}`, r.peer.attendance, [peerL, r.peerY], [evR, leftY], { x: evR + 8, anchor: "start", rowTop: r.peerY - NH / 2 }),
        )}
        {rows.flatMap((r) =>
          r.rounds.flatMap((p, i) => [
            edge(`iss-${p.id}`, p.links[0], [peerR, r.peerY], [rndL, r.roundY[i]], { x: peerR - 84, anchor: "start", rowTop: r.roundY[i] - ROUND_H / 2 }),
            edge(`par-${p.id}`, p.links[1], [invL, invY], [rndR, r.roundY[i]], { x: invL - 6, anchor: "end", rowTop: r.roundY[i] - ROUND_H / 2 }, p.isLead),
          ]),
        )}
        {rows.map((r) =>
          r.direct
            ? edge(`dir-${r.direct.id}`, r.direct.links[0], [invL, invY], [peerR, r.peerY], { x: peerR + 16, anchor: "start", rowTop: r.peerY + 8 })
            : null,
        )}

        {/* people of each peer: a trunk into the peer, one tick per person */}
        {rows.map((r) =>
          r.people.length ? (
            <g key={`ppl-${r.peerId}`} className="people">
              <path
                className="trunk"
                d={`M${peerL + 14},${r.peopleTop + (r.people.length - 1) * (PERSON_H + PERSON_GAP) + PERSON_H / 2} V${r.peerY + NH / 2 + 2}`}
                markerEnd="url(#arrow-UNRANKED)"
              />
              {r.people.map((p, i) => {
                const py = r.peopleTop + i * (PERSON_H + PERSON_GAP);
                const rels = [...new Set(p.roles.map((x) => x.relation))].join(" · ");
                const sel: Selection = { kind: "person", id: p.id, peerId: r.peerId };
                return (
                  <g key={p.id} className="person" transform={`translate(${peerL + 14},${py})`} {...interactive(sel)}>
                    <title>{`${p.name}: ${p.roles.map((x) => x.relation).join(", ")}`}</title>
                    <path className="tick" d={`M0,${PERSON_H / 2} H12`} />
                    <rect x={12} width={pillW} height={PERSON_H} rx={10} />
                    <circle className={`dot rk-${p.rank}`} cx={25} cy={13} r={4} />
                    <text className="pname" x={35} y={17}>
                      {clip(p.name, 21)}
                    </text>
                    <text className="prel" x={22} y={30}>
                      {clip(rels, 30)}
                    </text>
                  </g>
                );
              })}
              {r.morePeople > 0 && (
                <text className="more" x={peerL + 28} y={r.peopleTop + r.people.length * (PERSON_H + PERSON_GAP) + 8}>
                  + {r.morePeople} more in Cala
                </text>
              )}
            </g>
          ) : null,
        )}

        {box("you", you.placeholder ? "you placeholder" : "you", X.you, leftY, NW.you, NH, you.placeholder ? "YOU · EXAMPLE" : "YOU · COMPANY", you.name, you.sub, you.rank ?? null, you.placeholder ? null : { kind: "node", id: you.id })}
        {box("event", "event", X.event, leftY, NW.event, NH, "EVENT", event.name, "Helsinki · 18–19 Nov 2026", nodeRank(event), { kind: "node", id: event.id })}
        {rows.map((r) => {
          const s = r.peer.similarity.score;
          const country = r.peer.headline.hq?.split(",").pop()?.trim();
          const sub = !r.peer.node.loaded
            ? "profile not loaded"
            : s === null
              ? (r.peer.headline.industry ?? country)
              : `${Math.round(s * 100)}% like you${country ? ` · ${country}` : ""}`;
          return box(`peer-${r.peerId}`, "peer", X.peer, r.peerY, NW.peer, NH, "PEER AT SLUSH · COMPANY", r.peer.node.name, sub, nodeRank(r.peer.node), { kind: "node", id: r.peerId });
        })}
        {rows.flatMap((r) =>
          r.rounds.map((p, i) => {
            const rd = p.round!;
            const sub = [rd.amount, rd.date ? (rd.dateBasis === "earliest source" ? `source ${rd.date}` : rd.date) : null].filter(Boolean).join(" · ") || "details not loaded";
            return box(`round-${p.id}`, "round", X.round, r.roundY[i], NW.round, ROUND_H, "FUNDING ROUND", rd.label, sub, nodeRank(rd.node), { kind: "node", id: rd.node.id }, rd.labelInferred ? "label inferred by Cala" : undefined);
          }),
        )}
        {box("inv", "investor", X.inv, invY, NW.inv, NH, `INVESTOR · ${investor.type.toUpperCase()}`, investor.name, investor.loaded ? undefined : "known through its links", nodeRank(investor), { kind: "node", id: investor.id })}
      </svg>
      {order.length > shown.length && (
        <p className="muted small graph-more">
          Showing {shown.length} of {order.length} funded peers for this investor; the rest are in the list below.
        </p>
      )}
    </div>
  );
}
