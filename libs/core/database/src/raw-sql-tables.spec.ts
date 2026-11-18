import { policyTablesOfRawSql, sqlTextOfRawArgs, tablesOfRawSql } from './raw-sql-tables'

const POLICY = ['messages', 'conversations', 'orders', 'media', 'inventory_levels']

describe('tablesOfRawSql', () => {
  it('reads the table after FROM, JOIN, UPDATE, INTO and TRUNCATE', () => {
    expect(tablesOfRawSql('SELECT 1 FROM messages m JOIN conversations c ON c.id = m.c')).toEqual([
      'messages',
      'conversations'
    ])
    expect(tablesOfRawSql('UPDATE orders SET a = 1')).toEqual(['orders'])
    expect(tablesOfRawSql('INSERT INTO media (id) VALUES (1)')).toEqual(['media'])
    expect(tablesOfRawSql('DELETE FROM media WHERE id = 1')).toEqual(['media'])
    expect(tablesOfRawSql('TRUNCATE TABLE orders')).toEqual(['orders'])
  })

  it('reads through the schema and the quotes', () => {
    expect(tablesOfRawSql('SELECT * FROM public.messages')).toEqual(['messages'])
    expect(tablesOfRawSql('SELECT * FROM "public"."inventory_levels" l')).toEqual([
      'inventory_levels'
    ])
    expect(tablesOfRawSql('SELECT * FROM MESSAGES')).toEqual(['messages'])
  })

  it('ignores comments and the text of a string', () => {
    expect(tablesOfRawSql("SELECT 'from orders' -- FROM media\n")).toEqual([])
    expect(tablesOfRawSql('SELECT 1 /* join orders */')).toEqual([])
  })

  it('reads a function that returns rows as a name that is not a table', () => {
    expect(
      policyTablesOfRawSql('SELECT * FROM rls_list_pickup_targets($1, $2, $3)', POLICY)
    ).toEqual([])
  })
})

describe('policyTablesOfRawSql', () => {
  it('keeps the tables that have a policy and drops the others', () => {
    expect(
      policyTablesOfRawSql('SELECT 1 FROM users u JOIN orders o ON o.user = u.id', POLICY)
    ).toEqual(['orders'])
    expect(policyTablesOfRawSql('SELECT set_config($1, $2, true)', POLICY)).toEqual([])
  })
})

describe('sqlTextOfRawArgs', () => {
  it('reads a tagged template, an unsafe call and a nested fragment', () => {
    expect(
      sqlTextOfRawArgs({ strings: ['SELECT 1 FROM messages WHERE id = ', ''], values: [7] })
    ).toContain('FROM messages')
    expect(sqlTextOfRawArgs(['DELETE FROM media WHERE a = $1', 5])).toContain('FROM media')
    const nested = sqlTextOfRawArgs({
      strings: ['SELECT * FROM ', ''],
      values: [{ strings: ['orders o'], values: [] }]
    })
    expect(policyTablesOfRawSql(nested, POLICY)).toEqual(['orders'])
    expect(sqlTextOfRawArgs(undefined)).toBe('')
  })
})
