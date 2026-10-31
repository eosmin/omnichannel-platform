import { MENTION_PREFIX } from '@platform/core/domain'

export interface Segment {
  text: string
  isMention: boolean
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// The text of a note cut into plain parts and the `@Name` of each teammate it mentions, so that the
// mention can be highlighted. A name must end where the word ends ("@Anabel" is not "@Ana").
export function mentionSegments(content: string, names: readonly string[]): Segment[] {
  const unique = [...new Set(names.filter(name => name !== ''))].sort((a, b) => b.length - a.length)
  if (unique.length === 0) return [{ text: content, isMention: false }]
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}_])(?:${unique.map(name => escapeRegExp(MENTION_PREFIX + name)).join('|')})(?![\\p{L}\\p{N}_])`,
    'gu'
  )
  const segments: Segment[] = []
  let from = 0
  for (const match of content.matchAll(pattern)) {
    if (match.index > from)
      segments.push({ text: content.slice(from, match.index), isMention: false })
    segments.push({ text: match[0], isMention: true })
    from = match.index + match[0].length
  }
  if (from < content.length) segments.push({ text: content.slice(from), isMention: false })
  return segments
}
