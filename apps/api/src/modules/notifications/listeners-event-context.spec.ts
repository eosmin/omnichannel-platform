import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Every handler of a domain event runs after the commit, outside the transaction that made the event true, so with RLS_CONTEXT on it
// reads no row (or fails WITH CHECK) unless its work is wrapped in the context of the store or organization the event carries
// (EventContext, #745: @InEventStore / @InEventOrganization). This reads the source of EVERY listener of apps/ and libs/ (it needs no
// database). A listener of the notifications module must be fully wrapped. The others are listed in PENDING with the number of bare
// handlers each still has: the list can only SHRINK (a new bare handler, or a bigger number, fails; a smaller count fails too until the
// entry is lowered or removed), so nobody adds a listener with no context and each PR that wraps one closes its line. A handler that
// opens its context in its body (`this.events.inStore(...)`) is not seen by this check: wrap it with the decorator or keep it listed.
// A handler counts as wrapped with the decorator OR when its own body calls inStore( / inOrganization( / inOrganizationOfStore( /
// inUser( / forStore( / forOrganization( (comments and string literals do not count; it cannot see a context opened by another method it delegates to, nor a dead branch: list
// that handler or review it).
// A handler that needs no context at all (it only publishes to a socket room or drops a Redis key) says so with
// `@EventContextNotNeeded('reason')`. The marker is checked, not trusted: the reason must be there, and the body of the handler and of
// every method of the same file must not name prisma, a transaction or a client (comments and literals do not count): a marked handler that touches the database is a bare one. What it calls in ANOTHER class is for the reviewer: the reason says it.
// NOT covered by this check: a listener registered with `emitter.on(...)` / `onAny(...)` (WebhookDispatcher), tracked in the plan.
// Debt with owners: docs/IMPLEMENTATION_PLAN.md, "Event listeners with no context".
const ROOT = join(__dirname, '..', '..', '..', '..', '..')
const WRAPPERS = ['@InEventStore', '@InEventOrganization']
// Bare handlers per file today (fiscal and widget-delivery open their context in the body, so they are not listed). Owner B1 (session 7b):
// shipment-effects, order-message-triggers. Owner B3 (74): finance-posting. (cache-invalidation and realtime-events carry the marker.)
const PENDING: Readonly<Record<string, number>> = {
  'apps/api/src/modules/finance/finance-posting.listener.ts': 11,
  'apps/api/src/modules/order-messages/order-message-triggers.listener.ts': 2,
  'apps/api/src/modules/orders/shipment-effects.listener.ts': 1
}
interface Handler {
  file: string
  line: number
  event: string
  wrapped: boolean
}

// A call on a receiver (`this.events.inStore(`, `jobs.forStore(`), never a bare word
const OPENS_CONTEXT =
  /[\w)\]]\.(?:inStore|inEventStore|inOrganization|inOrganizationOfStore|inUser|forStore|forOrganization)\(/
// Comments and string literals, in one pass so that a `//` inside a string is not a comment: what they say is not what the code does
const COMMENTS_AND_LITERALS =
  /\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g
const withoutCommentsAndLiterals = (text: string): string => text.replace(COMMENTS_AND_LITERALS, '')

// The text of the method that starts at `from`: up to the brace that closes its first `{`
function bodyFrom(lines: readonly string[], from: number): string {
  let depth = 0
  let opened = false
  const body: string[] = []
  for (let at = from; at < lines.length; at += 1) {
    const text = lines[at] ?? ''
    body.push(text)
    for (const char of text) {
      if (char === '{') {
        depth += 1
        opened = true
      } else if (char === '}') depth -= 1
    }
    if (opened && depth <= 0) break
  }
  return body.join('\n')
}

// The marker with a reason that is not empty, over one or several lines
const MARKER = /^\s*@EventContextNotNeeded\(\s*(['"`])\s*\S[\s\S]*?\1\s*\)/m
// What a handler with no context must never touch
const DATABASE =
  /\b(?:prisma\w*|PrismaService|tenantTransaction|detachedTenantTransaction|transaction|client|db|repo|\$queryRaw|\$executeRaw)\b/i

// The marker is checked against the WHOLE file (code only): a listener that is marked anywhere must not name prisma, a transaction
// or a client in any method, signature, helper or injected dependency of the file, so a destructured multi-line signature or a helper
// cannot hide a read. What the file calls in ANOTHER class is for the reviewer: the reason says it.
const namesDatabase = (source: string): boolean => DATABASE.test(withoutCommentsAndLiterals(source))

// Parentheses of the code of a line: a bracket inside a reason is text, not syntax
const parenBalance = (text: string): number => {
  const code = withoutCommentsAndLiterals(text)
  return (code.match(/\(/g) ?? []).length - (code.match(/\)/g) ?? []).length
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
    let next = end + 1
    const decorators: string[] = []
    for (; next < lines.length; next += 1) {
      const text = lines[next] ?? ''
      if (!isDecoratorOrComment(text)) break
      // A decorator call may span several lines (prettier splits a long reason): take it whole
      let depth = text.trim().startsWith('@') ? parenBalance(text) : 0
      let whole = text
      while (depth > 0 && next + 1 < lines.length) {
        next += 1
        const more = lines[next] ?? ''
        whole += `\n${more}`
        depth += parenBalance(more)
      }
      decorators.push(whole)
      if (WRAPPERS.some(wrapper => text.trim().startsWith(wrapper))) wrapped = true
    }
    // Or the handler opens its context itself, in its body (so that the call to a carrier, a channel or Redis stays outside the
    // transaction): the body runs from the first `{` after the decorators to its closing one
    if (!wrapped) wrapped = OPENS_CONTEXT.test(withoutCommentsAndLiterals(bodyFrom(lines, next)))
    // Or it says, with a reason, that it needs none, and what it does is no database work
    if (!wrapped && MARKER.test(decorators.join('\n'))) wrapped = !namesDatabase(source)
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
      '  async onC(p: P): Promise<void> {}',
      '  @OnEvent(Events.D)',
      '  async onD(p: P): Promise<void> {',
      '    await this.events.inOrganization(p.organizationId, async () => {})',
      '  }',
      '  @OnEvent(Events.E)',
      '  async onE(p: P): Promise<void> {',
      '    await this.other.follow(p)',
      '  }',
      '  @OnEvent(Events.F)',
      '  async onF(p: P): Promise<void> {',
      '    // this.events.inStore(p.storeId, work)',
      '    const note = "this.events.inStore("',
      '    await this.other.follow(note)',
      '  }',
      '  // inStore( in a later method does not count for E',
      '  async later(): Promise<void> {',
      '    await this.events.inStore(id, async () => {})',
      '  }'
    ].join('\n')
    expect(handlersIn('sample.ts', source).map(handler => handler.wrapped)).toEqual([
      false,
      true,
      true,
      true,
      false,
      false
    ])
  })

  describe('a marker is taken only with a reason and no database work in the file', () => {
    const wrappedOf = (...lines: string[]): boolean[] =>
      handlersIn('sample.ts', lines.join('\n')).map(handler => handler.wrapped)
    const handler = (...body: string[]): string[] => [
      '  @OnEvent(Events.A)',
      "  @EventContextNotNeeded('only a socket')",
      '  async onA(p: P): Promise<void> {',
      ...body,
      '  }'
    ]

    it('takes a handler that only publishes', () => {
      expect(wrappedOf(...handler('    await this.realtime.toStore(p)'))).toEqual([true])
    })

    it('takes a marker on stacked @OnEvent and a reason over several lines', () => {
      expect(
        wrappedOf(
          '  @OnEvent(Events.A)',
          '  @OnEvent(Events.B)',
          '  @EventContextNotNeeded(',
          "    'a reason over several lines'",
          '  )',
          '  async onA(p: P): Promise<void> {}'
        )
      ).toEqual([true, true])
    })

    it('refuses an empty reason', () => {
      expect(
        wrappedOf('  @OnEvent(Events.A)', "  @EventContextNotNeeded('')", '  async onA() {}')
      ).toEqual([false])
    })

    it('refuses a marker that is only a comment', () => {
      expect(
        wrappedOf(
          '  @OnEvent(Events.A)',
          "  // @EventContextNotNeeded('later')",
          '  async onA(p: P): Promise<void> {}'
        )
      ).toEqual([false])
    })

    it('reads a reason with an unbalanced parenthesis as text', () => {
      expect(
        wrappedOf(
          '  @OnEvent(Events.A)',
          "  @EventContextNotNeeded('drops a key (no table')",
          '  async onA(p: P): Promise<void> {}',
          '  @OnEvent(Events.B)',
          '  async onB(p: P): Promise<void> {}'
        )
      ).toEqual([true, false])
    })

    it.each([
      ['prisma in the body', '    await this.prisma.client.message.findMany({})'],
      ['a transaction', '    await this.other.tenantTransaction(ctx, () => work(p))'],
      ['a differently named service', '    await this.prismaService.conversation.findMany({})'],
      ['a db property', '    await this.db.message.findMany({})']
    ])('refuses a marked handler with %s', (_name, line) => {
      expect(wrappedOf(...handler(line))).toEqual([false])
    })

    it('refuses a marked handler whose database work is in a helper or a multi-line signature', () => {
      expect(
        wrappedOf(
          ...handler('    await this.reader(p)'),
          '  private async reader(',
          '    { storeId }: P',
          '  ): Promise<void> {',
          '    await this.prisma.client.x.findMany()',
          '  }'
        )
      ).toEqual([false])
    })

    it('does not count a database word in a comment or a string', () => {
      expect(
        wrappedOf(
          ...handler(
            '    await this.realtime.toStore(p) // this.prisma is a comment',
            "    log('client')"
          )
        )
      ).toEqual([true])
    })
  })
})
