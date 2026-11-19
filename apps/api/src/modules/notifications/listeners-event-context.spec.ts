import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Every handler of a domain event runs after the commit, outside the transaction that made the event true, so with RLS_CONTEXT on it
// reads no row (or fails WITH CHECK) unless its work is wrapped in the context of the store or organization the event carries
// (EventContext, #745: @InEventStore / @InEventOrganization). This reads the source of EVERY listener of apps/ and libs/ (it needs no
// database). A listener of the notifications module must be fully wrapped. The others are listed in PENDING with the number of bare
// handlers each still has: the list can only SHRINK (a new bare handler, or a bigger number, fails; a smaller count fails too until the
// entry is lowered or removed), so nobody adds a listener with no context and each PR that wraps one closes its line. A handler that
// opens its context in its body (`this.events.inStore(...)`) is not seen by this check: wrap it with the decorator or keep it listed.
// Debt with owners: docs/IMPLEMENTATION_PLAN.md, "Event listeners with no context".
const ROOT = join(__dirname, '..', '..', '..', '..', '..')
const WRAPPERS = ['@InEventStore', '@InEventOrganization']
// Bare handlers per file today. Owner B1 (session 7b): shipment-effects, order-message-triggers. Owner B3: finance-posting, fiscal,
// widget-delivery, cache-invalidation. Owner C (sockets): realtime-events.
const PENDING: Readonly<Record<string, number>> = {
  'apps/api/src/modules/cache/cache-invalidation.listener.ts': 7,
  'apps/api/src/modules/finance/finance-posting.listener.ts': 12,
  'apps/api/src/modules/fiscal/fiscal.listener.ts': 2,
  'apps/api/src/modules/order-messages/order-message-triggers.listener.ts': 3,
  'apps/api/src/modules/orders/shipment-effects.listener.ts': 1,
  'apps/api/src/modules/realtime/realtime-events.listener.ts': 33,
  'apps/api/src/modules/widget/widget-delivery.listener.ts': 1
}
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

const SKIPPED = new Set(['node_modules', 'generated', 'dist', '.next', '.nx', 'coverage'])

function sourcesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap(name => {
    if (SKIPPED.has(name)) return []
    const path = join(directory, name)
    if (statSync(path).isDirectory()) return sourcesUnder(path)
    return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [path] : []
  })
}

const HANDLERS = ['apps', 'libs']
  .flatMap(top => sourcesUnder(join(ROOT, top)))
  .map(path => ({ path: path.slice(ROOT.length + 1), source: readFileSync(path, 'utf8') }))
  .filter(file => file.source.includes('@OnEvent('))
  .map(file => ({ file: file.path, handlers: handlersIn(file.path, file.source) }))
  .filter(file => file.handlers.length > 0)

const bareOf = (file: string): Handler[] =>
  (HANDLERS.find(entry => entry.file === file)?.handlers ?? []).filter(handler => !handler.wrapped)

describe('the listeners of domain events open the context of their event', () => {
  it('finds the listeners and their handlers (so the checks below are not empty)', () => {
    const files = HANDLERS.map(entry => entry.file)
    expect(files).toEqual(
      expect.arrayContaining([
        'apps/api/src/modules/notifications/notifications-events.listener.ts',
        'apps/api/src/modules/notifications/notifications-inbox.listener.ts',
        ...Object.keys(PENDING)
      ])
    )
    expect(HANDLERS.flatMap(entry => entry.handlers).length).toBeGreaterThan(100)
  })

  it.each(HANDLERS.map(entry => entry.file))(
    '%s: no handler without a context beyond the pending list',
    file => {
      const bare = bareOf(file)
      const allowed = PENDING[file] ?? 0
      // Fewer bare handlers than listed: lower the entry (or remove it) so the list keeps shrinking
      expect({ file, bare: bare.length }).toEqual({ file, bare: Math.min(bare.length, allowed) })
      if (bare.length === allowed) return
      expect(bare.map(handler => `${handler.file}:${handler.line} ${handler.event}`)).toEqual([])
    }
  )

  it('lists in PENDING only files that exist and still have a bare handler', () => {
    const stale = Object.entries(PENDING)
      .filter(([file, count]) => bareOf(file).length !== count)
      .map(([file]) => file)
    expect(stale).toEqual([])
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
