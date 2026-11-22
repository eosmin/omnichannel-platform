import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import {
  NOT_VALID_CONSTRAINTS,
  constraintEvents,
  quoteIdentifier,
  refusalToChange
} from './not-valid-constraints'

const MIGRATIONS = join(__dirname, '../../libs/core/database/prisma/migrations')

// What is still NOT VALID after every migration ran, in order: added NOT VALID, and neither validated nor dropped afterwards
// (a constraint added again with the same name is a new one)
function stillNotValid(): string[] {
  const open = new Set<string>()
  const folders = readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort()
  for (const folder of folders) {
    const sql = readFileSync(join(MIGRATIONS, folder, 'migration.sql'), 'utf8')
    for (const event of constraintEvents(sql)) {
      if (event.kind === 'not-valid') open.add(event.name)
      else open.delete(event.name)
    }
  }
  return [...open].sort()
}

describe('NOT_VALID_CONSTRAINTS', () => {
  it('lists every constraint that the migrations leave NOT VALID, and nothing else', () => {
    expect(NOT_VALID_CONSTRAINTS.map(entry => entry.name).sort()).toEqual(stillNotValid())
  })

  it('names no constraint twice', () => {
    const names = NOT_VALID_CONSTRAINTS.map(entry => entry.name)
    expect(new Set(names).size).toBe(names.length)
  })
})

describe('constraintEvents', () => {
  it('reads an addition NOT VALID, a validation and a drop, in order, and skips comments', () => {
    const sql = `
      -- ALTER TABLE x ADD CONSTRAINT "ghost" CHECK (a) NOT VALID;
      ALTER TABLE "t" ADD CONSTRAINT "first_check"
        CHECK (a IS NULL OR b IS NULL) NOT VALID;
      ALTER TABLE "t" ADD CONSTRAINT second_check CHECK (a > 0);
      ALTER TABLE "t" VALIDATE CONSTRAINT "first_check";
      ALTER TABLE "t" DROP CONSTRAINT IF EXISTS "first_check";`
    expect(constraintEvents(sql)).toEqual([
      { kind: 'not-valid', name: 'first_check' },
      { kind: 'validate', name: 'first_check' },
      { kind: 'drop', name: 'first_check' }
    ])
  })
})

describe('constraintEvents with several clauses', () => {
  it('sees each constraint of one ALTER on its own', () => {
    const sql = `ALTER TABLE "t" ADD CONSTRAINT a_check CHECK (a > 0), ADD CONSTRAINT b_check CHECK (b > 0) NOT VALID;`
    expect(constraintEvents(sql)).toEqual([{ kind: 'not-valid', name: 'b_check' }])
  })
})

describe('quoteIdentifier', () => {
  it('doubles the quotes of an identifier', () => {
    expect(quoteIdentifier('a"b')).toBe('"a""b"')
  })
})

describe('refusalToChange', () => {
  it('refuses the development database even when it is confirmed', () => {
    expect(refusalToChange('platform_dev', ['--confirm=platform_dev'])).toMatch(/protected/)
  })
  it('asks for the name of the database', () => {
    expect(refusalToChange('shop_prod', [])).toMatch(/--confirm=shop_prod/)
    expect(refusalToChange('shop_prod', ['--confirm=other'])).toMatch(/--confirm=shop_prod/)
  })
  it('lets a confirmed database through', () => {
    expect(refusalToChange('platform_test_s5', ['--confirm=platform_test_s5'])).toBeNull()
  })
})
