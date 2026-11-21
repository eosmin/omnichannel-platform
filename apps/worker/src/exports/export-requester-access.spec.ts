import { Permissions } from '@platform/core/auth'
import { ExportTypes } from '@platform/core/exports'

import { accessOfRequester, narrowedViewer } from './export-requester-access'

describe('what the requester of an export may still take out', () => {
  it('lets a requester who holds every permission of the kind through', () => {
    const held = [Permissions.CUSTOMERS_EXPORT]
    expect(accessOfRequester(ExportTypes.CUSTOMERS, held)).toEqual({ allowed: true })
  })

  it('refuses a requester who lost one of the permissions of the kind, however many others remain', () => {
    const held = [Permissions.CONVERSATIONS_VIEW, Permissions.ORDERS_EXPORT]
    expect(accessOfRequester(ExportTypes.CONVERSATIONS, held)).toEqual({ allowed: false })
    expect(accessOfRequester(ExportTypes.ORDERS, held)).toEqual({ allowed: false })
  })

  it('refuses a requester who holds nothing (no membership, an inactive installation)', () => {
    for (const type of Object.values(ExportTypes)) {
      expect(accessOfRequester(type, null)).toEqual({ allowed: false })
      expect(accessOfRequester(type, [])).toEqual({ allowed: false })
    }
  })

  it('refuses a kind that no permission serves (fails closed)', () => {
    expect(accessOfRequester('not_a_kind', [Permissions.CUSTOMERS_EXPORT])).toEqual({
      allowed: false
    })
  })
})

describe('the viewer a file is written for', () => {
  const frozen = {
    userId: '6f1c2b7e-3c1a-4d57-9a38-0d5f7a6b1c11',
    held: [Permissions.CONVERSATIONS_VIEW, Permissions.CONVERSATIONS_VIEW_ALL]
  }

  it('is narrowed to what the requester holds now', () => {
    const viewer = narrowedViewer(frozen, [Permissions.CONVERSATIONS_VIEW])
    expect(viewer.held).toEqual([Permissions.CONVERSATIONS_VIEW])
    expect(viewer.userId).toBe(frozen.userId)
  })

  it('is never widened past what was frozen when it was asked, even for a promoted member', () => {
    const viewer = narrowedViewer(frozen, [
      Permissions.CONVERSATIONS_VIEW,
      Permissions.CONVERSATIONS_VIEW_ALL,
      Permissions.CONVERSATIONS_ARCHIVE
    ])
    expect(viewer.held).toEqual([
      Permissions.CONVERSATIONS_VIEW,
      Permissions.CONVERSATIONS_VIEW_ALL
    ])
  })
})
