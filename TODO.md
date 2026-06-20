## TODO

### Review the status of Edge functions

```
Two things to know before deploying
I couldn't typecheck the edge functions — Deno isn't installed locally, and the app's tsc/eslint skip supabase/functions. I reviewed them by hand; the real check is supabase functions deploy chat webhook scheduler (or deno check).
gen:types not run — it needs a linked project, but provider is already typed as string, so the build stays green without it. Run it after applying the migration if you want to be thorough.
```

### Prompts that get passed in the chat 
Business prompts
Personal Prompts


### Manage Supabase vault in the UI