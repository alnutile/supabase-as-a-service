# Marketing plan: making "the small-business AI intranet" sink in

A 12-week, education-first content plan. The category ("self-hosted AI workspace on
Supabase") isn't something people search for yet, so the job is not promotion — it's
**teaching a problem until the product feels like the obvious answer**.

## Positioning (say this everywhere, verbatim)

> **Your team's AI, on your own database.** An open-source intranet where AI learns your
> business from your documents — and everyone shares it.

One line, repeated until it's boring to *you*. That's roughly when it starts landing for
everyone else. Every post, bio, README, and reply should be able to collapse back to this
sentence.

## What this campaign is actually for

This is a **reputation play, not a revenue play**. The product is open source the way
WordPress is — free, forkable, owned by whoever runs it. The campaign's job is for
people to know the builder's name, what he can do, and what's possible at this layer.
That changes three things:

- **Voice:** never selling, always showing. "Look what's possible" beats "you should
  use this" in every post.
- **Lead with the origin story.** The builder shipped this product category in 2023
  (LaraLlama: document collections, email ingestion, multi-LLM workflows, deployable
  chatbots — archived 2025) before the platforms made it a category. "I was two years
  early; the models finally caught up to the idea" is the most credible opening
  available — it converts every later post from a pitch into earned insight.
- **The metric is recognition,** not deploys: repo stars, followers, and especially
  inbound — DMs, podcast invites, "can you build this for us." (Visible open-source
  projects are also how acquisitions and partnerships find you; same actions either
  way.)

## Two audiences, one funnel

1. **Builders** (developers, freelancers, agency tech leads) — found on Reddit, Hacker
   News, dev Twitter/X. They can actually deploy it. They are also the *channel* to
   audience 2: every consultant who deploys it installs it at client businesses.
2. **Small-business operators** (agency owners, consultancies, firms) — found on
   LinkedIn and via the Substack. They feel the pain; they won't deploy it themselves.

LinkedIn + Substack speak to operators in pain language. Reddit + HN speak to builders in
architecture language. Same product, two vocabularies — never mix them in one post.

## The narrative arc (the "slowly explain" sequence)

Don't lead with features. Walk the audience through an argument, one claim per week:

| Phase | Weeks | Theme | The claim being taught |
| --- | --- | --- | --- |
| Origin | 1 | "I was two years early" | The LaraLlama story: right idea, 2023 models couldn't deliver it; now they can, so I'm rebuilding in the open. Credibility + narrative in one. |
| Problem | 2 | Scattered knowledge | "Your company's knowledge lives in inboxes and heads. AI can't help with what it can't see." |
| Problem | 3 | Personal AI is a dead end | "Ten employees with ten ChatGPT accounts = zero shared memory, and your data leaks out one paste at a time." |
| Shift | 4 | Shared context | "AI gets useful when it's *yours*: your proposals, your rate card, your voice — for the whole team." |
| Shift | 5 | Ownership & cost | "The whole thing runs on a free-tier Postgres you own. No per-seat fees. RLS, not promises." |
| Proof | 6–9 | One capability per week | PDF RAG → proposal artifacts/share links → webhooks & agents → schedules + MCP. Each shown, not described. |
| Proof | 10 | The day-one story | The full agency walkthrough (from WHY.md) as a 90-second screen recording. |
| Invite | 11–12 | Build in public | Roadmap (model routing to cheaper models, cost numbers), call for deployers, recap. |

Weeks 6–9 are where the earlier abstract claims get cashed in with demos — that ordering
is deliberate. A feature demo *after* the audience has internalized the problem reads as
"finally"; the same demo cold reads as noise.

## The weekly engine

One theme per week. Everything derives from one long-form piece, so the workload is one
real writing session per week (~3–4 hrs) plus assembly:

```
Substack/blog essay (Tue)
   ├── LinkedIn post A (Mon)  — the hook/problem, no link, ends in a question
   ├── LinkedIn post B (Wed)  — the meat: story or demo clip + link to essay
   ├── LinkedIn post C (Fri)  — contrarian take or behind-the-scenes build note
   ├── Reddit post (when it fits — see cadence below, NOT weekly everywhere)
   └── 30–90s screen recording (reused on LinkedIn + Reddit + the essay)
```

### LinkedIn — every 2–3 days (Mon/Wed/Fri)

- **Format:** 150–250 words, first line is the hook (it's all most people see), one idea
  per post, plain text or a short screen recording. No links in post A and C (the
  algorithm punishes them); put the essay link in comments or post B.
- **Voice:** founder learning in public, not vendor. "Here's what I noticed building
  this" outperforms "Announcing."
- **Hooks that fit the arc:** "Your agency has written 200 proposals. Your AI has read
  none of them." / "Every employee with a personal ChatGPT account is a small data
  leak." / "I gave my AI our last 20 proposals. Here's what happened to proposal #21."
- **Engagement floor:** 15 min/day replying to comments and commenting on 3–5 posts from
  agency owners / AI-for-SMB people. Distribution on LinkedIn comes from conversations,
  not broadcasts.

### Substack (or the blog/CMS) — weekly, same day every week

- The long-form home of each week's theme; LinkedIn exists to feed it subscribers.
- Titles are problem-first, not product-first: *"Why your team's ChatGPT use isn't
  compounding"*, *"The proposal that writes itself (because it read the last twenty)"*,
  *"What 'your data, your database' actually means (RLS in plain English)"*.
- Every essay ends with the same two CTAs: subscribe + the GitHub repo. Nothing else.
- Cross-post the weekly essay to dev.to / Hashnode / Medium with a canonical link —
  free reach, zero extra writing.

### Reddit — 1–2 posts/month per community, not weekly

Reddit rewards usefulness and bans drumbeats. Spend week 1–2 only commenting helpfully
in these subs (account credibility matters), then post on this rhythm:

| Subreddit | What works there | When |
| --- | --- | --- |
| r/Supabase | Architecture write-up: edge-function agentic loop, pgvector RAG with free `gte-small` embeddings, RLS as the security boundary | Week 3–4 |
| r/selfhosted | "Self-hosted AI workspace for a small team — own your data" angle, screenshots | Week 5–6 |
| r/SideProject, r/opensource | The build story + repo | Week 6–8 |
| r/smallbusiness, r/agency | **No links.** Answer "how are you using AI?" threads; describe the workflow; share the repo only if asked | Ongoing, comments only |
| r/LocalLLaMA, r/OpenSourceAI | Save for the model-routing release — cost reduction is their language | Week 11+ |
| Hacker News (Show HN) | One shot; fire it when the deploy is one-command smooth and the README demo GIF exists. A weekday morning US time. Stay in the thread all day. | Week 8–10, when polished |

### YouTube — one video per week's theme

The highest-trust format for "know what this person can do," which is the campaign's
actual goal. Two shapes, both derived from the week's theme:

- **Build-alongs / walkthroughs (8–12 min):** the architecture, a feature being built,
  a real workflow end to end. These are the reputation engine — they *prove*
  competence instead of claiming it. Video 1 is the origin story + new-repo tour.
- **Shorts (60–90s):** the week's demo clip, vertical cut. Same recording as the
  LinkedIn/Reddit clip — record once, cut twice.

Don't over-produce: screen recording, optional face cam, captions, honest pacing.
Embed each video in that week's Substack essay and link it from the LinkedIn demo post.

### Demos — the asset that does the heavy lifting

One 90-second screen recording of the WHY.md day-one story: upload 20 proposals → ask
"price this like the Henderson project" → watch it search the PDFs → "make that an
artifact" → flip to Unlisted → client link. **This single video is reused everywhere for
12 weeks.** Record once, well (Loom or OBS, real-ish data, no dead air). Shorter
10–20s clips of individual features feed weeks 6–9.

## What it takes to make it sink in

This is the actual answer to the question, independent of channel mechanics:

1. **One sentence, ~50 repetitions.** People need 7–10 exposures to a new idea before it
   registers, and your reach per post is a fraction of your followers. Twelve weeks of
   the same positioning line in different clothes is the minimum dose. Resist the urge
   to rotate taglines — the boredom you feel at week 6 is the message *starting* to land.
2. **Show, don't claim.** "AI that knows your business" is noise; a 20-second clip of
   the assistant quoting *your own rate card* is the whole pitch. Every abstract claim
   in weeks 1–5 must get a demo payoff in weeks 6–10.
3. **A named villain.** Position against something familiar: the per-seat AI SaaS bill
   and the ten-personal-ChatGPT-accounts mess. People place new things relative to
   things they know.
4. **Dogfood publicly.** Run your own consultancy/projects on it and narrate real
   moments ("my webhook agent triaged 14 leads this week; here's the log"). One true
   story beats ten feature lists — and it becomes your first case study.
5. **One CTA per audience, never more.** Builders → star/deploy the repo. Operators →
   subscribe to the Substack. A confused reader does nothing.
6. **Consistency over intensity.** 3 LinkedIn posts + 1 essay every week for 12 weeks
   beats a launch-week blitz followed by silence. The compounding is the strategy —
   same as the product's pitch, fittingly.
7. **The name.** "✺ Intranet" is hard to repeat, search, or tell a friend about. Before
   week 1, pick a real name + domain; "sinking in" requires a label for the idea to
   stick to.

## Prerequisites (one weekend, before week 1)

- [ ] Name + domain + simple landing page (the WHY.md content, basically) with the
      Substack signup
- [ ] README top: add the 90-second demo GIF/video
- [ ] The "deploy in an afternoon" tutorial tested end-to-end by someone who isn't you —
      this is the flagship builder asset and the HN/Reddit credibility check
- [ ] Record the day-one demo video
- [ ] Write weeks 1–3 in advance (a buffer is what keeps the cadence alive)

## Measuring (weekly, 10 minutes, one spreadsheet row)

GitHub stars · Substack subscribers · LinkedIn followers + best post · YouTube
subscribers + watch time · inbound DMs, "how do I deploy this" questions, and
podcast/collab invites (the reputation metric that matters most). The leading indicator that it's sinking in: **people
describing the product back to you in their own words** — in comments, DMs, or Reddit
threads you didn't start. Optimize for that, not for any single viral post.

## After week 12

The model-routing / cheaper-models release is the natural season 2: it re-opens
r/LocalLLaMA and the cost-conscious crowd, gives the Substack a new arc ("what AI
actually costs a 10-person business"), and converts the price objection — the main one
left — into content.
