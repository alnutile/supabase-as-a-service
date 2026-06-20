## TODO

### Imagegen and openrouter

### Reindex Function

### Chat with "Files"

### Make Collections of Files to chat with
Create a chat and upload files is a start to this but can not get back there and keep chatting


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


### Sha code in the footer
So we know the released version


### Edge Function Web Parser


### Ui for the event system
Then we can connect these edge functions to the events



### Examples
You can vibe code and deploy these functions.

Edge Function Calc
Edge Function PDF Parser OCR before AI
Edge Function HTML to Markdown parser - more simple pages work here 

They become APIs or steps in a more complex process.

Here is a common one I use.

Opt-out email comes in 
Then the system uses ai to parse the data out of it - non-deterministic unstructured to structured
Then those results are deterministic results that get sent to the edge function that will save them to the database (yes we could just write the db)



### Testing Functions

```
curl -X POST 'https://pcyvmpjrszgatwvmyxbg.supabase.co/functions/v1/webhook/ebf93410-3913-416b-a931-a82e28fa2015' \
  -H 'Content-Type: application/json' \
  -d '{"expression":"2 + 2 * 10"}'

```