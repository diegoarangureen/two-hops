"""Frugal Cala probe: one call per invocation, raw response saved, short summary printed.

  python probe.py OUT_DIR TAG GET  /entities/<id>/introspection
  python probe.py OUT_DIR TAG POST /entities/<id> '<json body>'
"""
import json
import pathlib
import sys
import time
import urllib.error
import urllib.request

out, tag, method, path = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4]
body = json.loads(sys.argv[5]) if len(sys.argv) > 5 else None
out.mkdir(parents=True, exist_ok=True)
key = (pathlib.Path.home() / ".cala_key").read_text(encoding="utf-8").strip()
req = urllib.request.Request("https://api.cala.ai/v1" + path, method=method,
                             data=json.dumps(body).encode() if body is not None else None,
                             headers={"X-API-KEY": key, "Content-Type": "application/json",
                                      "Accept": "application/json", "User-Agent": "cala-audit/1.0"})
t0 = time.time()
try:
    with urllib.request.urlopen(req, timeout=200) as r:
        status, text = r.status, r.read().decode("utf-8", "replace")
except urllib.error.HTTPError as e:
    status, text = e.code, e.read().decode("utf-8", "replace")
dt = round(time.time() - t0, 2)
(out / f"{tag}.json").write_text(text, encoding="utf-8")
print(f"HTTP {status} in {dt}s, {len(text)} bytes -> {out / (tag + '.json')}")
if status != 200:
    print(text[:500])
