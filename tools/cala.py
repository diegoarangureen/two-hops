"""Shared Cala client for the tools: the key, the rate limit, the cache and the call log in one place.

Rules it enforces:
  - the key comes from env CALA_API_KEY or a one-line file at ~/.cala_key and is never printed or saved;
  - every call is appended to data/cala_calls.jsonl (method, path, purpose, status, seconds);
  - an entity already cached under data/ is never fetched again;
  - calls are spaced CALA_MIN_GAP seconds apart (free plan: 10 per minute) and stop at a budget.
"""
import datetime
import json
import os
import pathlib
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = "https://api.cala.ai/v1"
SLUSH_2026 = "bc844d56-6ab4-452b-96bf-2661e86e592b"
ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
LOG = DATA / "cala_calls.jsonl"
MONTHLY_CREDITS = int(os.environ.get("CALA_MONTHLY_CREDITS", "100"))  # free plan, 1 credit = 1 call
PAGE = 1000  # the API rejects a larger limit per relationship

# Property names seen in Cala's field guide and in introspection results. Asking for one the entity
# does not have is fine: it just comes back absent.
COMPANY_PROPS = ["name", "legal_name", "aliases", "website", "description", "founding_date", "headquarters_address",
                 "registered_address", "operational_status", "company_ownership_status", "employee_count_range",
                 "total_funding", "total_funding_units", "total_funding_excluding_debt", "funding_stage"]
ORG_PROPS = ["name", "aliases", "website", "description", "founding_date", "registered_address"]
ROUND_PROPS = ["name", "aliases", "round_label", "instrument", "transaction_value", "transaction_value_units",
               "announcement_date", "event_date", "annotations"]
ENTITY_RELS = {
    "outgoing": ["PARTICIPATES_IN_FUNDING_ROUND", "PARTICIPATES_IN_CORPORATE_EVENT", "PARTICIPATES_IN_EVENT",
                 "OPERATES_IN_INDUSTRY", "HAS_HEADQUARTERS_IN", "IS_REGISTERED_IN", "HAS_PRESENCE_IN", "INVESTED_IN"],
    "incoming": ["INVESTED_IN", "FOUNDED", "IS_CEO_OF", "IS_CTO_OF", "IS_BOARD_MEMBER_OF", "WORKS_AT"],
}
ROUND_RELS = {"outgoing": [], "incoming": ["PARTICIPATES_IN_FUNDING_ROUND", "IS_TRANCHE_OF"]}

# Where each kind of entity is cached.
KIND_DIR = {"company": "companies", "investor": "investors", "round": "rounds"}


def utf8_stdout():
    """Windows consoles default to cp1252; company names need UTF-8."""
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def load_key():
    k = os.environ.get("CALA_API_KEY", "").strip()
    if k:
        return k
    p = pathlib.Path.home() / ".cala_key"
    if p.exists():
        for line in p.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#"):
                return line.split("=", 1)[1].strip().strip("\"'") if "=" in line else line
    sys.exit("No key: set CALA_API_KEY or put it in ~/.cala_key")


def body_for(kind, entity_type=None, limit=PAGE):
    """Projection for one retrieval. One call costs one credit whatever it returns, so ask for everything useful."""
    if kind == "round":
        props, rels = ROUND_PROPS, ROUND_RELS
    else:
        props = ORG_PROPS if entity_type == "Organization" else COMPANY_PROPS
        rels = ENTITY_RELS
    return {"properties": props,
            "relationships": {d: {r: {"limit": limit, "offset": 0} for r in rs} for d, rs in rels.items() if rs}}


def read_log():
    if not LOG.exists():
        return []
    out = []
    for line in LOG.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            out.append(json.loads(line))
    return out


def credits_used():
    return sum(int(e.get("credits", 0)) for e in read_log())


def log_call(entry):
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with LOG.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")


def cached_index():
    """entity id -> cached file, for everything already downloaded."""
    idx = {}
    for sub in KIND_DIR.values():
        d = DATA / sub
        if not d.exists():
            continue
        for f in sorted(d.glob("*.json")):
            try:
                j = json.loads(f.read_text(encoding="utf-8"))
            except ValueError:
                continue
            if isinstance(j, dict) and j.get("id"):
                idx[j["id"]] = f
    return idx


class Client:
    def __init__(self, budget):
        self.key, self.budget, self.n, self.last = load_key(), budget, 0, 0.0
        self.gap = float(os.environ.get("CALA_MIN_GAP", "6.5"))
        self.cache = cached_index()

    def call(self, method, path, body=None, params=None, purpose="", timeout=120, saved=None):
        """One HTTP call. Returns (status, json). Always logged; every attempt is counted as one credit."""
        if self.n >= self.budget:
            raise SystemExit(f"budget of {self.budget} calls reached; rerun with a higher --budget to continue")
        wait = self.gap - (time.time() - self.last)
        if wait > 0:
            time.sleep(wait)
        self.last, self.n = time.time(), self.n + 1
        url = BASE + path
        if params:
            url += "?" + urllib.parse.urlencode(params, doseq=True)
        req = urllib.request.Request(url, method=method, data=json.dumps(body).encode() if body is not None else None,
                                     headers={"X-API-KEY": self.key, "Content-Type": "application/json",
                                              "Accept": "application/json", "User-Agent": "two-hops/1.0"})
        t0, headers = time.time(), {}
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                status, text, headers = r.status, r.read().decode("utf-8", "replace"), dict(r.headers.items())
        except urllib.error.HTTPError as e:
            status, text, headers = e.code, e.read().decode("utf-8", "replace"), dict(e.headers.items())
        except Exception as e:  # timeout, connection reset
            status, text = 0, json.dumps({"client_error": repr(e)})
        seconds = round(time.time() - t0, 2)
        # keep only headers that say something about quota; never the key
        quota = {k: v for k, v in headers.items() if any(w in k.lower() for w in ("ratelimit", "credit", "quota", "retry"))}
        entry = {"ts": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
                 "method": method, "path": path, "purpose": purpose, "status": status, "seconds": seconds,
                 "bytes": len(text), "credits": 1}
        if params:
            entry["params"] = params
        if saved:
            entry["saved"] = saved
        if quota:
            entry["quota_headers"] = quota
        log_call(entry)
        if status == 429:
            raise SystemExit(f"429 rate limited after {self.n} calls: stop, wait a minute, rerun")
        if status in (401, 403):
            raise SystemExit(f"{status}: key rejected")
        try:
            return status, json.loads(text)
        except ValueError:
            return status, {"raw": text[:300]}

    def entity(self, eid, kind, purpose, entity_type=None, limit=PAGE):
        """Fetch one entity with everything useful and cache it. Returns (json or None, made_a_call)."""
        if eid in self.cache:
            return json.loads(self.cache[eid].read_text(encoding="utf-8")), False
        out = DATA / KIND_DIR[kind] / f"{eid}.json"
        out.parent.mkdir(parents=True, exist_ok=True)
        rel = out.relative_to(ROOT).as_posix()
        st, js = self.call("POST", f"/entities/{eid}", body_for(kind, entity_type, limit), purpose=purpose, saved=rel)
        if st != 200 or not isinstance(js, dict) or not js.get("id"):
            print(f"  HTTP {st} for {eid}: {json.dumps(js, ensure_ascii=False)[:200]}")
            return None, True
        out.write_text(json.dumps(js, ensure_ascii=False, indent=1), encoding="utf-8")
        self.cache[eid] = out
        return js, True
