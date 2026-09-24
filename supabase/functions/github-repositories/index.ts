import { createClient } from 'jsr:@supabase/supabase-js@2'
import { handleRepositoryRequest } from './handler.ts'

Deno.serve(req => handleRepositoryRequest(req, createClient(
  Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
)))
