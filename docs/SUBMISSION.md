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

4,890 characters, limit 5,000. Paste the content of the block below, without the fence lines.

````markdown
A founder going to Slush on 18 and 19 November to raise a round knows that a warm intro gets a meeting where a cold email does not. What they don't know is which investors really fit them, and who in the building that week could introduce them. An investor database gives names and sector tags, not the founder at Slush who already took that investor's money.

Two Hops answers both questions by walking Cala's knowledge graph from the founder's own company:

1. You find your company among the 2,989 entities Cala links to the Slush 2026 event node. The search runs locally; an uncached profile is read from Cala in one call and kept.
2. First hop: the other attendees that have at least one sourced investor. Each one is compared with you on industry, sector tag, country, stage and shared description terms, and the comparison shows the points per factor.
3. Second hop: who funded them. Where Cala records the round, the path runs through it (`PARTICIPATES_IN_FUNDING_ROUND`, with `role` and `is_lead`); otherwise through the direct `INVESTED_IN` link.
4. The result is a ranked list of investors. Each comes with its paths (you → peer at Slush → round → investor) and the peer's current founders or CEO to ask (`FOUNDED`, `IS_CEO_OF`; roles whose `valid_until` has passed are dropped).
5. For the path you choose, an intro kit: a draft message to that founder that states only facts of the path, each listed with its sources, and a CSV or Markdown list of who to look for at Slush.

### The answer is a path

The path is drawn as a graph with Cala's relationship names on the edges, pointing the way Cala points them. Clicking a node or a link shows its sources: name, link to the document, date, age and `source_rank` (FILING, PRIMARY, PRESS, AGGREGATOR, or none given). A funding link that Cala returns without a source never becomes a path. A path is as trustworthy as its weakest funding link, and one switch keeps only the paths where every funding link rests on an official filing or a first-party source, re-ranking the list on the spot.

A real example from the landing page: Reactional Music is on the Slush 2026 attendee list, Butterfly Ventures LLC led its Pre-Series A round (USD 2M, 2023-04-12), and Cala records Tomas Jenneborg as its CEO, the person to ask.

### The order is arithmetic you can check

An investor's score is 2 × log₂(1 + attendees it funded, each weighted from 0.25 to 1 by how much it resembles you) + 1.5 × log₂(1 + rounds it led) + 3 × the likeness of its closest funded attendee + recency of its latest loaded round (fading to zero over six years) + the trust of its best path. A panel shows each term for the selected investor. Counts and intersections run over the whole loaded set, not over the first results: which investors fund more than one attendee, which pairs invest together, and how the sources split by rank.

### Data traps, flagged where they appear

- One organisation stored twice, as a `Company` and as an `Organization`, is merged when the names match after removing case, punctuation and legal form and the pairing is unambiguous. Same-name records of the same type are kept apart, since they may be different companies.
- Round labels that Cala inferred from the order of rounds (`round_label_basis:INFERRED` in `annotations`) are tagged. Cala labels a CHF 3.9M round of Synhelion "Series D" this way, so the intro draft calls it a "funding round".
- Investments recorded in both directions, such as an attendee "investing in" Y Combinator, are detected; the direction pointing at the party with more investments is not used for paths.
- A financing recorded both as a `FundingRound` and as a `PrivateCompanyFundingRound` filing is matched by date and never added twice. Rounds and filing events are shown side by side, never summed.
- A source date is not a round date. A round whose own record is not loaded shows its earliest source date labelled as such, earns no recency points, and the draft gives no date for it.

### Honest about coverage

The free Cala plan allows 100 calls a month, which cannot load 2,989 profiles. So the data enters through investors: one call returns an investor's whole portfolio, up to 1,000 `INVESTED_IN` links, which is crossed with the attendee list by Cala id, never by name. Every screen states how many of the 2,989 entities are loaded. Likeness and people to ask exist only for peers whose own profile is loaded, and amount and date only for rounds whose own record is loaded. Every Cala call is logged in `data/cala_calls.jsonl`, and the app runs entirely from one graph file built from the cache, with no key.

### The language model supplies no facts

The draft is a template filled from the graph on the server. On request, Claude Haiku rewords it from the same facts; the result is thrown away if it contains a link, a number or a name that is not in the facts, or drops the investor's name.
````

## Links for the form

- Project demo: TODO: demo URL
- Source code: the repository is not published yet; add its link when it is.

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

About 255 spoken words. Record on the deployed app or on `npm run dev`. Use a cached company so no live call is spent
on camera; DBtune works with the current data.

**0:00–0:14** · Screen: the landing page hero, then scroll to the real example path.
Say: "Slush is next week. If you're a founder raising a round, you know a warm intro beats a cold email. But which
investors really fit you, and who at Slush can introduce you? Two Hops answers both from Cala's knowledge graph."

**0:14–0:30** · Screen: open the app, type "DBtune", pick it. Point at the coverage line in the top bar.
Say: "I find my startup among the 2,989 entities Cala links to Slush 2026. The search is local; a profile that is not
cached costs one live call. The top bar always says how much of the event is actually loaded."

**0:30–0:52** · Screen: the ranked investor list; select Butterfly Ventures; the path graph through Reactional Music.
Say: "First hop: other attendees with a sourced investor, compared with me. Second hop: their rounds, who invested and
who led. Butterfly Ventures led Reactional Music's Pre-Series A, and Reactional's CEO is at Slush. That's my path."

**0:52–1:12** · Screen: click the `is_lead` link, the sources panel opens; then flip the "Official & first-party
sources only" switch and watch the list re-rank.
Say: "Every node and link opens its sources: the document, its date, and Cala's source rank, from official filing to
aggregator. A path is only as strong as its weakest link, and this switch keeps only paths backed by filings and
first-party sources."

**1:12–1:30** · Screen: the "Why #n" panel, then scroll to "Data traps, in the open".
Say: "The ranking shows its arithmetic: attendees funded, rounds led, likeness, recency, trust. And the data's traps
are flagged in the open: merged duplicates, round labels Cala inferred, investments recorded both ways."

**1:30–1:48** · Screen: open the intro kit; the draft beside "The only facts this message may use"; click Download
CSV.
Say: "Then the intro kit: a draft to that CEO that cites only facts of this path, each with its source, and a list of
who to find at Slush. A language model can reword the draft, but it supplies no facts."

**1:48–2:00** · Screen: the "Across everything loaded" section, then back to the landing.
Say: "Partial coverage, said out loud, and every claim checkable in the graph. Two Hops: the warm intro that is already
at Slush."

## Numbers to refresh before submitting

These come from the current build (`data/graph.json` built 2026-11-14 14:19 UTC) and will change as more data is
loaded. The texts above do not quote them; check them before submitting and before recording. Live values are on the
app's coverage line, in the "Across everything loaded" section, in `data/graph.json` under `meta`, and from
`python tools/crawl.py status`.

- Attendee profiles loaded: 17 of 2,989 (9 of them startups).
- Loaded startups with a funding round on record: 5.
- Attendees with at least one sourced investor: 44.
- Investors linked to those attendees: 24, of which 9 have their full portfolio loaded.
- Funding rounds whose own record is loaded: 2 (Reactional Music Pre-Series A, Synhelion "Series D").
- Cala credits used: 55 of the 100 this month, of which 45 are a hand count of calls made before the log existed.
- Data traps in this build: 7 merged duplicates, 1 inferred round label, 19 investments recorded both ways, 0
  financings found twice (the check runs, but no pair is in the loaded data), 83 same-name records kept apart.
- The example in the description and the video (Reactional Music, Butterfly Ventures, Tomas Jenneborg) is the one the
  landing page picks today. The landing picks the best loaded path automatically, so confirm it still shows this one.
- The video beat with DBtune assumes Butterfly Ventures is in DBtune's list with a path through Reactional Music.
- Punchline and description character counts, if either text is edited.
