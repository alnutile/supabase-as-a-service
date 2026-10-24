// Supabase Edge Function: `artifact-image` (PUBLIC — verify_jwt=false).
// Proxies artifact images with access control based on the linked artifact's
// current visibility. This solves the "artifact becomes private" problem:
// instead of baking long-lived signed URLs into markdown (which remain valid
// even when un-sharing), we store proxy URLs that check visibility on each request.
//
// Flow:
//   1. Client requests /functions/v1/artifact-image/<owner>/<uuid>/<filename>
//   2. We look up the image's artifact_id from storage metadata
//   3. We check the artifact's current visibility
//   4. If public/unlisted: serve to anyone
//   5. If private: serve only to the authenticated owner
//   6. Return the image bytes with appropriate caching headers
//
// URLs in markdown look like: ![](https://.../functions/v1/artifact-image/...)
// and automatically respect the artifact's current visibility.

import { createClient } from 'npm:@supabase/supabase-js@2.45.4'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS })
  }

  if (req.method !== 'GET') {
    return new Response('Method not allowed', { status: 405, headers: CORS })
  }

  try {
    // Parse the path: /artifact-image/<owner>/<uuid>/<filename>
    const url = new URL(req.url)
    const pathParts = url.pathname.split('/').filter(Boolean)

    // Expect at least 4 parts: ["artifact-image", owner, uuid, filename]
    if (pathParts.length < 4) {
      return new Response('Not found', { status: 404, headers: CORS })
    }

    // Remove "artifact-image" prefix if present (it might be in the path)
    const startIdx = pathParts.indexOf('artifact-image') + 1
    const [owner, uuid, ...filenameParts] = pathParts.slice(startIdx)
    const filename = filenameParts.join('/')

    if (!owner || !uuid || !filename) {
      return new Response('Not found', { status: 404, headers: CORS })
    }

    const storagePath = `${owner}/${uuid}/${filename}`

    // Use service role to read the image metadata (which includes artifact_id)
    const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

    // Get the storage object metadata
    const { data: objectData, error: objectError } = await serviceClient
      .storage
      .from('artifact-images')
      .list(owner + '/' + uuid, {
        limit: 100,
        search: filename
      })

    if (objectError || !objectData || objectData.length === 0) {
      return new Response('Not found', { status: 404, headers: CORS })
    }

    // Get the artifact_id from metadata
    const object = objectData[0]
    const artifactId = object.metadata?.artifact_id

    if (!artifactId) {
      // No artifact_id means this image isn't properly linked
      return new Response('Not found', { status: 404, headers: CORS })
    }

    // Check the artifact's visibility using anon client (respects RLS)
    const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    const { data: artifact, error: artifactError } = await anonClient
      .from('artifacts')
      .select('id, visibility, owner_id, deleted_at')
      .eq('id', artifactId)
      .is('deleted_at', null)
      .single()

    if (artifactError || !artifact) {
      // Artifact not found or not accessible through anonymous RLS
      // This means it's either deleted or private

      // Check if the requester is the owner (authenticated)
      const authHeader = req.headers.get('authorization')
      if (!authHeader) {
        return new Response('Not found', { status: 404, headers: CORS })
      }

      // Create user client with their JWT
      const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: authHeader } }
      })

      const { data: { user } } = await userClient.auth.getUser()
      if (!user) {
        return new Response('Not found', { status: 404, headers: CORS })
      }

      // Check if this is a private artifact owned by this user
      const { data: privateArtifact } = await serviceClient
        .from('artifacts')
        .select('id, owner_id, deleted_at')
        .eq('id', artifactId)
        .eq('owner_id', user.id)
        .is('deleted_at', null)
        .single()

      if (!privateArtifact) {
        return new Response('Not found', { status: 404, headers: CORS })
      }

      // Owner can access their own private artifact's images
    } else if (artifact.visibility === 'private') {
      // Shouldn't happen (anon client shouldn't see private artifacts)
      // but handle it just in case
      return new Response('Not found', { status: 404, headers: CORS })
    }

    // If we got here, access is allowed. Download and serve the image.
    const { data: imageData, error: downloadError } = await serviceClient
      .storage
      .from('artifact-images')
      .download(storagePath)

    if (downloadError || !imageData) {
      return new Response('Not found', { status: 404, headers: CORS })
    }

    // Determine content type from filename
    const contentType = getContentType(filename)

    // Serve the image with caching headers
    // Cache for 1 hour (short enough that visibility changes take effect relatively quickly)
    return new Response(imageData, {
      headers: {
        ...CORS,
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=3600',
      },
    })
  } catch (error) {
    console.error('Error serving artifact image:', error)
    return new Response('Internal server error', { status: 500, headers: CORS })
  }
})

function getContentType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'png':
      return 'image/png'
    case 'gif':
      return 'image/gif'
    case 'webp':
      return 'image/webp'
    case 'svg':
      return 'image/svg+xml'
    default:
      return 'application/octet-stream'
  }
}
