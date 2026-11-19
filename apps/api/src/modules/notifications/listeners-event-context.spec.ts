import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import * as ts from 'typescript'

// Every handler of a domain event runs after the commit, outside the transaction that made the event true, so with RLS_CONTEXT on it
// reads no row (or fails WITH CHECK) unless its work is wrapped in the context of the store or organization the event carries
// (EventContext, #745: @InEventStore / @InEventOrganization). This reads the source of EVERY listener of apps/ and libs/ (it needs no
// database). A listener of the notifications module must be fully wrapped. The others are listed in PENDING with the number of bare
// handlers each still has: the list can only SHRINK (a new bare handler, or a bigger number, fails; a smaller count fails too until the
// entry is lowered or removed), so nobody adds a listener with no context and each PR that wraps one closes its line. A handler that
// opens its context in its body (`this.events.inStore(...)`) is not seen by this check: wrap it with the decorator or keep it listed.
// A handler counts as wrapped with the decorator OR when its own body REACHES a call `x.inStore(` / `inEventStore(` / `inOrganization(` /
// `inOrganizationOfStore(` / `inUser(` / `forStore(` / `forOrganization(` (read from the TypeScript syntax tree: a comment, a string,
// a branch that never runs (`if (false)`) or the code after a `return` / `throw` does not count). It cannot see a context opened by
// another method the handler delegates to: such a handler stays listed, with the reason (order-message-triggers 2 and
// shipment-effects 1 are covered by delegation, B1 #776: `this.send` / `effects.follow` open it per step so no transaction stays open
// during the provider, the e-mail or the retry sleeps; they are not debt of B3).
// NOT covered by this check: a listener registered with `emitter.on(...)` / `onAny(...)` (WebhookDispatcher), tracked in the plan.
// Debt with owners: docs/IMPLEMENTATION_PLAN.md, "Event listeners with no context".
const ROOT = join(__dirname, '..', '..', '..', '..', '..')
const WRAPPERS = new Set(['InEventStore', 'InEventOrganization'])
// Bare handlers per file today (fiscal and widget-delivery open their context in the body, so they are not listed). Owner B1 (session 7b):
// shipment-effects, order-message-triggers. Owner B3 (74 and 8c): finance-posting, cache-invalidation, realtime-events.
const PENDING: Readonly<Record<string, number>> = {
  'apps/api/src/modules/cache/cache-invalidation.listener.ts': 7,
  'apps/api/src/modules/finance/finance-posting.listener.ts': 11,
  'apps/api/src/modules/order-messages/order-message-triggers.listener.ts': 2,
  'apps/api/src/modules/orders/shipment-effects.listener.ts': 1,
  'apps/api/src/modules/realtime/realtime-events.listener.ts': 33
}
interface Handler {
  file: string
  line: number
  event: string
  wrapped: boolean
}

// A call on a receiver (`this.events.inStore(`, `jobs.forStore(`), never a bare word
const OPENING_CALLS = new Set([
  'inStore',
  'inEventStore',
  'inOrganization',
  'inOrganizationOfStore',
  'inUser',
  'forStore',
  'forOrganization'
])

const isConstantFalse = (node: ts.Expression): boolean => {
  if (ts.isParenthesizedExpression(node)) return isConstantFalse(node.expression)
  return (
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isNumericLiteral(node) && Number(node.text) === 0) ||
    (ts.isIdentifier(node) && node.text === 'undefined')
  )
}
const isConstantTrue = (node: ts.Expression): boolean => {
  if (ts.isParenthesizedExpression(node)) return isConstantTrue(node.expression)
  return (
    node.kind === ts.SyntaxKind.TrueKeyword ||
    (ts.isNumericLiteral(node) && Number(node.text) !== 0)
  )
}
const endsFlow = (node: ts.Node): boolean =>
  ts.isReturnStatement(node) ||
  ts.isThrowStatement(node) ||
  ts.isBreakStatement(node) ||
  ts.isContinueStatement(node)

// Does this code REACH a call that opens a context: not one in a comment or a string (they are no nodes), not one under a constant
// false condition, not one after a return or a throw in the same block
function reachesOpeningCall(root: ts.Node): boolean {
  const visit = (node: ts.Node): boolean => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      OPENING_CALLS.has(node.expression.name.text)
    ) {
      return true
    }
    if (ts.isIfStatement(node)) {
      if (isConstantFalse(node.expression)) {
        return node.elseStatement !== undefined && visit(node.elseStatement)
      }
      if (isConstantTrue(node.expression)) return visit(node.thenStatement)
    }
    if (ts.isBlock(node)) {
      for (const statement of node.statements) {
        if (visit(statement)) return true
        if (endsFlow(statement)) return false
      }
      return false
    }
    return ts.forEachChild(node, child => (visit(child) ? true : undefined)) === true
  }
  return visit(root)
}

const decoratorName = (decorator: ts.Decorator): string | undefined => {
  const expression = ts.isCallExpression(decorator.expression)
    ? decorator.expression.expression
    : decorator.expression
  return ts.isIdentifier(expression) ? expression.text : undefined
}

// The event a listener names: the text of the argument of @OnEvent(...)
const eventOf = (decorator: ts.Decorator, tree: ts.SourceFile): string =>
  ts.isCallExpression(decorator.expression)
    ? (decorator.expression.arguments[0]?.getText(tree) ?? '')
    : ''

// Every method of the file that carries @OnEvent: wrapped by a decorator under it, or by a context its body reaches
function handlersIn(file: string, source: string): Handler[] {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const found: Handler[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isMethodDeclaration(node)) {
      const decorators = ts.getDecorators(node) ?? []
      const listeners = decorators.filter(decorator => decoratorName(decorator) === 'OnEvent')
      // One entry for each @OnEvent: a method that listens to several events counts once for each of them
      if (listeners.length > 0) {
        const wrapped =
          decorators.some(decorator => WRAPPERS.has(decoratorName(decorator) ?? '')) ||
          (node.body !== undefined && reachesOpeningCall(node.body))
        for (const listener of listeners) {
          const { line } = tree.getLineAndCharacterOfPosition(listener.getStart(tree))
          found.push({ file, line: line + 1, event: eventOf(listener, tree), wrapped })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
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

  it('reads the handlers from the syntax tree', () => {
    const source = [
      'class L {',
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
      '  @OnEvent(Events.G)',
      '  async onG(p: P): Promise<void> {',
      '    if (false) {',
      '      await this.events.inStore(p.storeId, async () => {})',
      '    }',
      '  }',
      '  @OnEvent(Events.H)',
      '  async onH(p: P): Promise<void> {',
      '    if (true) {',
      '      await this.events.inStore(p.storeId, async () => {})',
      '    } else {',
      '      await this.other.follow(p)',
      '    }',
      '  }',
      '  @OnEvent(Events.I)',
      '  async onI(p: P): Promise<void> {',
      '    return',
      '    await this.events.inStore(p.storeId, async () => {})',
      '  }',
      '  @OnEvent(Events.J)',
      '  async onJ(p: P): Promise<void> {',
      '    const open = bare.inStore',
      '    await events.inStore',
      '      .call(open)',
      '  }',
      '  // inStore( in a later method does not count for these',
      '  async later(): Promise<void> {',
      '    await this.events.inStore(id, async () => {})',
      '  }',
      '}'
    ].join('\n')
    expect(
      handlersIn('sample.ts', source).map(handler => `${handler.event}:${handler.wrapped}`)
    ).toEqual([
      'Events.A:false',
      'Events.B:true',
      'Events.C:true',
      'Events.D:true',
      'Events.E:false',
      'Events.F:false',
      'Events.G:false',
      'Events.H:true',
      'Events.I:false',
      'Events.J:false'
    ])
  })
})
