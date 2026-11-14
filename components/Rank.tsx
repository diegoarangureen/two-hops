import { RANK_HELP, RANK_LABEL, type Rank } from "@/lib/rank";
import type { SourceView } from "@/lib/types";

export function RankBadge({ rank, small }: { rank: Rank; small?: boolean }) {
  return (
    <span className={`rank rank-${rank}${small ? " rank-small" : ""}`} title={`${rank}: ${RANK_HELP[rank]}`}>
      <i />
      {small ? rank : RANK_LABEL[rank]}
    </span>
  );
}

export function age(days: number | null): string {
  if (days === null) return "undated";
  if (days < 1) return "today";
  if (days < 60) return `${days} d old`;
  if (days < 730) return `${Math.round(days / 30.44)} mo old`;
  return `${(days / 365.25).toFixed(1)} y old`;
}

export function SourceList({ sources, empty }: { sources: SourceView[]; empty?: string }) {
  if (!sources.length) return <p className="muted small">{empty ?? "Cala returned no source for this."}</p>;
  return (
    <ul className="sources">
      {sources.map((s, i) => (
        <li key={i}>
          <RankBadge rank={s.rank} small />
          {s.url ? (
            <a href={s.url} target="_blank" rel="noreferrer noopener" title={s.url}>
              {s.name} ↗
            </a>
          ) : (
            <span>{s.name}</span>
          )}
          <span className="muted">
            {s.date ?? "no date"}
            {s.date ? ` · ${age(s.ageDays)}` : ""}
          </span>
        </li>
      ))}
    </ul>
  );
}
