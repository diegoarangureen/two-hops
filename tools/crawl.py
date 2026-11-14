"""Download from Cala into data/, one call at a time, with a cache and a call log.

  python tools/crawl.py status                          # credits used and what is cached (no calls)
  python tools/crawl.py plan                            # what the next calls would buy, from data/graph.json (no calls)
  python tools/crawl.py attendees                       # attendee list -> data/attendees.json (3 calls)
  python tools/crawl.py companies --budget 50           # full profile per attendee -> data/companies/<id>.json
  python tools/crawl.py deep --budget 5000              # profile per attendee and, if it has investors, its rounds
  python tools/crawl.py peers --budget 30               # profiles of attendees that already have a sourced investor
  python tools/crawl.py rounds --budget 5               # rounds on a path that are not loaded yet, led ones first
  python tools/crawl.py entity investor <id> [<id>...]  # one investor: portfolio and rounds -> data/investors/<id>.json
  python tools/crawl.py entity company <id> [<id>...]   # one company profile -> data/companies/<id>.json
  python tools/crawl.py entity round <id> [<id>...]     # one funding round with participants -> data/rounds/<id>.json
  python tools/crawl.py search "Name" [--types Company,Organization]   # entity search -> data/raw/search/
  python tools/crawl.py kq "question" --tag name        # one knowledge_query -> data/raw/kq/<tag>.json

Entities already cached are skipped, so every command can be stopped and resumed.
Every call is logged in data/cala_calls.jsonl. Key: env CALA_API_KEY, or a one-line file at ~/.cala_key.
Free plan: 10 requests/minute and 100 credits/month (1 credit = 1 call), hence the gap and the budget.
  CALA_MIN_GAP  seconds between calls (default 6.5)
  --budget N    stop after N calls in this run (default 20)
  --purpose "…" why the calls are made; written to the log
"""
import json
import random
import re
import sys

import cala
from cala import DATA, PAGE, SLUSH_2026


def opt(args, flag, default=None):
    return args[args.index(flag) + 1] if flag in args else default


def positional(args):
    """Arguments that are neither a --flag nor the value of one."""
    out, skip = [], False
    for a in args:
        if skip:
            skip = False
        elif a.startswith("--"):
            skip = a != "--shuffle"
        else:
            out.append(a)
    return out


def status():
    idx = cala.cached_index()
    att = json.loads((DATA / "attendees.json").read_text(encoding="utf-8"))
    ids = {a["id"] for a in att}
    print(f"credits used, from data/cala_calls.jsonl: {cala.credits_used()} in total")
    for k, n in cala.credits_by_key().items():
        print(f"  key {k}: {n}")
    if cala.MONTHLY_CREDITS is not None:
        mine = cala.credits_used(cala.key_id(cala.load_key()))
        print(f"  current key: {mine} of {cala.MONTHLY_CREDITS} (CALA_MONTHLY_CREDITS), {cala.MONTHLY_CREDITS - mine} left")
    print(f"attendees listed: {len(att)}; attendee profiles cached: {len(ids & set(idx))}")
    for sub in cala.KIND_DIR.values():
        d = DATA / sub
        print(f"  data/{sub}: {len(list(d.glob('*.json'))) if d.exists() else 0} files")


def attendees(c):
    out, off = [], 0
    while True:
        st, js = c.call("POST", f"/entities/{SLUSH_2026}", {
            "properties": ["name"],
            "relationships": {"incoming": {"PARTICIPATES_IN_EVENT": {"limit": PAGE, "offset": off}}}},
            purpose=f"attendee list, offset {off}", saved="data/attendees.json")
        if st != 200:
            sys.exit(f"HTTP {st} at offset {off}: {js}")
        got = ((js.get("relationships") or {}).get("incoming") or {}).get("PARTICIPATES_IN_EVENT") or []
        out += got
        print(f"offset {off}: {len(got)}")
        if len(got) < PAGE:
            break
        off += PAGE
    (DATA / "attendees.json").write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    print(f"{len(out)} attendees -> data/attendees.json")


def companies(c, shuffle, purpose):
    att = json.loads((DATA / "attendees.json").read_text(encoding="utf-8"))
    todo = [a for a in att if a["id"] not in c.cache]
    print(f"{len(att) - len(todo)} cached, {len(todo)} to go, budget {c.budget}")
    if shuffle:
        random.shuffle(todo)
    for a in todo:
        js, _ = c.entity(a["id"], "company", purpose or "attendee profile (bulk crawl)", a.get("entity_type"))
        print(f"  {c.n}: {a['name']}" + ("" if js else "  (failed, will be retried on the next run)"))


def round_ids(company, cap=6):
    """Funding rounds a company raised, as ids, grants left out (a grant body is not an investor to be introduced to)."""
    out = []
    for r in ((company.get("relationships") or {}).get("outgoing") or {}).get("PARTICIPATES_IN_FUNDING_ROUND") or []:
        if (r.get("properties") or {}).get("role") == "ISSUER" and r.get("entity_type") == "FundingRound" \
                and not re.search(r"grant", r.get("name") or "", re.I):
            out.append(r["id"])
    return out[:cap]


def has_investors(company):
    return bool(((company.get("relationships") or {}).get("incoming") or {}).get("INVESTED_IN"))


def deep(c, purpose):
    """Attendee by attendee: the profile, then, if it has investors, its funding rounds (who led, how much, when).
    So whatever is cached at any moment is complete for the companies it covers. Resumable."""
    att = json.loads((DATA / "attendees.json").read_text(encoding="utf-8"))
    todo = [a for a in att if a["id"] not in c.cache]
    print(f"{len(att) - len(todo)} profiles cached, {len(todo)} to go, budget {c.budget}", flush=True)

    def rounds_of(js, name):
        if not has_investors(js):
            return
        for rid in round_ids(js):
            if rid not in c.cache:
                r, _ = c.entity(rid, "round", "funding round of an attendee with investors: amount, date, who led")
                print(f"    {c.n}: round of {name}: {(r or {}).get('name', 'failed')}", flush=True)

    # first catch up on the rounds of what is already cached
    for a in att:
        f = c.cache.get(a["id"])
        if f:
            try:
                rounds_of(json.loads(f.read_text(encoding="utf-8")), a["name"])
            except ValueError:
                pass
    for a in todo:
        js, _ = c.entity(a["id"], "company", purpose or "attendee profile (full crawl of the Slush 2026 node)", a.get("entity_type"))
        print(f"  {c.n}: {a['name']}" + ("" if js else "  (failed, will be retried on the next run)"), flush=True)
        if js:
            rounds_of(js, a["name"])


def entities(c, kind, ids, purpose):
    att = {a["id"]: a for a in json.loads((DATA / "attendees.json").read_text(encoding="utf-8"))}
    for eid in ids:
        etype = (att.get(eid) or {}).get("entity_type")
        js, called = c.entity(eid, kind, purpose or f"{kind} profile", etype)
        if not js:
            continue
        rels = js.get("relationships") or {}
        sizes = {f"{d[:3]}:{r}": len(v) for d in ("outgoing", "incoming") for r, v in (rels.get(d) or {}).items() if v}
        print(f"  {'fetched' if called else 'cached '} {js.get('name')} [{js.get('entity_type')}] {sizes}")


def load_graph():
    p = DATA / "graph.json"
    if not p.exists():
        sys.exit("data/graph.json is missing: run `python tools/build_graph.py` first")
    return json.loads(p.read_text(encoding="utf-8"))


RANK = {"FILING": 4, "PRIMARY": 3, "PRESS": 2, "AGGREGATOR": 1, None: 0}


def plan_peers(g):
    """Attendees that already have a sourced investor in the graph but no profile of their own.
    One call each gives the sector, the rounds and the people to ask. Best first: more investors, better sources."""
    nodes = {n["id"]: n for n in g["nodes"]}
    att = {a[0] for a in g["attendees"]}
    best = lambda e: max((RANK.get(g["sources"][s]["source_rank"], 0) for s in e["sources"]), default=0)
    found = {}
    for e in g["edges"]:
        if e["type"] != "INVESTED_IN" or e.get("suspect_inverted") or not e["sources"]:
            continue
        n = nodes.get(e["to"])
        if e["to"] in att and n and not n["loaded"] and not n.get("investor_like"):
            rec = found.setdefault(e["to"], {"id": e["to"], "name": n["name"], "type": n["type"], "investors": set(), "rank": 0})
            rec["investors"].add(nodes[e["from"]]["name"])
            rec["rank"] = max(rec["rank"], best(e))
    # Take one attendee per investor in turn, smallest portfolios first, so that a short budget completes many
    # investors instead of sinking into the one with the most attendees. Within an investor, best sources first.
    queues = {}
    for rec in sorted(found.values(), key=lambda r: (-len(r["investors"]), -r["rank"], r["name"].lower())):
        for inv in rec["investors"]:
            queues.setdefault(inv, []).append(rec)
    order, seen = [], set()
    investors = sorted(queues, key=lambda i: (len(queues[i]), i.lower()))
    while any(queues.values()):
        for inv in investors:
            while queues[inv]:
                rec = queues[inv].pop(0)
                if rec["id"] not in seen:
                    seen.add(rec["id"])
                    order.append(rec)
                    break
    return order


def plan_rounds(g):
    """Funding rounds on a path (issued by an attendee, backed by someone) whose own record is not loaded.
    One call each gives amount, date, label basis and every participant. Led rounds first."""
    nodes = {n["id"]: n for n in g["nodes"]}
    att = {a[0] for a in g["attendees"]}
    issuer, backers = {}, {}
    for e in g["edges"]:
        if e["type"] != "PARTICIPATES_IN_FUNDING_ROUND" or not e["sources"]:
            continue
        if e["props"].get("role") == "ISSUER" and e["from"] in att:
            issuer[e["to"]] = e["from"]
        elif e["props"].get("role") in ("INVESTOR", "LENDER"):
            backers.setdefault(e["to"], []).append(e)
    out = []
    for rid, cid in issuer.items():
        n = nodes[rid]
        if n["type"] != "FundingRound" or n["loaded"] or nodes[cid].get("investor_like"):
            continue
        b = backers.get(rid, [])
        out.append({"id": rid, "name": n["name"], "company": nodes[cid]["name"], "backers": len(b),
                    "led": any(e["props"].get("is_lead") is True for e in b)})
    return sorted(out, key=lambda r: (not r["led"], -r["backers"], r["company"].lower()))


def plan(g):
    peers, rounds = plan_peers(g), plan_rounds(g)
    print(f"{len(peers)} attendees have a sourced investor but no profile loaded (1 call each):")
    for r in peers:
        print(f"  {r['id']}  {r['name']}  <- {', '.join(sorted(r['investors']))}")
    print(f"\n{len(rounds)} rounds on a path are not loaded (1 call each):")
    for r in rounds:
        print(f"  {r['id']}  {r['company']} / {r['name']}  backers known: {r['backers']}{'  LED' if r['led'] else ''}")


def search(c, name, types, purpose):
    params = {"name": name, "limit": 10}
    if types:
        params["entity_types"] = types
    st, js = c.call("GET", "/entities", params=params, purpose=purpose or f"entity search: {name}")
    out = DATA / "raw" / "search"
    out.mkdir(parents=True, exist_ok=True)
    slug = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")
    (out / f"name_{slug}.json").write_text(json.dumps(
        {"request": {"method": "GET", "path": "/entities", "params": params}, "status": st, "response": js},
        ensure_ascii=False, indent=1), encoding="utf-8")
    for e in (js.get("entities") or []) if isinstance(js, dict) else []:
        print(f"  {e['id']}  [{e.get('entity_type')}] {e.get('name')}: {(e.get('description') or '')[:90]}")


def kq(c, question, tag, purpose):
    st, js = c.call("POST", "/knowledge/query", {"input": question}, purpose=purpose or f"knowledge_query probe: {tag}",
                    timeout=200, saved=f"data/raw/kq/{tag}.json")
    out = DATA / "raw" / "kq"
    out.mkdir(parents=True, exist_ok=True)
    (out / f"{tag}.json").write_text(json.dumps({"input": question, "status": st, "response": js},
                                                ensure_ascii=False, indent=1), encoding="utf-8")
    rows = js.get("results") if isinstance(js, dict) else None
    ents = js.get("entities") if isinstance(js, dict) else None
    print(f"HTTP {st}: {len(rows) if isinstance(rows, list) else '?'} rows, {len(ents) if isinstance(ents, list) else '?'} entities")
    for row in (rows or [])[:10]:
        print("  ", json.dumps(row, ensure_ascii=False)[:300])


if __name__ == "__main__":
    cala.utf8_stdout()
    args = sys.argv[1:]
    cmds = ("status", "plan", "attendees", "companies", "deep", "peers", "rounds", "entity", "search", "kq")
    if not args or args[0] not in cmds:
        sys.exit(__doc__)
    if args[0] == "status":
        status()
        sys.exit(0)
    if args[0] == "plan":
        plan(load_graph())
        sys.exit(0)
    purpose = opt(args, "--purpose", "")
    client = cala.Client(int(opt(args, "--budget", "20")))
    pos = positional(args[1:])
    if args[0] == "attendees":
        attendees(client)
    elif args[0] == "companies":
        companies(client, "--shuffle" in args, purpose)
    elif args[0] == "deep":
        deep(client, purpose)
    elif args[0] == "peers":
        todo = [r["id"] for r in plan_peers(load_graph())][: client.budget]
        entities(client, "company", todo, purpose or "profile of an attendee that an investor's portfolio points at")
    elif args[0] == "rounds":
        todo = [r["id"] for r in plan_rounds(load_graph())][: client.budget]
        entities(client, "round", todo, purpose or "funding round on a path: amount, date, participants")
    elif args[0] == "entity":
        if len(pos) < 2 or pos[0] not in cala.KIND_DIR:
            sys.exit("usage: crawl.py entity company|investor|round <id> [<id>...]")
        entities(client, pos[0], pos[1:], purpose)
    elif args[0] == "search":
        types = opt(args, "--types")
        search(client, pos[0], types.split(",") if types else None, purpose)
    elif args[0] == "kq":
        kq(client, pos[0], opt(args, "--tag", "probe"), purpose)
    print(f"{client.n} call(s) made in this run; {cala.credits_used(client.key_id)} credits logged for this key in total")
