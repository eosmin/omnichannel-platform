import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The `state` of the OAuth redirect is a one-time credential of 256 bits and the `code` is one too (rule 5): the
// callback of the channels must never put the query, or either of them, in a log call. Read as source because the
// property is "no log call mentions them", which a runtime test could only prove for the paths it takes.
describe('the OAuth callback of the channels does not log the query', () => {
  const FILES = ['channel-oauth.service.ts', 'channel-oauth.controller.ts']

  function logCalls(source: string): string[] {
    const calls: string[] = []
    for (const match of source.matchAll(/\blogger\.(?:trace|debug|info|warn|error|fatal|log)\(/g)) {
      let depth = 1
      let end = match.index + match[0].length
      while (depth > 0 && end < source.length) {
        if (source[end] === '(') depth += 1
        if (source[end] === ')') depth -= 1
        end += 1
      }
      calls.push(source.slice(match.index, end))
    }
    return calls
  }

  it.each(FILES)(
    '%s has log calls and none of them names the query, the code or the state',
    file => {
      const source = readFileSync(join(__dirname, file), 'utf8')
      const calls = logCalls(source)
      for (const call of calls) {
        // The words of the message text are not values: look at the code around the strings
        const code = call.replace(/'(?:[^'\\]|\\.)*'/g, "''")
        expect(code).not.toMatch(/\b(query|code|state|req|request)\b(?!\w)(?!:)/)
      }
    }
  )

  it('finds the log calls of the service, so the check above is not empty', () => {
    const source = readFileSync(join(__dirname, FILES[0] ?? ''), 'utf8')
    expect(logCalls(source).length).toBeGreaterThan(5)
  })
})
