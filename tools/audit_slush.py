"""Audit the Slush node in Cala's knowledge graph.

Usage:
  python audit_slush.py OUT_DIR [--id UUID] [--name "Slush 2026"] [--sample 8] [--no-kq]

Key: env CALA_API_KEY, or a one-line file at ~/.cala_key. The key is never printed or saved.

What it does:
  1. entity_search for the Slush node(s)
  2. introspection of every candidate
  3. full crawl of the best candidate: all properties, every edge paginated
  4. per neighbour type, introspect a sample to see what the next hop offers
  5. a few knowledge_query probes
Everything raw goes to OUT_DIR/raw, the summary to OUT_DIR/report.md.
"""
import collections
import json
import os
import pathlib
import random
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = "https://api.cala.ai/v1"
PAGE = 100
EDGE_CAP = 20000


def load_key():
    k = os.environ.get("CALA_API_KEY", "").strip()
    if k:
        return k
    for p in (pathlib.Path.home() / ".cala_key", pathlib.Path.home() / "cala.env"):
        if p.exists():
            for line in p.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                return line.split("=", 1)[1].strip().strip('"\'') if "=" in line else line
    sys.exit("No key: set CALA_API_KEY or put it in ~/.cala_key")


class Cala:
    def __init__(self, key, out):
        self.key, self.raw, self.n = key, out / "raw", 0
        self.raw.mkdir(parents=True, exist_ok=True)
        self.calls = []
        # free plan: 10 req/min and 100 credits/month (1 credit = 1 query)
        self.min_gap = float(os.environ.get("CALA_MIN_GAP", "6.5"))
        self.budget = int(os.environ.get("CALA_BUDGET", "20"))
        self.last = 0.0

    def call(self, method, path, body=None, params=None, tag="", timeout=200):
        if self.n >= self.budget:
            raise SystemExit(f"call budget of {self.budget} reached: stopping (raw data kept). Raise CALA_BUDGET to go on.")
        gap = self.min_gap - (time.time() - self.last)
        if gap > 0:
            time.sleep(gap)
        self.last = time.time()
        url = BASE + path
        if params:
            url += "?" + urllib.parse.urlencode(params, doseq=True)
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method, headers={
            "X-API-KEY": self.key, "Content-Type": "application/json",
            "Accept": "application/json", "User-Agent": "cala-audit/1.0"})
        t0 = time.time()
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                status, text = r.status, r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            status, text = e.code, e.read().decode("utf-8", "replace")
        except Exception as e:  # timeout, DNS, ...
            status, text = 0, json.dumps({"client_error": repr(e)})
        dt = round(time.time() - t0, 2)
        try:
            js = json.loads(text)
        except ValueError:
            js = {"non_json": text[:2000]}
        self.n += 1
        self.calls.append({"n": self.n, "tag": tag, "method": method, "path": path,
                           "status": status, "seconds": dt})
        (self.raw / f"{self.n:04d}_{tag or 'call'}.json").write_text(
            json.dumps({"request": {"method": method, "path": path, "params": params, "body": body},
                        "status": status, "seconds": dt, "response": js},
                       ensure_ascii=False, indent=1), encoding="utf-8")
        if status == 429:
            raise SystemExit(f"429 rate limited after {self.n} calls: stopping (raw data kept).")
        if status in (401, 403):
            raise SystemExit(f"{status}: key rejected: {text[:200]}")
        return status, js


def src_list(obj):
    """Sources of a property ({value, sources}) or of an edge ({properties: {sources}})."""
    if not isinstance(obj, dict):
        return []
    s = obj.get("sources")
    if s is None and isinstance(obj.get("properties"), dict):
        s = obj["properties"].get("sources")
    return s if isinstance(s, list) else []


def src_stats(items):
    names, ranks, dates, with_src = collections.Counter(), collections.Counter(), [], 0
    for it in items:
        ss = src_list(it)
        if ss:
            with_src += 1
        for s in ss:
            if isinstance(s, dict):
                names[str(s.get("name"))] += 1
                ranks[str(s.get("source_rank"))] += 1
                if s.get("date"):
                    dates.append(str(s["date"]))
    return {"n": len(items), "with_sources": with_src, "top_sources": names.most_common(8),
            "ranks": dict(ranks),
            "date_min": min(dates) if dates else None, "date_max": max(dates) if dates else None}


def val(p):
    return p.get("value") if isinstance(p, dict) and "value" in p else p


def eprop(item, k):
    return (item.get("properties") or {}).get(k)


COMPANY_PROPS = ["name", "legal_name", "website", "description", "founding_date", "headquarters_address",
                 "operational_status", "company_ownership_status", "employee_count_range", "total_funding",
                 "total_funding_units", "total_funding_excluding_debt", "funding_stage"]
COMPANY_RELS = {"outgoing": ["PARTICIPATES_IN_FUNDING_ROUND", "PARTICIPATES_IN_CORPORATE_EVENT",
                             "PARTICIPATES_IN_EVENT", "OPERATES_IN_INDUSTRY", "HAS_HEADQUARTERS_IN",
                             "IS_REGISTERED_IN", "HAS_DOMAIN_NAME", "INVESTED_IN"],
                "incoming": ["INVESTED_IN", "FOUNDED", "IS_CEO_OF", "IS_CTO_OF", "IS_BOARD_MEMBER_OF", "WORKS_AT"]}
ROUND_PROPS = ["name", "round_label", "instrument", "transaction_value", "transaction_value_units",
               "announcement_date", "event_date"]


def deep_attendees(c, attendees, n_companies, n_rounds, P):
    """Sample attendee companies and measure how much funding / people / investor data hangs off them."""
    comps = [a for a in attendees if a.get("entity_type") == "Company"]
    pick = random.sample(comps, min(n_companies, len(comps)))
    P(f"\n## 4b. depth of {len(pick)} sampled attendee companies (of {len(comps)} Company attendees)")
    fill, relfill, stages, status = collections.Counter(), collections.Counter(), collections.Counter(), collections.Counter()
    relsizes, roles, investors, other_events, obs_names = collections.defaultdict(list), collections.Counter(), collections.Counter(), collections.Counter(), collections.Counter()
    prop_src, rounds, ok, rows = [], [], 0, []
    for nb in pick:
        st, ij = c.call("GET", f"/entities/{nb['id']}/introspection", tag="introspect_co")
        if st != 200:
            continue
        have = ij.get("relationships") or {}
        for kind, lst in (ij.get("numerical_observations") or {}).items():
            for o in lst if isinstance(lst, list) else []:
                obs_names[f"{kind}: {o.get('name') if isinstance(o, dict) else o}"] += 1
        body = {"properties": [p for p in COMPANY_PROPS if p in (ij.get("properties") or [])],
                "relationships": {d: {r: {"limit": 50, "offset": 0} for r in COMPANY_RELS[d] if r in (have.get(d) or [])}
                                  for d in ("outgoing", "incoming")}}
        st, ej = c.call("POST", f"/entities/{nb['id']}", body, tag="company_deep")
        if st != 200:
            continue
        ok += 1
        ep, er = ej.get("properties") or {}, ej.get("relationships") or {}
        for k, v in ep.items():
            if val(v) not in (None, "", []):
                fill[k] += 1
                prop_src.append(v)
        stages[str(val(ep.get("funding_stage")))] += 1
        status[str(val(ep.get("operational_status")))] += 1
        for d in ("outgoing", "incoming"):
            for r, lst in (er.get(d) or {}).items():
                if lst:
                    relfill[f"{d}:{r}"] += 1
                    relsizes[f"{d}:{r}"].append(len(lst))
        for fr in (er.get("outgoing") or {}).get("PARTICIPATES_IN_FUNDING_ROUND") or []:
            roles[str(eprop(fr, "role"))] += 1
            rounds.append((nb.get("name"), fr))
        for inv in (er.get("incoming") or {}).get("INVESTED_IN") or []:
            investors[(inv.get("name"), inv.get("entity_type"))] += 1
        for ev in (er.get("outgoing") or {}).get("PARTICIPATES_IN_EVENT") or []:
            other_events[(ev.get("name"), str(eprop(ev, "role")))] += 1
        rows.append({"name": nb.get("name"), "stage": val(ep.get("funding_stage")),
                     "total_funding": val(ep.get("total_funding")), "units": val(ep.get("total_funding_units")),
                     "founded": val(ep.get("founding_date")), "employees": val(ep.get("employee_count_range")),
                     "n_rounds": len((er.get("outgoing") or {}).get("PARTICIPATES_IN_FUNDING_ROUND") or []),
                     "n_investors": len((er.get("incoming") or {}).get("INVESTED_IN") or []),
                     "n_founders": len((er.get("incoming") or {}).get("FOUNDED") or [])})
    P(f"- retrieved OK: {ok}")
    P(f"- property fill (of {ok}): {dict(fill.most_common())}")
    P(f"- edge fill (of {ok}): {dict(relfill.most_common())}")
    P(f"- median edge size where present: { {k: sorted(v)[len(v) // 2] for k, v in relsizes.items()} }")
    P(f"- funding_stage: {dict(stages.most_common())}")
    P(f"- operational_status: {dict(status.most_common())}")
    P(f"- company role in its funding-round links: {dict(roles)}")
    P(f"- time series available: {dict(obs_names.most_common(15))}")
    ss = src_stats(prop_src)
    P(f"- property provenance: {ss['with_sources']}/{ss['n']} sourced; ranks={ss['ranks']}; top={ss['top_sources']}; dates {ss['date_min']}..{ss['date_max']}")
    P(f"- events these companies link to: {other_events.most_common(15)}")
    P(f"- investors appearing most often in the sample: {investors.most_common(25)}")
    P("\n| company | stage | total funding | founded | employees | rounds | investors | founders |\n|---|---|---|---|---|---|---|---|")
    for r in rows[:40]:
        P(f"| {r['name']} | {r['stage']} | {r['total_funding']} {r['units'] or ''} | {r['founded']} | {r['employees']} | {r['n_rounds']} | {r['n_investors']} | {r['n_founders']} |")

    # rounds: are amount, date, investors and lead flags there?
    rpick = random.sample(rounds, min(n_rounds, len(rounds)))
    P(f"\n## 4c. {len(rpick)} sampled funding rounds (of {len(rounds)} seen)")
    rfill, lead, prole, ptypes, rsrc, n_ok, with_inv = collections.Counter(), collections.Counter(), collections.Counter(), collections.Counter(), [], 0, 0
    for cname, fr in rpick:
        st, rj = c.call("POST", f"/entities/{fr['id']}", {
            "properties": ROUND_PROPS,
            "relationships": {"incoming": {"PARTICIPATES_IN_FUNDING_ROUND": {"limit": 50, "offset": 0}}}}, tag="round")
        if st != 200:
            continue
        n_ok += 1
        rp = rj.get("properties") or {}
        for k, v in rp.items():
            if val(v) not in (None, "", []):
                rfill[k] += 1
                rsrc.append(v)
        parts = ((rj.get("relationships") or {}).get("incoming") or {}).get("PARTICIPATES_IN_FUNDING_ROUND") or []
        inv = [p for p in parts if str(eprop(p, "role")) in ("INVESTOR", "LENDER")]
        with_inv += 1 if inv else 0
        for p in parts:
            prole[str(eprop(p, "role"))] += 1
            lead[str(eprop(p, "is_lead"))] += 1
            ptypes[p.get("entity_type")] += 1
        P(f"- {cname} / {val(rp.get('name'))}: {val(rp.get('transaction_value'))} {val(rp.get('transaction_value_units')) or ''}, "
          f"event {val(rp.get('event_date'))}, announced {val(rp.get('announcement_date'))}, "
          f"investors={[(p.get('name'), eprop(p, 'is_lead')) for p in inv][:8]}")
    ss = src_stats(rsrc)
    P(f"\n- round property fill (of {n_ok}): {dict(rfill.most_common())}")
    P(f"- rounds with at least one investor: {with_inv}/{n_ok}; participant roles={dict(prole)}; is_lead={dict(lead)}; participant types={dict(ptypes)}")
    P(f"- round provenance: {ss['with_sources']}/{ss['n']} sourced; ranks={ss['ranks']}; top={ss['top_sources']}; dates {ss['date_min']}..{ss['date_max']}")
    return {"companies": rows, "property_fill": dict(fill), "edge_fill": dict(relfill), "stages": dict(stages),
            "top_investors": [(k[0], k[1], v) for k, v in investors.most_common(50)]}


def crawl_edges(c, eid, direction, rel, tag):
    out, off, page = [], 0, PAGE
    while off < EDGE_CAP:
        st, js = c.call("POST", f"/entities/{eid}",
                        {"properties": ["name"], "relationships": {direction: {rel: {"limit": page, "offset": off}}}},
                        tag=f"{tag}_{direction}_{rel}_{off}")
        if st == 422 and page > 25:
            page = 25
            continue
        if st != 200:
            break
        got = ((js.get("relationships") or {}).get(direction) or {}).get(rel) or []
        out.extend(got)
        if len(got) < page:
            break
        off += page
    return out


def main():
    args = sys.argv[1:]
    if not args:
        sys.exit(__doc__)
    out = pathlib.Path(args[0])
    out.mkdir(parents=True, exist_ok=True)

    def opt(flag, default=None):
        return args[args.index(flag) + 1] if flag in args else default

    # Slush 2026 event id, from Cala's field guide for the challenge
    seed_id, sample_n = opt("--id", "bc844d56-6ab4-452b-96bf-2661e86e592b"), int(opt("--sample", "6"))
    names = [opt("--name")] if opt("--name") else ["Slush 2026", "Slush"]
    c = Cala(load_key(), out)
    rep, summary = [], {}
    P = lambda s="": (print(s), rep.append(s))

    # 1. search -------------------------------------------------------------
    P("# Cala: Slush node audit\n\n## 1. entity_search")
    cands = {}
    for nm in names:
        for types in (None, ["Event"]):
            params = {"name": nm, "limit": 20}
            if types:
                params["entity_types"] = types
            st, js = c.call("GET", "/entities", params=params, tag="search")
            for e in (js.get("entities") or []) if isinstance(js, dict) else []:
                cands.setdefault(e["id"], e)
    for e in cands.values():
        P(f"- `{e['id']}` **{e.get('name')}** [{e.get('entity_type')}] {e.get('description') or ''}")
    summary["search_hits"] = list(cands.values())

    slushy = [e for e in cands.values() if "slush" in (e.get("name") or "").lower()]
    if seed_id:
        slushy = [{"id": seed_id, "name": "(given id)", "entity_type": "?"}] + [e for e in slushy if e["id"] != seed_id]

    # 2. introspect candidates ---------------------------------------------
    P("\n## 2. introspection of candidates")
    intro = {}
    for e in slushy[:12]:
        st, js = c.call("GET", f"/entities/{e['id']}/introspection", tag="introspect_cand")
        if st != 200:
            P(f"- {e.get('name')}: HTTP {st}")
            continue
        rel = js.get("relationships") or {}
        intro[e["id"]] = js
        P(f"- **{e.get('name')}** [{e.get('entity_type')}] `{e['id']}`: "
          f"{len(js.get('properties') or [])} props, out={rel.get('outgoing') or []}, in={rel.get('incoming') or []}, "
          f"obs={ {k: len(v) for k, v in (js.get('numerical_observations') or {}).items()} }")
    if not intro:
        P("No Slush candidate found. Re-run with --id UUID or --name.")
        finish(out, rep, summary, c)
        return

    def richness(i):
        r = intro[i].get("relationships") or {}
        return len(r.get("outgoing") or []) + len(r.get("incoming") or [])
    seed = seed_id if seed_id in intro else max(intro, key=richness)
    seed_name = next((e.get("name") for e in slushy if e["id"] == seed), seed)
    summary["seed"] = {"id": seed, "name": seed_name, "introspection": intro[seed]}

    # 3. full crawl of the seed ---------------------------------------------
    P(f"\n## 3. full crawl of seed: {seed_name} `{seed}`")
    props = intro[seed].get("properties") or []
    st, js = c.call("POST", f"/entities/{seed}", {"properties": props}, tag="seed_props")
    pv = js.get("properties") or {} if isinstance(js, dict) else {}
    P("\n### properties")
    for k, v in pv.items():
        val = v.get("value") if isinstance(v, dict) else v
        P(f"- {k}: {json.dumps(val, ensure_ascii=False)[:300]}  (sources: {len(src_list(v))})")
    summary["seed_properties"] = pv

    edges = {}
    P("\n### edges")
    for direction in ("outgoing", "incoming"):
        for rel in (intro[seed].get("relationships") or {}).get(direction) or []:
            items = crawl_edges(c, seed, direction, rel, "seed")
            edges[(direction, rel)] = items
            types = collections.Counter(i.get("entity_type") for i in items)
            ekeys = collections.Counter(k for i in items for k in (i.get("properties") or {}) if k not in ("sources", "id"))
            ss = src_stats(items)
            P(f"- **{direction} {rel}**: {len(items)} neighbours, types={dict(types)}, "
              f"edge props={dict(ekeys)}, with sources={ss['with_sources']}/{ss['n']}, "
              f"sources={ss['top_sources']}, dates {ss['date_min']}..{ss['date_max']}")
            P(f"  - e.g. {[i.get('name') for i in items[:12]]}")
    summary["seed_edges"] = {f"{d}:{r}": {"count": len(v), "sample": v[:5]} for (d, r), v in edges.items()}
    (out / "seed_edges_full.json").write_text(json.dumps(
        {f"{d}:{r}": v for (d, r), v in edges.items()}, ensure_ascii=False, indent=1), encoding="utf-8")

    # 4. what the next hop offers -------------------------------------------
    P(f"\n## 4. next hop: introspect up to {sample_n} neighbours per (edge, type)")
    random.seed(7)
    hop = {}
    for (direction, rel), items in edges.items():
        by_type = collections.defaultdict(list)
        for i in items:
            by_type[i.get("entity_type")].append(i)
        for t, lst in by_type.items():
            pick = random.sample(lst, min(sample_n, len(lst)))
            pc, oc, ic, nobs, ok = collections.Counter(), collections.Counter(), collections.Counter(), 0, 0
            example = None
            for nb in pick:
                st, js = c.call("GET", f"/entities/{nb['id']}/introspection", tag="introspect_nb")
                if st != 200:
                    continue
                ok += 1
                pc.update(js.get("properties") or [])
                r = js.get("relationships") or {}
                oc.update(r.get("outgoing") or [])
                ic.update(r.get("incoming") or [])
                nobs += 1 if js.get("numerical_observations") else 0
                if example is None:
                    example = (nb, js)
            hop[f"{direction}:{rel}:{t}"] = {"total": len(lst), "sampled": ok, "properties": dict(pc),
                                           "outgoing": dict(oc), "incoming": dict(ic), "with_observations": nobs}
            P(f"\n### {direction} {rel} -> {t} ({len(lst)} total, {ok} sampled)")
            P(f"- properties (of {ok}): {dict(pc.most_common())}")
            P(f"- outgoing edges: {dict(oc.most_common())}")
            P(f"- incoming edges: {dict(ic.most_common())}")
            P(f"- with numerical observations: {nobs}")
            if example:  # one full worked example, edges capped at 5 each
                nb, ij = example
                r = ij.get("relationships") or {}
                body = {"properties": ij.get("properties") or [],
                        "relationships": {"outgoing": {x: {"limit": 5, "offset": 0} for x in r.get("outgoing") or []},
                                          "incoming": {x: {"limit": 5, "offset": 0} for x in r.get("incoming") or []}}}
                st, ej = c.call("POST", f"/entities/{nb['id']}", body, tag="example_nb")
                if st == 200:
                    ep = ej.get("properties") or {}
                    P(f"- example **{nb.get('name')}**: " + "; ".join(
                        f"{k}={json.dumps(v.get('value') if isinstance(v, dict) else v, ensure_ascii=False)[:90]}"
                        for k, v in ep.items() if k != "id"))
                    er = ej.get("relationships") or {}
                    for d2 in ("outgoing", "incoming"):
                        for r2, lst2 in (er.get(d2) or {}).items():
                            P(f"  - {d2} {r2}: {[(x.get('name'), x.get('entity_type')) for x in lst2]}")
                    ss = src_stats(list(ep.values()))
                    P(f"  - property provenance: {ss['with_sources']}/{ss['n']} sourced, {ss['top_sources']}")
    summary["next_hop"] = hop

    # 4b/4c. depth of the attendee companies ----------------------------------
    attendees = edges.get(("incoming", "PARTICIPATES_IN_EVENT")) or []
    if attendees:
        roles = collections.Counter(str(eprop(a, "role")) for a in attendees)
        P(f"\nattendee roles on the event edge: {dict(roles)}")
        summary["attendee_depth"] = deep_attendees(
            c, attendees, int(opt("--companies", "60")), int(opt("--rounds", "30")), P)

    # 5. knowledge_query probes ---------------------------------------------
    if "--no-kq" not in args:
        P("\n## 5. knowledge_query probes")
        probes = [
            f"companies.event={seed_name}.return(name, sector, location, funding, investors)",
            f"Which startups attending {seed_name} raised a funding round in 2026, and who led it?",
        ]
        for q in probes:
            st, js = c.call("POST", "/knowledge/query", {"input": q}, tag="kq")
            rows = js.get("results") if isinstance(js, dict) else None
            P(f"\n**{q}** -> HTTP {st}, {len(rows) if isinstance(rows, list) else '?'} rows, "
              f"{len(js.get('entities') or []) if isinstance(js, dict) else '?'} entities, {c.calls[-1]['seconds']} s")
            for row in (rows or [])[:8]:
                P(f"  - {json.dumps(row, ensure_ascii=False)[:400]}")
    finish(out, rep, summary, c)


def finish(out, rep, summary, c):
    lat = collections.defaultdict(list)
    for x in c.calls:
        lat[x["tag"]].append(x["seconds"])
    rep.append("\n## calls")
    rep.append(f"- total: {len(c.calls)}; non-200: {[(x['tag'], x['status']) for x in c.calls if x['status'] != 200][:30]}")
    for t, v in lat.items():
        rep.append(f"- {t}: n={len(v)}, median={sorted(v)[len(v) // 2]} s, max={max(v)} s")
    summary["calls"] = c.calls
    (out / "report.md").write_text("\n".join(rep), encoding="utf-8")
    (out / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    print(f"\nwrote {out / 'report.md'}")


if __name__ == "__main__":
    main()
