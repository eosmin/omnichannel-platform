import * as ts from 'typescript'

// What a function that reads from the replica may not do (TDD_08 §2.5: "anything in a write path, guards and the inbound
// pipeline use the primary"). The calls are the ones a service has for writing or for holding a lock or a transaction, and
// the words are the ones a raw statement uses for it.
const WRITE_CALLS = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
  'delete',
  'deleteMany',
  '$executeRaw',
  '$executeRawUnsafe',
  '$transaction',
  'transaction',
  'tenantTransaction',
  'afterCommit',
  'lockStoreForWrite',
  'lockCustomerForWrite'
])
const WRITE_SQL =
  /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE)\b|\bFOR\s+(UPDATE|SHARE|NO\s+KEY\s+UPDATE)\b/i
const WRITE_DECORATORS = new Set(['Post', 'Put', 'Patch', 'Delete'])

export interface ReplicaViolation {
  file: string
  line: number
  message: string
}

function isReplicaCall(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    // `replicaTenantRead(context, fn)` is the only way to read the replica (it carries the tenant context); `replica()` with no
    // argument is the old shape, still recognized so that a call that came back is refused like any other
    ((node.expression.name.text === 'replica' && node.arguments.length === 0) ||
      node.expression.name.text === 'replicaTenantRead')
  )
}

const REPLICA_NAME = 'replicaTenantRead'

// A way to reach the method that is not `x.replicaTenantRead(...)`: the method taken as a value (`const read = x.replicaTenantRead`), a
// destructured one (`const { replicaTenantRead } = x`), a string key (`x['replicaTenantRead']`) or a bare call. Each one passes the
// method around under a name the rest of this check does not look for, so it is refused like any other call outside a listed reader
function isIndirectReplicaReference(node: ts.Node): boolean {
  if (ts.isPropertyAccessExpression(node) && node.name.text === REPLICA_NAME) {
    const parent = node.parent
    return !(ts.isCallExpression(parent) && parent.expression === node)
  }
  // The name as a string anywhere (`x['replicaTenantRead']`, a computed key, `Reflect.get(x, 'replicaTenantRead')`, a const key); the
  // import of a module and a message that is not a code path are the only other places such a string can be
  if (ts.isStringLiteralLike(node) && node.text === REPLICA_NAME) {
    return !ts.isImportDeclaration(node.parent) && !ts.isExportDeclaration(node.parent)
  }
  // A key built at run time on the prisma service (`this.prisma[key]`, `this.prisma['replica' + 'TenantRead']`)
  if (ts.isElementAccessExpression(node)) {
    return (
      /\bprisma$/i.test(node.expression.getText()) &&
      !ts.isStringLiteralLike(node.argumentExpression)
    )
  }
  // Only an object pattern names a property of the object (`const { replicaTenantRead } = x`); `const [replicaTenantRead] = list` does not
  if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
    const name = node.propertyName ?? node.name
    return ts.isIdentifier(name) && name.text === REPLICA_NAME
  }
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === REPLICA_NAME
  )
}

function enclosingFunction(node: ts.Node): ts.FunctionLikeDeclaration | undefined {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (
      ts.isMethodDeclaration(current) ||
      ts.isFunctionDeclaration(current) ||
      ts.isArrowFunction(current) ||
      ts.isFunctionExpression(current)
    ) {
      // An arrow inside a method is part of the method: look at the outermost one
      const outer = enclosingFunction(current)
      return outer ?? current
    }
  }
  return undefined
}

function writesIn(body: ts.Node, source: ts.SourceFile): ReplicaViolation[] {
  const found: ReplicaViolation[] = []
  const at = (node: ts.Node): number =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const name = ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : ts.isIdentifier(callee)
          ? callee.text
          : undefined
      if (name !== undefined && WRITE_CALLS.has(name)) {
        found.push({
          file: source.fileName,
          line: at(node),
          message: `${name}() in a function that reads from the replica`
        })
      }
    }
    // `$executeRaw` and `$queryRaw` are used as tags: the tag is the call
    if (ts.isTaggedTemplateExpression(node)) {
      const tag = node.tag
      const name = ts.isPropertyAccessExpression(tag)
        ? tag.name.text
        : ts.isIdentifier(tag)
          ? tag.text
          : undefined
      if (name !== undefined && WRITE_CALLS.has(name)) {
        found.push({
          file: source.fileName,
          line: at(node),
          message: `${name} in a function that reads from the replica`
        })
      }
      // Only the text of a statement is looked at (a log message that says "update" is not one), and not its SQL comments
      const template = node.template
      const text = ts.isTemplateExpression(template)
        ? [template.head.text, ...template.templateSpans.map(span => span.literal.text)].join(' ')
        : template.text
      if (WRITE_SQL.test(text.replace(/--[^\n]*/g, ' '))) {
        found.push({
          file: source.fileName,
          line: at(node),
          message: 'a statement that writes or locks, in a function that reads from the replica'
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(body)
  return found
}

// Limits, on purpose: the check looks at the function that holds the `replica()` call, so a write that a helper does for it
// is for the review to see; and `x.replica()` is the only shape it knows. A name like `delete` on any object counts as a
// write (it fails closed: restructure the reader, do not loosen the check).
// The violations of one file: a `replica()` call outside the list of readers, in a guard, in a route that writes (a
// controller method with @Post, @Put, @Patch or @Delete) or in a function that also writes. `calls` is how many
// `replica()` calls the file has, so the caller can tell a reader that no longer reads from the replica.
export function checkReplicaUse(
  file: string,
  text: string,
  readers: readonly string[]
): { violations: ReplicaViolation[]; calls: number } {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const violations: ReplicaViolation[] = []
  let calls = 0
  const lineOf = (node: ts.Node): number =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
  const visit = (node: ts.Node): void => {
    if (isIndirectReplicaReference(node)) {
      calls++
      violations.push({
        file,
        line: lineOf(node),
        message: `${REPLICA_NAME} reached through another name or as a value: call it as x.${REPLICA_NAME}(context, fn)`
      })
    }
    if (isReplicaCall(node)) {
      calls++
      const line = lineOf(node)
      if (!readers.includes(file)) {
        violations.push({
          file,
          line,
          message: 'replica() outside the files of scripts/replica-readers.ts'
        })
      }
      if (/\.guard\.ts$/.test(file) || /\.interceptor\.ts$/.test(file)) {
        violations.push({
          file,
          line,
          message: 'replica() in a guard or an interceptor: they read the primary'
        })
      }
      const fn = enclosingFunction(node)
      if (fn !== undefined) {
        const decorators = ts.canHaveDecorators(fn) ? (ts.getDecorators(fn) ?? []) : []
        for (const decorator of decorators) {
          const expression = decorator.expression
          const name =
            ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)
              ? expression.expression.text
              : undefined
          if (name !== undefined && WRITE_DECORATORS.has(name)) {
            violations.push({ file, line, message: `replica() in a route that writes (@${name})` })
          }
        }
        if (fn.body !== undefined) violations.push(...writesIn(fn.body, source))
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  // The same function reports once for each of its replica() calls: keep one of each
  const unique = new Map(violations.map(v => [`${v.line}:${v.message}`, v]))
  return { violations: [...unique.values()], calls }
}

// The readers that no longer call replicaTenantRead() (or the old replica()): a stale entry would let the next call in that file through unnoticed
export function staleReaders(
  readers: readonly string[],
  callsByFile: ReadonlyMap<string, number>
): string[] {
  return readers.filter(file => (callsByFile.get(file) ?? 0) === 0)
}
