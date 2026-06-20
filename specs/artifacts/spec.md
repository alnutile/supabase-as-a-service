Here is a comprehensive specification document formatted specifically for an LLM coding assistant (like Claude, Cursor, or ChatGPT). It provides the exact context, architecture, and step-by-step requirements needed to generate the working code without hallucinating the wrong Supabase or Deno APIs.
You can copy and paste everything inside the blockquote below directly into your AI tool of choice.
> **System Context & Goal**
> I am building an open-source project called supabase-as-a-service. A core feature allows an AI to generate ("vibe-code") a Vite-based Single Page Application (SPA), push the compiled build to a Supabase Storage Bucket, and serve that SPA globally using a single Supabase Edge Function acting as a proxy router.
> Your task is to write the complete, production-ready code for this proof-of-concept.
> **Architecture Overview**
>  1. **Storage:** A Supabase Storage bucket named hosted_spas holds the compiled Vite assets (HTML, JS, CSS). Assets are stored in subfolders representing app IDs (e.g., hosted_spas/app_123/index.html).
>  2. **Edge Function (spa-router):** A Deno-based Supabase Edge Function that acts as a wildcard web server. It catches all requests, extracts the app_id and the requested file path from the URL, fetches the raw file from the hosted_spas bucket, and returns it with the correct HTTP Content-Type headers.
>  3. **Database & RLS:** A simple leads table that the hosted SPA will write to directly from the browser using the Supabase anon key.
>  4. **The Client App:** A minimal Vite SPA (Vanilla JS or React) that contains a simple lead-capture form.
> **Requirement 1: Database & Storage Migration (SQL)**
> Write the exact PostgreSQL SQL script to:
>  * Create a private storage bucket called hosted_spas.
>  * Create a table called leads with columns: id (uuid, pk), app_id (text), email (text), message (text), and created_at (timestamp).
>  * Enable Row Level Security (RLS) on the leads table.
>  * Create a policy that allows anon users to INSERT rows, but not SELECT, UPDATE, or DELETE.
> **Requirement 2: The Edge Function Proxy (supabase/functions/spa-router/index.ts)**
> Write the Deno code for the Supabase Edge Function.
>  * **Framework:** Use the standard Deno.serve.
>  * **Client:** Initialize the @supabase/supabase-js client using the environment variables SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (since the storage bucket is private, the function needs service role privileges to read the files).
>  * **Routing Logic:**
>    * Assume the URL structure is https://<project>.supabase.co/functions/v1/spa-router/<app_id>/<file_path>.
>    * Extract the <app_id> and <file_path>.
>    * If <file_path> is empty or does not contain a file extension, default it to index.html (SPA fallback routing).
>  * **Storage Fetch:** Use supabase.storage.from('hosted_spas').download(full_path) to get the file blob.
>  * **Headers:** Map the file extensions (.html, .js, .css, .svg, etc.) to their proper Content-Type headers.
>  * **Error Handling:** Return a proper 404 response if the file does not exist in the bucket.
> **Requirement 3: The Generated Vite App (Client)**
> Write a minimal example of the Vite application that an AI might generate.
>  * Provide the index.html and main.js.
>  * The app should contain a basic form (Email, Message, Submit).
>  * On submit, it should use @supabase/supabase-js to insert a row into the leads table.
>  * Assume SUPABASE_URL and SUPABASE_ANON_KEY are injected globally (e.g., via window.env or standard Vite env variables).
> **Requirement 4: The Deployment Script (Node.js)**
> Write a short Node.js script (deploy.js) simulating the platform backend.
>  * It should take a local directory path (e.g., ./dist) and an app_id.
>  * It should recursively read the files in the directory and use the @supabase/supabase-js client (with the Service Role key) to upload them to the hosted_spas/<app_id>/ path in the bucket.
> Please output the code clearly separated by filenames and provide brief comments explaining the tricky parts (like the Deno content-type mapping and SPA fallback logic).
> 
### A quick tip for the handoff:
Depending on which AI you are using (Claude 3.5 Sonnet is highly recommended for Deno/Supabase work), it might try to give you old Deno standard library imports (like https://deno.land/std/http/server.ts). The prompt explicitly asks it to use the modern, built-in Deno.serve API, which will keep your edge function fast and free of unnecessary dependencies.
