// Test the email recipient allowlist logic.
//
// The recipientAllowed helper (in builtins.ts) checks whether a recipient
// address is permitted by the workspace's allowed_recipients list. It supports:
// - Exact email addresses ('user@example.com')
// - Domain suffixes ('@example.com' allows any address at that domain)
//
// This test verifies the matching logic is sound, so the send_email tool
// enforces the allowlist correctly.

import { assertEquals } from 'jsr:@std/assert'

// Mirror of the recipientAllowed function from _shared/builtins.ts
function recipientAllowed(to: string, allowed: string[]): boolean {
  const addr = to.toLowerCase()
  return allowed.some((a) => {
    const rule = (a ?? '').trim().toLowerCase()
    if (!rule) return false
    return rule.startsWith('@') ? addr.endsWith(rule) : addr === rule
  })
}

Deno.test('recipientAllowed - exact match', () => {
  const allowed = ['alice@example.com', 'bob@partner.com']
  assertEquals(recipientAllowed('alice@example.com', allowed), true)
  assertEquals(recipientAllowed('bob@partner.com', allowed), true)
  assertEquals(recipientAllowed('charlie@example.com', allowed), false)
  assertEquals(recipientAllowed('alice@other.com', allowed), false)
})

Deno.test('recipientAllowed - domain suffix', () => {
  const allowed = ['@example.com', '@partner.org']
  assertEquals(recipientAllowed('anyone@example.com', allowed), true)
  assertEquals(recipientAllowed('user@partner.org', allowed), true)
  assertEquals(recipientAllowed('admin@example.com', allowed), true)
  assertEquals(recipientAllowed('user@other.com', allowed), false)
  assertEquals(recipientAllowed('user@examplexcom', allowed), false) // no dot
})

Deno.test('recipientAllowed - mixed rules', () => {
  const allowed = ['admin@acme.com', '@partners.net']
  assertEquals(recipientAllowed('admin@acme.com', allowed), true)
  assertEquals(recipientAllowed('sales@partners.net', allowed), true)
  assertEquals(recipientAllowed('user@acme.com', allowed), false) // not exact
  assertEquals(recipientAllowed('user@gmail.com', allowed), false)
})

Deno.test('recipientAllowed - case insensitive', () => {
  const allowed = ['Alice@Example.COM', '@Partner.ORG']
  assertEquals(recipientAllowed('alice@example.com', allowed), true)
  assertEquals(recipientAllowed('ALICE@EXAMPLE.COM', allowed), true)
  assertEquals(recipientAllowed('User@partner.org', allowed), true)
  assertEquals(recipientAllowed('USER@PARTNER.ORG', allowed), true)
})

Deno.test('recipientAllowed - whitespace handling', () => {
  const allowed = ['  alice@example.com  ', '  @partner.com  ']
  assertEquals(recipientAllowed('alice@example.com', allowed), true)
  assertEquals(recipientAllowed('bob@partner.com', allowed), true)
  assertEquals(recipientAllowed('  alice@example.com  ', allowed), false) // to is not trimmed by helper
})

Deno.test('recipientAllowed - empty/invalid rules', () => {
  const allowed = ['', '  ', 'valid@example.com']
  assertEquals(recipientAllowed('valid@example.com', allowed), true)
  assertEquals(recipientAllowed('other@example.com', allowed), false)
  // Empty strings in the allowlist are skipped
})

Deno.test('recipientAllowed - subdomain behavior', () => {
  const allowed = ['@example.com']
  // A '@domain' rule matches on addr.endsWith('@domain'), so it only matches
  // that exact domain. A subdomain address ends with '.example.com' (not
  // '@example.com'), so it does NOT match and needs its own rule — the safe
  // default for a send-to allowlist.
  assertEquals(recipientAllowed('user@example.com', allowed), true)
  assertEquals(recipientAllowed('user@sub.example.com', allowed), false) // ends with .example.com, not @example.com
  assertEquals(recipientAllowed('user@notexample.com', allowed), false)
})

Deno.test('recipientAllowed - edge cases', () => {
  // Single character domains
  assertEquals(recipientAllowed('user@a.co', ['@a.co']), true)
  // Very long addresses
  const long = 'a'.repeat(64) + '@' + 'b'.repeat(200) + '.com'
  assertEquals(recipientAllowed(long, [long]), true)
  // Special characters in local part (valid in email)
  assertEquals(recipientAllowed('user+tag@example.com', ['@example.com']), true)
  assertEquals(recipientAllowed('user.name@example.com', ['user.name@example.com']), true)
})
