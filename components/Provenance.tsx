"use client";

// Where a node or a link comes from: its sources as Cala returned them, with rank, date and age.

import type { LinkView, NodeView, PersonView } from "@/lib/types";
import { RankBadge, SourceList } from "./Rank";

export type Picked =
  | { kind: "node"; node: NodeView; role: string; extra?: React.ReactNode }
  | { kind: "link"; link: LinkView; fromName: string; toName: string }
  | { kind: "person"; person: PersonView; company: string }
  | null;

function LinkBlock({ link, fromName, toName }: { link: LinkView; fromName: string; toName: string }) {
  const props = Object.entries(link.props);
  return (
    <div className="prov-block">
      <p className="prov-rel">
        <span>{fromName}</span>
        <code>—{link.type}→</code>
        <span>{toName}</span>
      </p>
      <div className="prov-line">
        <RankBadge rank={link.rank} />
        {props.map(([k, v]) => (
          <code key={k} className={`kv${k === "is_lead" && v === true ? " kv-lead" : ""}`}>
            {k}: {String(v)}
          </code>
        ))}
      </div>
      {link.note && <p className="note">{link.note}.</p>}
      <SourceList sources={link.sources} />
      <p className="ids">
        Cala relationship id{link.calaIds.length > 1 ? "s (two records merged)" : ""}: {link.calaIds.join(", ") || "not given"}
      </p>
    </div>
  );
}

export default function Provenance({ picked }: { picked: Picked }) {
  if (!picked) {
    return (
      <div className="panel prov">
        <h3>Provenance</h3>
        <p className="muted">
          Click any node or arrow in the graph. You get the sources Cala holds for it: who published it, when, and what kind
          of source it is.
        </p>
        <div className="legend">
          <RankBadge rank="FILING" />
          <RankBadge rank="PRIMARY" />
          <RankBadge rank="PRESS" />
          <RankBadge rank="AGGREGATOR" />
          <RankBadge rank="UNRANKED" />
        </div>
      </div>
    );
  }
  if (picked.kind === "link") {
    return (
      <div className="panel prov">
        <h3>Provenance · relationship</h3>
        <LinkBlock link={picked.link} fromName={picked.fromName} toName={picked.toName} />
      </div>
    );
  }
  if (picked.kind === "person") {
    const p = picked.person;
    return (
      <div className="panel prov">
        <h3>Provenance · person</h3>
        <p className="prov-title">
          {p.name} <span className="muted">· Person</span>
        </p>
        {p.roles.map((r) => (
          <LinkBlock key={r.link.id} link={r.link} fromName={p.name} toName={picked.company} />
        ))}
        <p className="muted small">Roles with a valid_until in the past are left out.</p>
      </div>
    );
  }
  const n = picked.node;
  return (
    <div className="panel prov">
      <h3>Provenance · {picked.role}</h3>
      <p className="prov-title">
        {n.name} <span className="muted">· {n.type}</span>
      </p>
      {n.flags.length > 0 && (
        <p className="flags">
          {n.flags.map((f) => (
            <span key={f} className="flag">
              {f}
            </span>
          ))}
        </p>
      )}
      {n.merged && (
        <p className="note">
          Cala holds this organisation as {n.merged.length} records ({n.merged.map((m) => `${m.type} ${m.id.slice(0, 8)}`).join(", ")}).
          They are shown as one.
        </p>
      )}
      {picked.extra}
      {n.facts.length === 0 ? (
        <p className="muted">
          This entity&apos;s own profile is not loaded. It is known only through the relationships that point at it; click an
          arrow to see their sources.
        </p>
      ) : (
        <dl className="facts">
          {n.facts.map((f) => (
            <div key={f.key}>
              <dt>
                {f.label} <RankBadge rank={f.rank} small />
              </dt>
              <dd>
                <p className={f.key === "description" || f.key === "annotations" ? "long" : undefined}>{f.value}</p>
                <SourceList sources={f.sources} />
              </dd>
            </div>
          ))}
        </dl>
      )}
      {n.unsourced.length > 0 && (
        <p className="muted small">
          Not shown, because Cala gives no source for {n.unsourced.length === 1 ? "it" : "them"}: {n.unsourced.join(", ").toLowerCase()}.
        </p>
      )}
      <p className="ids">Cala entity id: {n.id}</p>
    </div>
  );
}
