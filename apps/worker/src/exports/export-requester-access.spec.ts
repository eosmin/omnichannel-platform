import { Permissions } from '@platform/core/auth'
import { MembershipStatus, PluginInstallationStatus, PluginStatus } from '@platform/core/domain'
import { ExportTypes } from '@platform/core/exports'

import {
  accessOfRequester,
  currentPermissionsOfRequester,
  fileStillCovered,
  narrowedViewer
} from './export-requester-access'

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

describe('the permissions a requester holds now', () => {
  const STORE = '0b8e7a52-6d1f-4a63-8c4e-2f9d3b7a1e55'
  const INSTALLATION = '9d3b7a1e-55aa-4c63-8c4e-2f9d3b7a1e01'
  const jobContext = { forStore: (_id: string, work: () => unknown) => work() }

  function prismaOf(answer: { installation?: unknown; membership?: unknown }) {
    const installation = { findFirst: jest.fn().mockResolvedValue(answer.installation ?? null) }
    const membership = { findFirst: jest.fn().mockResolvedValue(answer.membership ?? null) }
    return {
      installation,
      membership,
      prisma: { client: { pluginInstallation: installation, membership } }
    }
  }

  it('asks for an installation that is active, of an approved plugin, of the store of the row', async () => {
    const t = prismaOf({ installation: { scopes: ['orders:read'] } })
    await currentPermissionsOfRequester(
      t.prisma as never,
      jobContext as never,
      STORE,
      `plugin:${INSTALLATION}`
    )
    expect(t.installation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: INSTALLATION,
          storeId: STORE,
          status: PluginInstallationStatus.ACTIVE,
          plugin: { status: PluginStatus.APPROVED }
        }
      })
    )
  })

  it('holds nothing when the plugin was withdrawn (no row answers)', async () => {
    const t = prismaOf({})
    const held = await currentPermissionsOfRequester(
      t.prisma as never,
      jobContext as never,
      STORE,
      `plugin:${INSTALLATION}`
    )
    expect(held).toBeNull()
  })

  it('asks for a membership that is active, not revoked and of the store of the row', async () => {
    const t = prismaOf({})
    await currentPermissionsOfRequester(t.prisma as never, jobContext as never, STORE, 'user-1')
    expect(t.membership.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: 'user-1',
          storeId: STORE,
          status: MembershipStatus.ACTIVE,
          revokedAt: null
        }
      })
    )
  })
})

describe('whether a file that was written is still covered', () => {
  it('is covered while every permission it was made with is still held', () => {
    const used = [Permissions.CONVERSATIONS_VIEW, Permissions.CONVERSATIONS_EXPORT]
    expect(fileStillCovered(ExportTypes.CONVERSATIONS, used, used)).toBe(true)
  })

  it('is not covered when a permission of the view it was made with was lost, even if the kind is still allowed', () => {
    const used = [
      Permissions.CONVERSATIONS_VIEW,
      Permissions.CONVERSATIONS_EXPORT,
      Permissions.CONVERSATIONS_VIEW_ALL
    ]
    const now = [Permissions.CONVERSATIONS_VIEW, Permissions.CONVERSATIONS_EXPORT]
    expect(fileStillCovered(ExportTypes.CONVERSATIONS, used, now)).toBe(false)
  })

  it('is not covered when the requester holds nothing', () => {
    expect(fileStillCovered(ExportTypes.CUSTOMERS, [Permissions.CUSTOMERS_EXPORT], null)).toBe(
      false
    )
    expect(fileStillCovered(ExportTypes.CUSTOMERS, [Permissions.CUSTOMERS_EXPORT], [])).toBe(false)
  })
})
