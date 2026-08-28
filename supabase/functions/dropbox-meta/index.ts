// Fetch Dropbox file metadata using the workspace's configured access token.
// Called by the Links UI when adding a Dropbox URL and by the save_link builtin
// when the assistant/agents save a Dropbox link.
//
// Auth: verify_jwt: true (any workspace member can use this if Dropbox is
// configured). The access token is read server-side via the service-role-only
// read_dropbox_secret RPC.

import { createClient } from 'jsr:@supabase/supabase-js@2'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS })
  }

  const supabaseClient = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  )

  try {
    // Verify the user is authenticated
    const authHeader = req.headers.get('authorization')
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing authorization header' }), {
        status: 401,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      })
    }

    const token = authHeader.replace('Bearer ', '')
    const { data: { user }, error: authError } = await supabaseClient.auth.getUser(token)
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      })
    }

    const { url } = await req.json()
    if (!url || typeof url !== 'string') {
      return new Response(JSON.stringify({ error: 'url is required' }), {
        status: 400,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      })
    }

    // Read the Dropbox access token from Vault
    const { data: accessToken, error: secretError } = await supabaseClient.rpc('read_dropbox_secret')
    if (secretError || !accessToken) {
      return new Response(JSON.stringify({ error: 'Dropbox is not configured' }), {
        status: 503,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      })
    }

    // Extract the path from the Dropbox URL
    const path = extractDropboxPath(url)
    if (!path) {
      return new Response(JSON.stringify({ error: 'Invalid Dropbox URL' }), {
        status: 400,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      })
    }

    // Fetch metadata from Dropbox API
    const metadata = await fetchDropboxMetadata(accessToken, path)

    return new Response(JSON.stringify(metadata), {
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    })
  } catch (error) {
    console.error('Dropbox metadata fetch error:', error)
    return new Response(JSON.stringify({ error: error.message || 'Failed to fetch Dropbox metadata' }), {
      status: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    })
  }
})

// Extract the file path from various Dropbox URL formats:
// - https://www.dropbox.com/s/abc123/filename.pdf
// - https://www.dropbox.com/home/folder/file.txt
// - https://www.dropbox.com/scl/fi/xyz/file.pdf?rlkey=...
function extractDropboxPath(url: string): string | null {
  try {
    const u = new URL(url)
    if (!u.hostname.includes('dropbox.com')) return null

    // Shared link format: /s/...
    if (u.pathname.startsWith('/s/')) {
      // For shared links, we need to use get_shared_link_metadata instead
      return url
    }

    // Home format: /home/...
    if (u.pathname.startsWith('/home/')) {
      return u.pathname.replace('/home', '')
    }

    // File request format: /scl/fi/...
    if (u.pathname.startsWith('/scl/')) {
      // These are also shared links
      return url
    }

    // Default: use the pathname
    return u.pathname
  } catch {
    return null
  }
}

async function fetchDropboxMetadata(accessToken: string, pathOrUrl: string) {
  // Determine if this is a shared link or a direct path
  const isSharedLink = pathOrUrl.startsWith('http')

  if (isSharedLink) {
    // Use the shared link metadata endpoint
    const response = await fetch('https://api.dropboxapi.com/2/sharing/get_shared_link_metadata', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url: pathOrUrl }),
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Dropbox API error: ${error}`)
    }

    const data = await response.json()

    // Get a thumbnail if it's an image
    let thumbnail = null
    if (data['.tag'] === 'file' && data.name.match(/\.(jpg|jpeg|png|gif|bmp)$/i)) {
      thumbnail = await getSharedLinkThumbnail(accessToken, pathOrUrl)
    }

    return {
      title: data.name || 'Dropbox File',
      description: `Dropbox file: ${data.path_display || data.name}`,
      image_url: thumbnail,
      favicon_url: 'https://cfl.dropboxstatic.com/static/images/favicon-vflUeLeeY.ico',
      file_type: data['.tag'],
      size: data.size,
      modified: data.server_modified,
    }
  } else {
    // Use the regular metadata endpoint for direct paths
    const response = await fetch('https://api.dropboxapi.com/2/files/get_metadata', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ path: pathOrUrl }),
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Dropbox API error: ${error}`)
    }

    const data = await response.json()

    // Get a thumbnail if it's an image
    let thumbnail = null
    if (data['.tag'] === 'file' && data.name.match(/\.(jpg|jpeg|png|gif|bmp)$/i)) {
      thumbnail = await getThumbnail(accessToken, pathOrUrl)
    }

    return {
      title: data.name || 'Dropbox File',
      description: `Dropbox file: ${data.path_display || data.name}`,
      image_url: thumbnail,
      favicon_url: 'https://cfl.dropboxstatic.com/static/images/favicon-vflUeLeeY.ico',
      file_type: data['.tag'],
      size: data.size,
      modified: data.server_modified,
    }
  }
}

async function getThumbnail(accessToken: string, path: string): Promise<string | null> {
  try {
    const response = await fetch('https://content.dropboxapi.com/2/files/get_thumbnail_v2', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Dropbox-API-Arg': JSON.stringify({
          resource: { '.tag': 'path', path },
          format: 'jpeg',
          size: 'w256h256',
        }),
      },
    })

    if (!response.ok) return null

    const blob = await response.blob()
    const arrayBuffer = await blob.arrayBuffer()
    const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)))
    return `data:image/jpeg;base64,${base64}`
  } catch {
    return null
  }
}

async function getSharedLinkThumbnail(accessToken: string, url: string): Promise<string | null> {
  try {
    const response = await fetch('https://content.dropboxapi.com/2/files/get_thumbnail_v2', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Dropbox-API-Arg': JSON.stringify({
          resource: { '.tag': 'link', url },
          format: 'jpeg',
          size: 'w256h256',
        }),
      },
    })

    if (!response.ok) return null

    const blob = await response.blob()
    const arrayBuffer = await blob.arrayBuffer()
    const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)))
    return `data:image/jpeg;base64,${base64}`
  } catch {
    return null
  }
}
