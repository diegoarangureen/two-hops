"""Coverage of the company profiles cached in data/companies (no API calls).

  python tools/coverage.py
"""
import collections
import json
import pathlib

DATA = pathlib.Path(__file__).resolve().parent.parent / "data"


def val(p):
    return p.get("value") if isinstance(p, dict) else p


files = sorted((DATA / "companies").glob("*.json"))
fill, edges, ranks, stages = collections.Counter(), collections.Counter(), collections.Counter(), collections.Counter()
for f in files:
    j = json.loads(f.read_text(encoding="utf-8"))
    props, rels = j.get("properties") or {}, j.get("relationships") or {}
    for k, v in props.items():
        if val(v) not in (None, "", []):
            fill[k] += 1
        for s in (v.get("sources") or []) if isinstance(v, dict) else []:
            ranks[str(s.get("source_rank"))] += 1
    stages[str(val(props.get("funding_stage")))] += 1
    for d in ("outgoing", "incoming"):
        for r, lst in (rels.get(d) or {}).items():
            if lst:
                edges[f"{d}:{r}"] += 1

n = len(files)
print(f"{n} companies cached\n\nproperties filled:")
for k, c in fill.most_common():
    print(f"  {k:34s} {c:5d}  {100 * c // n}%")
print("\nrelationships present:")
for k, c in edges.most_common():
    print(f"  {k:44s} {c:5d}  {100 * c // n}%")
print("\nfunding_stage:", dict(stages.most_common()))
print("source_rank of property sources:", dict(ranks.most_common()))
