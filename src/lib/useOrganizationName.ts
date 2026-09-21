import { useEffect, useState } from 'react'
import { supabase } from './supabase'

// The workspace's organization name (`workspace_settings.organization_name`,
// migration 0125), shared by every surface that shows it — the home page
// heading and the browser tab title. Subscribes to the realtime publication
// (0092) so an admin renaming the workspace in Settings → Organization updates
// every open tab without a reload. Empty string = not set.
export function useOrganizationName(): string {
  const [orgName, setOrgName] = useState('')

  useEffect(() => {
    let active = true
    const load = () =>
      supabase
        .from('workspace_settings')
        .select('value')
        .eq('key', 'organization_name')
        .maybeSingle()
        .then(({ data }) => {
          if (active) setOrgName(data?.value?.trim() || '')
        })
    load()
    const channel = supabase
      .channel('workspace-organization-name')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'workspace_settings' },
        load,
      )
      .subscribe()
    return () => {
      active = false
      supabase.removeChannel(channel)
    }
  }, [])

  return orgName
}
