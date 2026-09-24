import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CollectionRepositories } from './CollectionRepositories'

const invoke = vi.fn()
let rows: Record<string, unknown>[] = []
let secrets: Record<string, unknown>[] = []
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'owner' } }) }))
vi.mock('../lib/supabase', () => ({ supabase: {
  functions: { invoke: (...args: unknown[]) => invoke(...args) },
  from: (table: string) => {
    const builder = { select: () => builder, eq: () => builder, order: () => Promise.resolve({ data: table === 'collection_repositories' ? rows : secrets, error: null }) }
    return builder
  },
} }))
beforeEach(() => { rows = []; secrets = []; invoke.mockReset() })
afterEach(cleanup)
it('shared collection readers see snapshot provenance without management controls', async () => {
  rows = [{ id: 'r', repository: 'org/app', branch: 'main', status: 'error', file_count: 3, omitted_count: 4, synced_at: '2026-09-24T12:00:00Z', commit_sha: 'abc12345', error: 'GitHub unavailable' }]
  render(<MemoryRouter><CollectionRepositories collectionId="c" isOwner={false} shared /></MemoryRouter>)
  await screen.findByText('org/app')
  expect(screen.queryByText('Connect repository')).toBeNull()
  expect(screen.getByText(/previous snapshot is still available/)).toBeTruthy()
  expect(screen.getByText(/abc12345/)).toBeTruthy()
})
it('connect sends collection, folder, branch and connection through the authenticated function', async () => {
  invoke.mockResolvedValue({ data: { status: 'syncing' }, error: null })
  render(<MemoryRouter><CollectionRepositories collectionId="c" isOwner shared /></MemoryRouter>)
  fireEvent.click(screen.getByText('Connect repository'))
  fireEvent.change(screen.getByLabelText('Repository'), { target: { value: 'org/app' } })
  fireEvent.change(screen.getByLabelText('Branch (optional)'), { target: { value: 'develop' } })
  fireEvent.change(screen.getByLabelText('Folder (optional)'), { target: { value: 'api' } })
  fireEvent.click(screen.getByText('Connect and import'))
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('github-repositories', { body: { action: 'add', collection_id: 'c', repository: 'org/app', branch: 'develop', path_prefix: 'api', vault_secret_id: '' } }))
})
it('selects existing Secrets and hides other owners private credentials', async () => {
  secrets = [
    { id: 'team', name: 'github-team', scope: 'workspace', owner_id: 'other' },
    { id: 'mine', name: 'github-personal', scope: 'private', owner_id: 'owner' },
    { id: 'hidden', name: 'other-private', scope: 'private', owner_id: 'other' },
  ]
  render(<MemoryRouter><CollectionRepositories collectionId="c" isOwner shared={false} /></MemoryRouter>)
  fireEvent.click(screen.getByText('Connect repository'))
  await screen.findByRole('option', { name: 'github-team' })
  expect(screen.getByRole('option', { name: 'github-personal' })).toBeTruthy()
  expect(screen.queryByRole('option', { name: 'other-private' })).toBeNull()
  expect(screen.getByRole('link', { name: 'Secrets' }).getAttribute('href')).toBe('/vault')
  expect(screen.queryByLabelText('GitHub token')).toBeNull()
})
