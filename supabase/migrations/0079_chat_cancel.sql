-- Background-persisted chat replies. The `chat` edge function now finishes the
-- model run and writes the assistant message SERVER-SIDE inside an
-- EdgeRuntime.waitUntil background task (same pattern as slack-events / loop /
-- evals). Before this, the assistant reply was only written by the browser
-- after the SSE stream fully drained (ChatPage.submit → insertMessage), so
-- reloading the page or navigating away mid-reply tore down the fetch and lost
-- the reply. Now the run completes off-request and the reply lands in the DB;
-- the client's existing Realtime subscription (or simply remounting the page)
-- surfaces it.
--
-- The Stop button must still TRULY cancel such a run. A dropped SSE connection
-- looks identical to the server whether the user navigated away (→ keep going,
-- persist) or hit Stop (→ halt, save nothing) — so Stop writes a per-run marker
-- here that the background task checks between tool turns and again right before
-- it persists. If the marker matches the run in flight, the task stops and saves
-- nothing.
--
-- Scoped by run id (a uuid the client mints per send) so a stale value left over
-- from a previous, already-finished run can never cancel the next one — the task
-- only honors the marker when it equals the current run's id. Any thread
-- participant may set it: the existing "Members update shared conversations"
-- policy (migration 0053) already allows owner-or-member UPDATEs, so a member
-- who summoned @ai can stop the reply too. The task reads it with the service
-- role, so no extra grant is needed.

alter table public.conversations
  add column if not exists cancel_requested_run text;
