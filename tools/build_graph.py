"""Build the single graph file the app reads, from the Cala responses cached under data/. No API calls.

  python tools/build_graph.py            # -> data/graph.json, prints a summary
  python tools/build_graph.py --check    # also verify the output against the raw cache

What goes in:
  data/attendees.json           the 2,989 entities linked to the Slush 2026 node
  data/companies/*.json         company profiles (properties and relationships, each with its sources)
  data/investors/*.json         investor profiles with their portfolio and rounds
  data/rounds/*.json            funding rounds with their participants
  data/cala_calls.jsonl         the call log, only to report how many calls the data cost

What comes out (data/graph.json):
  meta        when it was built, what is loaded, the data traps found
  sources     every distinct source once: name, document, date, date_precision, source_rank
  nodes       one per entity: id, type, name, loaded (do we have its profile), props {name: {value, sources}}
  edges       one per Cala relationship: id (Cala's edge id), type, from, to, props (role, is_lead, valid_since,
              valid_until, event_date, ...), sources
  attendees   compact list of everyone linked to the event: [id, name, type, role, edge id]

Nothing is invented here. Every value and every edge is copied from a Cala response together with its sources;
the only additions are flags that describe the data (merged duplicates, labels Cala inferred, edges recorded
both ways, one financing recorded as two entities), and each flag says what it is based on.
"""
import collections
import datetime
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
OUT = DATA / "graph.json"
SLUSH_2026 = "bc844d56-6ab4-452b-96bf-2661e86e592b"
ORG_TYPES = {"Company", "Organization"}
ROUND_TYPES = {"FundingRound", "PrivateCompanyFundingRound"}
LEGAL_SUFFIXES = {"inc", "ltd", "limited", "gmbh", "ag", "oy", "oyj", "ab", "sas", "bv", "se", "llc", "ou", "oü", "uab",
                  "sa", "srl", "as", "aps", "plc", "corp", "co", "ug", "kg", "spa", "sl", "nv", "pte", "pty", "lp",
                  "llp", "sarl", "sp", "zoo", "ehf", "sia", "doo", "kft", "ltda", "incorporated", "corporation"}
SAME_FINANCING_DAYS = 45  # a FundingRound and a filing event of the same company this close are one financing


def norm_name(name):
    """Company name without case, punctuation or a trailing legal form: 'CLIO' and 'Clio', 'Omnea Limited' and 'Omnea'."""
    n = (name or "").casefold().replace("&", " and ")
    words = re.sub(r"[^\w\s]", " ", n).split()
    while len(words) > 1 and words[-1] in LEGAL_SUFFIXES:
        words.pop()
    return " ".join(words)


def domain(value):
    v = (value or "").strip().lower()
    v = re.sub(r"^https?://", "", v).split("/")[0]
    return v[4:] if v.startswith("www.") else v


def parse_date(s):
    try:
        return datetime.date.fromisoformat(str(s)[:10])
    except (TypeError, ValueError):
        return None


class Builder:
    def __init__(self):
        self.sources, self.source_ix = [], {}
        self.nodes, self.edges = {}, {}
        self.notes = collections.Counter()

    # -- sources -----------------------------------------------------------------------------------------
    def src(self, lst):
        out = []
        for s in lst or []:
            if not isinstance(s, dict):
                continue
            rec = {"name": s.get("name"), "document": s.get("document"), "date": s.get("date"),
                   "date_precision": s.get("date_precision"), "source_rank": s.get("source_rank")}
            key = json.dumps(rec, sort_keys=True, ensure_ascii=False)
            if key not in self.source_ix:
                self.source_ix[key] = len(self.sources)
                self.sources.append(rec)
            if self.source_ix[key] not in out:
                out.append(self.source_ix[key])
        return out

    # -- nodes and edges ---------------------------------------------------------------------------------
    def node(self, eid, name=None, etype=None):
        n = self.nodes.get(eid)
        if n is None:
            n = self.nodes[eid] = {"id": eid, "type": etype, "name": name, "loaded": False, "props": {}}
        if n["name"] is None and name:
            n["name"] = name
        if n["type"] is None and etype:
            n["type"] = etype
        return n

    def edge(self, eid, etype, a, b, props, sources):
        key = eid or f"{etype}:{a}:{b}"
        e = self.edges.get(key)
        if e is None:
            self.edges[key] = {"id": key, "type": etype, "from": a, "to": b, "props": dict(props), "sources": list(sources)}
            return
        # the same Cala edge seen from its other end: same facts, keep the union of what both ends said
        for k, v in props.items():
            if k not in e["props"]:
                e["props"][k] = v
            elif e["props"][k] != v:
                self.notes["edge_props_differ_between_ends"] += 1
        for s in sources:
            if s not in e["sources"]:
                e["sources"].append(s)

    def add_entity(self, j, file):
        n = self.node(j["id"], j.get("name"), j.get("entity_type"))
        n["loaded"], n["file"] = True, file
        for k, v in (j.get("properties") or {}).items():
            if k == "id" or not isinstance(v, dict) or v.get("value") in (None, "", []):
                continue
            n["props"][k] = {"value": v["value"], "sources": self.src(v.get("sources"))}
        rels = j.get("relationships") or {}
        for direction in ("outgoing", "incoming"):
            for rel, items in (rels.get(direction) or {}).items():
                for it in items or []:
                    if not isinstance(it, dict) or not it.get("id"):
                        continue
                    self.node(it["id"], it.get("name"), it.get("entity_type"))
                    p = dict(it.get("properties") or {})
                    sources, eid = self.src(p.pop("sources", None)), p.pop("id", None)
                    a, b = (j["id"], it["id"]) if direction == "outgoing" else (it["id"], j["id"])
                    self.edge(eid, rel, a, b, p, sources)


def merge_duplicates(b, attendee_ids):
    """Cala can hold one real organisation as several records (often a Company and an Organization).
    Records with the same normalised name are merged, unless both are separate Slush attendees or they
    are loaded with different websites. Returns {duplicate id: kept id} and the list of groups."""
    groups = collections.defaultdict(list)
    for n in b.nodes.values():
        if n["type"] in ORG_TYPES and n["name"]:
            k = norm_name(n["name"])
            if len(k) >= 3:
                groups[k].append(n)
    redirect, merged = {}, []
    for k, ns in groups.items():
        if len(ns) < 2:
            continue
        if sum(1 for n in ns if n["id"] in attendee_ids) > 1:
            b.notes["same_name_kept_apart_both_attendees"] += 1
            continue
        sites = {domain((n["props"].get("website") or {}).get("value")) for n in ns if n["props"].get("website")}
        if len(sites - {""}) > 1:
            b.notes["same_name_kept_apart_different_websites"] += 1
            continue
        ns.sort(key=lambda n: (n["id"] not in attendee_ids, not n["loaded"], n["type"] != "Company", n["id"]))
        keep = ns[0]
        keep["merged"] = [{"id": n["id"], "type": n["type"], "name": n["name"]} for n in ns]
        for n in ns[1:]:
            redirect[n["id"]] = keep["id"]
            for pk, pv in n["props"].items():  # keep anything only the duplicate had
                keep["props"].setdefault(pk, pv)
            keep["loaded"] = keep["loaded"] or n["loaded"]
        merged.append({"kept": keep["id"], "name": keep["name"], "records": keep["merged"],
                       "basis": "identical name after removing case, punctuation and legal form"})
    for dup in redirect:
        del b.nodes[dup]
    # re-point edges; two Cala edges that now join the same pair become one edge that remembers both ids
    out = {}
    for e in b.edges.values():
        a, c = redirect.get(e["from"], e["from"]), redirect.get(e["to"], e["to"])
        if a == c:
            b.notes["self_edges_dropped_after_merge"] += 1
            continue
        key = (e["type"], a, c, e["props"].get("role"))
        if key in out:
            o = out[key]
            o.setdefault("cala_ids", [o["id"]]).append(e["id"])
            for s in e["sources"]:
                if s not in o["sources"]:
                    o["sources"].append(s)
            for pk, pv in e["props"].items():
                if pk == "is_lead":
                    o["props"]["is_lead"] = bool(o["props"].get("is_lead")) or bool(pv)
                else:
                    o["props"].setdefault(pk, pv)
            b.notes["parallel_edges_merged"] += 1
        else:
            e["from"], e["to"] = a, c
            out[key] = e
    b.edges = {e["id"]: e for e in out.values()}
    return redirect, merged


def flag_rounds(b):
    """Round labels Cala derived rather than read: annotations say round_label_basis:INFERRED."""
    inferred = []
    for n in b.nodes.values():
        if n["type"] != "FundingRound" or not n["loaded"]:
            continue
        ann = (n["props"].get("annotations") or {}).get("value") or []
        ann = ann if isinstance(ann, list) else [ann]
        if any("round_label_basis:INFERRED" in str(a) for a in ann):
            n["label_inferred"] = True
            inferred.append({"id": n["id"], "name": n["name"],
                             "basis": "annotations contain round_label_basis:INFERRED"})
    return inferred


def flag_investment_direction(b):
    """INVESTED_IN recorded both ways between the same pair: one of the two is the wrong way round.
    The one pointing at the party that holds more investments is flagged and not used for paths."""
    out_deg = collections.Counter(e["from"] for e in b.edges.values() if e["type"] == "INVESTED_IN")
    pairs = {(e["from"], e["to"]): e for e in b.edges.values() if e["type"] == "INVESTED_IN"}
    flagged = []
    for (a, c), e in pairs.items():
        back = pairs.get((c, a))
        if not back:
            continue
        e["reciprocal"] = True
        if out_deg[a] < out_deg[c] or (out_deg[a] == out_deg[c] and a > c):
            e["suspect_inverted"] = True
            flagged.append({"edge": e["id"], "from": b.nodes[a]["name"], "to": b.nodes[c]["name"],
                            "basis": f"also recorded the other way; {b.nodes[c]['name']} holds {out_deg[c]} "
                                     f"investments, {b.nodes[a]['name']} holds {out_deg[a]}"})
    return flagged, out_deg


def flag_double_financings(b):
    """One financing can be a FundingRound (from announcements) and a PrivateCompanyFundingRound (from filings).
    For each company, a filing event within SAME_FINANCING_DAYS of one of its rounds is marked as the same
    financing, so nothing downstream counts it twice."""
    by_company = collections.defaultdict(lambda: {"rounds": [], "events": []})
    for e in b.edges.values():
        t = b.nodes[e["to"]]
        if e["type"] == "PARTICIPATES_IN_FUNDING_ROUND" and t["type"] == "FundingRound" and e["props"].get("role") == "ISSUER":
            by_company[e["from"]]["rounds"].append((e, t))
        elif e["type"] == "PARTICIPATES_IN_CORPORATE_EVENT" and t["type"] == "PrivateCompanyFundingRound" \
                and e["props"].get("role") in (None, "ISSUER"):
            by_company[e["from"]]["events"].append((e, t))
    found = []
    for cid, g in by_company.items():
        for ee, ev in g["events"]:
            d_ev = parse_date(ee["props"].get("event_date"))
            if not d_ev:
                continue
            for re_, rd in g["rounds"]:
                p = rd["props"]
                d_r = parse_date((p.get("event_date") or {}).get("value")) or parse_date((p.get("announcement_date") or {}).get("value"))
                basis = "round date"
                if not d_r:  # round not loaded: fall back to the earliest source date on its link
                    ds = [parse_date(b.sources[s]["date"]) for s in re_["sources"]]
                    ds = [d for d in ds if d]
                    d_r, basis = (min(ds) if ds else None), "earliest source date of the round link"
                if d_r and abs((d_ev - d_r).days) <= SAME_FINANCING_DAYS:
                    ev["same_financing_as"] = rd["id"]
                    found.append({"company": b.nodes[cid]["name"], "round": rd["id"], "filing_event": ev["id"],
                                  "basis": f"dates {abs((d_ev - d_r).days)} days apart ({basis})"})
                    break
    return found


def main():
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    b = Builder()
    att = json.loads((DATA / "attendees.json").read_text(encoding="utf-8"))
    attendee_ids = {a["id"] for a in att}

    files = collections.Counter()
    for sub in ("companies", "investors", "rounds"):
        for f in sorted((DATA / sub).glob("*.json")) if (DATA / sub).exists() else []:
            try:
                j = json.loads(f.read_text(encoding="utf-8"))
            except ValueError:
                b.notes["unreadable_cache_files"] += 1
                continue
            if isinstance(j, dict) and j.get("id"):
                b.add_entity(j, f.relative_to(ROOT).as_posix())
                files[sub] += 1

    # the event and its attendance edges come from the attendee list, which is the complete set
    ev = b.node(SLUSH_2026, "Slush 2026", "Event")
    att_sources = collections.Counter()
    attendees, edge_id_mismatch = [], 0
    for a in att:
        p = a.get("properties") or {}
        s = b.src(p.get("sources"))
        att_sources[tuple(s)] += 1
        attendees.append([a["id"], a["name"], a["entity_type"], p.get("role"), p.get("id"), s])
        seen = b.edges.get(p.get("id"))
        if a["id"] in b.nodes and b.nodes[a["id"]]["loaded"] and not seen and any(
                e["type"] == "PARTICIPATES_IN_EVENT" and e["from"] == a["id"] and e["to"] == SLUSH_2026 for e in b.edges.values()):
            edge_id_mismatch += 1
    # drop per-profile copies of the attendance edge: the attendee list is the one place it lives
    b.edges = {k: e for k, e in b.edges.items() if not (e["type"] == "PARTICIPATES_IN_EVENT" and e["to"] == SLUSH_2026)}
    common = att_sources.most_common(1)[0][0] if att_sources else ()
    for row in attendees:  # keep the source list only where it differs from the common one
        if tuple(row[5]) == common:
            row.pop()

    redirect, merged = merge_duplicates(b, attendee_ids)
    inferred = flag_rounds(b)
    inverted, out_deg = flag_investment_direction(b)
    double = flag_double_financings(b)

    # attendees that now sit under another id after the merge keep pointing at the kept record
    for row in attendees:
        if row[0] in redirect:
            b.notes["attendee_ids_redirected"] += 1
    for n in b.nodes.values():
        if n["id"] in attendee_ids or any(m["id"] in attendee_ids for m in n.get("merged", [])):
            n["attendee"] = True
        if out_deg[n["id"]]:
            n["investments"] = out_deg[n["id"]]

    log = [json.loads(line) for line in (DATA / "cala_calls.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()] \
        if (DATA / "cala_calls.jsonl").exists() else []
    loaded_att = [n for n in b.nodes.values() if n.get("attendee") and n["loaded"]]
    edge_types = collections.Counter(e["type"] for e in b.edges.values())
    node_types = collections.Counter(n["type"] for n in b.nodes.values())
    ranks = collections.Counter(str(s["source_rank"]) for s in b.sources)
    meta = {
        "built_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "built_from": "Cala API responses cached under data/ (see data/cala_calls.jsonl); no call is made at build time",
        "event": {"id": SLUSH_2026, "name": ev["name"], "attendance_sources": list(common)},
        "counts": {
            "attendees_listed": len(att),
            "attendee_profiles_loaded": len(loaded_att),
            "investor_profiles_loaded": files["investors"],
            "rounds_loaded": files["rounds"],
            "cache_files": dict(files),
            "nodes": len(b.nodes), "edges": len(b.edges), "sources": len(b.sources),
            "nodes_by_type": dict(node_types.most_common()),
            "edges_by_type": dict(edge_types.most_common()),
            "sources_by_rank": dict(ranks.most_common()),
        },
        "cala_calls": {"credits_logged": sum(int(e.get("credits", 0)) for e in log),
                       "calls_logged_individually": sum(1 for e in log if not e.get("estimated"))},
        "traps": {
            "merged_duplicates": merged,
            "inferred_round_labels": inferred,
            "investment_recorded_both_ways": inverted,
            "financing_recorded_twice": double,
            "notes": dict(b.notes),
        },
        "redirect": redirect,
    }
    graph = {"meta": meta, "sources": b.sources,
             "nodes": sorted(b.nodes.values(), key=lambda n: n["id"]),
             "edges": sorted(b.edges.values(), key=lambda e: e["id"]),
             "attendees": attendees}
    OUT.write_text(json.dumps(graph, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    c = meta["counts"]
    print(f"data/graph.json: {OUT.stat().st_size / 1024:.0f} KB")
    print(f"  attendees listed {c['attendees_listed']}, attendee profiles loaded {c['attendee_profiles_loaded']}, "
          f"investor profiles {c['investor_profiles_loaded']}, rounds {c['rounds_loaded']}")
    print(f"  nodes {c['nodes']} {c['nodes_by_type']}")
    print(f"  edges {c['edges']} {c['edges_by_type']}")
    print(f"  sources {c['sources']} {c['sources_by_rank']}")
    print(f"  traps: {len(merged)} merged duplicate groups, {len(inferred)} inferred round labels, "
          f"{len(inverted)} investments recorded both ways, {len(double)} financings recorded twice; notes {dict(b.notes)}")
    if edge_id_mismatch:
        print(f"  warning: {edge_id_mismatch} loaded attendees whose attendance edge id differs from the attendee list")
    if "--check" in sys.argv:
        check(graph, att)


def check(graph, att):
    """Independent re-read of the cache: every edge and property value in the graph must exist in a cached response."""
    redirect = graph["meta"]["redirect"]
    raw_edges, raw_props = set(), {}
    for sub in ("companies", "investors", "rounds"):
        for f in sorted((DATA / sub).glob("*.json")) if (DATA / sub).exists() else []:
            j = json.loads(f.read_text(encoding="utf-8"))
            for k, v in (j.get("properties") or {}).items():
                if isinstance(v, dict) and v.get("value") not in (None, "", []):
                    raw_props[(redirect.get(j["id"], j["id"]), k)] = v["value"]
            for d in ("outgoing", "incoming"):
                for rel, items in ((j.get("relationships") or {}).get(d) or {}).items():
                    for it in items or []:
                        eid = (it.get("properties") or {}).get("id")
                        if eid:
                            raw_edges.add(eid)
    bad = 0
    for e in graph["edges"]:
        ids = e.get("cala_ids") or [e["id"]]
        if not all(i in raw_edges for i in ids):
            bad += 1
        if not e["sources"]:
            pass  # allowed: Cala returns some edges without sources; the app hides them
    for n in graph["nodes"]:
        for k, v in n["props"].items():
            if (n["id"], k) not in raw_props and not n.get("merged"):
                bad += 1
    unsourced = sum(1 for e in graph["edges"] if not e["sources"])
    att_ids = {a["id"] for a in att}
    print(f"check: {len(graph['edges'])} edges, {bad} not traceable to a cached response; "
          f"{unsourced} edges carry no source in Cala; attendee list intact: {len(graph['attendees']) == len(att_ids)}")
    if bad:
        sys.exit(1)


if __name__ == "__main__":
    main()
