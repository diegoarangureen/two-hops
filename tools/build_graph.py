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
import os
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
PAGE_LIMIT = 1000  # Cala returns at most this many items per relationship; a list this long is cut short
INVESTOR_INDUSTRIES = ("VENTURE_CAPITAL", "ASSET_MANAGEMENT", "PRIVATE_EQUITY")
CLEAR_DEGREE_GAP = 3  # INVESTED_IN recorded both ways: this many more out-edges on one side makes it the clear investor
# a shared neighbour of one of these types corroborates a Company/Organization pair; industries, places and the
# event are shared by thousands of unrelated companies and say nothing
CORROBORATING_TYPES = ORG_TYPES | ROUND_TYPES | {"Person", "DomainName", "FundingRoundTranche", "CorporateEvent"}
INVESTOR_NAME = re.compile(r"\b(ventures?|capital|vc|invest\w*|funds?|angels?|accelerator|incubator|family\s+office)\b",
                           re.IGNORECASE)
MAX_EXAMPLES = 20


def norm_name(name):
    """Company name without case, punctuation or a trailing legal form: 'CLIO' and 'Clio', 'Omnea Limited' and 'Omnea'."""
    n = (name or "").casefold().replace("&", " and ")
    words = re.sub(r"[^\w\s]", " ", n).split()
    while len(words) > 1 and words[-1] in LEGAL_SUFFIXES:
        words.pop()
    return " ".join(words)


def domain(value):
    if isinstance(value, list):
        value = value[0] if value else ""
    v = str(value or "").strip().lower()
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
                if len(items or []) >= PAGE_LIMIT:
                    n.setdefault("truncated", {})[rel] = len(items)
                    self.notes["relationship_lists_cut_at_page_limit"] += 1
                for it in items or []:
                    if not isinstance(it, dict) or not it.get("id"):
                        continue
                    self.node(it["id"], it.get("name"), it.get("entity_type"))
                    p = dict(it.get("properties") or {})
                    sources, eid = self.src(p.pop("sources", None)), p.pop("id", None)
                    a, b = (j["id"], it["id"]) if direction == "outgoing" else (it["id"], j["id"])
                    self.edge(eid, rel, a, b, p, sources)


def merge_duplicates(b, attendee_ids):
    """Cala can hold one real organisation twice, once as a Company and once as an Organization.
    Such a pair is merged only when all of this holds:
      - the names are identical after normalisation and exactly one record of each type carries the name
        (two records of the same type are never merged: Cala models legal entities one by one);
      - not both records are attendees, and their websites (when both give one) do not differ;
      - something corroborates that they are one organisation: (a) both are neighbours of the same third entity
        through the same relationship type in the same direction (one investor's portfolio listing the company
        once per type), or (b) both profiles are loaded and give the same website domain.
    A name match alone is not enough: a same-name Organization in some investor's portfolio may be an unrelated
    company, and merging it would show that investor as funding the attendee.
    Returns {duplicate id: kept id}, the list of merged pairs and the uncorroborated pairs left apart."""
    groups = collections.defaultdict(list)
    for n in b.nodes.values():
        if n["type"] in ORG_TYPES and n["name"]:
            k = norm_name(n["name"])
            if len(k) >= 3:
                groups[k].append(n)

    def site(n):
        return domain((n["props"].get("website") or {}).get("value"))

    candidates = []
    for k, ns in groups.items():
        if len(ns) < 2:
            continue
        types = collections.Counter(n["type"] for n in ns)
        if len(ns) != 2 or len(types) != 2:
            b.notes["same_name_same_type_kept_apart"] += 1
            continue
        if sum(1 for n in ns if n["id"] in attendee_ids) > 1:
            b.notes["same_name_kept_apart_both_attendees"] += 1
            continue
        if len({site(n) for n in ns} - {""}) > 1:
            b.notes["same_name_kept_apart_different_websites"] += 1
            continue
        candidates.append(ns)

    # neighbour signatures (relationship type, direction, third entity), for the candidate records only: one pass
    pair_of = {n["id"]: {m["id"] for m in ns} for ns in candidates for n in ns}
    sig = collections.defaultdict(set)
    for e in b.edges.values():
        for me, other, d in ((e["from"], e["to"], "out"), (e["to"], e["from"], "in")):
            if me in pair_of and other not in pair_of[me] and b.nodes[other]["type"] in CORROBORATING_TYPES:
                sig[me].add((e["type"], d, other))

    redirect, merged, apart = {}, [], []
    for ns in candidates:
        x, y = ns
        shared = sorted(sig[x["id"]] & sig[y["id"]])
        basis = None
        if shared:
            rel, d, other = shared[0]
            on = b.nodes[other]
            who = f"{on['name']} ({on['type']} {other})"
            basis = (f"both records have a {rel} relationship to {who}" if d == "out"
                     else f"{who} has a {rel} relationship to both records")
            if len(shared) > 1:
                basis += f", and {len(shared) - 1} more shared neighbour(s)"
        elif x["loaded"] and y["loaded"] and site(x) and site(x) == site(y):
            basis = f"both profiles are loaded and give the website domain {site(x)}"
        if basis is None:
            b.notes["same_name_kept_apart_uncorroborated"] += 1
            apart.append({"name": x["name"], "records": [{"id": n["id"], "type": n["type"], "name": n["name"]}
                                                          for n in sorted(ns, key=lambda n: n["id"])]})
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
                       "basis": "one Company and one Organization with the same name after removing case, "
                                "punctuation and legal form; corroborated: " + basis})
    for dup in redirect:
        del b.nodes[dup]

    # Re-point edges. Two edges that became parallel only because an endpoint was re-pointed are one Cala fact
    # seen from both records: they become one edge that remembers both ids, provided their properties agree
    # (is_lead aside). Edges that were already parallel before the merge are distinct Cala facts (a current and
    # a past stint, say) and are never collapsed.
    out = {}
    for e in b.edges.values():
        orig = (e["from"], e["to"])
        a, c = redirect.get(e["from"], e["from"]), redirect.get(e["to"], e["to"])
        if a == c:
            b.notes["self_edges_dropped_after_merge"] += 1
            continue
        e["from"], e["to"] = a, c
        kept = out.setdefault((e["type"], a, c, e["props"].get("role")), [])
        mine = {k: v for k, v in e["props"].items() if k != "is_lead"}
        for o in kept:
            if orig in o["_origs"]:
                continue  # parallel already before the merge: a distinct fact
            if {k: v for k, v in o["props"].items() if k != "is_lead"} != mine:
                b.notes["parallel_edges_kept_apart_props_differ"] += 1
                continue
            o.setdefault("cala_ids", [o["id"]]).append(e["id"])
            o["_origs"].add(orig)
            for s in e["sources"]:
                if s not in o["sources"]:
                    o["sources"].append(s)
            if "is_lead" in e["props"] or "is_lead" in o["props"]:
                o["props"]["is_lead"] = bool(o["props"].get("is_lead")) or bool(e["props"].get("is_lead"))
            b.notes["parallel_edges_merged"] += 1
            break
        else:
            e["_origs"] = {orig}
            kept.append(e)
    b.edges = {}
    for kept in out.values():
        for e in kept:
            del e["_origs"]
            b.edges[e["id"]] = e
    return redirect, merged, apart


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


def flag_round_labels(b):
    """A FundingRound into which Cala folded several financings: its name, its aliases and its
    round_label_stated: annotations name more than one label. Its amount and date may come from different
    financings, so the app must not state them together."""
    several = []
    for n in b.nodes.values():
        if n["type"] not in ROUND_TYPES or not n["loaded"]:
            continue
        raw = [n["name"]]
        aliases = (n["props"].get("aliases") or {}).get("value") or []
        raw += aliases if isinstance(aliases, list) else [aliases]
        ann = (n["props"].get("annotations") or {}).get("value") or []
        for a in ann if isinstance(ann, list) else [ann]:
            a = str(a)
            if a.startswith("round_label_stated:"):
                raw.append(a[len("round_label_stated:"):])
        labels = {}
        for lab in raw:
            lab = str(lab or "").strip()
            if lab:
                labels.setdefault(lab.casefold(), lab)
        if len(labels) > 1:
            n["several_labels"] = sorted(labels.values(), key=str.casefold)
            several.append({"id": n["id"], "name": n["name"], "labels": n["several_labels"]})
    return several


def investor_industries(b):
    """{entity id: [investor industries Cala files it under]} from OPERATES_IN_INDUSTRY."""
    out = collections.defaultdict(set)
    for e in b.edges.values():
        if e["type"] == "OPERATES_IN_INDUSTRY" and b.nodes[e["to"]]["name"] in INVESTOR_INDUSTRIES:
            out[e["from"]].add(b.nodes[e["to"]]["name"])
    return {k: sorted(v) for k, v in out.items()}


def flag_investment_direction(b, vc):
    """INVESTED_IN recorded both ways between the same pair: one of the two is the wrong way round.
    The direction pointing at the clear investor is flagged suspect_inverted and not used for paths. The
    investor is clear only when one side is filed under an investor industry and the other is not, or one side
    holds at least CLEAR_DEGREE_GAP more INVESTED_IN out-edges, and these two signs do not disagree. The count
    does not count when the side it favours is filed only under non-investor industries, or when only the other
    side's name reads as an investor's (a loaded startup profile lists its investors as out-edges). Otherwise
    both directions are flagged suspect_inverted and direction_unclear, so neither is used."""
    inv = [e for e in b.edges.values() if e["type"] == "INVESTED_IN"]
    out_deg = collections.Counter(e["from"] for e in inv)
    filed = {e["from"] for e in b.edges.values() if e["type"] == "OPERATES_IN_INDUSTRY"}
    by_pair = collections.defaultdict(list)
    for e in inv:
        by_pair[(e["from"], e["to"])].append(e)
    flagged = []

    def item(e, basis, unclear=False):
        it = {"edge": e["id"], "from": b.nodes[e["from"]]["name"], "to": b.nodes[e["to"]]["name"], "basis": basis}
        if unclear:
            it["direction_unclear"] = True
        return it

    for (a, c) in sorted(by_pair):
        if a > c or (c, a) not in by_pair:
            continue  # each unordered pair once; the order here decides nothing
        both = by_pair[(a, c)] + by_pair[(c, a)]
        for e in both:
            e["reciprocal"] = True
        na, nc = b.nodes[a]["name"], b.nodes[c]["name"]
        by_ind = a if a in vc and c not in vc else c if c in vc and a not in vc else None
        gap = out_deg[a] - out_deg[c]
        by_deg = a if gap >= CLEAR_DEGREE_GAP else c if -gap >= CLEAR_DEGREE_GAP else None
        degrees = f"{na} holds {out_deg[a]} investments, {nc} holds {out_deg[c]}"
        # Out-degree counts only what is loaded, and a loaded startup profile often lists its own investors as
        # INVESTED_IN out-edges (Cala's inversion), so the count is void when the side it favours is filed only
        # under non-investor industries, or when only the other side's name reads as an investor's.
        void = None
        if by_deg:
            other = c if by_deg == a else a
            if by_deg in filed and by_deg not in vc:
                void = f"{b.nodes[by_deg]['name']} is filed only under non-investor industries"
            elif INVESTOR_NAME.search(b.nodes[other]["name"] or "") and not INVESTOR_NAME.search(b.nodes[by_deg]["name"] or ""):
                void = f"the name {b.nodes[other]['name']} reads as an investor's"
            if void:
                by_deg = None
        industry = (f"{b.nodes[by_ind]['name']} is filed under {', '.join(vc[by_ind])} and "
                    f"{nc if by_ind == a else na} is not") if by_ind else None
        if by_ind and by_deg and by_ind != by_deg:
            investor = None
        else:
            investor = by_ind or by_deg
        if investor:
            reasons = "; ".join(r for r in (industry, degrees) if r)
            for e in both:
                if e["to"] == investor:
                    e["suspect_inverted"] = True
                    flagged.append(item(e, f"also recorded the other way; {b.nodes[investor]['name']} is the clear "
                                           f"investor: {reasons}"))
        else:
            why = (f"the signs disagree ({industry}, but {degrees})" if by_ind and by_deg
                   else f"no clear sign ({degrees}" + (f", which does not count because {void}" if void else "") +
                        f"; {'both' if a in vc and c in vc else 'neither'} filed under an investor industry)")
            for e in both:
                e["suspect_inverted"] = True
                e["direction_unclear"] = True
                flagged.append(item(e, f"recorded both ways and it is not clear which side is the investor: {why}; "
                                       f"neither direction is used for paths", unclear=True))
    return flagged, out_deg


def flag_double_financings(b):
    """One financing can be a FundingRound (from announcements) and a PrivateCompanyFundingRound (from filings).
    For each company, a filing event whose event_date lies within SAME_FINANCING_DAYS of one of its rounds' own
    event_date or announcement_date (so only loaded rounds can match) is marked as the same financing as the
    closest such round, so nothing downstream counts it twice. Source dates are never used: they are often the
    day Cala read the page. A tie between two rounds is left unmatched."""
    by_company = collections.defaultdict(lambda: {"rounds": {}, "events": {}})
    for e in b.edges.values():
        t = b.nodes[e["to"]]
        if e["type"] == "PARTICIPATES_IN_FUNDING_ROUND" and t["type"] == "FundingRound" and e["props"].get("role") == "ISSUER":
            by_company[e["from"]]["rounds"][t["id"]] = t
        elif e["type"] == "PARTICIPATES_IN_CORPORATE_EVENT" and t["type"] == "PrivateCompanyFundingRound" \
                and e["props"].get("role") in (None, "ISSUER"):
            by_company[e["from"]]["events"].setdefault(t["id"], (e, t))
    found = []
    for cid, g in by_company.items():
        dated = []
        for rd in g["rounds"].values():
            for field in ("event_date", "announcement_date"):
                d = parse_date((rd["props"].get(field) or {}).get("value"))
                if d:
                    dated.append((rd, d, field))
                    break
        if not dated:
            continue
        for _, (ee, ev) in sorted(g["events"].items()):
            d_ev = parse_date(ee["props"].get("event_date"))
            if not d_ev or ev.get("same_financing_as"):
                continue
            near = sorted((abs((d_ev - d).days), rd["id"], rd, d, field) for rd, d, field in dated
                          if abs((d_ev - d).days) <= SAME_FINANCING_DAYS)
            if not near:
                continue
            if len(near) > 1 and near[0][0] == near[1][0]:
                b.notes["filing_event_equally_close_to_two_rounds_left_unmatched"] += 1
                continue
            days, _, rd, d_r, field = near[0]
            ev["same_financing_as"] = rd["id"]
            amounts = ("amounts were not compared" if ev["loaded"] else
                       "amounts could not be compared because the filing event's own record is not loaded")
            found.append({"company": b.nodes[cid]["name"], "round": rd["id"], "filing_event": ev["id"],
                          "basis": f"dates {days} days apart (round {field} {d_r}, filing event_date {d_ev}; the "
                                   f"closest of {len(near)} round(s) within {SAME_FINANCING_DAYS} days); {amounts}"})
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
    attending = {e["from"] for e in b.edges.values() if e["type"] == "PARTICIPATES_IN_EVENT" and e["to"] == SLUSH_2026}
    for a in att:
        p = a.get("properties") or {}
        s = b.src(p.get("sources"))
        att_sources[tuple(s)] += 1
        attendees.append([a["id"], a["name"], a["entity_type"], p.get("role"), p.get("id"), s])
        seen = b.edges.get(p.get("id"))
        if a["id"] in b.nodes and b.nodes[a["id"]]["loaded"] and not seen and a["id"] in attending:
            edge_id_mismatch += 1
    # drop per-profile copies of the attendance edge: the attendee list is the one place it lives
    b.edges = {k: e for k, e in b.edges.items() if not (e["type"] == "PARTICIPATES_IN_EVENT" and e["to"] == SLUSH_2026)}
    common = att_sources.most_common(1)[0][0] if att_sources else ()
    for row in attendees:  # keep the source list only where it differs from the common one
        if tuple(row[5]) == common:
            row.pop()

    redirect, merged, apart = merge_duplicates(b, attendee_ids)
    inferred = flag_rounds(b)
    several = flag_round_labels(b)
    vc = investor_industries(b)
    inverted, out_deg = flag_investment_direction(b, vc)
    double = flag_double_financings(b)

    # attendees that now sit under another id after the merge keep pointing at the kept record
    for row in attendees:
        if row[0] in redirect:
            b.notes["attendee_ids_redirected"] += 1
    backs = collections.Counter(e["from"] for e in b.edges.values() if e["type"] == "PARTICIPATES_IN_FUNDING_ROUND"
                                and e["props"].get("role") in ("INVESTOR", "LENDER"))
    for n in b.nodes.values():
        if n["id"] in attendee_ids or any(m["id"] in attendee_ids for m in n.get("merged", [])):
            n["attendee"] = True
        if out_deg[n["id"]]:
            n["investments"] = out_deg[n["id"]]
        # an attendee that is itself an investor is not a peer startup: it holds several investments, backs
        # several rounds, Cala files it under an investor industry, or (attendees only) its name says so. This
        # only ever excludes an attendee from being a peer; it is not shown as a fact about the entity.
        names = [n["name"]] + [m["name"] for m in n.get("merged", [])]
        if out_deg[n["id"]] >= 3:
            basis = f"holds {out_deg[n['id']]} investments"
        elif backs[n["id"]] >= 2:
            basis = f"backed {backs[n['id']]} rounds"
        elif n["id"] in vc:
            basis = f"filed under {', '.join(vc[n['id']])}"
        elif n.get("attendee") and any(INVESTOR_NAME.search(x or "") for x in names):
            basis = "name"
        else:
            basis = None
        if basis:
            n["investor_like"] = True
            n["investor_like_basis"] = basis

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
            "rounds_with_several_labels": several,
            "same_name_left_apart": {"count": len(apart), "examples": apart[:MAX_EXAMPLES],
                                     "basis": "one Company and one Organization with the same name, left apart "
                                              "because nothing corroborates that they are one organisation"},
            "notes": dict(b.notes),
        },
        "redirect": redirect,
    }
    graph = {"meta": meta, "sources": b.sources,
             "nodes": sorted(b.nodes.values(), key=lambda n: n["id"]),
             "edges": sorted(b.edges.values(), key=lambda e: e["id"]),
             "attendees": attendees}
    # written whole, then renamed: a server reading the file never sees half of it
    tmp = OUT.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(graph, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    os.replace(tmp, OUT)

    c = meta["counts"]
    print(f"data/graph.json: {OUT.stat().st_size / 1024:.0f} KB")
    print(f"  attendees listed {c['attendees_listed']}, attendee profiles loaded {c['attendee_profiles_loaded']}, "
          f"investor profiles {c['investor_profiles_loaded']}, rounds {c['rounds_loaded']}")
    print(f"  nodes {c['nodes']} {c['nodes_by_type']}")
    print(f"  edges {c['edges']} {c['edges_by_type']}")
    print(f"  sources {c['sources']} {c['sources_by_rank']}")
    print(f"  traps: {len(merged)} merged duplicate groups, {len(inferred)} inferred round labels, "
          f"{len(inverted)} investments recorded both ways, {len(double)} financings recorded twice, "
          f"{len(several)} rounds with several labels, {len(apart)} same-name pairs left apart; notes {dict(b.notes)}")
    if edge_id_mismatch:
        print(f"  warning: {edge_id_mismatch} loaded attendees whose attendance edge id differs from the attendee list")
    if "--check" in sys.argv:
        check(graph, att)


def check(graph, att):
    """Independent re-read of the cache. Every edge, and every Cala id it carries, must be a cached relationship
    with that id that joins the same two entities (after the merge redirect), in the same direction, with the same
    relationship type. Every property value of an unmerged node must equal the cached value."""
    redirect = graph["meta"]["redirect"]
    raw_edges, raw_props = collections.defaultdict(set), {}
    for sub in ("companies", "investors", "rounds"):
        for f in sorted((DATA / sub).glob("*.json")) if (DATA / sub).exists() else []:
            try:
                j = json.loads(f.read_text(encoding="utf-8"))
            except ValueError:
                continue  # half-written by the crawl; the build skipped it too
            if not isinstance(j, dict) or not j.get("id"):
                continue
            me = redirect.get(j["id"], j["id"])
            for k, v in (j.get("properties") or {}).items():
                if k != "id" and isinstance(v, dict) and v.get("value") not in (None, "", []):
                    raw_props[(me, k)] = v["value"]
            for d in ("outgoing", "incoming"):
                for rel, items in ((j.get("relationships") or {}).get(d) or {}).items():
                    for it in items or []:
                        if not isinstance(it, dict) or not it.get("id"):
                            continue
                        eid = (it.get("properties") or {}).get("id")
                        other = redirect.get(it["id"], it["id"])
                        if eid:
                            raw_edges[eid].add((rel, me, other) if d == "outgoing" else (rel, other, me))
    missing = misjoined = props_bad = 0
    examples = []
    for e in graph["edges"]:
        here = (e["type"], e["from"], e["to"])
        for i in e.get("cala_ids") or [e["id"]]:
            if i not in raw_edges:
                missing += 1
                examples.append(f"edge {i}: not in the cache")
            elif here not in raw_edges[i]:
                misjoined += 1
                examples.append(f"edge {i}: graph has {here}, cache has {sorted(raw_edges[i])}")
    for n in graph["nodes"]:
        if n.get("merged"):
            continue
        for k, v in n["props"].items():
            if raw_props.get((n["id"], k), object()) != v["value"]:
                props_bad += 1
                examples.append(f"node {n['id']} property {k}: value not in the cache")
    bad = missing + misjoined + props_bad
    unsourced = sum(1 for e in graph["edges"] if not e["sources"])  # allowed: Cala returns some edges unsourced
    att_ids = {a["id"] for a in att}
    print(f"check: {len(graph['edges'])} edges; {missing} edge ids not in the cache, {misjoined} edges whose cached "
          f"relationship joins other entities, type or direction; {props_bad} property values not in the cache; "
          f"{unsourced} edges carry no source in Cala; attendee list intact: {len(graph['attendees']) == len(att_ids)}")
    for x in examples[:10]:
        print("  " + x)
    if bad:
        sys.exit(1)


if __name__ == "__main__":
    main()
