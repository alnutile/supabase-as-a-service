// Renders the real Terminology page on the in-memory backend, with no Supabase
// in the loop. This is the proof that the page only depends on the data layer,
// which is what lets the local (SQLite) build reuse it unchanged.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setBackend } from '../lib/data'
import { createMemoryBackend, LOCAL_USER_ID } from '../lib/data/memory'
import type { Backend } from '../lib/data'
import TerminologyPage from './TerminologyPage'

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: '00000000-0000-0000-0000-000000000001' } }),
}))

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/terminology']}>
      <Routes>
        <Route path="/terminology" element={<TerminologyPage />} />
        <Route path="/terminology/:termId" element={<TerminologyPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

const now = '2026-01-01T00:00:00Z'

describe('TerminologyPage on the memory backend', () => {
  let backend: Backend

  beforeEach(() => {
    backend = createMemoryBackend({
      terms: [
        {
          id: 't1',
          owner_id: LOCAL_USER_ID,
          term: 'RAG',
          definition: 'Retrieval augmented generation',
          notes: '',
          source: {},
          visibility: 'private',
          created_at: now,
          updated_at: now,
        },
      ],
    })
    setBackend(backend)
  })

  afterEach(() => cleanup())

  it('lists terms from the backend', async () => {
    renderPage()
    expect(await screen.findByText('RAG')).toBeTruthy()
    expect(screen.getByText('Retrieval augmented generation')).toBeTruthy()
  })

  it('adds a term through the data layer', async () => {
    renderPage()
    await screen.findByText('RAG')
    fireEvent.change(screen.getByPlaceholderText('Term...'), { target: { value: 'FTS5' } })
    fireEvent.change(screen.getByPlaceholderText('Definition...'), { target: { value: 'SQLite full-text search' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /add/i }))
    })
    expect(await screen.findByText('FTS5')).toBeTruthy()
    await waitFor(async () => {
      expect((await backend.terminology.list()).map((t) => t.term)).toEqual(['FTS5', 'RAG'])
    })
  })
})
