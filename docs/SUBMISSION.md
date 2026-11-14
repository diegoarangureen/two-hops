# Submission texts

Texts for the Junction 2026 project form, Cala challenge "Make Unicorns Real". Every figure here can be checked in the
repo. The coverage figures that change as more data is loaded are kept out of the texts and gathered in
"Numbers to refresh before submitting" at the end.

## Project name

Two Hops (8 characters, limit 30)

The working name is kept. It says what the product does: two hops across Cala's graph, from your company through a
peer at Slush to an investor, with the peer's founder as the person in between.

## Punchline

For founders raising at Slush 2026: find the investors who funded companies like yours, and the founder in the room who can introduce you. Every link is sourced in Cala's knowledge graph.

(187 characters, limit 200)

## Description

4,968 characters, limit 5,000. Paste the content of the block below, without the fence lines.

````markdown
A founder going to Slush on 18 and 19 November to raise a round knows that a warm intro gets a meeting where a cold email does not. What they don't know is which investors really fit them, and who in the building that week could introduce them. An investor database gives names and sector tags, not the founder at Slush who already took that investor's money.

Two Hops answers both questions by walking Cala's knowledge graph from the founder's own company:

1. You find your company among the 2,989 entities Cala links to the Slush 2026 event node. The search runs locally; an uncached profile is read from Cala in one call and kept.
2. First hop: the other attendees that have at least one sourced investor, closest to you first, each with how many investors stand behind it. Each is compared with you on industry, sector tag, country, stage and description terms, with the points per factor shown.
3. Second hop: who funded them. Where Cala records the round, the path runs through it (`PARTICIPATES_IN_FUNDING_ROUND`, with `role` and `is_lead`); otherwise through the direct `INVESTED_IN` link.
4. The result is a ranked list of investors. Each comes with its paths (you → peer at Slush → round → investor) and the peer's current founders or CEO to ask (`FOUNDED`, `IS_CEO_OF`; roles whose `valid_until` has passed are dropped).
5. For the path you choose, an intro kit: a draft message to that founder that states only facts of the path, each listed with its sources, and a CSV or Markdown list of who to look for at Slush.

### The answer is a path

The path is drawn as a graph with Cala's relationship names on the edges, pointing the way Cala points them. Clicking a node or a link shows its best sources: name, link to the document, date, age and `source_rank` (FILING, PRIMARY, PRESS, AGGREGATOR, or none given). A link or a value that Cala returns without a source is never shown or used; the panel names what was withheld. A path is as trustworthy as its weakest funding link. Each investor is scored twice on the server, over all its paths and over only those resting on official filings or first-party sources; one switch flips between the two orders.

A real example from the graph: Reactional Music is on the Slush 2026 attendee list, Butterfly Ventures LLC led its Pre-Series A round (USD 2M, 2023-04-12), and Cala records Tomas Jenneborg as its CEO, the person to ask.

### The order is arithmetic you can check

An investor's score is 2 × log₂(1 + attendees it funded, each weighted from 0.25 to 1 by how much it resembles you) + 1.5 × log₂(1 + rounds it led) + 3 × the likeness of its closest funded attendee + recency of its latest loaded round (fading to zero over six years) + the trust of its best path. A panel shows each term. Counts over the whole loaded set show which investors fund several attendees, which pairs invest together, and how sources split by rank.

### Data traps, flagged where they appear

- One organisation stored as both a `Company` and an `Organization` is merged only when the names match after removing case, punctuation and legal form and something corroborates it: a shared neighbour through the same relationship, or the same website. Other pairs are kept apart and counted.
- Round labels Cala inferred from the order of rounds (`round_label_basis:INFERRED`) are tagged. Cala labels a CHF 3.9M round of Synhelion "Series D" this way, so the draft calls it a "funding round".
- A round record carrying several stage labels (Seed and Series A, say) holds several financings: its amount and date are never stated together.
- An investment recorded both ways, such as an attendee "investing in" Y Combinator, is resolved only when it is evident who the investor is; otherwise neither direction is used.
- A financing recorded both as a `FundingRound` and as a `PrivateCompanyFundingRound` filing is matched by the round's own date, within 45 days, and never added twice.
- A source date is not a round date: it earns no recency points and the draft does not give it.

### Honest about coverage

Loading started from the investors' side: one call returns an investor's whole portfolio, up to 1,000 `INVESTED_IN` links, crossed with the attendee list by Cala id, never by name. It continues attendee by attendee, each profile followed by its rounds, at Cala's limit of about ten calls a minute, so a full pass takes hours. Every screen states how many of the 2,989 entities are loaded. Likeness and people to ask exist only for peers whose profile is loaded. Every Cala call is logged in `data/cala_calls.jsonl`, and the app runs from one graph file built from the cache, with no key.

### The language model supplies no facts

The draft is a template filled from the graph on the server. On request, Claude Haiku rewords it from the facts in use only; the result is thrown away if it contains a link, a number or a name not in those facts, drops the investor, peer or addressee, or says "led" when the path does not.
````

## Links for the form

- Project demo: http://5.175.171.185:3050
- Source code: https://github.com/diegoarangureen/two-hops

## Technologies used

Next.js 16 (App Router pages and route handlers), React 19 and TypeScript 5.9 for the web app; the path graph is
hand-written SVG, with no graph or chart library. Python 3, standard library only, for the Cala crawler and the graph
builder. Cala's REST API for all data. The Anthropic TypeScript SDK with Claude Haiku, optional, only to reword the
intro draft.

## Cala endpoints and what they are used for

- `POST /v1/entities/{id}` is the only endpoint the product depends on. The tools use it to read the Slush 2026
  event node with its incoming `PARTICIPATES_IN_EVENT` links, 1,000 per page, which gives the attendee list; investors,
  with their outgoing `INVESTED_IN` and `PARTICIPATES_IN_FUNDING_ROUND` links (their portfolio and the rounds they
  backed); attendee company profiles, with properties such as industry, headquarters and stage and their incoming
  `FOUNDED`, `IS_CEO_OF`, `WORKS_AT` and board links; and funding rounds, with their incoming
  `PARTICIPATES_IN_FUNDING_ROUND` participants and `IS_TRANCHE_OF` tranches. In the running app it is the one live
  call: reading the profile of an attendee that is not cached yet (`lib/cala.ts`).
- `GET /v1/entities?name=…` (entity search) was used during research to find the Slush 2026 node. `tools/crawl.py
  search` can still call it; the app does not, because its name search runs on the cached attendee list.
- `GET /v1/entities/{id}/introspection` was used during research to learn which fields and relationships each entity
  type has (`data/introspection/`, `data/raw/search/`). The product does not call it.
- `POST /v1/knowledge/query` was probed once, asking for Slush 2026 attendees with rounds and investors. It answered
  in 46 seconds with four rows. The only thing taken from it was Y Combinator's entity id, which was then read with
  `POST /v1/entities/{id}` like any other investor. Nothing in the product uses `knowledge_query`.
- `POST /v1/knowledge/search` and the MCP server are not used.

## Video script (under 2 minutes)

About 253 spoken words. Record on the deployed app or on `npm run dev`. Use a cached company so no live call is spent
on camera; DBtune works with the current data.

**0:00–0:14** · Screen: the landing page hero, then scroll to the real example path.
Say: "Slush is next week. If you're a founder raising a round, you know a warm intro beats a cold email. But which
investors really fit you, and who at Slush can introduce you? Two Hops answers both from Cala's knowledge graph."

**0:14–0:30** · Screen: open the app, type "DBtune", pick it. Point at the coverage line in the top bar.
Say: "I find my startup among the 2,989 entities Cala links to Slush 2026. The search is local; a profile that is not
cached costs one live call. The top bar always says how much of the event is actually loaded."

**0:30–0:52** · Screen: the first-hop step (the funded peers closest to DBtune), then the ranked investor list;
select Butterfly Ventures LLC (sixth for DBtune at the last check); in its path graph, point at the path through
Reactional Music.
Say: "First hop: other attendees with a sourced investor, closest to me first. Second hop: their rounds, who invested
and who led. Butterfly Ventures led Reactional Music's Pre-Series A, and Cala names Reactional's CEO. That's my
path."

**0:52–1:12** · Screen: click the `is_lead` link, the sources panel opens; then flip the "Official & first-party
sources only" switch and watch the list re-rank (Butterfly Ventures falls back, keeping only its Reactional Music
path); flip it off again.
Say: "Every node and link opens its sources: the document, its date, and Cala's source rank, from official filing to
aggregator. A path is only as strong as its weakest link, and this switch keeps only paths backed by filings and
first-party sources."

**1:12–1:30** · Screen: the "Why #n" panel, then scroll to "Data traps, in the open".
Say: "The ranking shows its arithmetic: attendees funded, rounds led, likeness, recency, trust. And the data's traps
are flagged in the open: merged duplicates, round labels Cala inferred, investments recorded both ways."

**1:30–1:48** · Screen: open the intro kit from the Reactional Music path (the kit starts on the investor's first
path, which for Butterfly Ventures is DREV); the draft beside "The only facts this message may use"; click Download
CSV.
Say: "Then the intro kit: a draft to that CEO that cites only facts of this path, each with its source, and a list of
who to find at Slush. A language model can reword the draft, but it supplies no facts."

**1:48–2:00** · Screen: the "Across everything loaded" section, then back to the landing.
Say: "Partial coverage, said out loud, and every claim checkable in the graph. Two Hops: the warm intro that is already
at Slush."

## Numbers to refresh before submitting

Read on 2026-11-14 at 15:46 UTC, from `data/graph.json` (built 2026-11-14 15:42 UTC: `meta.counts`, `meta.traps`), from
`GET /api/overview` on that build, and from `python tools/crawl.py status`. A crawl is running, so all of them keep
changing until it ends. The texts above do not quote them; check them again before submitting and before recording.
Live values are on the app's coverage line, in the "Across everything loaded" section, in `data/graph.json` under
`meta`, and from `python tools/crawl.py status`.

- Attendee profiles loaded: 102 of 2,989 (92 of them not investors themselves).
- Attendees with a funding round on record: 69.
- Attendees with at least one sourced investor: 57.
- Investors linked to those attendees: 270, of which 9 have their full portfolio loaded.
- Funding rounds whose own record is loaded: 100.
- Rounds on a path still to load, from `python tools/crawl.py plan`: 58. Attendees with a sourced investor but no
  profile: 0.
- Cala credits logged: 238 in total. 55 on the first (free) key, of which 45 are a hand count of calls made before the
  log existed; 183 on the second key (tag `836ba1`). 429 answers are logged with 0 credits.
- Data traps in this build: 9 merged duplicates, 3 Company/Organization pairs with the same name left apart for lack of
  corroboration, 92 other same-name groups kept apart because they hold more than one record of a type, 33 inferred
  round labels, 16 round records with several labels, 49 investment edges recorded both ways (32 of them with the
  direction unclear, so neither is used), 16 financings found twice.
- The example in the description and the video (Reactional Music, Butterfly Ventures LLC, Tomas Jenneborg) is a real
  path in the graph: Butterfly Ventures LLC led Reactional Music's Pre-Series A (USD 2M, 2023-04-12), and Cala records
  Tomas Jenneborg as CEO. The landing page picks its example automatically and now shows a different one (yasp, whose
  Seed round of USD 5M on 2025-09-25 was led by Capnamic Ventures Management GmbH), so the 0:00–0:14 beat does not
  name it.
- The video beat with DBtune assumes Butterfly Ventures LLC is in DBtune's list with a path through Reactional Music.
  At the last check it was sixth of 267 investors (behind Techstars, Y Combinator, Capnamic Ventures Management GmbH,
  Northzone and BioInnovation Institute) and 38th of 138 with the "Official & first-party sources only" switch on,
  where only its Reactional Music path remains.
- Punchline and description character counts, if either text is edited.
