import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// Every handler of a domain event of the notifications module runs after the commit, outside the transaction that made the event true,
// so with RLS_CONTEXT on it reads no row unless its work is wrapped in the context of the store or organization the event carries
// (EventContext, #745). The listener is the ONLY caller of NotificationsService.send*, so a handler left bare would notify nobody, in
// silence. This reads the source (it needs no database): a new @OnEvent without @InEventStore / @InEventOrganization fails here.
const DIRECTORY = __dirname
const WRAPPERS = ['@InEventStore', '@InEventOrganization']
interface Handler {
  file: string
  line: number
  event: string
  wrapped: boolean
}

const isDecoratorOrComment = (line: string): boolean => {
  const text = line.trim()
  return (
    text.startsWith('@') || text.startsWith('//') || text.startsWith('/*') || text.startsWith('*')
  )
}

// The decorators of a handler are the lines under its @OnEvent that are decorators or comments, up to the first line that is not:
// a wrapper that belongs to the NEXT handler is never counted for this one. The @OnEvent call may span several lines.
function handlersIn(file: string, source: string): Handler[] {
  const lines = source.split('\n')
  const found: Handler[] = []
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\s*@OnEvent\(/.test(lines[index] ?? '')) continue
    let call = ''
    let end = index
    let depth = 0
    for (; end < lines.length; end += 1) {
      const text = lines[end] ?? ''
      call += `${text.trim()} `
      depth += (text.match(/\(/g) ?? []).length - (text.match(/\)/g) ?? []).length
      if (depth <= 0) break
    }
    let wrapped = false
    for (let next = end + 1; next < lines.length; next += 1) {
      const text = lines[next] ?? ''
      if (!isDecoratorOrComment(text)) break
      if (WRAPPERS.some(wrapper => text.trim().startsWith(wrapper))) wrapped = true
    }
    found.push({ file, line: index + 1, event: call.trim(), wrapped })
    index = end
  }
  return found
}

const handlersOf = (file: string): Handler[] =>
  handlersIn(file, readFileSync(join(DIRECTORY, file), 'utf8'))

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

  it('does not count the wrapper of the next handler, and reads an @OnEvent over several lines', () => {
    const source = [
      '  @OnEvent(Events.A)',
      '  async onA(p: P): Promise<void> {}',
      '  @OnEvent(',
      '    Events.B',
      '  )',
      '  @InEventStore()',
      '  async onB(p: P): Promise<void> {}',
      '  @OnEvent(Events.C)',
      '  // a comment between the decorators',
      '  @InEventOrganization()',
      '  async onC(p: P): Promise<void> {}'
    ].join('\n')
    expect(handlersIn('sample.ts', source).map(handler => handler.wrapped)).toEqual([
      false,
      true,
      true
    ])
  })
})
