// Lightweight HTML → markdown for LLM consumption. Used by the http_request
// builtin so an HTML page comes back as readable text instead of tag soup —
// the same 50k-char budget then carries ~10x more actual content. Regex-based
// on purpose: edge functions have no DOM, and "good enough for a model to
// read" beats a heavy parser dependency. Not a faithful renderer.
import { decodeEntities } from './linkmeta.ts'

function inner(t: string): string {
  return decodeEntities(t.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
}

export function htmlToMarkdown(html: string): string {
  let s = html
    // Drop the parts that are never content.
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '')
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')

  s = s
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, t) => `\n\n${'#'.repeat(Number(n))} ${inner(t)}\n\n`)
    .replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, t) => {
      const text = inner(t)
      return text && !href.startsWith('javascript:') ? `[${text}](${href})` : text
    })
    .replace(/<img\s[^>]*alt=["']([^"']+)["'][^>]*>/gi, (_, alt) => `(image: ${alt})`)
    .replace(/<(?:strong|b)\b[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi, (_, t) => `**${inner(t)}**`)
    .replace(/<(?:em|i)\b[^>]*>([\s\S]*?)<\/(?:em|i)>/gi, (_, t) => `*${inner(t)}*`)
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, t) => `\n\`\`\`\n${decodeEntities(t.replace(/<[^>]+>/g, ''))}\n\`\`\`\n`)
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, t) => `\`${inner(t)}\``)
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<blockquote[^>]*>/gi, '\n> ')
    .replace(/<(?:td|th)[^>]*>/gi, ' | ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|section|article|header|footer|main|aside|tr|ul|ol|table|blockquote|figure)>/gi, '\n')

  // Strip whatever tags remain, decode, and collapse the leftover whitespace.
  return decodeEntities(s.replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
