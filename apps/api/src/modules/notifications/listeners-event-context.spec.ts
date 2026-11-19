import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// Every handler of a domain event of the notifications module runs after the commit, outside the transaction that made the event true,
// so with RLS_CONTEXT on it reads no row unless its work is wrapped in the context of the store or organization the event carries
// (EventContext, #745). The listener is the ONLY caller of NotificationsService.send*, so a handler left bare would notify nobody, in
// silence. This reads the source (it needs no database): a new @OnEvent without @InEventStore / @InEventOrganization fails here.
const DIRECTORY = __dirname
const WRAPPERS = ['@InEventStore', '@InEventOrganization']
// The decorators sit right under @OnEvent; a comment or a second decorator may come between, never more than a few lines
const WINDOW = 4

interface Handler {
  file: string
  line: number
  event: string
  wrapped: boolean
}

function handlersOf(file: string): Handler[] {
  const lines = readFileSync(join(DIRECTORY, file), 'utf8').split('\n')
  const found: Handler[] = []
  lines.forEach((text, index) => {
    const match = /^\s*@OnEvent\((.+)\)\s*$/.exec(text)
    if (match === null) return
    const below = lines.slice(index + 1, index + 1 + WINDOW)
    found.push({
      file,
      line: index + 1,
      event: match[1] ?? '',
      wrapped: below.some(line => WRAPPERS.some(wrapper => line.trim().startsWith(wrapper)))
    })
  })
  return found
}

const LISTENERS = readdirSync(DIRECTORY).filter(name => name.endsWith('.listener.ts'))

describe('the listeners of the notifications module open the context of their event', () => {
  it('finds the listeners and their handlers (so the check below is not empty)', () => {
    expect(LISTENERS).toEqual(
      expect.arrayContaining([
        'notifications-events.listener.ts',
        'notifications-inbox.listener.ts'
      ])
    )
    expect(LISTENERS.flatMap(handlersOf).length).toBeGreaterThan(40)
  })

  it.each(LISTENERS)('%s: every @OnEvent handler is wrapped in a context', file => {
    const bare = handlersOf(file)
      .filter(handler => !handler.wrapped)
      .map(handler => `${handler.file}:${handler.line} ${handler.event}`)
    expect(bare).toEqual([])
  })
})
