-- Teardown jobs ride the same queue/worker as provisioning: a job now carries a
-- `kind`, and the worker branches on it. The claim RPC is kind-agnostic.

alter table public.provisioning_jobs
  add column if not exists kind text not null default 'provision'
    check (kind in ('provision', 'teardown'));
