-- "Think" mode: an always-on prompt teaching the assistant to answer FROM the
-- knowledge base with citations and explicit gap/staleness analysis, rather than
-- returning raw chunks or quietly filling gaps from its own training. This is the
-- gbrain "think vs search" idea — synthesis that says what it knows, cites the
-- source document, and is honest about what the brain does NOT contain.
--
-- Pairs with the retrieval changes: search_documents now labels each passage with
-- its document name + recency (updated YYYY-MM) and, on no match, returns an
-- explicit "nothing indexed on this topic" signal. This prompt tells the model what
-- to DO with that. Same seed shape as the 0069 "User memory" always-on skill:
-- workspace-wide (auto_apply), built-in, reply mode.

insert into public.skills (owner_id, name, description, instructions, auto_apply, is_builtin, output_mode)
select
  (select id from public.profiles order by created_at asc limit 1),
  'Grounded answers',
  'Built-in. Teaches the assistant to answer from the knowledge base with citations and honest gap/staleness analysis (cite sources, say what the brain does not contain).',
  $prompt$GROUNDED ANSWERS (knowledge base)

When a question is about the team's own documents, files, people, processes, or anything specific to this workspace, answer FROM the knowledge base — call search_documents first, then synthesize. Do not answer such questions from general training alone.

Cite your sources:
- Each retrieved passage is labeled with its source document (and, when known, "updated YYYY-MM"). Attribute claims to the document they came from, e.g. "per the LiveRamp Measurement guide…".
- When several documents agree or conflict, say so.

Be honest about gaps (this is the point of a brain you can trust):
- If search_documents returns "nothing indexed on this topic", say plainly that the knowledge base has nothing on it — do NOT invent an answer or quietly substitute general knowledge. Offer to look elsewhere or suggest what to add.
- If the only sources are old (check the "updated" date against the question), flag the staleness: "the most recent thing indexed on this is from <date>, so it may be out of date."
- If the retrieved passages only partially answer the question, answer what they support and name what's missing.

Keep it synthesized, not a chunk dump: give the answer in your own words with citations, not a wall of pasted passages. If you did use general knowledge to fill a small gap, mark that part as not from the knowledge base.$prompt$,
  true,
  true,
  'reply'
where not exists (select 1 from public.skills where name = 'Grounded answers' and is_builtin = true);
