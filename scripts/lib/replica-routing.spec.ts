import { checkReplicaUse, staleReaders } from './replica-routing'

const FILE = 'apps/api/src/modules/x/x.service.ts'
const READERS = [FILE]

function check(body: string, file = FILE, readers: readonly string[] = READERS) {
  return checkReplicaUse(file, body, readers)
}

describe('checkReplicaUse', () => {
  it('lets a listed file read from the replica', () => {
    const { violations, calls } = check(`
      class S { async list(storeId: string) { return this.prisma.replica().$queryRaw\`SELECT 1 WHERE store_id = \${storeId}\` } }`)
    expect(violations).toEqual([])
    expect(calls).toBe(1)
  })

  it('refuses a call outside the listed files', () => {
    const { violations } = check(
      `class S { list() { return this.prisma.replica().order.findMany() } }`,
      'apps/api/src/modules/y/y.service.ts'
    )
    expect(violations.map(v => v.message)).toEqual([expect.stringContaining('outside the files')])
  })

  it('refuses a call in a guard or an interceptor even when the file is listed', () => {
    const guard = 'apps/api/src/guards/tenant.guard.ts'
    const { violations } = check(
      `class G { canActivate() { return this.prisma.replica().store.findFirst() } }`,
      guard,
      [guard]
    )
    expect(violations.map(v => v.message)).toEqual([expect.stringContaining('guard')])
  })

  it('refuses a function that reads from the replica and writes', () => {
    const { violations } = check(`
      class S { async resolve() {
        const row = await this.prisma.replica().conversation.findFirst()
        await this.prisma.client.conversation.update({ where: { id: row.id }, data: {} })
      } }`)
    expect(violations.map(v => v.message)).toEqual([expect.stringContaining('update()')])
  })

  it('refuses a transaction, a lock and a hook inside the same function', () => {
    for (const call of [
      'this.prisma.transaction(async () => 1)',
      'lockStoreForWrite(tx, id)',
      'this.prisma.afterCommit(db, () => 1)'
    ]) {
      const { violations } = check(
        `class S { async m() { await this.prisma.replica().a.findMany(); ${call} } }`
      )
      expect(violations.length).toBeGreaterThan(0)
    }
  })

  it('refuses a statement that writes or locks', () => {
    for (const sql of ['INSERT INTO t VALUES (1)', 'SELECT 1 FOR UPDATE', 'delete from t']) {
      const { violations } = check(
        `class S { async m() { return this.prisma.replica().$queryRaw\`${sql}\` } }`
      )
      expect(violations.length).toBeGreaterThan(0)
    }
  })

  it('sees a write made with a tagged $executeRaw', () => {
    const { violations } = check(
      'class S { async m() { await this.prisma.replica().a.findMany(); await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)` } }'
    )
    expect(violations.map(v => v.message)).toEqual([expect.stringContaining('$executeRaw')])
  })

  it('does not take a message that says update for a statement', () => {
    const { violations } = check(
      'class S { async m() { const rows = await this.prisma.replica().$queryRaw`SELECT 1`; throw new Error(`could not update ${rows}`) } }'
    )
    expect(violations).toEqual([])
  })

  it('ignores a word of a SQL comment', () => {
    const { violations } = check(
      'class S { async m() { return this.prisma.replica().$queryRaw`SELECT 1 -- never delete here\n` } }'
    )
    expect(violations).toEqual([])
  })

  it('does not take a column named like a verb for a write', () => {
    const { violations } = check(
      'class S { async m() { return this.prisma.replica().$queryRaw`SELECT updated_at, deleted_at FROM t` } }'
    )
    expect(violations).toEqual([])
  })

  it('refuses a replica call in a route that writes', () => {
    const { violations } = check(`
      class C { @Post('x') async make() { return this.prisma.replica().a.findMany() } }`)
    expect(violations.map(v => v.message)).toEqual([expect.stringContaining('@Post')])
  })

  it('looks inside an arrow function as part of its method', () => {
    const { violations } = check(`
      class S { async m() { const rows = await this.prisma.replica().a.findMany(); rows.forEach(async r => { await this.prisma.client.a.delete({ where: { id: r.id } }) }) } }`)
    expect(violations.map(v => v.message)).toEqual([expect.stringContaining('delete()')])
  })

  it('does not count a method that is only named replica', () => {
    const { calls } = check(`class P { replica() { return this.base.$replica() } }`)
    expect(calls).toBe(0)
  })
})

describe('staleReaders', () => {
  it('names a listed file that no longer calls replica()', () => {
    expect(staleReaders(['a', 'b'], new Map([['a', 2]]))).toEqual(['b'])
  })
})
