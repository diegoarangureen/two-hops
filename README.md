# Two Hops

Two Hops is for a founder going to Slush 2026 (18 and 19 November) to raise a round. It walks Cala's knowledge graph
from the founder's own company to other Slush attendees that have a sourced investor, then to the rounds of those
attendees and who invested in and led them. The result is a ranked list of investors, each with its paths (you → peer
at Slush → round → investor) and the peer's current founders or CEO to ask for an intro, plus a draft message that
cites only facts of the chosen path and an exportable list of who to look for at Slush. Every node and link shows the
sources Cala gave for it.

Built at Junction 2026 for Cala's "Make Unicorns Real" challenge. The submission texts are in `docs/SUBMISSION.md`.

## Quick start

You need Node.js 20.9 or newer, with npm.

```
npm install
npm run dev
```

Open http://localhost:3000. The landing page is at `/` and the tool at `/app`.

No key is needed. The app reads everything from `data/graph.json`, which is in the repo. On start it also takes in any
profile saved under `data/companies/` after the graph was last built.

To try it, type a company name in the search box, or click one of the cached profiles offered under it. A company whose
profile is cached gets the full comparison with its peers. You can also open an attendee whose profile is not cached:
without a Cala key no call is made, the paths are still shown, but peers cannot be compared with you. A result can be
linked directly as `/app?me=<Cala entity id>`.

Other scripts in `package.json`:

```
npm run build && npm start   # production build, served on port 3000
npm run typecheck            # tsc --noEmit
npm run graph                # same as: python tools/build_graph.py --check
```

## Optional keys

Copy `.env.example` to `.env.local` and fill in what you want. Keys are read on the server only and never reach the
browser.

| Variable | Default | What it does |
|---|---|---|
| `CALA_API_KEY` | empty | Enables the one live call: when you open an attendee whose profile is not cached, the server reads it with `POST /v1/entities/{id}`, saves it to `data/companies/<id>.json`, logs the call and adds it to the graph in memory. A cached profile is never fetched again. If unset, the server also looks for a one-line file at `~/.cala_key`. |
| `CALA_LIVE_BUDGET` | 10 | Live calls allowed per server process. |
| `CALA_MONTHLY_CREDITS` | 100 | Not in `.env.example`. The server also stops making live calls once the credits in `data/cala_calls.jsonl` reach this number. |
| `ANTHROPIC_API_KEY` | empty | Enables "Reword it" in the intro kit. Without it the draft is the template built from the graph. |
| `INTRO_LLM_BUDGET` | 40 | Rewording calls allowed per server process. |

Live calls are spaced 6.5 seconds apart (the free plan allows 10 calls a minute) and time out after 20 seconds. If a
call fails or the budget is used up, the app says so and works from the cached graph.

## Where the current numbers are

How much of the event is loaded changes as more data is fetched, so this README does not quote it. The live numbers
are in the coverage line at the top of `/app` and in its "Across everything loaded" section, in the `meta` object of
`data/graph.json` (`counts`, `cala_calls`, `traps`), from `GET /api/overview`, and from:

```
python tools/crawl.py status    # credits used and what is cached; makes no call
```

## Rebuild the graph

```
python tools/build_graph.py --check
```

Python 3 with the standard library only (use `python3` where that is the command name). It makes no API calls. It reads
the cached Cala responses (`data/attendees.json`, `data/companies/`, `data/investors/`, `data/rounds/`, and
`data/cala_calls.jsonl` for the call count), writes `data/graph.json` and prints a summary. `--check` then re-reads the
cache and verifies that every edge and every property value in the graph is traceable to a cached response; it exits
with an error if one is not. Without `--check` it only builds.

A running server notices the new `graph.json` within about two seconds and reloads it.

## Download more from Cala

These commands spend credits. They need the key in `CALA_API_KEY` or `~/.cala_key`.

```
python tools/crawl.py status                          # credits used and what is cached (no calls)
python tools/crawl.py attendees                       # attendee list -> data/attendees.json (3 calls)
python tools/crawl.py companies --budget 50           # full profile per attendee -> data/companies/<id>.json
python tools/crawl.py entity investor <id> [<id>...]  # one investor: portfolio and rounds -> data/investors/<id>.json
python tools/crawl.py entity company <id> [<id>...]   # one company profile -> data/companies/<id>.json
python tools/crawl.py entity round <id> [<id>...]     # one funding round with participants -> data/rounds/<id>.json
python tools/crawl.py search "Name" [--types Company,Organization]   # entity search -> data/raw/search/
python tools/crawl.py kq "question" --tag name        # one knowledge_query -> data/raw/kq/<tag>.json
python tools/coverage.py                              # field coverage of the cached company profiles (no calls)
```

Each run stops after `--budget` calls (default 20); `--purpose "…"` records why the calls are made. Calls are spaced
`CALA_MIN_GAP` seconds apart (default 6.5). Entities already cached are skipped, so every command can be stopped and
resumed. Run `python tools/build_graph.py --check` afterwards.

Every call, from the tools and from the app, is appended to `data/cala_calls.jsonl` with its time, method, path,
purpose, HTTP status, duration, size, credits and the file it was saved to. Its first line is a hand count of the
calls made before the log existed, marked `"estimated": true`.

Two research tools remain from the first audit of the Slush node: `tools/audit_slush.py OUT_DIR` (search,
introspection, full crawl of the node and `knowledge_query` probes; about 250 calls) and `tools/probe.py` (one call per
run, reads the key from `~/.cala_key` only). Neither writes to the call log, and the app does not need them.

## Layout

```
app/
  page.tsx                landing page, with a real example path picked from the graph
  app/page.tsx            the tool (/app)
  api/search/route.ts     GET  /api/search?q=   name search over the attendee list; never calls Cala
  api/analyze/route.ts    POST /api/analyze     walk the graph from one attendee; the one live call happens here
  api/intro/route.ts      POST /api/intro       intro draft for one path, from ids only
  api/overview/route.ts   GET  /api/overview    coverage, whole-set counts and data traps
components/               the client UI: AppClient, PathGraph (SVG), Provenance, Rank, IntroKit, Overview
lib/
  graph.ts                loads data/graph.json, indexes it, takes in live profiles
  engine.ts               peers, rounds, paths, people, likeness, coverage and set operations
  score.ts                investor ranking (shared by server and browser)
  rank.ts                 source ranks, best and weakest rank
  intro.ts                intro draft template and the optional rewording
  cala.ts                 the live Cala call, its budget and its log entry
  types.ts                shapes passed from server to client
tools/                    Python: cala.py (client), crawl.py, build_graph.py, coverage.py, audit_slush.py, probe.py
data/
  graph.json              the graph the app reads, built by tools/build_graph.py
  attendees.json          the 2,989 entities linked to Slush 2026 (2,988 attendees and the organiser)
  companies/ investors/ rounds/   cached Cala entity responses
  introspection/ raw/     research-stage responses (search, introspection, attendee pages, the knowledge_query probe)
  cala_calls.jsonl        log of every Cala call
docs/                     see below
```

## How trust and ranking are computed

Each source has the `source_rank` Cala gives it: `FILING` (registries, regulators, official filings), `PRIMARY` (the
company or its investors), `PRESS`, `AGGREGATOR`, or none. A link counts as its best source. A path counts as its
weakest funding link: the issuer link from the peer to the round and the investor link from the round, or the direct
`INVESTED_IN` link when no round is identified. Attendance links come from slush.org without a rank and are the same in
every path, so they are shown but left out of path trust. Funding links and people links without any source are
never used. The "Official & first-party sources only" switch keeps the paths whose trust is `FILING` or `PRIMARY` and
re-ranks in the browser.

Likeness between you and a peer (`lib/engine.ts`) is a weighted sum: same industry 0.4, same sector tag 0.1, same
country 0.2, stage 0.15 (half for an adjacent stage), and shared description terms 0.15 (full at four shared terms).
It needs both profiles loaded; otherwise it is not computed.

An investor's score (`lib/score.ts`) is the sum of five terms, each shown in the app's "Why #n" panel:

- 2 × log₂(1 + attendees it funded), where each attendee counts 0.25 plus 0.75 × its likeness to you;
- 1.5 × log₂(1 + rounds of those attendees it led, from `is_lead`);
- 3 × the likeness of its closest funded attendee;
- 1 × recency of its latest round whose own record is loaded, falling linearly to 0 over six years;
- 1 × the trust of its best path: 1 for FILING, 0.8 PRIMARY, 0.55 PRESS, 0.35 AGGREGATOR, 0.15 for no rank.

People to ask are the peer's `FOUNDED`, `IS_CEO_OF`, `IS_CTO_OF`, `WORKS_AT` and `IS_BOARD_MEMBER_OF` links whose
`valid_until` is empty or in the future; founders and CEOs are listed first. Attendees that look like investors
themselves (three or more investments, two or more rounds backed, or filed under venture capital, asset management or
private equity) are not used as peers.

The graph builder also flags data traps, each with the basis it used: Company/Organization duplicates merged into one
record, round labels Cala inferred (`round_label_basis:INFERRED` in `annotations`), `INVESTED_IN` recorded both ways
(the direction pointing at the party with more investments is not used), and a `FundingRound` and a
`PrivateCompanyFundingRound` of the same company within 45 days marked as one financing.

## Known limits

- Coverage is partial. The free Cala plan allows 100 calls a month, so only a small share of the 2,989 profiles is
  loaded. Most peers were found by crossing investor portfolios with the attendee list by Cala id; their own profiles
  are often not loaded, and then they have no likeness score and no people to ask.
- The name search is local, over the cached attendee list. Only opening an uncached company makes a live call, one per
  company, and only when the server has a Cala key and budget left.
- Round details (amount and date) exist only for rounds whose own record was loaded. Many paths go through a direct
  `INVESTED_IN` link with no round identified, and those carry only the date of their earliest source, which earns no
  recency.
- Some counts on an investor carry a "+": Cala returns at most 1,000 items per relationship, and those lists came back
  full.
- The duplicate merge is by normalised name and requires exactly one Company and one Organization record with that
  name; other duplicates are left as they are.
- The rewording check rejects output with a link or a number not found in the facts, or without the investor's name.
  It does not check every other word, so read a reworded draft before sending it.
- The live call writes to `data/companies/` and the call log; on a read-only deployment the profile is kept in memory
  for that server only and the log entry goes to the server log.

## Documents

| File | What it is |
|---|---|
| `docs/SUBMISSION.md` | Submission texts: name, punchline, description, technologies, Cala endpoints, video script |
| `docs/IDEA.md` | The project proposal and what was set aside (Spanish) |
| `docs/PROMPT_BUILD.md` | The build brief (Spanish) |
| `docs/AUDITORIA_SLUSH.md` | What the Slush 2026 node contains and its coverage (Spanish) |
| `docs/CALA_API.md` | How Cala is queried, with the traps found (Spanish) |
| `docs/cala_funding_fields_hack_guide.md` | Cala's official field guide for the challenge |
| `docs/cala_openapi.json` | Cala API specification |
| `docs/reto/` | Challenge text, submission rules, tech challenges and tools |
