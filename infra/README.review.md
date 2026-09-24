# Local Docker review

The frontend runs at http://localhost:5180. The Supabase CLI runs the database,
auth, storage and edge runtime in Docker on the usual local ports (API: 54321).
The database persists in Docker volumes.

Start the backend and apply local grants needed by the older migrations:

```sh
supabase start
docker exec -i supabase_db_intranet psql -U postgres -v ON_ERROR_STOP=1 < infra/local-review-grants.sql
supabase functions serve
```

In another terminal, put the local API URL and anon key from `supabase status`
into `infra/.env.review` (ignored by Git):

```dotenv
VITE_SUPABASE_URL=http://127.0.0.1:54321
VITE_SUPABASE_ANON_KEY=<local anon key>
```

```sh
docker compose --env-file infra/.env.review -f infra/docker-compose.review.yml -p supanet-review up -d --build
```

Sign up for the first local account to become the local admin. The current review
instance already has a review account and a **GitHub Review** collection containing
an imported snapshot of `expressjs/express`, folder `lib`.

Repository import/refresh and Secrets management work without a model key. AI
replies require `OPENROUTER_API_KEY` in a local ignored env file passed to
`supabase functions serve --env-file <file>`. This review instance has no model key.

To stop the frontend, use the same compose command with `stop` instead of
`up -d --build`. To stop the backend without deleting its data, use `supabase stop`.
