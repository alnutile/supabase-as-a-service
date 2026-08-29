import { afterEach, describe, expect, it } from 'vitest'
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { CollectionPicker, CollectionTokens } from './CollectionPicker'

const COLLECTIONS = [
  { id: 'a', name: 'SupaNet' },
  { id: 'b', name: 'Sponsors' },
  { id: 'c', name: 'Empty Bucket' },
]
const COUNTS = { a: 45, b: 66, c: 0 }

// Drives the picker the way a page does, so a click actually changes selection.
function Harness({ mode = 'multi' as 'single' | 'multi' }) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  return (
    <>
      <CollectionPicker
        collections={COLLECTIONS}
        selected={selected}
        onChange={setSelected}
        counts={COUNTS}
        mode={mode}
      />
      <CollectionTokens collections={COLLECTIONS} selected={selected} onChange={setSelected} counts={COUNTS} />
    </>
  )
}

// The trigger is the only element that owns the popover, so aria-expanded
// identifies it unambiguously even while the list below is open.
function trigger(): HTMLElement {
  return document.querySelector('[aria-expanded]') as HTMLElement
}

function openPopover() {
  fireEvent.click(trigger())
}

// Testing Library's auto-cleanup only runs with vitest `globals: true`; this
// project keeps globals off, so unmount between tests by hand.
afterEach(cleanup)

describe('CollectionPicker', () => {
  it('renders nothing when the workspace has no collections', () => {
    const { container } = render(
      <CollectionPicker collections={[]} selected={new Set()} onChange={() => {}} />,
    )
    expect(container.innerHTML).toBe('')
  })

  it('hides empty collections behind the "Show empty" toggle', () => {
    render(<Harness />)
    openPopover()
    expect(screen.queryByText('Empty Bucket')).toBeNull()
    fireEvent.click(screen.getByText(/Show empty \(1\)/))
    expect(screen.getByText('Empty Bucket')).toBeTruthy()
  })

  it('filters the list by name', () => {
    render(<Harness />)
    openPopover()
    fireEvent.change(screen.getByPlaceholderText('Filter collections…'), { target: { value: 'spon' } })
    expect(screen.getByText('Sponsors')).toBeTruthy()
    expect(screen.queryByText('SupaNet')).toBeNull()
  })

  it('accumulates picks in multi mode and names a single one on the trigger', () => {
    render(<Harness />)
    openPopover()
    fireEvent.click(screen.getByText('SupaNet'))
    expect(trigger().textContent).toContain('SupaNet')
    fireEvent.click(screen.getByText('Sponsors'))
    expect(trigger().textContent).toContain('2 collections')
  })

  it('replaces rather than accumulates in single mode', () => {
    render(<Harness mode="single" />)
    openPopover()
    fireEvent.click(screen.getByText('SupaNet'))
    fireEvent.click(screen.getByText('Sponsors'))
    expect(trigger().textContent).toContain('Sponsors')
    expect(trigger().textContent).not.toContain('2 collections')
  })

  it('removes a pick from the token row', () => {
    render(<Harness />)
    openPopover()
    fireEvent.click(screen.getByText('SupaNet'))
    fireEvent.click(screen.getByLabelText('Remove SupaNet'))
    expect(screen.queryByLabelText('Remove SupaNet')).toBeNull()
    expect(trigger().textContent).toContain('Collections')
  })
})
