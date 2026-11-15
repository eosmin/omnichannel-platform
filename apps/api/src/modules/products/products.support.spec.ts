import { AuditAction } from '@platform/core/audit'
import type { AuditService } from '@platform/core/audit-module'

import { pluginActorOf } from '../tenancy'

import { auditProductWrite, fieldsSet } from './products.support'

const request = { ip: '10.0.0.1', get: () => 'agent' } as never

describe('fieldsSet', () => {
  it('names the fields a body sets, sorted, and skips the ones left out', () => {
    expect(fieldsSet({ priceCents: 1, name: 'x', sku: undefined, active: false })).toEqual([
      'active',
      'name',
      'priceCents'
    ])
  })

  it('counts a field set to null: it is a change', () => {
    expect(fieldsSet({ costCents: null })).toEqual(['costCents'])
  })
})

describe('auditProductWrite', () => {
  const log = jest.fn<void, [Record<string, unknown>]>()
  const audit = { log } as unknown as AuditService
  beforeEach(() => log.mockReset())

  it('records a plugin as the system with its installation, and never a user id', () => {
    const actor = pluginActorOf({ id: 'inst-1', pluginId: 'plug-1' }, { id: 's-1' }, request)

    auditProductWrite(audit, 's-1', actor, {
      action: AuditAction.PRODUCT_UPDATED,
      productId: 'p-1',
      fields: ['name']
    })

    const entry = log.mock.calls[0]?.[0]
    expect(entry?.actor).toEqual({ system: true })
    expect(entry?.metadata).toEqual({ fields: ['name'], pluginInstallationId: 'inst-1' })
    expect(JSON.stringify(entry)).not.toContain('plugin:inst-1')
  })

  it('records a person by id, with the variant when there is one', () => {
    auditProductWrite(
      audit,
      's-1',
      { userId: 'u-1', storeId: 's-1' },
      { action: AuditAction.PRODUCT_CREATED, productId: 'p-1', variantId: 'v-1', fields: [] }
    )

    const entry = log.mock.calls[0]?.[0]
    expect(entry?.actor).toEqual({ userId: 'u-1' })
    expect(entry?.metadata).toEqual({ variantId: 'v-1', fields: [] })
  })
})
