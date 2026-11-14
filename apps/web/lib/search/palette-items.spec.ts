import { ClientPermissions, type Permission } from '@platform/core/auth'

import { matchingPages, moveActive, pageCommands } from './palette-items'

const canWith =
  (...held: Permission[]) =>
  (permission: Permission): boolean =>
    held.includes(permission)

describe('pageCommands', () => {
  it('offers only the pages the member may open', () => {
    const commands = pageCommands(
      's1',
      canWith(ClientPermissions.ORDERS_VIEW, ClientPermissions.CUSTOMERS_VIEW)
    )
    expect(commands.map(command => command.id)).toEqual(['customers', 'orders'])
    expect(commands[1]?.href).toBe('/s/s1/orders')
  })

  it('offers none to a member who may open none', () => {
    expect(pageCommands('s1', canWith())).toEqual([])
  })
})

describe('matchingPages', () => {
  const commands = pageCommands(
    's1',
    canWith(ClientPermissions.ORDERS_VIEW, ClientPermissions.CUSTOMERS_VIEW)
  )
  const labels: Record<string, string> = { customers: 'Clientes', orders: 'Órdenes' }
  const labelOf = (command: { id: string }): string => labels[command.id] ?? ''

  it('lists all of them for no text', () => {
    expect(matchingPages(commands, labelOf, '')).toHaveLength(2)
  })

  it('ignores accents and case', () => {
    expect(matchingPages(commands, labelOf, 'ORDENES').map(item => item.key)).toEqual([
      'page:orders'
    ])
  })

  it('finds nothing when no label holds the text', () => {
    expect(matchingPages(commands, labelOf, 'zzz')).toEqual([])
  })
})

describe('moveActive', () => {
  it('starts at the first row going down and at the last going up', () => {
    expect(moveActive(-1, 1, 3)).toBe(0)
    expect(moveActive(-1, -1, 3)).toBe(2)
  })

  it('wraps around both ends', () => {
    expect(moveActive(2, 1, 3)).toBe(0)
    expect(moveActive(0, -1, 3)).toBe(2)
  })

  it('has no active row in an empty list', () => {
    expect(moveActive(0, 1, 0)).toBe(-1)
  })
})
