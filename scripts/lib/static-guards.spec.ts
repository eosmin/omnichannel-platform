import { join } from 'node:path'

import {
  LOG_REFUSED_CALLERS,
  STORE_CONTEXT_WRITES_ALLOWED,
  checkRefusedAudit,
  checkStoreContextWrites,
  findLogRefusedUses,
  findStoreContextWrites
} from './static-guards'

const ROOT = join(__dirname, '..', '..')
const writes = (code: string): string[] =>
  findStoreContextWrites(code, 'probe.ts').map(finding => `${finding.line}:${finding.reason}`)

describe('no write inside inStoreContext', () => {
  it.each([
    ['a create', 'x.inStoreContext(s, () => tx.order.create({ data }))', '1:create('],
    [
      'an update through an async arrow',
      'x.inStoreContext(s, async () => { await p.client.order.update({}) })',
      '1:update('
    ],
    ['a deleteMany', 'x.inStoreContext(s, () => p.client.note.deleteMany({}))', '1:deleteMany('],
    ['an upsert', 'x.inStoreContext(s, () => p.client.note.upsert({}))', '1:upsert('],
    ['a createMany', 'x.inStoreContext(s, () => p.client.note.createMany({}))', '1:createMany('],
    ['an updateMany', 'x.inStoreContext(s, () => p.client.note.updateMany({}))', '1:updateMany('],
    [
      'an $executeRaw template',
      'x.inStoreContext(s, () => p.client.$executeRaw`SELECT 1`)',
      '1:$executeRaw`...`'
    ],
    ['a $transaction', 'x.inStoreContext(s, () => p.client.$transaction([]))', '1:$transaction('],
    ['a transaction', 'x.inStoreContext(s, () => p.transaction(() => 1))', '1:transaction('],
    [
      'an INSERT through $queryRaw',
      'x.inStoreContext(s, () => p.$queryRaw`INSERT INTO t VALUES (${a})`)',
      '1:$queryRaw`...`'
    ],
    [
      'a write in a method the callback reaches through this',
      'class A { run() { return this.p.inStoreContext(s, () => this.save()) } save() { return this.p.client.order.update({}) } }',
      '1:update('
    ],
    [
      'a write two methods deep',
      'class A { run() { return this.p.inStoreContext(s, () => this.a()) } a() { return this.b() } b() { return t.delete({}) } }',
      '1:delete('
    ],
    [
      'a write in a function of the file that the callback calls',
      'function save(c) { return c.order.create({}) }\nx.inStoreContext(s, () => save(c))',
      '1:create('
    ],
    [
      'a createManyAndReturn',
      'x.inStoreContext(s, () => t.note.createManyAndReturn({}))',
      '1:createManyAndReturn('
    ],
    [
      'an updateManyAndReturn',
      'x.inStoreContext(s, () => t.note.updateManyAndReturn({}))',
      '1:updateManyAndReturn('
    ],
    [
      'a COPY through $queryRawUnsafe',
      "x.inStoreContext(s, () => p.$queryRawUnsafe('COPY t FROM stdin'))",
      '1:$queryRawUnsafe( with a writing statement'
    ],
    [
      'a SELECT of a writing function',
      'x.inStoreContext(s, () => p.$queryRaw`SELECT public.purge_audit_logs(${n})`)',
      '1:$queryRaw`...`'
    ],
    [
      'a dynamic key',
      'x.inStoreContext(s, () => client[model][op]({}))',
      '1:a call through a dynamic key (client[model][op](...)) is suspect'
    ],
    [
      'a callback passed as a local identifier',
      'const work = () => t.order.update({})\nx.inStoreContext(s, work)',
      '1:update('
    ],
    [
      'the bare function form',
      'inStoreContext(p, s, () => t.order.create({}))'.replace(
        'inStoreContext(p, s,',
        'inStoreContext(s,'
      ),
      '1:create('
    ],
    [
      'a write in the callback of a forward (a private method that passes its parameter on)',
      'class A { ctx(w) { return this.p.inStoreContext(s, w) } run() { return this.ctx(() => t.order.update({})) } }',
      '1:update('
    ],
    [
      'a method passed as the callback',
      'class A { run() { return this.p.inStoreContext(s, this.save) } save = () => t.create({}) }',
      '1:create('
    ]
  ])('refuses %s', (_label, code, expected) => {
    expect(writes(code)).toEqual([expected])
  })

  it('refuses a callback it cannot read, so that nothing hides behind an import', () => {
    expect(writes('x.inStoreContext(s, imported)')).toEqual([
      '1:the callback is not written inline nor resolvable in this file: it cannot be read'
    ])
  })

  it('refuses a forward that is called with an imported callback, and one nobody calls', () => {
    expect(
      writes(
        'class A { ctx(w) { return this.p.inStoreContext(s, w) } run() { return this.ctx(imported) } }'
      )
    ).toHaveLength(1)
    expect(writes('class A { ctx(w) { return this.p.inStoreContext(s, w) } }')).toHaveLength(1)
  })

  it.each([
    [
      'a read through a forward',
      'class A { ctx(w) { return this.p.inStoreContext(s, w) } run() { return this.ctx(() => t.order.findMany({})) } }'
    ],
    ['a findMany', 'x.inStoreContext(s, () => p.client.order.findMany({}))'],
    [
      'a $queryRaw read',
      'x.inStoreContext(s, () => p.client.$queryRaw`SELECT f.* FROM public.rls_search_products(${t}::text) AS f`)'
    ],
    [
      'a write OUTSIDE the callback',
      'class A { run() { this.save(); return this.p.inStoreContext(s, () => t.findFirst({})) } save() { return t.create({}) } }'
    ],
    [
      'a write in a method the callback never calls',
      'class A { run() { return this.p.inStoreContext(s, () => this.read()) } read() { return 1 } other() { return t.update({}) } }'
    ],
    [
      'a write in a comment or a string',
      'x.inStoreContext(s, () => { /* t.create({}) */ return "t.update()" })'
    ],
    [
      'a recursive read (no loop)',
      'class A { run() { return this.p.inStoreContext(s, () => this.walk()) } walk() { return this.walk() } }'
    ],
    ['a file with no inStoreContext', 'const a = t.create({})']
  ])('accepts %s', (_label, code) => {
    expect(writes(code)).toEqual([])
  })

  it('has no allowlist entry today, and the real sources write nothing inside inStoreContext', () => {
    expect(STORE_CONTEXT_WRITES_ALLOWED).toEqual({})
    const report = checkStoreContextWrites(ROOT)
    expect(report.scanned).toBeGreaterThan(500)
    expect(report.failures).toEqual([])
  })
})

describe('AuditService.logRefused only for plugin denials', () => {
  const uses = (code: string): number[] =>
    findLogRefusedUses(code, 'probe.ts').map(finding => finding.line)

  it.each([
    ['a call', 'this.audit.logRefused({ action })'],
    ['a call through the client', 'audit.logRefused(entry)'],
    ['an alias', 'const f = audit.logRefused'],
    ['a destructuring', 'const { logRefused } = audit'],
    ['an element access', "audit['logRefused'](entry)"],
    ['a shorthand property', 'const o = { logRefused }']
  ])('refuses %s', (_label, code) => {
    expect(uses(code)).toEqual([1])
  })

  it.each([
    ['its declaration', 'class A { logRefused(entry: E): void { this.write(entry) } }'],
    ['a success through log', 'this.audit.log({ action })'],
    ['a comment or a string', "// audit.logRefused(x)\nconst s = 'audit.logRefused(x)'"]
  ])('accepts %s', (_label, code) => {
    expect(uses(code)).toEqual([])
  })

  it('lists exactly the plugin denial audit, and the real sources use it nowhere else', () => {
    expect(LOG_REFUSED_CALLERS).toEqual({
      'apps/api/src/modules/plugins/plugin-denial-audit.ts': 1
    })
    const report = checkRefusedAudit(ROOT)
    expect(report.failures).toEqual([])
  })
})
