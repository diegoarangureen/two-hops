"""Download from Cala into data/, one call at a time, with a cache and a call log.

  python tools/crawl.py status                          # credits used and what is cached (no calls)
  python tools/crawl.py attendees                       # attendee list -> data/attendees.json (3 calls)
  python tools/crawl.py companies --budget 50           # full profile per attendee -> data/companies/<id>.json
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
    used = cala.credits_used()
    idx = cala.cached_index()
    att = json.loads((DATA / "attendees.json").read_text(encoding="utf-8"))
    ids = {a["id"] for a in att}
    print(f"credits: {used} used of {cala.MONTHLY_CREDITS} this month, {cala.MONTHLY_CREDITS - used} left (from data/cala_calls.jsonl)")
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
    cmds = ("status", "attendees", "companies", "entity", "search", "kq")
    if not args or args[0] not in cmds:
        sys.exit(__doc__)
    if args[0] == "status":
        status()
        sys.exit(0)
    purpose = opt(args, "--purpose", "")
    client = cala.Client(int(opt(args, "--budget", "20")))
    pos = positional(args[1:])
    if args[0] == "attendees":
        attendees(client)
    elif args[0] == "companies":
        companies(client, "--shuffle" in args, purpose)
    elif args[0] == "entity":
        if len(pos) < 2 or pos[0] not in cala.KIND_DIR:
            sys.exit("usage: crawl.py entity company|investor|round <id> [<id>...]")
        entities(client, pos[0], pos[1:], purpose)
    elif args[0] == "search":
        types = opt(args, "--types")
        search(client, pos[0], types.split(",") if types else None, purpose)
    elif args[0] == "kq":
        kq(client, pos[0], opt(args, "--tag", "probe"), purpose)
    print(f"{client.n} call(s) made in this run; {cala.MONTHLY_CREDITS - cala.credits_used()} credits left by the log")
