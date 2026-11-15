import type { MovementView } from './inventory.views'
import { pluginMovementPage, pluginMovementView } from './plugin-inventory.views'

const movement = (over: Partial<MovementView> = {}): MovementView => ({
  id: 'm-1',
  productId: 'p-1',
  variantId: null,
  warehouseId: 'w-1',
  type: 'ADJUSTMENT',
  quantity: 3,
  reason: null,
  note: null,
  referenceType: null,
  referenceId: null,
  onHandAfter: 3,
  reservedAfter: 0,
  createdBy: 'user-staff-1',
  createdAt: new Date('2026-11-15T00:00:00Z'),
  ...over
})

describe('pluginMovementView', () => {
  it('drops the id of the person who made the movement', () => {
    const view = pluginMovementView(movement())

    expect('createdBy' in view).toBe(false)
    expect(JSON.stringify(view)).not.toContain('user-staff-1')
  })

  it('keeps the fields a plugin reads', () => {
    expect(pluginMovementView(movement({ quantity: 7 }))).toMatchObject({
      id: 'm-1',
      productId: 'p-1',
      quantity: 7,
      onHandAfter: 3
    })
  })

  it('names the fields one by one, so a new column does not reach a plugin', () => {
    const extra = { ...movement(), seq: 9, storeId: 's-1', idempotencyKey: 'k' }

    const view = pluginMovementView(extra)

    expect(view).not.toHaveProperty('seq')
    expect(view).not.toHaveProperty('storeId')
    expect(view).not.toHaveProperty('idempotencyKey')
  })

  it('carries the cost only when the movement has it (the caller holds the cost permission)', () => {
    expect('unitCostCents' in pluginMovementView(movement())).toBe(false)
    expect(pluginMovementView(movement({ unitCostCents: 250 })).unitCostCents).toBe(250)
  })
})

describe('pluginMovementPage', () => {
  it('maps every row and keeps the cursor', () => {
    const page = pluginMovementPage({
      data: [movement(), movement({ id: 'm-2' })],
      nextCursor: 'c',
      hasMore: true
    })

    expect(page.nextCursor).toBe('c')
    expect(page.hasMore).toBe(true)
    expect(page.data.map(row => row.id)).toEqual(['m-1', 'm-2'])
    expect(page.data.every(row => !('createdBy' in row))).toBe(true)
  })
})
