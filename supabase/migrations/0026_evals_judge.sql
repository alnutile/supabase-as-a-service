-- Evals Phase 2: judge-graded task quality (Promptfoo-style).
--
-- Phase 1 scored retrieval deterministically. This adds the piece that scores
-- open-ended answers: a case carries an `expected` reference answer ("a
-- reasonable result"), the suite carries a `rubric` (how to grade), and a
-- `chat`/`agent` run actually answers each question through the real
-- orchestrator, then a judge model compares the answer to the reference + rubric
-- and returns pass/score/reason. The verdict is enforced in code, never fed back
-- into the orchestrator — same trust model as guardrails.

-- The reference answer for a case (the "reasonable result" to grade against).
alter table public.eval_cases
  add column expected text;

-- Suite-level grading guidance for the judge, and an optional judge-model
-- override (an OpenRouter slug). When judge_model is null the judge uses the
-- `utility` model profile — cheap, like the guardrail evaluator.
alter table public.eval_suites
  add column rubric text not null default '',
  add column judge_model text;
