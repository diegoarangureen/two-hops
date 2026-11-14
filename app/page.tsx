import Link from "next/link";
import PathGraph from "@/components/PathGraph";
import { RankBadge, SourceList } from "@/components/Rank";
import { coverage, examplePath } from "@/lib/engine";
import type { LinkView } from "@/lib/types";

// Rendered per request, so the numbers and the example always match the graph file that is on disk.
export const dynamic = "force-dynamic";

function LinkCard({ title, link, from, to }: { title: string; link: LinkView; from: string; to: string }) {
  return (
    <div className="panel">
      <h3>{title}</h3>
      <p className="prov-rel">
        <span>{from}</span>
        <code>—{link.type}→</code>
        <span>{to}</span>
      </p>
      <div className="prov-line">
        <RankBadge rank={link.rank} />
        {Object.entries(link.props).map(([k, v]) => (
          <code key={k} className={`kv${k === "is_lead" && v === true ? " kv-lead" : ""}`}>
            {k}: {String(v)}
          </code>
        ))}
      </div>
      <SourceList sources={link.sources} />
    </div>
  );
}

export default function Landing() {
  const c = coverage();
  const ex = examplePath();
  const asks = ex?.peer.people.filter((p) => p.primary) ?? [];
  const n = (x: number) => x.toLocaleString("en");

  return (
    <>
    <header className="hdr landing-hdr">
      <div className="hdr-in">
        <Link href="/" className="logo">
          <span className="logo-mark" aria-hidden />
          Two&nbsp;Hops
        </Link>
        <span className="tagline">built on Cala&apos;s knowledge graph</span>
        <div className="hdr-right">
          <Link href="/app" className="btn">
            Open the app
          </Link>
        </div>
      </div>
    </header>
    <div className="landing">

      <div className="hero">
        <p className="eyebrow">For founders raising at Slush 2026</p>
        <h1>
          The warm intro is already <em>in the room.</em>
        </h1>
        <p>
          Two Hops walks Cala&apos;s knowledge graph from your own startup: to the companies at Slush that look like yours, to the
          rounds they raised, to the investors who funded and led them. You leave with the investors worth meeting and the
          founder, a few metres away, who can introduce you. Every step shows its source.
        </p>
        <div className="cta-row">
          <Link href="/app" className="cta">
            Find your two hops →
          </Link>
          <span className="muted">
            Search all {n(c.attendeesListed)} entities linked to the event. {n(c.profilesLoaded)} full profiles loaded so far.
          </span>
        </div>
      </div>

      <section>
        <h2>You know an intro beats a cold email. You don&apos;t know whose.</h2>
        <div className="problem">
          <div className="panel">
            <b>Which investors really fit?</b>
            <p>Not the ones whose website says they like your sector. The ones who already wrote a cheque to a company like yours.</p>
          </div>
          <div className="panel">
            <b>Who can vouch for you this week?</b>
            <p>
              An investor database gives you a name. It does not give you the founder who took that investor&apos;s money and is
              walking the same floor as you.
            </p>
          </div>
          <div className="panel">
            <b>Can you trust the link?</b>
            <p>
              A chatbot will happily tell you who invested in whom. Here each link is a relationship in Cala&apos;s graph with the
              filing, the company page or the article it comes from.
            </p>
          </div>
        </div>
      </section>

      {ex && (
        <section>
          <h2>A real path, read from the graph</h2>
          <p className="lede">
            Not a mock-up. {ex.peer.node.name} is on the Slush 2026 attendee list. {ex.investor.name}{" "}
            {ex.path.isLead ? "led" : "took part in"} its {ex.path.round?.labelInferred ? "funding" : ex.path.round?.label} round
            {ex.path.round?.amount ? ` (${ex.path.round.amount}${ex.path.round.dateText ? `, ${ex.path.round.dateText}` : ""})` : ""}.
            {asks.length > 0 && ` ${asks[0].name} is the person to ask.`} If your company is at Slush too, that investor is two hops
            from you.
          </p>
          <PathGraph
            you={{ id: "you", name: "Your startup", sub: "attending Slush 2026", placeholder: true }}
            event={ex.event}
            investor={ex.investor}
            paths={[ex.path]}
            peers={{ [ex.path.peerId]: ex.peer }}
          />
          <div className="example-facts">
            <LinkCard title="Hop 1 · a peer in the room" link={ex.attendance} from={ex.peer.node.name} to={ex.event.name} />
            <LinkCard title="Hop 2 · the round it raised" link={ex.path.links[0]} from={ex.peer.node.name} to={`${ex.path.round?.label ?? "Funding"} round`} />
            <LinkCard title="Hop 2 · who funded it, and who led" link={ex.path.links[1]} from={ex.investor.name} to={`${ex.path.round?.label ?? "Funding"} round`} />
            {asks[0] && <LinkCard title="The person to ask" link={asks[0].roles[0].link} from={asks[0].name} to={ex.peer.node.name} />}
          </div>
          <p className="muted small" style={{ marginTop: 10 }}>
            Arrows point the way the relationship points in Cala. Colour is the kind of source behind each link: official filing,
            first-party, press, aggregator, or no rank given. Path trust here: <RankBadge rank={ex.path.trust} small />, the weakest
            of its funding links.
          </p>
        </section>
      )}

      <section>
        <h2>How it works</h2>
        <div className="steps">
          <div className="panel">
            <b>Find yourself</b>
            <p>
              Search the {n(c.attendeesListed)} entities linked to the Slush 2026 node. Your profile (sector, stage, headquarters)
              is read from Cala in one live call and cached.
            </p>
          </div>
          <div className="panel">
            <b>Two hops across the graph</b>
            <p>
              First hop: other attendees with a sourced investor, scored against your profile. Second hop:{" "}
              <code>PARTICIPATES_IN_FUNDING_ROUND</code> and <code>INVESTED_IN</code> say who funded them, and <code>is_lead</code>{" "}
              says who led.
            </p>
          </div>
          <div className="panel">
            <b>Ask the person in the room</b>
            <p>
              Investors are ranked with the arithmetic in plain sight. Each path comes with the founder or CEO to ask, a draft
              message that cites only the facts of that path, and a list to carry around Slush.
            </p>
          </div>
        </div>
      </section>

      <section className="honest">
        <h2>What is loaded, and what is not</h2>
        <p>
          Cala links <b>{n(c.attendeesListed)}</b> entities to Slush 2026. This build holds the full profile of{" "}
          <b>{n(c.profilesLoaded)}</b> of them, a sourced investor for <b>{n(c.withNamedInvestor)}</b>, and{" "}
          <b>{n(c.roundsLoaded)}</b> of their funding rounds with who led. Cala answers about ten calls a minute, so the rest
          is still being read. Investors are matched to attendees by Cala id and never by name. The app shows these numbers
          on every screen instead of pretending to cover the whole event.
        </p>
        <p>
          If Cala has no source for a fact, the fact is not shown. Duplicate records, round labels that Cala inferred, and
          investments recorded in both directions are flagged where they appear. A language model rewords one message when you
          ask it to. It supplies no facts.
        </p>
        <div className="cta-row">
          <Link href="/app" className="cta">
            Find your two hops →
          </Link>
        </div>
      </section>

      <footer className="foot">
        Two Hops · built at Junction 2026 for the Cala challenge. Data: Cala knowledge graph, cached {c.builtAt.slice(0, 10)}.
      </footer>
    </div>
    </>
  );
}
