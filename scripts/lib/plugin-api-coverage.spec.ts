import {
  type PluginApiCoverage,
  baselineDrift,
  baselineGrowth,
  checkPluginApiCoverage,
  declaredScopes,
  mappedKeys,
  pendingKeys
} from './plugin-api-coverage'

const steps = new Map([
  ['5.6', 'todo'],
  ['5.7', 'deferred (Phase 2)']
])
const scopes = ['orders:read', 'orders:write']

function check(map: Record<string, PluginApiCoverage>, exposed = Object.keys(map)) {
  return checkPluginApiCoverage(exposed, map, scopes, steps)
}

describe('declaredScopes', () => {
  it('reads the values of the PluginScopes object and nothing after it', () => {
    const source = `export const PluginScopes = {
  ORDERS_READ: 'orders:read',
  SHIPMENTS_WRITE: 'shipments:write'
} as const
const Other = {
  X: 'not:ascope'
} as const`
    expect(declaredScopes(source)).toEqual(['orders:read', 'shipments:write'])
  })

  it('reads a scope with a digit and one that prettier wrapped to the next line', () => {
    const source = `export const PluginScopes = {
  A2: 'a2:read',
  LONG_NAME:
    'long-name:write'
} as const`
    expect(declaredScopes(source)).toEqual(['a2:read', 'long-name:write'])
  })

  it('fails when a key of the object has a value the pattern cannot read', () => {
    const source = `export const PluginScopes = {
  ORDERS_READ: 'orders:read',
  BAD: \`x:y\`
} as const`
    expect(() => declaredScopes(source)).toThrow('could not be read')
  })

  it('finds nothing in a file that is not the SDK', () => {
    expect(declaredScopes('export const Other = {}')).toEqual([])
  })
})

describe('mappedKeys', () => {
  it('lists the route keys of a copy of the map', () => {
    expect(
      mappedKeys(`  'auth.me': { none: 'x' },\n  'returns.reception.scan': { scope: 'a:b' },`)
    ).toEqual(['auth.me', 'returns.reception.scan'])
  })
})

describe('checkPluginApiCoverage', () => {
  it('accepts a declared scope, a list of them, a proposed scope with a live step and a reason', () => {
    expect(
      check({
        'orders.byId': { scope: ['orders:read', 'orders:write'] },
        'orders.create': { scope: 'orders:write' },
        'returns.create': { proposed: 'returns:write', step: '5.6' },
        'returns.list': { proposed: ['orders:read', 'returns:read'], step: '5.6' },
        'auth.me': { none: 'A session' }
      })
    ).toEqual({ unmapped: [], stale: [], invalid: [] })
  })

  it('reports a route with no entry and an entry with no route', () => {
    const report = check({ 'orders.list': { scope: 'orders:read' } }, [
      'orders.list',
      'orders.cancel'
    ])
    expect(report.unmapped).toEqual(['orders.cancel'])
    expect(check({ 'orders.gone': { scope: 'orders:read' } }, []).stale).toEqual(['orders.gone'])
  })

  it.each<[string, unknown]>([
    ['a scope PluginScopes does not declare', { scope: 'returns:read' }],
    ['a list with one scope it does not declare', { scope: ['orders:read', 'returns:read'] }],
    ['an empty list', { scope: [] }],
    ['a proposed scope that is already declared', { proposed: 'orders:read', step: '5.6' }],
    [
      'a list of proposed scopes that are all declared',
      { proposed: ['orders:read', 'orders:write'], step: '5.6' }
    ],
    ['a proposed scope with a bad shape', { proposed: 'Returns', step: '5.6' }],
    ['a proposed scope with no step', { proposed: 'returns:read' }],
    ['a step the plan does not have', { proposed: 'returns:read', step: '9.9' }],
    ['a deferred step', { proposed: 'returns:read', step: '5.7' }],
    ['an empty reason', { none: '  ' }],
    ['a scope and a reason', { scope: 'orders:read', none: 'why' }],
    ['nothing at all', {}],
    ['a step on a scope that exists', { scope: 'orders:read', step: '5.6' }],
    ['a reason with an exposed path', { none: 'why', exposed: '/plugin-api/orders' }],
    ['an exposed that is not a plugin-api path', { scope: 'orders:read', exposed: '/orders' }],
    ['a typo in the key', { scoped: 'orders:read' }]
  ])('rejects %s', (_name, entry) => {
    expect(check({ 'orders.list': entry as PluginApiCoverage }).invalid).toEqual(['orders.list'])
  })

  it('accepts an exposed path under /plugin-api', () => {
    expect(
      check({ 'orders.list': { scope: 'orders:read', exposed: '/plugin-api/orders' } }).invalid
    ).toEqual([])
  })
})

describe('pendingKeys', () => {
  it('lists what has a scope and no plugin-api path, and not a reason or an exposed route', () => {
    expect(
      pendingKeys({
        'b.pending': { scope: 'orders:read' },
        'a.proposed': { proposed: 'x:y', step: '5.6' },
        'c.exposed': { scope: 'orders:read', exposed: '/plugin-api/orders' },
        'd.none': { none: 'why' }
      })
    ).toEqual(['a.proposed', 'b.pending'])
  })
})

describe('baselineGrowth', () => {
  const previous = { pending: ['a.one'] }

  it('allows the baseline to shrink or stay', () => {
    expect(baselineGrowth(previous, { pending: [] }, ['a.one'])).toEqual([])
    expect(baselineGrowth(previous, previous, ['a.one'])).toEqual([])
  })

  it('allows a key that main did not map (a new route)', () => {
    expect(baselineGrowth(previous, { pending: ['a.one', 'b.new'] }, ['a.one'])).toEqual([])
  })

  it('refuses a route that main maps and that was not pending (an exposed or a none turned back)', () => {
    expect(baselineGrowth(previous, { pending: ['a.one', 'c.done'] }, ['a.one', 'c.done'])).toEqual(
      ['c.done']
    )
  })
})

describe('baselineDrift', () => {
  it('says what is pending and not listed, and what is listed and no longer pending', () => {
    expect(baselineDrift({ pending: ['a', 'b'] }, ['b', 'c'])).toEqual({
      added: ['c'],
      removed: ['a']
    })
  })
})
