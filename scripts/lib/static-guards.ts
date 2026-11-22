// Two static guards read from the TypeScript syntax tree (a comment, a string or dead text does not count), shared by the CLIs
// scripts/validate-store-context-writes.ts and scripts/validate-refused-audit.ts and by scripts/lib/static-guards.spec.ts.
//
// 1. NO WRITE INSIDE inStoreContext. PrismaService.inStoreContext opens the context {storeIds: [x], organizationIds: []}: a read-only
//    organ. A write there that fires a trigger which reads a table of the ORGANIZATION (warehouses, stock_*, ledger_accounts) fails
//    with the empty organization context. The callback is read to any depth, following `this.method()` into the same class and
//    `helper()` into a function of the same file. Limit: a call into ANOTHER file (an imported helper, an injected service) is not
//    followed; a reviewer reads those, and the callback that is not written inline nor resolvable in the file is itself refused.
//    Forms followed: (a) a callback written inline, to any depth; (b) a callback passed as an IDENTIFIER (`const work = () => ...;
//    inStoreContext(id, work)`) or as `this.member`, resolved to its declaration in the same file; (c) `this.method()` of the same
//    class and `helper()` of the same file, from inside the callback. NOT followed (the main false negative, read in review): a call
//    that delegates to ANOTHER service (`this.orders.create(...)`) or to an imported function. The calls are searched as
//    `x.inStoreContext(` and the bare `inStoreContext(`; the free helper of the test fixtures (`inStoreContext(prisma, ...)`) lives in
//    tests/ and in specs, which are not scanned. Raw SQL: a `$queryRaw` / `$queryRawUnsafe` whose text is INSERT / UPDATE / DELETE /
//    MERGE / TRUNCATE / COPY, or selects a function of the database known to write (WRITING_FUNCTIONS), counts as a write, as does
//    `$executeRaw(Unsafe)`. A call through a dynamic key (`client[model][op](...)`) inside the callback is refused as suspect.
//    `audit.log(...)` inside a callback is NOT a write for this guard on purpose: it queues the entry for the request transaction
//    (beforeCommit), it does not write in the store context.
//    The seven uses today are reads: product-search.service (rls_search_products), search.service (the search functions),
//    agent-typing-relay.service (a findFirst of the conversation), inventory-queries.service (a read of levels), customer-search.ts
//    (two: rls_search_customer_list reads), order-text-customers.ts (rls_search_order_customers).
// 2. AuditService.logRefused only for denials. It writes on a transaction of its own and survives a rollback, so a success recorded
//    through it would stay although its action was reverted. Only the listed files may reference it.
// 3. A JOB IS QUEUED AFTER THE REAL COMMIT. With RLS_CONTEXT a request is ONE transaction that the interceptor commits when the handler
//    returns, and `prisma.transaction()` inside it only joins it: a `queue.add` written after it runs BEFORE the commit, the worker
//    can start before the row is visible, finds none and ends without a retry. Every `X.add(` / `X.addBulk(` whose receiver is named
//    like a queue (`queue`, `heavyQueue`, `this.emailQueue`...) in apps/api and libs must be written inside the function given to
//    `PrismaService.afterCommitStep(...)`, or its file is listed in QUEUE_ADD_ALLOWED with the reason it is safe where it is. Read from
//    the syntax tree, so a call split over lines (`this.heavyQueue\n.add(`) is seen. NOT followed: a call through a wrapper that is
//    itself called inside a step, or a queue held under a name that does not end in `queue` (a reviewer reads those).
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import * as ts from 'typescript'

export interface Finding {
  file: string
  line: number
  reason: string
}

// Writes allowed inside inStoreContext, per file. It can only SHRINK: a bigger number fails, a smaller one fails too until the entry
// is lowered or removed. Today every use is a read.
export const STORE_CONTEXT_WRITES_ALLOWED: Readonly<Record<string, number>> = {}

// References to AuditService.logRefused (denials only), per file. Same rule: it can only shrink. Its own declaration is not a use.
export const LOG_REFUSED_CALLERS: Readonly<Record<string, number>> = {
  'apps/api/src/modules/plugins/plugin-denial-audit.ts': 1
}

// Files of apps/api and libs that call `.add(` / `.addBulk(` on a queue OUTSIDE afterCommitStep, with how many, and why that is safe
// there. It can only SHRINK (a bigger number fails, a smaller one fails too until the entry is lowered). A new call goes through
// `prisma.afterCommitStep(prisma.client, () => queue.add(...))`; an entry here needs a reviewer who read the caller.
export const QUEUE_ADD_ALLOWED: Readonly<Record<string, number>> = {
  // A public route (no transaction of the request: `tenantContextOf` is undefined) and a job that carries what it needs in its payload
  'apps/api/src/modules/auth/magic-link.service.ts': 1,
  'apps/api/src/modules/carriers/carrier-webhook.service.ts': 1,
  'apps/api/src/modules/compliance/dsr-intake.service.ts': 1, // The public data request form: the route holds no transaction and the sealed payload is the whole job
  // Inside the transaction on purpose, as the LAST step of it: the answer to the person is queued before the sealed address is cleared, so a queue
  // that is down rolls the decision back; a commit that fails after it re-sends the same notice at worst (Step 7.2-H1b)
  'apps/api/src/modules/compliance/dsr-review.service.ts': 1,
  'apps/api/src/modules/channels/inbound-event-queue.service.ts': 1,
  'apps/api/src/modules/webhooks/resend-webhook.controller.ts': 1,
  // Payload only (the event of an analytics row is the whole job; nothing it reads was written by the request)
  'apps/api/src/modules/search/search-tracker.service.ts': 1,
  // The job reads a ledger that was committed by an earlier request, and its id is made of the organization (a cooldown of the queue)
  'apps/api/src/modules/finance/finance-chain.service.ts': 1,
  // The email is queued FIRST on purpose, under an id made from the key; the dispatch is claimed after it (see the comment there)
  'apps/api/src/modules/order-messages/order-messages.service.ts': 1,
  // The deliveries of a webhook name rows that were committed earlier (the webhook) and carry the body in the job; the dispatcher runs
  // from a listener after the commit of the event
  'apps/api/src/modules/tenant-webhooks/webhook-dispatcher.ts': 2,
  // After a unit of `inStore` (a unit of its own that committed); the queue is never inside one (see the comment there)
  'libs/core/messaging/src/inbound/inbound-message.service.ts': 2,
  // Inside the transaction on purpose: the worker takes the row lock before it clears the entry, so it reads this commit
  'libs/core/messaging/src/messages/media-refetch.service.ts': 1,
  // The callers queue through `prisma.afterCommit(tx, () => outbound.enqueue(...))`, which is after the real commit (the pattern of the
  // reply, the edit, the delete, the caption and the requeue); the typing and the read receipt carry what the job needs
  'libs/core/messaging/src/outbound/outbound-queue.ts': 7
}

const WRITE_METHODS = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'delete',
  'deleteMany',
  'upsert',
  '$executeRaw',
  '$executeRawUnsafe',
  'transaction',
  '$transaction',
  'tenantTransaction'
])
const RAW_QUERIES = new Set(['$queryRaw', '$queryRawUnsafe'])
// Anywhere in the statement, so a CTE (`WITH x AS (...) UPDATE ...`) is seen too. Column names such as updated_at do not match \bupdate\b.
const WRITING_SQL = /\b(insert|update|delete|merge|truncate|copy)\b/i
// Functions of the database that write although they are called with SELECT. A LIST, but not one kept from memory: static-guards.spec
// crosses it with the migrations (every non-trigger function whose body inserts, updates or deletes must be here).
export const WRITING_FUNCTION_NAMES: readonly string[] = [
  'rls_clear_orphan_avatar',
  'rls_take_disconnected_connection',
  'purge_audit_logs',
  // the re-seal of a rotation of the credentials key (Step 7.3-S11b): the swap of the sealed columns of a fiscal document or contingency
  'fiscal_reseal_document',
  'fiscal_reseal_contingency'
]
const WRITING_FUNCTIONS = new RegExp(`\\b(${WRITING_FUNCTION_NAMES.join('|')})\\s*\\(`, 'i')
const writesSql = (text: string): boolean => WRITING_SQL.test(text) || WRITING_FUNCTIONS.test(text)

const parse = (text: string, file: string): ts.SourceFile =>
  ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )

// The literal text of a statement: a string, a template (its fixed parts), or `Prisma.sql` / `sql` over one. Undefined when it is built
// from something else (a variable), which cannot be read.
function sqlTextOf(node: ts.Expression): string | undefined {
  const at = unwrap(node)
  if (ts.isStringLiteralLike(at)) return at.text
  if (ts.isTemplateExpression(at)) {
    return [at.head.text, ...at.templateSpans.map(span => span.literal.text)].join(' ')
  }
  if (ts.isTaggedTemplateExpression(at)) return sqlTextOf(at.template)
  return undefined
}

const lineOf = (node: ts.Node): number =>
  node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1

const unwrap = (node: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)
    ? unwrap(node.expression)
    : node

const calleeName = (call: ts.CallExpression): string | undefined => {
  const callee = unwrap(call.expression)
  // `x.create.call(...)`, `.apply(...)`: the method is the one the call/apply/bind hangs from
  if (
    ts.isPropertyAccessExpression(callee) &&
    ['call', 'apply', 'bind'].includes(callee.name.text) &&
    ts.isPropertyAccessExpression(unwrap(callee.expression))
  ) {
    return (unwrap(callee.expression) as ts.PropertyAccessExpression).name.text
  }
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text
  if (ts.isIdentifier(callee)) return callee.text
  if (ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression)) {
    return callee.argumentExpression.text
  }
  return undefined
}

const isFunctionLike = (
  node: ts.Node
): node is
  ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration | ts.MethodDeclaration =>
  ts.isArrowFunction(node) ||
  ts.isFunctionExpression(node) ||
  ts.isFunctionDeclaration(node) ||
  ts.isMethodDeclaration(node)

// The named functions of a file: top-level functions and arrows, and the methods of every class by name
function declaredFunctions(source: ts.SourceFile): {
  functions: Map<string, ts.Node>
  methods: Map<ts.ClassLikeDeclaration, Map<string, ts.Node>>
} {
  const functions = new Map<string, ts.Node>()
  const methods = new Map<ts.ClassLikeDeclaration, Map<string, ts.Node>>()
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
      functions.set(statement.name.text, statement)
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.initializer !== undefined &&
          isFunctionLike(declaration.initializer)
        ) {
          functions.set(declaration.name.text, declaration.initializer)
        }
      }
    }
  }
  const visit = (node: ts.Node): void => {
    if (ts.isClassLike(node)) {
      const own = new Map<string, ts.Node>()
      for (const member of node.members) {
        if (ts.isMethodDeclaration(member) && ts.isIdentifier(member.name)) {
          own.set(member.name.text, member)
        }
        if (
          ts.isPropertyDeclaration(member) &&
          ts.isIdentifier(member.name) &&
          member.initializer !== undefined &&
          isFunctionLike(member.initializer)
        ) {
          own.set(member.name.text, member.initializer)
        }
      }
      methods.set(node, own)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return { functions, methods }
}

const enclosingClass = (node: ts.Node): ts.ClassLikeDeclaration | undefined => {
  for (let at = node.parent as ts.Node | undefined; at !== undefined; at = at.parent) {
    if (ts.isClassLike(at)) return at
  }
  return undefined
}

function writeReasonOf(call: ts.CallExpression): string | undefined {
  const name = calleeName(call)
  if (name === undefined) return undefined
  if (WRITE_METHODS.has(name)) return `${name}(`
  return undefined
}

// Every write reached from `root`, following the calls into the same class / the same file
function writesReachedFrom(
  root: ts.Node,
  declared: ReturnType<typeof declaredFunctions>,
  followed: Set<ts.Node>
): Finding[] {
  const found: Finding[] = []
  // A method or function of the file REACHED, called or only passed as a value (`rows.map(this.persist)`): `this.method` and a bare name
  // that resolves to a declaration of the file are followed wherever they stand, not only as the callee of a call
  const follow = (node: ts.Node): void => {
    let target: ts.Node | undefined
    if (ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword) {
      const owner = enclosingClass(node)
      target = owner === undefined ? undefined : declared.methods.get(owner)?.get(node.name.text)
    } else if (
      ts.isIdentifier(node) &&
      !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
    ) {
      target = declared.functions.get(node.text)
    }
    if (target !== undefined && !followed.has(target)) {
      followed.add(target)
      walk(target)
    }
  }
  const walk = (node: ts.Node): void => {
    follow(node)
    if (ts.isCallExpression(node)) {
      const reason = writeReasonOf(node)
      if (reason !== undefined) {
        found.push({ file: node.getSourceFile().fileName, line: lineOf(node), reason })
      }
      const callee = node.expression
      const dynamicKey = (access: ts.Node): boolean =>
        ts.isElementAccessExpression(access) && !ts.isStringLiteralLike(access.argumentExpression)
      if (
        dynamicKey(callee) ||
        (ts.isElementAccessExpression(callee) && dynamicKey(callee.expression)) ||
        (ts.isPropertyAccessExpression(callee) && dynamicKey(callee.expression))
      ) {
        found.push({
          file: node.getSourceFile().fileName,
          line: lineOf(node),
          reason: 'a call through a dynamic key (client[model][op](...)) is suspect'
        })
      }
      const name = calleeName(node)
      if (name !== undefined && RAW_QUERIES.has(name)) {
        const first = node.arguments[0]
        const sql = first === undefined ? undefined : sqlTextOf(first)
        if (sql === undefined) {
          found.push({
            file: node.getSourceFile().fileName,
            line: lineOf(node),
            reason: `${name}( with a statement that is not a literal: it cannot be read`
          })
        } else if (writesSql(sql)) {
          found.push({
            file: node.getSourceFile().fileName,
            line: lineOf(node),
            reason: `${name}( with a writing statement`
          })
        }
      }
    }
    if (ts.isTaggedTemplateExpression(node)) {
      const tag = ts.isPropertyAccessExpression(node.tag)
        ? node.tag.name.text
        : ts.isIdentifier(node.tag)
          ? node.tag.text
          : undefined
      if (tag !== undefined) {
        const template = node.template
        const text = ts.isNoSubstitutionTemplateLiteral(template)
          ? template.text
          : [template.head.text, ...template.templateSpans.map(span => span.literal.text)].join(' ')
        if (WRITE_METHODS.has(tag) || (RAW_QUERIES.has(tag) && writesSql(text))) {
          found.push({
            file: node.getSourceFile().fileName,
            line: lineOf(node),
            reason: `${tag}\`...\``
          })
        }
      }
    }
    ts.forEachChild(node, walk)
  }
  walk(root)
  return found
}

// Every write reached from the callback of a call to inStoreContext(storeId, work, userId?) in this source
// A callback that is passed through a forward and cannot be resolved at one of its call sites
const UNREADABLE: ts.Node = ts.factory.createEmptyStatement()

export function findStoreContextWrites(text: string, file: string): Finding[] {
  if (!text.includes('inStoreContext')) return []
  const source = parse(text, file)
  const declared = declaredFunctions(source)
  const found: Finding[] = []

  // A function or arrow held in a variable declared in a block that encloses `at` (the nearest one wins over the module level)
  const localFunction = (name: string, at: ts.Node): ts.Node | undefined => {
    for (let up = at.parent as ts.Node | undefined; up !== undefined; up = up.parent) {
      if (!ts.isBlock(up)) continue
      for (const statement of up.statements) {
        if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement
        if (!ts.isVariableStatement(statement)) continue
        for (const declaration of statement.declarationList.declarations) {
          if (
            ts.isIdentifier(declaration.name) &&
            declaration.name.text === name &&
            declaration.initializer !== undefined &&
            isFunctionLike(declaration.initializer)
          ) {
            return declaration.initializer
          }
        }
      }
    }
    return undefined
  }

  // The function-like (method, function, arrow) whose parameter `name` is, with its name, or undefined when `name` is no parameter
  const forwarder = (
    name: string,
    at: ts.Node
  ): { index: number; owner?: ts.ClassLikeDeclaration; fn: string } | undefined => {
    for (let up = at.parent as ts.Node | undefined; up !== undefined; up = up.parent) {
      if (!isFunctionLike(up)) continue
      const index = up.parameters.findIndex(p => ts.isIdentifier(p.name) && p.name.text === name)
      if (index < 0) continue
      const fn = up.name !== undefined && ts.isIdentifier(up.name) ? up.name.text : undefined
      if (fn === undefined) return undefined
      // Only a forward that nobody outside this file can call is read through its call sites in this file: a public method, or an
      // exported function, could be called with a write from another file
      const reach = ts.getCombinedModifierFlags(up)
      if (ts.isMethodDeclaration(up) && (reach & ts.ModifierFlags.Private) === 0) return undefined
      if (ts.isFunctionDeclaration(up) && (reach & ts.ModifierFlags.Export) !== 0) return undefined
      return { index, owner: ts.isMethodDeclaration(up) ? enclosingClass(up) : undefined, fn }
    }
    return undefined
  }

  // The bodies the callback expression stands for, or undefined when it cannot be read in this file. A callback that is a parameter of
  // the function it sits in is a FORWARD (`private inContext(id, work) { return prisma.inStoreContext(id, work) }`): what is read is
  // the argument of every call to that function in this file, and a forward nobody calls in this file cannot be read.
  const bodiesOf = (
    expr: ts.Expression | undefined,
    at: ts.Node,
    depth: number
  ): ts.Node[] | undefined => {
    if (expr === undefined || depth > 4) return undefined
    if (isFunctionLike(expr)) return [expr]
    if (ts.isIdentifier(expr)) {
      const named = localFunction(expr.text, at) ?? declared.functions.get(expr.text)
      if (named !== undefined) return [named]
      const through = forwarder(expr.text, at)
      if (through === undefined) return undefined
      const bodies: ts.Node[] = []
      let calls = 0
      const scan = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const callee = node.expression
          const sameFn =
            through.owner !== undefined
              ? ts.isPropertyAccessExpression(callee) &&
                callee.expression.kind === ts.SyntaxKind.ThisKeyword &&
                callee.name.text === through.fn
              : ts.isIdentifier(callee) && callee.text === through.fn
          if (sameFn) {
            calls += 1
            const inner = bodiesOf(node.arguments[through.index], node, depth + 1)
            if (inner === undefined) bodies.push(UNREADABLE)
            else bodies.push(...inner)
          }
        }
        ts.forEachChild(node, scan)
      }
      scan(source)
      return calls === 0 ? undefined : bodies
    }
    if (ts.isPropertyAccessExpression(expr) && expr.expression.kind === ts.SyntaxKind.ThisKeyword) {
      const owner = enclosingClass(at)
      const method =
        owner === undefined ? undefined : declared.methods.get(owner)?.get(expr.name.text)
      return method === undefined ? undefined : [method]
    }
    return undefined
  }

  const isDirectCall = (node: ts.Node): boolean =>
    ts.isCallExpression(node.parent) && node.parent.expression === node
  const aliased = (node: ts.Node): boolean => {
    if (ts.isPropertyAccessExpression(node)) {
      return node.name.text === 'inStoreContext' && !isDirectCall(node)
    }
    if (ts.isElementAccessExpression(node)) {
      return (
        ts.isStringLiteralLike(node.argumentExpression) &&
        node.argumentExpression.text === 'inStoreContext' &&
        !isDirectCall(node)
      )
    }
    if (ts.isBindingElement(node)) {
      const names = [node.name, node.propertyName]
      return names.some(
        name => name !== undefined && ts.isIdentifier(name) && name.text === 'inStoreContext'
      )
    }
    if (ts.isShorthandPropertyAssignment(node)) return node.name.text === 'inStoreContext'
    // The bare name used as a value: `const f = inStoreContext`, `run(inStoreContext)`
    return (
      ts.isIdentifier(node) &&
      node.text === 'inStoreContext' &&
      ((ts.isVariableDeclaration(node.parent) && node.parent.initializer === node) ||
        (ts.isCallExpression(node.parent) && node.parent.arguments.includes(node)))
    )
  }
  const visit = (node: ts.Node): void => {
    if (aliased(node)) {
      found.push({
        file,
        line: lineOf(node),
        reason:
          'inStoreContext is aliased (bind, destructuring, a reference): its callback cannot be followed'
      })
    }
    // `x.inStoreContext.bind(...)` is reported once, as the alias it is
    const viaBind =
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ['call', 'apply', 'bind'].includes(node.expression.name.text)
    if (ts.isCallExpression(node) && !viaBind && calleeName(node) === 'inStoreContext') {
      const bodies = bodiesOf(node.arguments[1], node, 0)
      if (bodies === undefined || bodies.includes(UNREADABLE)) {
        found.push({
          file,
          line: lineOf(node),
          reason:
            'the callback is not written inline nor resolvable in this file: it cannot be read'
        })
      }
      for (const body of bodies ?? []) {
        if (body !== UNREADABLE) found.push(...writesReachedFrom(body, declared, new Set([body])))
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

// Every reference to `logRefused` that is not its own declaration: a call, a property read, an alias, a destructuring
export function findLogRefusedUses(text: string, file: string): Finding[] {
  if (!text.includes('logRefused')) return []
  const source = parse(text, file)
  const found: Finding[] = []
  const add = (node: ts.Node): void => {
    found.push({ file, line: lineOf(node), reason: 'logRefused' })
  }
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'logRefused') add(node)
    else if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === 'logRefused'
    ) {
      add(node)
    } else if (
      (ts.isBindingElement(node) || ts.isShorthandPropertyAssignment(node)) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'logRefused'
    ) {
      add(node)
    } else if (
      ts.isBindingElement(node) &&
      node.propertyName !== undefined &&
      (ts.isIdentifier(node.propertyName) || ts.isStringLiteralLike(node.propertyName)) &&
      node.propertyName.text === 'logRefused'
    ) {
      // const { logRefused: alias } = audit
      add(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

// Every `X.add(...)` / `X.addBulk(...)` whose receiver ends in `queue` (any case) that is NOT inside the function given to a call of
// `afterCommitStep`. The receiver is the last name of the expression: `this.heavyQueue`, `queue`, `deps.emailQueue`.
export function findQueueAddsOutsideAfterCommit(text: string, file: string): Finding[] {
  if (!/[qQ]ueue/.test(text)) return []
  const source = parse(text, file)
  const found: Finding[] = []
  const receiverName = (node: ts.Expression): string | undefined => {
    const at = unwrap(node)
    if (ts.isIdentifier(at)) return at.text
    if (ts.isPropertyAccessExpression(at)) return at.name.text
    return undefined
  }
  const visit = (node: ts.Node, inStep: boolean): void => {
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression)
      if (
        ts.isPropertyAccessExpression(callee) &&
        ['add', 'addBulk'].includes(callee.name.text) &&
        /queue$/i.test(receiverName(callee.expression) ?? '') &&
        !inStep
      ) {
        found.push({ file, line: lineOf(node), reason: `${callee.name.text}(` })
      }
      // The arguments of afterCommitStep(db, step) are the step: what is written inside it runs after the commit
      if (calleeName(node) === 'afterCommitStep') {
        ts.forEachChild(node.expression, child => visit(child, inStep))
        // Only a function is the step: `afterCommitStep(this.queue.add(...), ...)` would run the add NOW
        for (const argument of node.arguments) {
          const at = unwrap(argument)
          visit(argument, ts.isArrowFunction(at) || ts.isFunctionExpression(at))
        }
        return
      }
    }
    ts.forEachChild(node, child => visit(child, inStep))
  }
  visit(source, false)
  return found
}

const SCANNED_DIRS = ['apps', 'libs']
// Skipped by EXACT place, never by a name at any depth (production code in a folder called `generated` must still be read: the
// image hosts of the web are in apps/web/lib/generated). Scanned: .ts, .tsx, .mts, .cts (there is no .js in apps/ or libs/ outside
// configuration files).
const SKIPPED_PATHS = [
  /(^|\/)node_modules$/,
  /^apps\/[^/]+\/(\.next|dist)$/,
  /^libs\/core\/database\/generated$/
]

// The production sources of apps/ and libs/ (specs are fixtures, not callers)
export function productionSources(root: string): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(join(root, dir), { withFileTypes: true }).flatMap(entry => {
      const path = `${dir}/${entry.name}`
      if (entry.isDirectory()) return SKIPPED_PATHS.some(skip => skip.test(path)) ? [] : walk(path)
      return /\.[mc]?tsx?$/.test(entry.name) && !/\.(spec|test)\.[mc]?tsx?$/.test(entry.name)
        ? [path]
        : []
    })
  return SCANNED_DIRS.flatMap(walk)
}

export interface GuardReport {
  scanned: number
  failures: string[]
}

// Compares what was found per file with what is allowed per file: more fails, fewer fails too (the entry must be lowered)
function compare(
  found: Map<string, Finding[]>,
  allowed: Readonly<Record<string, number>>,
  describe: (finding: Finding) => string
): string[] {
  const failures: string[] = []
  for (const [file, findings] of found) {
    const limit = allowed[file] ?? 0
    if (findings.length > limit) {
      for (const finding of findings) failures.push(`${file}:${finding.line}: ${describe(finding)}`)
    }
  }
  for (const [file, limit] of Object.entries(allowed)) {
    const count = found.get(file)?.length ?? 0
    if (count < limit) {
      failures.push(`${file}: allowed ${limit} but found ${count}: lower or remove the entry`)
    }
  }
  return failures
}

function scan(
  root: string,
  finder: (text: string, file: string) => Finding[]
): {
  scanned: number
  found: Map<string, Finding[]>
} {
  const files = productionSources(root)
  const found = new Map<string, Finding[]>()
  for (const file of files) {
    const findings = finder(readFileSync(join(root, file), 'utf8'), file)
    if (findings.length > 0) found.set(file, findings)
  }
  return { scanned: files.length, found }
}

export function checkStoreContextWrites(root: string): GuardReport {
  const { scanned, found } = scan(root, findStoreContextWrites)
  return {
    scanned,
    failures: compare(
      found,
      STORE_CONTEXT_WRITES_ALLOWED,
      finding => `${finding.reason} inside inStoreContext`
    )
  }
}

export function checkRefusedAudit(root: string): GuardReport {
  const { scanned, found } = scan(root, findLogRefusedUses)
  return {
    scanned,
    failures: compare(
      found,
      LOG_REFUSED_CALLERS,
      () => 'AuditService.logRefused is only for plugin denials'
    )
  }
}

export function checkQueueAddsAfterCommit(root: string): GuardReport {
  // The worker is another process: its jobs run in units of JobContext of their own, and are not covered by this rule
  const { scanned, found } = scan(root, (text, file) =>
    /^(apps\/api|libs)\//.test(file) ? findQueueAddsOutsideAfterCommit(text, file) : []
  )
  return {
    scanned,
    failures: compare(
      found,
      QUEUE_ADD_ALLOWED,
      finding =>
        `queue.${finding.reason} outside afterCommitStep: with RLS_CONTEXT the job can start before the COMMIT of the request`
    )
  }
}
