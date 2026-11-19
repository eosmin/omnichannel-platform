import * as ts from 'typescript'

// Routes that reach a service with I/O outside the database must carry @NoTenantTransaction (RLS phase 6, F6-3d).
// With RLS_CONTEXT on, the interceptor wraps the handler of a request in ONE database transaction that lasts at most 15 s. A route that
// calls a carrier, a channel, the bucket or the mail inside it holds a connection and a transaction open for the network, and a route that
// streams cannot be one transaction at all. Such a route is marked @NoTenantTransaction(reason) and opens short contexts of its own.
//
// The check reads the code, it does not run it. It builds a graph of `Class.method` nodes: an edge is `this.field.method()` (the type of
// `field` comes from the constructor) or `this.method()`. A node is external when it is a method of a provider listed in
// scripts/external-io-providers.ts, or calls an external node. A controller method that reaches one, or that takes the response with
// @Res() / @UploadedFile(), must be marked on the method or on the class.
//
// Limits, on purpose: a call through an interface, a callback, a spread or a type the graph does not know is not followed (the list of
// providers is where a new boundary is added); inheritance is not followed. The routes that are not marked today are frozen in
// scripts/external-io-baseline.json and the list can only shrink.

export interface ExternalIoProvider {
  readonly name: string
  readonly reason: string
}

interface ClassInfo {
  readonly name: string
  readonly file: string
  readonly fields: ReadonlyMap<string, string>
  // The class it extends, so `this.method()` and the fields of a base class are found
  readonly parent: string | undefined
  readonly isController: boolean
  readonly marked: boolean
  readonly methods: readonly MethodInfo[]
}

interface MethodInfo {
  readonly name: string
  // Calls an adapter method that goes over the network (see NETWORK_METHODS) or `fetch`
  readonly directIo: boolean
  readonly line: number
  readonly decorators: readonly string[]
  readonly calls: readonly Call[]
  readonly takesResponse: boolean
  readonly marked: boolean
}

interface Call {
  // The field of `this` that is called, or undefined for `this.method()`
  readonly field: string | undefined
  readonly method: string
  // The name is one of NETWORK_METHODS: it counts when the type of the field is not a class the scan knows (an interface, a port)
  readonly network: boolean
}

export interface ExternalRoute {
  readonly key: string
  readonly file: string
  readonly line: number
  readonly why: string
}

const HTTP_METHODS = new Set(['Get', 'Post', 'Put', 'Patch', 'Delete', 'Head', 'Options', 'All'])
// An @Sse() route is already skipped by the interceptor
const ROUTE_DECORATORS = new Set([...HTTP_METHODS])
const STREAM_PARAMS = new Set(['Res', 'UploadedFile', 'UploadedFiles'])
// The methods of the plugin contracts (carrier, channel, fiscal provider) that call a remote API. The adapter comes out of a registry
// into a local variable, so the call is not `this.field.method()`: any receiver other than `this` counts. A service of the platform
// with a method of the same name is followed through `this.field.method()` instead, so these names are only read on other receivers.
const NETWORK_METHODS = new Set([
  'createShipment',
  'createShipmentsWithPickup',
  'fetchPickup',
  'cancelShipment',
  'fetchLabel',
  'fetchStatus',
  'lookupLocations',
  'requestPickup',
  'modifyPickup',
  'cancelPickup',
  'sendMessage',
  'sendMedia',
  'sendTemplate',
  'listTemplates',
  'sendButtons',
  'sendLocation',
  'sendTypingIndicator',
  'markAsRead',
  'sendReaction',
  'deleteMessage',
  'editMessage',
  'inspectToken',
  'healthCheck',
  'submit',
  'consult'
])
const NETWORK_FUNCTIONS = new Set(['fetch', 'safeFetch'])

function decoratorName(decorator: ts.Decorator): string | undefined {
  const expression = decorator.expression
  if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)) {
    return expression.expression.text
  }
  return ts.isIdentifier(expression) ? expression.text : undefined
}

function decoratorsOf(node: ts.Node): string[] {
  if (!ts.canHaveDecorators(node)) return []
  return (ts.getDecorators(node) ?? []).flatMap(d => decoratorName(d) ?? [])
}

// `Service`, `Service | null` and `Service | undefined` name the class; anything else (a generic, an intersection) does not
function typeName(type: ts.TypeNode | undefined): string | undefined {
  if (type === undefined) return undefined
  if (ts.isUnionTypeNode(type)) {
    const named = type.types.filter(
      member =>
        member.kind !== ts.SyntaxKind.UndefinedKeyword &&
        !(ts.isLiteralTypeNode(member) && member.literal.kind === ts.SyntaxKind.NullKeyword)
    )
    return named.length === 1 ? typeName(named[0]) : undefined
  }
  return ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)
    ? type.typeName.text
    : undefined
}

function callsIn(body: ts.Node): { calls: Call[]; directIo: boolean } {
  const calls: Call[] = []
  let directIo = false
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      if (NETWORK_FUNCTIONS.has(node.expression.text)) directIo = true
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const callee = node.expression
      const target = callee.expression
      if (target.kind === ts.SyntaxKind.ThisKeyword) {
        calls.push({ field: undefined, method: callee.name.text, network: false })
      } else if (
        ts.isPropertyAccessExpression(target) &&
        target.expression.kind === ts.SyntaxKind.ThisKeyword
      ) {
        calls.push({
          field: target.name.text,
          method: callee.name.text,
          network: NETWORK_METHODS.has(callee.name.text)
        })
      } else if (NETWORK_METHODS.has(callee.name.text)) {
        directIo = true
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(body)
  return { calls, directIo }
}

// `@Res({ passthrough: true })` only sets a header or a cookie and lets Nest send the body: not a stream
function takesStream(parameter: ts.ParameterDeclaration): boolean {
  return (ts.getDecorators(parameter) ?? []).some(decorator => {
    const name = decoratorName(decorator)
    if (name === undefined || !STREAM_PARAMS.has(name)) return false
    const expression = decorator.expression
    if (name !== 'Res' || !ts.isCallExpression(expression)) return true
    return !/passthrough\s*:\s*true/.test(expression.arguments.map(a => a.getText()).join(','))
  })
}

export function parseClasses(file: string, text: string): ClassInfo[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const found: ClassInfo[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name !== undefined) {
      const fields = new Map<string, string>()
      for (const member of node.members) {
        if (ts.isConstructorDeclaration(member)) {
          for (const parameter of member.parameters) {
            const type = typeName(parameter.type)
            if (ts.isIdentifier(parameter.name) && type !== undefined) {
              fields.set(parameter.name.text, type)
            }
          }
        } else if (ts.isPropertyDeclaration(member) && ts.isIdentifier(member.name)) {
          const type = typeName(member.type)
          if (type !== undefined) fields.set(member.name.text, type)
        }
      }
      const classDecorators = decoratorsOf(node)
      const methods: MethodInfo[] = []
      for (const member of node.members) {
        if (!ts.isMethodDeclaration(member) || !ts.isIdentifier(member.name)) continue
        const decorators = decoratorsOf(member)
        const takesResponse = member.parameters.some(takesStream)
        const { calls, directIo } =
          member.body === undefined ? { calls: [], directIo: false } : callsIn(member.body)
        methods.push({
          directIo,
          name: member.name.text,
          line: source.getLineAndCharacterOfPosition(member.getStart(source)).line + 1,
          decorators,
          calls,
          takesResponse,
          marked: decorators.includes('NoTenantTransaction')
        })
      }
      found.push({
        name: node.name.text,
        file,
        fields,
        parent: node.heritageClauses
          ?.find(clause => clause.token === ts.SyntaxKind.ExtendsKeyword)
          ?.types[0]?.expression.getText(source),
        isController: classDecorators.includes('Controller'),
        marked: classDecorators.includes('NoTenantTransaction'),
        methods
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

// Whether a call reaches external I/O. `this.method()` is looked up in the class and in the classes it extends; the type of a field in
// the same chain
function callReaches(
  owner: ClassInfo,
  call: Call,
  byName: ReadonlyMap<string, ClassInfo>,
  roots: ReadonlySet<string>,
  external: ReadonlySet<string>
): boolean {
  const chain: ClassInfo[] = []
  for (
    let current: ClassInfo | undefined = owner;
    current !== undefined && !chain.includes(current);
    current = current.parent === undefined ? undefined : byName.get(current.parent)
  ) {
    chain.push(current)
  }
  if (call.field === undefined) {
    return chain.some(c => external.has(`${c.name}.${call.method}`))
  }
  const target = chain.map(c => c.fields.get(call.field as string)).find(t => t !== undefined)
  if (target === undefined) return false
  if (roots.has(target)) return true
  if (external.has(`${target}.${call.method}`)) return true
  return call.network && !byName.has(target)
}

// The `Class.method` nodes that reach external I/O: a fixed point over the graph
export function externalNodes(
  classes: readonly ClassInfo[],
  providers: readonly ExternalIoProvider[]
): Set<string> {
  const roots = new Set(providers.map(p => p.name))
  const byName = new Map(classes.map(c => [c.name, c]))
  const external = new Set<string>()
  const reaches = (owner: ClassInfo, call: Call): boolean =>
    callReaches(owner, call, byName, roots, external)
  for (let changed = true; changed;) {
    changed = false
    for (const owner of classes) {
      if (roots.has(owner.name)) continue
      for (const method of owner.methods) {
        const key = `${owner.name}.${method.name}`
        if (external.has(key)) continue
        if (method.directIo || method.calls.some(call => reaches(owner, call))) {
          external.add(key)
          changed = true
        }
      }
    }
  }
  return external
}

// The routes of the controllers that must be marked and are not
export function unmarkedExternalRoutes(
  classes: readonly ClassInfo[],
  providers: readonly ExternalIoProvider[]
): ExternalRoute[] {
  const external = externalNodes(classes, providers)
  const roots = new Set(providers.map(p => p.name))
  const byName = new Map(classes.map(c => [c.name, c]))
  const routes: ExternalRoute[] = []
  for (const owner of classes) {
    if (!owner.isController || owner.marked) continue
    for (const method of owner.methods) {
      if (method.marked || !method.decorators.some(name => ROUTE_DECORATORS.has(name))) continue
      const reached = method.calls.find(call => callReaches(owner, call, byName, roots, external))
      const why = method.directIo
        ? 'calls a remote API itself'
        : reached
          ? `calls ${reached.field === undefined ? 'this' : `this.${reached.field}`}.${reached.method}(), which reaches I/O outside the database`
          : method.takesResponse
            ? 'takes the response or a file stream itself (@Res / @UploadedFile)'
            : undefined
      if (why !== undefined) {
        routes.push({
          key: `${owner.file}#${owner.name}.${method.name}`,
          file: owner.file,
          line: method.line,
          why
        })
      }
    }
  }
  return routes.sort((a, b) => a.key.localeCompare(b.key))
}

// Providers listed that no class has: a stale entry would hide the next boundary behind a name that no longer exists
export function unknownProviders(
  classes: readonly ClassInfo[],
  providers: readonly ExternalIoProvider[]
): string[] {
  const names = new Set(classes.map(c => c.name))
  return providers.filter(p => !names.has(p.name)).map(p => p.name)
}

export type ExternalIoBaseline = readonly string[]

// The keys that are in the current list and not in the baseline: the routes that are new, or that lost their mark
export function newlyUnmarked(
  baseline: ExternalIoBaseline,
  current: readonly ExternalRoute[]
): ExternalRoute[] {
  const allowed = new Set(baseline)
  return current.filter(route => !allowed.has(route.key))
}

// The entries of the baseline that are fixed (marked, or gone): they can be removed, and the check asks to
export function fixedEntries(
  baseline: ExternalIoBaseline,
  current: readonly ExternalRoute[]
): string[] {
  const keys = new Set(current.map(route => route.key))
  return baseline.filter(key => !keys.has(key))
}

// Entries on the baseline of the pull request that are not on the one of main: the list cannot grow
export function baselineGrowth(previous: ExternalIoBaseline, next: ExternalIoBaseline): string[] {
  const before = new Set(previous)
  return next.filter(key => !before.has(key))
}
