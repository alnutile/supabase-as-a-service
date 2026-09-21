import { useEffect, useState } from 'react'
import { supabase } from './supabase'

// The workspace's organization name (`workspace_settings.organization_name`,
// migration 0125), shared by every surface that shows it — the home page
// heading and the browser tab title.
//
// This is ONE subscription for the whole app, not one per component. An earlier
// cut created a channel inside the hook's effect, so mounting the hook twice
// (Layout + HomePage) asked supabase-js for the same topic twice — it hands back
// the channel it already has, and `.on()` on an already-subscribed channel
// THROWS ("cannot add postgres_changes callbacks ... after subscribe()"),
// which crashed the render tree into a blank page. Hence the module-level
// store: consumers are refcounted listeners, and the channel is created with
// the first one and removed with the last.

const SETTING_KEY = 'organization_name'
const CHANNEL = 'workspace-organization-name'

let cached = ''
const listeners = new Set<(value: string) => void>()
let channel: ReturnType<typeof supabase.channel> | null = null

function load() {
  return supabase
    .from('workspace_settings')
    .select('value')
    .eq('key', SETTING_KEY)
    .maybeSingle()
    .then(({ data }) => {
      cached = data?.value?.trim() || ''
      for (const listener of listeners) listener(cached)
    })
}

function subscribe(listener: (value: string) => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) {
    // First consumer: fetch once and open the single realtime channel, so an
    // admin renaming the workspace re-titles every open tab without a reload.
    load()
    channel = supabase
      .channel(CHANNEL)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'workspace_settings' },
        () => {
          load()
        },
      )
      .subscribe()
  } else {
    // Later consumers render the value we already have; the channel keeps it fresh.
    listener(cached)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && channel) {
      supabase.removeChannel(channel)
      channel = null
    }
  }
}

export function useOrganizationName(): string {
  const [orgName, setOrgName] = useState(cached)
  useEffect(() => subscribe(setOrgName), [])
  return orgName
}
