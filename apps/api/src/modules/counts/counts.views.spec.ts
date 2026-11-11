import { CountStatus } from '@platform/core/domain'

import { countLineView, countView } from './counts.views'

const header = {
  id: 'c1',
  number: 'CT-0001',
  status: CountStatus.COUNTING,
  storeId: null,
  note: null,
  createdBy: 'u1',
  startedAt: null,
  submittedAt: null,
  appliedBy: null,
  appliedAt: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  warehouse: { id: 'w1', name: 'Main', code: 'MAIN' }
}

describe('countView', () => {
  it('carries the sheet and the name of the store it is limited to', () => {
    expect(countView(header, 'Store A')).toMatchObject({
      id: 'c1',
      number: 'CT-0001',
      storeName: 'Store A',
      warehouse: { code: 'MAIN' }
    })
    expect(countView(header, null).storeName).toBeNull()
  })
})

describe('countLineView', () => {
  const row = {
    id: 'l1',
    storeId: 's1',
    productId: 'p1',
    variantId: null,
    expectedQuantity: 10,
    countedQuantity: 8,
    product: { name: 'Mug', sku: 'MUG' },
    variant: null
  }

  it('shows the variance against the snapshot and the sku of the product', () => {
    expect(countLineView(row)).toMatchObject({ variance: -2, sku: 'MUG', variantName: null })
  })

  it('prefers the sku and the name of the variant, and has no variance until counted', () => {
    const view = countLineView({
      ...row,
      variantId: 'v1',
      countedQuantity: null,
      variant: { name: 'Blue', sku: 'MUG-B' }
    })
    expect(view).toMatchObject({ sku: 'MUG-B', variantName: 'Blue', variance: null })
  })
})
