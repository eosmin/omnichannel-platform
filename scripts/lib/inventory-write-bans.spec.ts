import { createRequire } from 'node:module'

import { Linter } from 'eslint'
import { parser } from 'typescript-eslint'

// The ban of eslint.config.js on writing stock outside libs/core/inventory (TDD_16 §8), run as the linter runs it
const { inventoryWriteBans } = createRequire(__filename)('../../eslint-inventory-bans.cjs') as {
  inventoryWriteBans: { selector: string; message: string }[]
}

const linter = new Linter({ configType: 'flat' })

function linesFlagged(code: string): number[] {
  const messages = linter.verify(
    code,
    [
      {
        files: ['**/*.ts'],
        languageOptions: { parser },
        rules: { 'no-restricted-syntax': ['error', ...inventoryWriteBans] }
      }
    ],
    'probe.ts'
  )
  return messages.map(message => message.line).sort((a, b) => a - b)
}

describe('the ban on writing stock outside the inventory engine', () => {
  it.each([
    ['an update of a level', 'await tx.inventoryLevel.update({})'],
    [
      'a create of a movement through the client',
      'await prisma.client.inventoryMovement.create({})'
    ],
    ['a deleteMany', 'await tx.inventoryLevel.deleteMany({ where: { id } })'],
    ['an upsert of a destructured model', 'await inventoryLevel.upsert({})'],
    ['createManyAndReturn', 'await tx.inventoryMovement.createManyAndReturn({})'],
    ['a template with an UPDATE', 'await tx.$executeRaw`UPDATE inventory_levels SET on_hand = 0`'],
    [
      'a template with an INSERT into the public schema',
      'await tx.$queryRaw`insert into public.inventory_movements (id) values (1)`'
    ],
    [
      'a quoted table in a string',
      'await tx.$queryRawUnsafe(\'DELETE FROM "inventory_movements"\')'
    ],
    ['a TRUNCATE', "await tx.$executeRawUnsafe('TRUNCATE TABLE inventory_levels')"]
  ])('refuses %s', (_label, statement) => {
    expect(linesFlagged(statement)).toEqual([1])
  })

  it.each([
    ['a read of a level', 'await tx.inventoryLevel.findMany({})'],
    ['a count of movements', 'await tx.inventoryMovement.count({})'],
    ['a write of another model', 'await tx.warehouse.update({})'],
    ['a select in SQL', 'await tx.$queryRaw`SELECT * FROM inventory_levels`'],
    [
      'a table whose name only starts the same',
      'await tx.$executeRaw`UPDATE inventory_levels_archive SET a = 1`'
    ]
  ])('allows %s', (_label, statement) => {
    expect(linesFlagged(statement)).toEqual([])
  })
})
