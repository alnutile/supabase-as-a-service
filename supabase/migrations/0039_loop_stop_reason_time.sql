-- Loops: allow a 'time' stop reason.
--
-- The `loop` edge function now runs in the background (EdgeRuntime.waitUntil) and
-- self-stops before the platform wall-clock limit (150s free / 400s paid) so a
-- long run finalizes cleanly with the best result so far instead of getting
-- killed mid-flight and stuck on status='running'. That graceful stop records
-- stop_reason='time', so widen the check constraint to accept it.

alter table public.loop_runs drop constraint if exists loop_runs_stop_reason_check;
alter table public.loop_runs add constraint loop_runs_stop_reason_check
  check (stop_reason in ('budget', 'max_iterations', 'converged', 'target_reached', 'time', 'error'));
