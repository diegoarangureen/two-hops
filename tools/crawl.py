"""Download the Slush 2026 node from Cala into data/, one call at a time, with a cache.

  python tools/crawl.py attendees               # attendee list -> data/attendees.json (3 calls)
  python tools/crawl.py companies --budget 50   # full profile per attendee -> data/companies/<id>.json

Already-downloaded companies are skipped, so it can be stopped and resumed.
Key: env CALA_API_KEY, or a one-line file at ~/.cala_key. Never put the key in this repo.
Free plan: 10 requests/minute and 100 credits/month (1 credit = 1 call), hence the gap and the budget.
  CALA_MIN_GAP  seconds between calls (default 6.5)
"""
import json
import os
import pathlib
import random
import sys
import time
import urllib.error
import urllib.request

BASE = "https://api.cala.ai/v1"
SLUSH_2026 = "bc844d56-6ab4-452b-96bf-2661e86e592b"
ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
PAGE = 1000  # the API rejects a larger limit per relationship

COMPANY_PROPS = ["name", "legal_name", "website", "description", "founding_date", "headquarters_address",
                 "operational_status", "company_ownership_status", "employee_count_range", "total_funding",
                 "total_funding_units", "total_funding_excluding_debt", "funding_stage"]
COMPANY_RELS = {
    "outgoing": ["PARTICIPATES_IN_FUNDING_ROUND", "PARTICIPATES_IN_CORPORATE_EVENT", "PARTICIPATES_IN_EVENT",
                 "OPERATES_IN_INDUSTRY", "HAS_HEADQUARTERS_IN", "IS_REGISTERED_IN", "INVESTED_IN"],
    "incoming": ["INVESTED_IN", "FOUNDED", "IS_CEO_OF", "IS_CTO_OF", "IS_BOARD_MEMBER_OF", "WORKS_AT"],
}
# Asking for a relationship the entity does not have is fine: it just comes back absent.
COMPANY_BODY = {"properties": COMPANY_PROPS,
                "relationships": {d: {r: {"limit": 50, "offset": 0} for r in rels} for d, rels in COMPANY_RELS.items()}}


def load_key():
    k = os.environ.get("CALA_API_KEY", "").strip()
    if k:
        return k
    p = pathlib.Path.home() / ".cala_key"
    if p.exists():
        return p.read_text(encoding="utf-8").strip()
    sys.exit("No key: set CALA_API_KEY or put it in ~/.cala_key")


class Client:
    def __init__(self, budget):
        self.key, self.budget, self.n, self.last = load_key(), budget, 0, 0.0
        self.gap = float(os.environ.get("CALA_MIN_GAP", "6.5"))

    def post(self, path, body):
        if self.n >= self.budget:
            raise SystemExit(f"budget of {self.budget} calls reached; rerun with a higher --budget to continue")
        wait = self.gap - (time.time() - self.last)
        if wait > 0:
            time.sleep(wait)
        self.last, self.n = time.time(), self.n + 1
        req = urllib.request.Request(BASE + path, method="POST", data=json.dumps(body).encode(), headers={
            "X-API-KEY": self.key, "Content-Type": "application/json", "User-Agent": "cala-project/1.0"})
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                status, text = r.status, r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            status, text = e.code, e.read().decode("utf-8", "replace")
        except Exception as e:  # timeout, connection reset
            status, text = 0, repr(e)
        if status == 429:
            raise SystemExit(f"429 rate limited after {self.n} calls: stop, wait a minute, rerun")
        if status in (401, 403):
            raise SystemExit(f"{status}: key rejected")
        try:
            return status, json.loads(text)
        except ValueError:
            return status, {"raw": text[:300]}


def attendees(c):
    out, off = [], 0
    while True:
        st, js = c.post(f"/entities/{SLUSH_2026}", {
            "properties": ["name"],
            "relationships": {"incoming": {"PARTICIPATES_IN_EVENT": {"limit": PAGE, "offset": off}}}})
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


def companies(c, shuffle):
    att = json.loads((DATA / "attendees.json").read_text(encoding="utf-8"))
    out = DATA / "companies"
    out.mkdir(exist_ok=True)
    todo = [a for a in att if not (out / f"{a['id']}.json").exists()]
    print(f"{len(att) - len(todo)} cached, {len(todo)} to go, budget {c.budget}")
    if shuffle:
        random.shuffle(todo)
    for a in todo:
        st, js = c.post(f"/entities/{a['id']}", COMPANY_BODY)
        if st != 200:  # transient failures happen; skip and pick it up on the next run
            print(f"  {a['name']}: HTTP {st}, skipped")
            continue
        (out / f"{a['id']}.json").write_text(json.dumps(js, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"  {c.n}: {a['name']}")


if __name__ == "__main__":
    args = sys.argv[1:]
    if not args or args[0] not in ("attendees", "companies"):
        sys.exit(__doc__)
    budget = int(args[args.index("--budget") + 1]) if "--budget" in args else 20
    client = Client(budget)
    if args[0] == "attendees":
        attendees(client)
    else:
        companies(client, "--shuffle" in args)
