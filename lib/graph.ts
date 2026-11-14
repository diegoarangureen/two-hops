// Server only. Loads data/graph.json once, indexes it, and can take in a profile fetched live from Cala.

import fs from "node:fs";
import path from "node:path";

export const DATA_DIR = path.join(process.cwd(), "data");
export const SLUSH_2026 = "bc844d56-6ab4-452b-96bf-2661e86e592b";

export interface RawSource {
  name: string | null;
  document: string | null;
  date: string | null;
  date_precision: string | null;
  source_rank: string | null;
}

export interface GNode {
  id: string;
  type: string;
  name: string;
  loaded: boolean;
  props: Record<string, { value: unknown; sources: number[] }>;
  attendee?: boolean;
  merged?: { id: string; type: string; name: string }[];
  investments?: number;
  investor_like?: boolean;
  label_inferred?: boolean;
  same_financing_as?: string;
  /** Relationship lists that hit Cala's page limit when this profile was read: {name: items loaded}. */
  truncated?: Record<string, number>;
  file?: string;
}

export interface GEdge {
  id: string;
  type: string;
  from: string;
  to: string;
  props: Record<string, unknown>;
  sources: number[];
  cala_ids?: string[];
  reciprocal?: boolean;
  suspect_inverted?: boolean;
}

/** [id, name, type, role, edge id, own sources?] */
export type AttendeeRow = [string, string, string, string | null, string | null, number[]?];

interface GraphFile {
  meta: {
    built_at: string;
    event: { id: string; name: string; attendance_sources: number[] };
    counts: Record<string, unknown>;
    cala_calls: { credits_logged: number; calls_logged_individually: number };
    traps: {
      merged_duplicates: { kept: string; name: string; records: { id: string; type: string; name: string }[] }[];
      inferred_round_labels: { id: string; name: string }[];
      investment_recorded_both_ways: { edge: string; from: string; to: string; basis: string }[];
      financing_recorded_twice: { company: string; round: string; filing_event: string; basis: string }[];
      notes: Record<string, number>;
    };
    redirect: Record<string, string>;
  };
  sources: RawSource[];
  nodes: GNode[];
  edges: GEdge[];
  attendees: AttendeeRow[];
}

/** A Cala entity response, as cached under data/ or fetched live. */
export interface RawEntity {
  id: string;
  name?: string;
  entity_type?: string;
  properties?: Record<string, { value?: unknown; sources?: Partial<RawSource>[] } | unknown>;
  relationships?: Partial<Record<"outgoing" | "incoming", Record<string, RawRelItem[]>>>;
}

interface RawRelItem {
  id?: string;
  name?: string;
  entity_type?: string;
  properties?: Record<string, unknown> & { sources?: Partial<RawSource>[]; id?: string };
}

export class Graph {
  meta: GraphFile["meta"];
  sources: RawSource[];
  nodes = new Map<string, GNode>();
  edges: GEdge[] = [];
  out = new Map<string, GEdge[]>();
  inc = new Map<string, GEdge[]>();
  attendees = new Map<string, AttendeeRow>();
  attendeeList: AttendeeRow[];
  /** Bumps whenever a profile is taken in, so derived data can be recomputed. */
  version = 0;
  private sourceIx = new Map<string, number>();
  private edgeIds = new Set<string>();

  constructor(file: GraphFile) {
    this.meta = file.meta;
    this.sources = file.sources;
    this.sources.forEach((s, i) => this.sourceIx.set(JSON.stringify(s), i));
    for (const n of file.nodes) this.nodes.set(n.id, n);
    for (const e of file.edges) this.addEdge(e);
    this.attendeeList = file.attendees;
    for (const a of file.attendees) this.attendees.set(a[0], a);
  }

  private addEdge(e: GEdge) {
    this.edges.push(e);
    for (const id of e.cala_ids ?? [e.id]) this.edgeIds.add(id);
    push(this.out, e.from, e);
    push(this.inc, e.to, e);
  }

  canonical(id: string): string {
    return this.meta.redirect[id] ?? id;
  }

  node(id: string): GNode | undefined {
    return this.nodes.get(this.canonical(id));
  }

  outgoing(id: string, type?: string): GEdge[] {
    const es = this.out.get(id) ?? [];
    return type ? es.filter((e) => e.type === type) : es;
  }

  incoming(id: string, type?: string): GEdge[] {
    const es = this.inc.get(id) ?? [];
    return type ? es.filter((e) => e.type === type) : es;
  }

  private intern(list: Partial<RawSource>[] | undefined): number[] {
    const out: number[] = [];
    for (const s of list ?? []) {
      if (!s || typeof s !== "object") continue;
      const rec: RawSource = {
        name: s.name ?? null,
        document: s.document ?? null,
        date: s.date ?? null,
        date_precision: s.date_precision ?? null,
        source_rank: s.source_rank ?? null,
      };
      // same key order as tools/build_graph.py writes, so identical sources collapse
      const key = JSON.stringify(rec);
      let i = this.sourceIx.get(key);
      if (i === undefined) {
        i = this.sources.length;
        this.sources.push(rec);
        this.sourceIx.set(key, i);
      }
      if (!out.includes(i)) out.push(i);
    }
    return out;
  }

  /** Take in one Cala entity response (the same thing tools/build_graph.py does for the cache). */
  ingest(j: RawEntity, file?: string): GNode {
    const id = this.canonical(j.id);
    let n = this.nodes.get(id);
    if (!n) {
      n = { id, type: j.entity_type ?? "Entity", name: j.name ?? id, loaded: false, props: {} };
      this.nodes.set(id, n);
    }
    n.loaded = true;
    if (file) n.file = file;
    if (j.name && !n.name) n.name = j.name;
    if (this.attendees.has(j.id)) n.attendee = true;
    for (const [k, v] of Object.entries(j.properties ?? {})) {
      if (k === "id" || !v || typeof v !== "object") continue;
      const p = v as { value?: unknown; sources?: Partial<RawSource>[] };
      if (p.value === null || p.value === undefined || p.value === "" || (Array.isArray(p.value) && !p.value.length)) continue;
      n.props[k] = { value: p.value, sources: this.intern(p.sources) };
    }
    for (const direction of ["outgoing", "incoming"] as const) {
      for (const [rel, items] of Object.entries(j.relationships?.[direction] ?? {})) {
        for (const it of items ?? []) {
          if (!it?.id) continue;
          const other = this.canonical(it.id);
          if (rel === "PARTICIPATES_IN_EVENT" && other === SLUSH_2026) continue; // lives in the attendee list
          if (!this.nodes.has(other)) {
            this.nodes.set(other, { id: other, type: it.entity_type ?? "Entity", name: it.name ?? other, loaded: false, props: {} });
          }
          const { sources, id: edgeId, ...props } = it.properties ?? {};
          const key = edgeId ?? `${rel}:${direction === "outgoing" ? id : other}:${direction === "outgoing" ? other : id}`;
          if (this.edgeIds.has(key)) continue;
          const [from, to] = direction === "outgoing" ? [id, other] : [other, id];
          if (from === to) continue;
          this.addEdge({ id: key, type: rel, from, to, props, sources: this.intern(sources) });
        }
      }
    }
    this.version++;
    return n;
  }
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const a = m.get(k);
  if (a) a.push(v);
  else m.set(k, [v]);
}

function load(): Graph {
  const file = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "graph.json"), "utf8")) as GraphFile;
  const g = new Graph(file);
  // Profiles fetched live after the last build are in data/companies but not yet in graph.json: take them in,
  // so a call whose result is already on disk is never made again.
  try {
    const dir = path.join(DATA_DIR, "companies");
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      const id = f.slice(0, -5);
      const n = g.node(id);
      if (n?.loaded) continue;
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as RawEntity;
      if (j?.id && !g.node(j.id)?.loaded) g.ingest(j, `data/companies/${f}`);
    }
  } catch {
    // no data directory at runtime (read-only bundle): the built graph is all there is
  }
  return g;
}

const holder = globalThis as unknown as { __twoHopsGraph?: { graph: Graph; mtime: number; checked: number } };

function graphMtime(): number {
  try {
    return fs.statSync(path.join(DATA_DIR, "graph.json")).mtimeMs;
  } catch {
    return 0;
  }
}

/** The graph, loaded once. If tools/build_graph.py rewrites graph.json, the next request picks the new file up. */
export function getGraph(): Graph {
  const h = holder.__twoHopsGraph;
  const now = Date.now();
  if (h && now - h.checked < 2000) return h.graph;
  const mtime = graphMtime();
  if (h && h.mtime === mtime) {
    h.checked = now;
    return h.graph;
  }
  const graph = load();
  holder.__twoHopsGraph = { graph, mtime, checked: now };
  return graph;
}
