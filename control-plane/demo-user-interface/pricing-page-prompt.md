# Prompt: SupaNet pricing section / page

Design a **pricing section** for supanet.io (works standalone as /pricing or as a
landing-page section). Self-contained HTML, all assets inlined, responsive,
matching the existing SupaNet landing conventions.

## Brand (use exactly)

- **Fonts (Google):** Schibsted Grotesk 400/500/600/700 for headings + body;
  JetBrains Mono 400/500 ONLY for uppercase mono eyebrows/chips (e.g.
  `02 — SIMPLE PRICING`).
- **Surfaces:** page `#FBFBF9`, panel `#F6F7F4`, band `#F3F5F0`, border `#E6E8E2`.
- **Text:** ink `#11221C`, muted `#5B665F`, faint `#8A938C`.
- **Greens:** primary `#15795B` (buttons/links/accents), bright `#3ECF8E`
  (dots/highlights/CTA-on-dark), deep `#0E1F18` (dark bands).
- **Tints:** mint fill `#EAF7F0`, mint border `#C7E7D6`, on-dark green `#7FD7AA`,
  on-dark text `#EAF2EE`. Selection: `#C7EFD9` bg / `#0E1F18` text.
- Tone: warm, plain-spoken, confident. No SaaS clichés, no exclamation points.

## What SupaNet is (context for copy)

Your company's shared AI hub: an AI assistant that knows the team's documents,
shares its knowledge with everyone, and remembers — plus shareable docs, to-dos,
data tables, files, and automations. Built on Supabase and open source. The
buyer is a 5–50 person services business (agency, consultancy, law/accounting,
trades) tired of per-seat AI tools with no shared memory.

## The section

Eyebrow: `SIMPLE PRICING`. Headline theme: **one flat price per workspace —
never per seat**. Subline: your whole team, one price; the AI gets smarter with
every doc you add, not more expensive with every person you add.

### Three columns (middle featured)

1. **Self-host — Free, open source**
   - The whole product, MIT-style open. Run it on your own Supabase + hosting.
   - For teams with a developer on hand.
   - Bullets: full feature set · your infrastructure · community support.
   - CTA (secondary/outline): "View on GitHub".

2. **SupaNet Cloud — $79/month per workspace** ⭐ featured (mint fill panel,
   primary-green CTA, "Most popular" chip)
   - Everything set up for you in minutes — no servers, no keys, no setup.
   - Bullets: unlimited teammates, one flat price · your own private database
     (a dedicated Supabase project — never shared) · your address:
     `you.supanet.io` · AI assistant with shared team knowledge, fair-use AI
     included · docs, to-dos, tables, files, agents & automations · automatic
     updates · cancel anytime.
   - CTA (primary): **"Start your workspace →"** linking to
     `https://start.supanet.io` — note under button: "Live in about 5 minutes."

3. **Dedicated — Let's talk**
   - For teams that want a custom domain, isolated infrastructure, priority
     support, or a migration of an existing workspace.
   - CTA (secondary): "Contact us".

### The trust band (dark `#0E1F18` strip below the columns)

The eject promise, verbatim spirit: **"Leave whenever you want and take
everything — it was always yours."** Every Cloud workspace is a real, standalone
deployment on its own database; if you ever leave, we transfer the whole project
to you and hand you the open-source repo. No export files, no lock-in — it's
your infrastructure from day one. (Use on-dark text `#EAF2EE` + on-dark green
`#7FD7AA` mono eyebrow like `NO LOCK-IN`.)

### Small FAQ (3–5 items, accordion or simple stacked)

- *Is it really not per seat?* Yes — invite your whole company; $79 covers the
  workspace.
- *What does "fair-use AI included" mean?* A generous monthly allowance of AI
  usage is included; heavy automation users can add usage or bring their own
  model key.
- *Where does our data live?* In your own dedicated database (a private
  Supabase project created just for you) — never mixed with other customers.
- *Can we cancel?* Anytime, from your billing portal; your workspace pauses at
  the end of the period and you can take everything with you.
- *What if we already self-host?* Keep going — it's the same open-source
  product; Cloud is just the "we run it for you" version.

## Constraints

- Every "Start your workspace" CTA points to `https://start.supanet.io`.
- Price displays as `$79` with `/month per workspace` in muted text; add a
  small `Test mode — launch pricing` chip only if a flag is set (omit by
  default).
- No fake logos, testimonials, or invented stats. No countdown timers.
- Semantic HTML, keyboard-accessible accordion, visible focus states, WCAG AA
  contrast on all text (the greens above pass on their listed surfaces).
- Mobile: columns stack, featured card first.
