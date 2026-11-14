# Two Hops

Two Hops is for a founder going to Slush 2026 (18 and 19 November) to raise a round. It walks Cala's knowledge graph
from the founder's own company to other Slush attendees that have a sourced investor, then to the rounds of those
attendees and who invested in and led them. The result is a ranked list of investors, each with its paths (you → peer
at Slush → round → investor) and the peer's current founders or CEO to ask for an intro, plus a draft message that
cites only facts of the chosen path and an exportable list of who to look for at Slush. Every node and link shows up to
four of the sources Cala gave for it, best-ranked first.

Built at Junction 2026 for Cala's "Make Unicorns Real" challenge. The submission texts are in `docs/SUBMISSION.md`.

Try it at http://5.175.171.185:3050 (landing page at `/`, the tool at `/app`), or run it locally as below.

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
| `CALA_MONTHLY_CREDITS` | unset | Optional, not in `.env.example`. When set, the server also stops making live calls once the credits logged in `data/cala_calls.jsonl` for the key in use reach this number. Unset, only `CALA_LIVE_BUDGET` limits live calls. The Python tools read it too, only to report what is left. |
| `CALA_API_BASE` | `https://api.cala.ai/v1` | Not in `.env.example`. Where the live call goes, so it can be tested against a local stand-in without spending credits. |
| `ANTHROPIC_API_KEY` | empty | Enables "Reword it" in the intro kit. Without it the draft is the template built from the graph. |
| `INTRO_LLM_BUDGET` | 40 | Rewording calls allowed per server process. |

Live calls are spaced 6.5 seconds apart (Cala allows about 10 calls per rolling minute; we measured the same limit on
both keys we used) and each attempt times out after 20 seconds. A 429 answer is waited out for 7 seconds and the call
tried again, up to four attempts in all; a call that ends on a 429 is logged with no credit. A profile whose read
failed for another reason is not asked for again for ten minutes. If a call fails or the budget is used up, the app
says so and works from the cached graph.

## Where the current numbers are

How much of the event is loaded changes as more data is fetched, so this README does not quote it. The live numbers
are in the coverage line at the top of `/app` and in its "Across everything loaded" section, in the `meta` object of
`data/graph.json` (`counts`, `cala_calls`, `traps`), from `GET /api/overview`, and from:

```
python tools/crawl.py status    # credits used, per key, and what is cached; makes no call
```

## Rebuild the graph

```
python tools/build_graph.py --check
```

Python 3 with the standard library only (use `python3` where that is the command name). It makes no API calls. It reads
the cached Cala responses (`data/attendees.json`, `data/companies/`, `data/investors/`, `data/rounds/`, and
`data/cala_calls.jsonl` for the call count), writes `data/graph.json` and prints a summary. `--check` then re-reads the
cache on its own and verifies, for every edge and every Cala edge id it carries, that the cached relationship with
that id joins the same two entities, in the same direction, with the same relationship type; and that every property
value of a node not merged from duplicates equals the cached value. It exits with an error if anything does not
match. Without `--check` it only builds. A cache file that cannot be read (for example one being written) is skipped.

A running server notices the new `graph.json` within about two seconds and reloads it.

## Download more from Cala

Apart from `status`, `plan` and `coverage.py`, these commands spend credits. They need the key in `CALA_API_KEY` or
`~/.cala_key`.

```
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
python tools/coverage.py                              # field coverage of the cached company profiles (no calls)
```

`deep` goes attendee by attendee: the profile, then, if the profile lists any incoming `INVESTED_IN` link, the
company's funding rounds as issuer (up to six per company, grants left out). It first catches up on the rounds of
profiles cached earlier, so at any moment each company it has covered is cached with its rounds. `plan` lists, from `data/graph.json`, the attendees that have a sourced investor but no profile, and the
rounds on a path that are not loaded; `peers` and `rounds` fetch those lists in that order.

Each run stops after `--budget` calls (default 20); `--purpose "…"` records why the calls are made. Calls are spaced
`CALA_MIN_GAP` seconds apart (default 6.5). A 429 answer is waited out (for its `Retry-After`, or 20 seconds) and the
call retried, up to 8 attempts in all; a request that never left the machine (name lookup failed or connection refused) is
retried up to 5 times. Neither costs a credit or counts against `--budget`. A run stops on a 401, 402 or 403, or after
12 failed calls in a row. Entities already cached are skipped, including files the app wrote meanwhile, so every
command can be stopped and resumed. Each entity file is written whole and then renamed, so a reader never sees half of one.
Run `python tools/build_graph.py --check` afterwards.

Every call, from the tools and from the app, is appended to `data/cala_calls.jsonl` with its time, method, path,
purpose, HTTP status, duration, size, credits, a key tag and the file it was saved to. The key tag is the first 6 hex
characters of a SHA-256 of the key, so calls made with two keys can be told apart without revealing either; entries
from before keys were tagged carry none, and `crawl.py status` lists them as the first key. The tools log every
attempt, a 429 included with 0 credits. The log's first line is a hand count of the calls made before the log
existed, marked `"estimated": true`.

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
  engine.ts               peers, first hop, rounds, paths, people, likeness, both scores, coverage and set operations
  score.ts                investor score and order (weights shared by server and browser)
  rank.ts                 source ranks, best and weakest rank
  intro.ts                intro draft template and the optional rewording
  cala.ts                 the live Cala call, its budgets, retries and log entry
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
weakest funding link: the issuer link from the peer to the round and the investor link from the round, plus the
tranche's own `IS_TRANCHE_OF` link when the investor is recorded on a tranche of the round; or the direct
`INVESTED_IN` link when no round is identified. There is one path per investor and round: a link on the round itself
is preferred to one on a tranche, and a lead to a non-lead. A direct `INVESTED_IN` link next to a round path is shown
as corroboration and does not change its trust. Attendance links come from slush.org without a rank and are the same
in every path, so they are shown but left out of path trust.

A link that Cala returns without a source (funding, tranche, industry, country or people) is never used, and a
property value that Cala returns without a source is neither shown nor used: the provenance panel names what was
withheld.

Every investor is scored on the server twice: over all of its paths, and over only the paths whose trust is `FILING`
or `PRIMARY`. The "Official & first-party sources only" switch picks which of the two orders the browser shows. Scores
cover every investor; one analysis sends the detail of the best 40 organisations and the best 15 individuals of each
order, with up to 8 of their closest paths each (and up to 8 of their closest filing or first-party paths), and the
list says how many investors there are in total (constants at the top of `lib/engine.ts`).

The first step of a result is the first hop: the six funded attendees closest to you, each with how many investors
stand behind it.

Likeness between you and a peer (`lib/engine.ts`) is a weighted sum: same industry 0.4, same sector tag 0.1, same
country 0.2, stage 0.15 (half for an adjacent stage), and shared description terms 0.15 (full at four shared terms).
It needs both profiles loaded; otherwise it is not computed. A company's country comes from its `HAS_HEADQUARTERS_IN`
link to a country, then from the last part of its headquarters address only when that part is a country name (an
ending such as "CA" is not read as one), then from its `IS_REGISTERED_IN` link, then from its registered address in
the same way (`countryOf`).

An investor's score (`lib/score.ts`) is the sum of five terms, each shown in the app's "Why #n" panel:

- 2 × log₂(1 + attendees it funded), where each attendee counts 0.25 plus 0.75 × its likeness to you;
- 1.5 × log₂(1 + rounds of those attendees it led, from `is_lead`);
- 3 × the likeness of its closest funded attendee;
- 1 × recency of its latest round whose own record is loaded and dated, falling linearly to 0 over six years; a source
  date, a round whose label Cala inferred and a round record that carries several stage labels earn none;
- 1 × the trust of its best path: 1 for FILING, 0.8 PRIMARY, 0.55 PRESS, 0.35 AGGREGATOR, 0.15 for no rank.

People to ask are the peer's sourced `FOUNDED`, `IS_CEO_OF`, `IS_CTO_OF`, `WORKS_AT` and `IS_BOARD_MEMBER_OF` links
whose `valid_until` is empty or in the future; founders and CEOs are listed first. The intro endpoint refuses a person
id that is not one of these current role-holders; `person: null` writes to the team. An attendee is treated as an
investor, and so not used as a peer, if it holds 3 or more investments, backed 2 or more rounds, is filed under
venture capital, asset management or private equity, or its name reads as an investor's (ventures, capital, fund,
angels, accelerator and similar words).

The graph builder also flags data traps, each with the basis it used:

- A Company and an Organization with the same normalised name are merged only with corroboration: both are neighbours
  of the same third entity (an organisation, round, person, domain, tranche or corporate event) through the same
  relationship type in the same direction, or both profiles are loaded and give the same website domain. Pairs
  without corroboration are left apart and counted (`same_name_left_apart`).
- Round labels Cala inferred (`round_label_basis:INFERRED` in `annotations`) are tagged; the intro draft calls such a
  round a "funding round".
- A round record whose name, aliases and stated labels name more than one stage (Seed and Series A, say) holds
  several financings. The builder lists every label on the record (`several_labels`); the app counts it as mixed when
  two or more of them are stage labels, since a second name such as "Strategic Investment" is only another name for
  the same financing. For a mixed record the app shows the amount and the date each with its own source but never
  states them together, the intro message names neither, and it earns no recency.
- An `INVESTED_IN` recorded both ways is resolved only when it is evident who the investor is: one side alone is filed
  under an investor industry, or one side holds at least 3 more investments (a count that does not apply when the
  side it favours is filed only under other industries, or when only the other side's name reads as an investor's),
  and the two signs do not disagree. The direction pointing at the investor is then not used; otherwise neither
  direction is used.
- A `PrivateCompanyFundingRound` filing event of a company is marked as the same financing as the company's closest
  `FundingRound` whose own date (`event_date`, else `announcement_date`) lies within 45 days of it; a tie is left
  unmatched, and source dates are never used.

## Known limits

- Coverage is still growing. Loading started from the investors' side: one call returns an investor's whole portfolio,
  up to 1,000 `INVESTED_IN` links, which was crossed with the attendee list by Cala id. It continues attendee by
  attendee with `crawl.py deep` at about ten calls a minute, Cala's rate limit on both keys we used, so a full pass
  over the 2,989 entities and their rounds takes hours. The app always shows how many profiles are loaded. A peer
  whose own profile is not loaded has no likeness score and no people to ask.
- The name search is local, over the cached attendee list. Only opening an uncached company makes a live call, one per
  company, and only when the server has a Cala key and budget left.
- Round details (amount and date) exist only for rounds whose own record was loaded, and `deep` loads at most six
  rounds per company. Paths through a direct `INVESTED_IN` link with no round identified carry only the date of their
  earliest source, which earns no recency.
- Some counts on an investor carry a "+": Cala returns at most 1,000 items per relationship, and those lists came back
  full.
- Same-name records of the same type are never merged, and a Company/Organization pair is merged only as described
  above.
- A profile taken in after the last build (a live read, or a file the crawl wrote since) gets the investor test, and
  any investment it records both ways is set aside in both directions, but duplicates and several-label rounds are
  only found by the next build.
- The rewording check rejects output with a link; a number that is not, as a whole number, in the facts in use; a
  capitalised word in the middle of a sentence that is not in them; a missing investor, peer or addressee name; and the
  word "led" (or "leads", "headed" and similar) when the path does not say the investor led. Facts held back are not
  given to the model. The check does not judge the rest of the wording, so read a reworded draft before sending it.
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
