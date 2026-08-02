import { describe, expect, it } from 'vitest'
import { buildFormSnippet, escapeHtml, type FormField } from './forms'

describe('escapeHtml', () => {
  it('escapes HTML-significant characters', () => {
    expect(escapeHtml('<b>"x"&\'')).toBe('&lt;b&gt;&quot;x&quot;&amp;&#39;')
  })
})

describe('buildFormSnippet', () => {
  const fields: FormField[] = [
    { key: 'name', label: 'Full name', type: 'text', required: true },
    { key: 'email', label: 'Email', type: 'text' },
    { key: 'subscribe', label: 'Subscribe?', type: 'boolean' },
    { key: 'notes', label: 'Notes', type: 'longtext' },
  ]

  it('embeds the endpoint + token as JSON literals', () => {
    const html = buildFormSnippet({
      endpoint: 'https://x.supabase.co/functions/v1/form-submit',
      token: 'tok123',
      title: 'Leads',
      fields,
    })
    expect(html).toContain('var ENDPOINT = "https://x.supabase.co/functions/v1/form-submit"')
    expect(html).toContain('var TOKEN = "tok123"')
  })

  it('renders the right input per column type', () => {
    const html = buildFormSnippet({ endpoint: 'e', token: 't', title: 'T', fields })
    expect(html).toContain('name="name"')
    expect(html).toContain('<textarea name="notes"')
    expect(html).toContain('type="checkbox" name="subscribe"')
    // required marks the input
    expect(html).toMatch(/name="name"[^>]*required/)
  })

  it('escapes the title and labels', () => {
    const html = buildFormSnippet({
      endpoint: 'e',
      token: 't',
      title: '<script>alert(1)</script>',
      fields: [{ key: 'a', label: '<b>x</b>', type: 'text' }],
    })
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;')
  })
})
