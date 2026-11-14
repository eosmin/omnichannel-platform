import { SearchSnippetMarks } from '@platform/core/domain'

export interface SnippetPart {
  text: string
  isMatch: boolean
}

// The snippet of a message hit as pieces of plain text, the matched words flagged. The text is the customer's: the
// screen draws every piece as text (never as markup), so a `<script>` typed by a customer shows as those characters.
// Only the marks of `SearchSnippetMarks` mean anything; a mark that was never closed (or closed twice) is dropped, so
// the rest is not all drawn as a match.
export function snippetParts(snippet: string): SnippetPart[] {
  const parts: SnippetPart[] = []
  let rest = snippet
  for (;;) {
    const start = rest.indexOf(SearchSnippetMarks.START)
    if (start === -1) break
    const afterStart = start + SearchSnippetMarks.START.length
    const stop = rest.indexOf(SearchSnippetMarks.STOP, afterStart)
    if (stop === -1) {
      rest = rest.slice(0, start) + rest.slice(afterStart)
      continue
    }
    if (start > 0) parts.push({ text: rest.slice(0, start), isMatch: false })
    const matched = rest.slice(afterStart, stop)
    if (matched !== '') parts.push({ text: stripMarks(matched), isMatch: true })
    rest = rest.slice(stop + SearchSnippetMarks.STOP.length)
  }
  const tail = stripMarks(rest)
  if (tail !== '') parts.push({ text: tail, isMatch: false })
  return parts
}

function stripMarks(text: string): string {
  return text.replaceAll(SearchSnippetMarks.START, '').replaceAll(SearchSnippetMarks.STOP, '')
}
